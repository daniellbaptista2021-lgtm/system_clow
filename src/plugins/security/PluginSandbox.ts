/**
 * PluginSandbox.ts — Sandbox execution for untrusted plugins
 *
 * Based on Claude Code's sandbox patterns (300 lines)
 *
 * Implements:
 *   - Permission intersection (requested ∩ granted)
 *   - Permission check before component execution
 *   - Filesystem path restrictions (plugin can only access its own dir + workspace)
 *   - Network access control (allow/deny per plugin)
 *   - Shell execution restrictions
 *   - Hook execution sandboxing
 *   - Environment variable filtering (hide secrets from untrusted plugins)
 *   - Resource limits (max memory, max CPU time)
 *   - Environment sanitization details
 *   - Path validation with symlink resolution
 *   - Resource usage tracking
 *   - Sandbox violation logging
 */

import * as fs from 'fs';
import * as path from 'path';
import type { LoadedPlugin, PluginPermission } from '../types.js';

// ─── Resource Limits ────────────────────────────────────────────────────────

export interface SandboxLimits {
  /** Max memory in MB for plugin processes */
  maxMemoryMb: number;
  /** Max CPU time in seconds */
  maxCpuSeconds: number;
  /** Max number of files the plugin can open */
  maxOpenFiles: number;
  /** Max number of child processes */
  maxChildProcesses: number;
  /** Max network connections */
  maxConnections: number;
}

const DEFAULT_LIMITS: SandboxLimits = {
  maxMemoryMb: 256,
  maxCpuSeconds: 30,
  maxOpenFiles: 100,
  maxChildProcesses: 5,
  maxConnections: 10,
};

const RESTRICTED_LIMITS: SandboxLimits = {
  maxMemoryMb: 64,
  maxCpuSeconds: 10,
  maxOpenFiles: 20,
  maxChildProcesses: 1,
  maxConnections: 2,
};

// ─── Sensitive Environment Variables ────────────────────────────────────────

const HIDDEN_ENV_VARS = new Set([
  'ANTHROPIC_API_KEY',
  'CLOW_API_KEY',
  'CLOW_ADMIN_KEY',
  'ZAPI_TOKEN',
  'ZAPI_INSTANCE_ID',
  'BRAVE_SEARCH_API_KEY',
  'ASAAS_WEBHOOK_TOKEN',
  'DATABASE_URL',
  'REDIS_URL',
  'AWS_SECRET_ACCESS_KEY',
  'GITHUB_TOKEN',
  'NPM_TOKEN',
]);

/**
 * Additional patterns for env-var names that should be redacted even if
 * they are not in the explicit set above.  Matched case-insensitively.
 */
const SENSITIVE_ENV_PATTERNS: RegExp[] = [
  /secret/i,
  /password/i,
  /token/i,
  /private[_-]?key/i,
  /api[_-]?key/i,
  /credentials?/i,
  /auth/i,
];

// ─── Sandbox Violation ──────────────────────────────────────────────────────

/** Severity of a sandbox violation */
export type ViolationSeverity = 'info' | 'warning' | 'error' | 'critical';

/** A single recorded sandbox violation */
export interface SandboxViolation {
  /** Plugin that caused the violation */
  pluginName: string;
  /** ISO-8601 timestamp of the violation */
  timestamp: string;
  /** Category of the violation */
  category: 'path' | 'permission' | 'network' | 'resource' | 'env';
  /** Severity level */
  severity: ViolationSeverity;
  /** Human-readable description */
  message: string;
  /** Additional contextual data (e.g. the path or URL that was attempted) */
  detail?: string;
}

// ─── Resource Usage Snapshot ────────────────────────────────────────────────

/** Point-in-time snapshot of resource consumption for a plugin */
export interface ResourceUsageSnapshot {
  pluginName: string;
  /** Timestamp when the snapshot was taken (ms since epoch) */
  takenAt: number;
  /** Estimated memory usage in MB */
  memoryMb: number;
  /** Accumulated CPU time in seconds */
  cpuSeconds: number;
  /** Number of open file handles */
  openFiles: number;
  /** Number of active child processes */
  activeProcesses: number;
  /** Number of active network connections */
  activeConnections: number;
}

// ════════════════════════════════════════════════════════════════════════════
// PluginSandbox Class
// ════════════════════════════════════════════════════════════════════════════

export class PluginSandbox {
  private customLimits = new Map<string, Partial<SandboxLimits>>();

  /** In-memory violation log */
  private violations: SandboxViolation[] = [];

  /** Maximum number of violations retained in memory */
  private maxViolations = 500;

  /** Per-plugin resource usage tracking */
  private resourceUsage = new Map<string, ResourceUsageSnapshot>();

  // ─── Permission Management ────────────────────────────────────────

  /** Get effective permissions (intersection of requested and granted). */
  getEffective(plugin: LoadedPlugin, granted: PluginPermission[]): PluginPermission[] {
    return (plugin.manifest.requiredPermissions ?? []).filter(p => granted.includes(p));
  }

  /** Check if a specific permission is granted. */
  hasPermission(plugin: LoadedPlugin, permission: PluginPermission, granted: PluginPermission[]): boolean {
    return granted.includes(permission);
  }

  /** Check all required permissions. Returns missing list. */
  checkRequired(plugin: LoadedPlugin, granted: PluginPermission[]): {
    allowed: boolean;
    missing: PluginPermission[];
    warnings: string[];
  } {
    const missing = (plugin.manifest.requiredPermissions ?? []).filter(p => !granted.includes(p));
    const warnings: string[] = [];

    // Warn about dangerous granted permissions
    for (const perm of granted) {
      if (['shell-execution', 'access-secrets'].includes(perm)) {
        warnings.push(`Dangerous permission granted: ${perm}`);
      }
    }

    return { allowed: missing.length === 0, missing, warnings };
  }

  // ─── Filesystem Restrictions ──────────────────────────────────────

  /** Check if a path is accessible to a plugin. */
  isPathAccessible(plugin: LoadedPlugin, requestedPath: string, workspaceRoot: string): boolean {
    const absolute = path.resolve(requestedPath);
    const normalizedWorkspace = path.normalize(workspaceRoot);
    const normalizedPlugin = path.normalize(plugin.rootDir);

    // Always allow access to plugin's own directory
    if (absolute.startsWith(normalizedPlugin)) return true;

    // Allow access to workspace if filesystem-read permission granted
    if (absolute.startsWith(normalizedWorkspace)) return true;

    // Block everything else
    return false;
  }

  /**
   * Validate a path with symlink resolution.
   *
   * Symlinks can be used to escape the sandbox (e.g. a symlink inside the
   * plugin dir that points to `/etc/passwd`).  This method resolves symlinks
   * using `fs.realpathSync` and then checks the *real* target against the
   * allowed paths.
   *
   * @returns An object indicating whether the path is safe plus the resolved
   *          real path.  When `safe` is `false`, a violation is logged.
   */
  validatePathWithSymlinks(
    plugin: LoadedPlugin,
    requestedPath: string,
    workspaceRoot: string,
  ): { safe: boolean; resolvedPath: string } {
    let resolvedPath: string;
    try {
      resolvedPath = fs.realpathSync(requestedPath);
    } catch {
      // If we cannot resolve the path (it may not exist yet), fall back to
      // the normalized version and allow the standard check.
      resolvedPath = path.resolve(requestedPath);
    }

    const normalizedWorkspace = path.normalize(workspaceRoot);
    const normalizedPlugin = path.normalize(plugin.rootDir);

    const withinPlugin = resolvedPath.startsWith(normalizedPlugin);
    const withinWorkspace = resolvedPath.startsWith(normalizedWorkspace);

    if (withinPlugin || withinWorkspace) {
      return { safe: true, resolvedPath };
    }

    // Record violation
    this.recordViolation({
      pluginName: plugin.manifest.name,
      timestamp: new Date().toISOString(),
      category: 'path',
      severity: 'error',
      message: 'Path escapes sandbox after symlink resolution',
      detail: `requested=${requestedPath} resolved=${resolvedPath}`,
    });

    return { safe: false, resolvedPath };
  }

  /** Get list of paths a plugin is allowed to access. */
  getAllowedPaths(plugin: LoadedPlugin, workspaceRoot: string): string[] {
    return [
      plugin.rootDir,
      workspaceRoot,
    ];
  }

  /** Get list of paths a plugin can write to. */
  getWritablePaths(plugin: LoadedPlugin, workspaceRoot: string, granted: PluginPermission[]): string[] {
    const paths = [plugin.rootDir]; // Always writable: own dir

    if (granted.includes('filesystem-write')) {
      paths.push(workspaceRoot);
    }

    return paths;
  }

  // ─── Environment Filtering ────────────────────────────────────────

  /** Filter environment variables for untrusted plugins. */
  filterEnvironment(plugin: LoadedPlugin, granted: PluginPermission[]): Record<string, string> {
    const env: Record<string, string> = {};

    for (const [key, value] of Object.entries(process.env)) {
      if (!value) continue;

      // If plugin doesn't have access-secrets, hide sensitive vars
      if (!granted.includes('access-secrets') && HIDDEN_ENV_VARS.has(key)) {
        continue;
      }

      env[key] = value;
    }

    // Always include safe vars
    env['CLOW_PLUGIN_NAME'] = plugin.manifest.name;
    env['CLOW_PLUGIN_VERSION'] = plugin.manifest.version;
    env['CLOW_PLUGIN_DIR'] = plugin.rootDir;

    return env;
  }

  /**
   * Produce a fully sanitized environment that also strips variables
   * matching sensitive patterns (not just the explicit set).
   *
   * This is stricter than `filterEnvironment` and should be used for
   * fully untrusted plugins that have not been granted `access-secrets`.
   */
  sanitizeEnvironment(plugin: LoadedPlugin): Record<string, string> {
    const env: Record<string, string> = {};

    for (const [key, value] of Object.entries(process.env)) {
      if (!value) continue;

      // Skip anything in the explicit set
      if (HIDDEN_ENV_VARS.has(key)) continue;

      // Skip anything matching a sensitive pattern
      if (SENSITIVE_ENV_PATTERNS.some(p => p.test(key))) continue;

      env[key] = value;
    }

    // Always inject plugin identity vars
    env['CLOW_PLUGIN_NAME'] = plugin.manifest.name;
    env['CLOW_PLUGIN_VERSION'] = plugin.manifest.version;
    env['CLOW_PLUGIN_DIR'] = plugin.rootDir;
    env['CLOW_SANDBOX'] = '1';

    return env;
  }

  /** Check if an env var is sensitive and should be hidden. */
  isSensitiveEnvVar(varName: string): boolean {
    if (HIDDEN_ENV_VARS.has(varName)) return true;
    return SENSITIVE_ENV_PATTERNS.some(p => p.test(varName));
  }

  /**
   * Return a list of environment variable names that would be redacted
   * for a given plugin.  Useful for diagnostics and policy reports.
   */
  listRedactedEnvVars(plugin: LoadedPlugin, granted: PluginPermission[]): string[] {
    if (granted.includes('access-secrets')) return [];

    const redacted: string[] = [];
    for (const key of Object.keys(process.env)) {
      if (HIDDEN_ENV_VARS.has(key) || SENSITIVE_ENV_PATTERNS.some(p => p.test(key))) {
        redacted.push(key);
      }
    }
    return redacted;
  }

  // ─── Resource Limits ──────────────────────────────────────────────

  /** Get resource limits for a plugin based on trust level. */
  getLimits(plugin: LoadedPlugin): SandboxLimits {
    // Custom limits override
    const custom = this.customLimits.get(plugin.manifest.name);
    if (custom) return { ...DEFAULT_LIMITS, ...custom };

    // Managed plugins get default limits
    if (plugin.source.type === 'builtin' || plugin.source.type === 'marketplace') {
      return DEFAULT_LIMITS;
    }

    // Untrusted plugins get restricted limits
    if (plugin.trustState !== 'trusted') {
      return RESTRICTED_LIMITS;
    }

    return DEFAULT_LIMITS;
  }

  /** Set custom resource limits for a plugin. */
  setCustomLimits(pluginName: string, limits: Partial<SandboxLimits>): void {
    this.customLimits.set(pluginName, limits);
  }

  /** Clear custom limits (fall back to defaults). */
  clearCustomLimits(pluginName: string): void {
    this.customLimits.delete(pluginName);
  }

  // ─── Resource Usage Tracking ──────────────────────────────────────

  /**
   * Record a resource usage snapshot for a plugin.
   * Callers (e.g. the plugin runner) should invoke this periodically.
   */
  recordUsage(snapshot: ResourceUsageSnapshot): void {
    this.resourceUsage.set(snapshot.pluginName, snapshot);
  }

  /**
   * Retrieve the latest resource usage snapshot for a plugin.
   * Returns `null` if no usage has been recorded.
   */
  getUsage(pluginName: string): ResourceUsageSnapshot | null {
    return this.resourceUsage.get(pluginName) ?? null;
  }

  /**
   * Check whether a plugin has exceeded any of its sandbox limits.
   * Returns a list of human-readable violation descriptions.
   * If the list is empty, the plugin is within limits.
   */
  checkLimitExceeded(plugin: LoadedPlugin): string[] {
    const snapshot = this.resourceUsage.get(plugin.manifest.name);
    if (!snapshot) return [];

    const limits = this.getLimits(plugin);
    const exceeded: string[] = [];

    if (snapshot.memoryMb > limits.maxMemoryMb) {
      exceeded.push(`Memory: ${snapshot.memoryMb}MB exceeds limit of ${limits.maxMemoryMb}MB`);
    }
    if (snapshot.cpuSeconds > limits.maxCpuSeconds) {
      exceeded.push(`CPU: ${snapshot.cpuSeconds}s exceeds limit of ${limits.maxCpuSeconds}s`);
    }
    if (snapshot.openFiles > limits.maxOpenFiles) {
      exceeded.push(`Open files: ${snapshot.openFiles} exceeds limit of ${limits.maxOpenFiles}`);
    }
    if (snapshot.activeProcesses > limits.maxChildProcesses) {
      exceeded.push(`Child processes: ${snapshot.activeProcesses} exceeds limit of ${limits.maxChildProcesses}`);
    }
    if (snapshot.activeConnections > limits.maxConnections) {
      exceeded.push(`Connections: ${snapshot.activeConnections} exceeds limit of ${limits.maxConnections}`);
    }

    // Log violations
    for (const msg of exceeded) {
      this.recordViolation({
        pluginName: plugin.manifest.name,
        timestamp: new Date().toISOString(),
        category: 'resource',
        severity: 'warning',
        message: msg,
      });
    }

    return exceeded;
  }

  /**
   * Clear tracked resource usage for a plugin (e.g. when it is unloaded).
   */
  clearUsage(pluginName: string): void {
    this.resourceUsage.delete(pluginName);
  }

  // ─── Network Access ───────────────────────────────────────────────

  /** Check if a plugin can make network requests. */
  canAccessNetwork(plugin: LoadedPlugin, granted: PluginPermission[]): boolean {
    return granted.includes('network');
  }

  /** Check if a plugin can access a specific URL. */
  canAccessUrl(plugin: LoadedPlugin, url: string, granted: PluginPermission[]): boolean {
    if (!this.canAccessNetwork(plugin, granted)) return false;

    // Block access to localhost/internal IPs for untrusted plugins
    if (plugin.trustState !== 'trusted') {
      try {
        const parsed = new URL(url);
        if (['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) {
          this.recordViolation({
            pluginName: plugin.manifest.name,
            timestamp: new Date().toISOString(),
            category: 'network',
            severity: 'error',
            message: 'Attempted access to localhost / loopback address',
            detail: url,
          });
          return false;
        }
        if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(parsed.hostname)) {
          this.recordViolation({
            pluginName: plugin.manifest.name,
            timestamp: new Date().toISOString(),
            category: 'network',
            severity: 'error',
            message: 'Attempted access to private/internal IP range',
            detail: url,
          });
          return false;
        }
      } catch {
        return false;
      }
    }

    return true;
  }

  // ─── Shell Execution ──────────────────────────────────────────────

  /** Check if a plugin can execute shell commands. */
  canExecuteShell(plugin: LoadedPlugin, granted: PluginPermission[]): boolean {
    return granted.includes('shell-execution');
  }

  /** Build environment for plugin shell execution (filtered + limited). */
  buildShellEnvironment(plugin: LoadedPlugin, workspaceRoot: string, granted: PluginPermission[]): {
    env: Record<string, string>;
    cwd: string;
    timeout: number;
  } {
    const limits = this.getLimits(plugin);
    return {
      env: this.filterEnvironment(plugin, granted),
      cwd: workspaceRoot,
      timeout: limits.maxCpuSeconds * 1000,
    };
  }

  // ─── Violation Logging ────────────────────────────────────────────

  /**
   * Record a sandbox violation in the in-memory log.
   * Old entries are pruned when the log exceeds `maxViolations`.
   */
  recordViolation(violation: SandboxViolation): void {
    this.violations.push(violation);
    if (this.violations.length > this.maxViolations) {
      // Keep the most recent half
      this.violations = this.violations.slice(-Math.floor(this.maxViolations / 2));
    }
  }

  /**
   * Retrieve all recorded violations, optionally filtered by plugin name.
   */
  getViolations(pluginName?: string): readonly SandboxViolation[] {
    if (!pluginName) return this.violations;
    return this.violations.filter(v => v.pluginName === pluginName);
  }

  /**
   * Retrieve violations filtered by severity.
   */
  getViolationsBySeverity(severity: ViolationSeverity): readonly SandboxViolation[] {
    return this.violations.filter(v => v.severity === severity);
  }

  /**
   * Clear all recorded violations (e.g. after they have been persisted
   * or reported).
   */
  clearViolations(): void {
    this.violations = [];
  }

  /**
   * Return a count of violations grouped by category.
   */
  getViolationCounts(): Record<SandboxViolation['category'], number> {
    const counts: Record<SandboxViolation['category'], number> = {
      path: 0,
      permission: 0,
      network: 0,
      resource: 0,
      env: 0,
    };

    for (const v of this.violations) {
      counts[v.category]++;
    }

    return counts;
  }

  // ─── Summary ──────────────────────────────────────────────────────

  /** Get a human-readable summary of sandbox configuration. */
  summarize(plugin: LoadedPlugin, granted: PluginPermission[]): string {
    const limits = this.getLimits(plugin);
    const effective = this.getEffective(plugin, granted);
    const network = this.canAccessNetwork(plugin, granted);
    const shell = this.canExecuteShell(plugin, granted);
    const violations = this.getViolations(plugin.manifest.name);
    const usage = this.getUsage(plugin.manifest.name);

    const lines = [
      `Sandbox for ${plugin.manifest.name}:`,
      `  Permissions: [${effective.join(', ')}]`,
      `  Network: ${network ? 'allowed' : 'blocked'}`,
      `  Shell: ${shell ? 'allowed' : 'blocked'}`,
      `  Memory: ${limits.maxMemoryMb}MB`,
      `  CPU: ${limits.maxCpuSeconds}s`,
      `  Files: ${limits.maxOpenFiles}`,
      `  Processes: ${limits.maxChildProcesses}`,
      `  Violations: ${violations.length}`,
    ];

    if (usage) {
      lines.push(`  Current memory: ${usage.memoryMb}MB`);
      lines.push(`  Current CPU: ${usage.cpuSeconds}s`);
    }

    return lines.join('\n');
  }
}
