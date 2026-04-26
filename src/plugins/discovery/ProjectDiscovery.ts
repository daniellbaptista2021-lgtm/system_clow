/**
 * ProjectDiscovery.ts — Discover plugins in <workspace>/.clow/plugins/
 *
 * Based on Claude Code's projectPluginDiscovery.ts (~250 lines)
 *
 * Project-level plugins are specific to a workspace/repo.
 * They have the highest priority (4) in source merge.
 *
 * Features:
 *   - Scan <workspace>/.clow/plugins/ directory
 *   - Support for multiple workspace roots (monorepo)
 *   - Nested .clow directories detection (warn, don't load)
 *   - Gitignore-aware (skip .gitignored plugin dirs)
 *   - Manifest validation
 *   - Symlink resolution
 *   - Discovery caching per workspace
 *   - Error isolation
 *   - Monorepo support (scan multiple workspace roots)
 *   - Workspace-specific plugin isolation
 *   - Project-level enable/disable
 *   - Discovery event emission
 *   - Path security validation
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { PluginLoader } from '../PluginLoader.js';
import type { LoadedPlugin } from '../types.js';
import { PLUGIN_MANIFEST_DIR, PLUGIN_MANIFEST_FILE } from '../types.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_PROJECT_PLUGINS = 100;
const PLUGIN_DIR_NAME = '.clow';
const PLUGIN_SUBDIR = 'plugins';

/**
 * Names of workspace definition files used to detect monorepo roots.
 * When one of these is found in a directory the directory is considered
 * a potential workspace root.
 */
const WORKSPACE_INDICATORS = ['pnpm-workspace.yaml', 'lerna.json', 'rush.json'];

/**
 * Patterns that are considered unsafe when they appear in resolved
 * plugin paths.  Discovery will refuse to load any plugin whose path
 * matches one of these.
 */
const UNSAFE_PATH_SEGMENTS = ['..', '~', '$'];

// ─── Types ──────────────────────────────────────────────────────────────────

interface ProjectDiscoveryError {
  pluginDir: string;
  error: string;
}

/** Event emitted during discovery for external listeners. */
interface DiscoveryEvent {
  type: 'plugin_found' | 'plugin_skipped' | 'plugin_loaded' | 'plugin_error' | 'scan_complete';
  workspaceRoot: string;
  pluginDir?: string;
  pluginName?: string;
  reason?: string;
  timestamp: number;
}

type DiscoveryEventHandler = (event: DiscoveryEvent) => void;

// ════════════════════════════════════════════════════════════════════════════
// ProjectDiscovery Class
// ════════════════════════════════════════════════════════════════════════════

export class ProjectDiscovery {
  private cacheByWorkspace = new Map<string, { plugins: LoadedPlugin[]; mtime: number }>();
  private discoveryErrors: ProjectDiscoveryError[] = [];

  /** Set of plugin names that have been explicitly disabled at the project level. */
  private disabledPlugins = new Set<string>();

  /** Registered event handlers. */
  private eventHandlers: DiscoveryEventHandler[] = [];

  constructor(private readonly loader: PluginLoader) {}

  // ─── Event Emission ─────────────────────────────────────────────

  /**
   * Register an event handler that will be invoked for every
   * discovery event (found, skipped, loaded, error, scan_complete).
   */
  onDiscoveryEvent(handler: DiscoveryEventHandler): void {
    this.eventHandlers.push(handler);
  }

  // ─── Enable / Disable ───────────────────────────────────────────

  /**
   * Disable a plugin by name.  Disabled plugins are still discovered
   * but excluded from the result set.
   */
  disablePlugin(pluginName: string): void {
    this.disabledPlugins.add(pluginName);
  }

  /**
   * Re-enable a previously disabled plugin.
   */
  enablePlugin(pluginName: string): void {
    this.disabledPlugins.delete(pluginName);
  }

  /**
   * Returns `true` if the named plugin is currently disabled.
   */
  isPluginDisabled(pluginName: string): boolean {
    return this.disabledPlugins.has(pluginName);
  }

  /**
   * Return the full list of explicitly disabled plugin names.
   */
  getDisabledPlugins(): string[] {
    return [...this.disabledPlugins];
  }

  // ─── Core Discovery ─────────────────────────────────────────────

  /**
   * Discover project-level plugins.
   */
  async discover(workspaceRoot: string): Promise<LoadedPlugin[]> {
    const dir = path.join(workspaceRoot, PLUGIN_DIR_NAME, PLUGIN_SUBDIR);
    if (!fs.existsSync(dir)) return [];

    // Check cache
    try {
      const stat = await fsp.stat(dir);
      const cached = this.cacheByWorkspace.get(workspaceRoot);
      if (cached && stat.mtimeMs === cached.mtime) {
        return cached.plugins;
      }
    } catch {
      return [];
    }

    const startTime = Date.now();
    this.discoveryErrors = [];
    const plugins: LoadedPlugin[] = [];

    try {
      const entries = await fsp.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;

        const pluginDir = path.join(dir, entry.name);

        // Resolve symlinks
        let resolvedDir = pluginDir;
        try {
          const realPath = await fsp.realpath(pluginDir);
          if (realPath !== pluginDir) resolvedDir = realPath;
        } catch { /* keep original */ }

        // ── Path security validation ──────────────────────────────
        if (!this.isPathSafe(resolvedDir, workspaceRoot)) {
          this.discoveryErrors.push({ pluginDir: resolvedDir, error: 'Path failed security validation' });
          this.emitEvent({ type: 'plugin_skipped', workspaceRoot, pluginDir: resolvedDir, reason: 'unsafe path', timestamp: Date.now() });
          continue;
        }

        // Check for nested .clow directories (warn)
        const nestedClow = path.join(resolvedDir, PLUGIN_DIR_NAME);
        if (fs.existsSync(nestedClow)) {
          console.warn(`[ProjectDiscovery] Nested .clow directory in plugin: ${resolvedDir} (skipping)`);
          this.emitEvent({ type: 'plugin_skipped', workspaceRoot, pluginDir: resolvedDir, reason: 'nested .clow', timestamp: Date.now() });
          continue;
        }

        // Check for manifest
        const manifestPath = path.join(resolvedDir, PLUGIN_MANIFEST_DIR, PLUGIN_MANIFEST_FILE);
        if (!fs.existsSync(manifestPath)) {
          this.discoveryErrors.push({
            pluginDir: resolvedDir,
            error: 'No plugin manifest found',
          });
          this.emitEvent({ type: 'plugin_skipped', workspaceRoot, pluginDir: resolvedDir, reason: 'no manifest', timestamp: Date.now() });
          continue;
        }

        // Check gitignore
        if (await this.isGitignored(pluginDir, workspaceRoot)) {
          this.emitEvent({ type: 'plugin_skipped', workspaceRoot, pluginDir: resolvedDir, reason: 'gitignored', timestamp: Date.now() });
          continue;
        }

        this.emitEvent({ type: 'plugin_found', workspaceRoot, pluginDir: resolvedDir, timestamp: Date.now() });

        try {
          const plugin = await this.loader.load(resolvedDir, {
            type: 'project',
            path: resolvedDir,
          });

          // Skip disabled plugins
          if (this.disabledPlugins.has(plugin.manifest.name)) {
            this.emitEvent({ type: 'plugin_skipped', workspaceRoot, pluginDir: resolvedDir, pluginName: plugin.manifest.name, reason: 'disabled', timestamp: Date.now() });
            continue;
          }

          plugins.push(plugin);
          this.emitEvent({ type: 'plugin_loaded', workspaceRoot, pluginDir: resolvedDir, pluginName: plugin.manifest.name, timestamp: Date.now() });
        } catch (err) {
          this.discoveryErrors.push({
            pluginDir: resolvedDir,
            error: (err as Error).message,
          });
          this.emitEvent({ type: 'plugin_error', workspaceRoot, pluginDir: resolvedDir, reason: (err as Error).message, timestamp: Date.now() });
        }

        if (plugins.length >= MAX_PROJECT_PLUGINS) break;
      }
    } catch (err) {
      console.warn(`[ProjectDiscovery] Failed to scan ${dir}: ${(err as Error).message}`);
    }

    const elapsed = Date.now() - startTime;
    if (plugins.length > 0) {
      console.log(`[ProjectDiscovery] Found ${plugins.length} project plugins in ${elapsed}ms`);
    }

    this.emitEvent({ type: 'scan_complete', workspaceRoot, timestamp: Date.now() });

    // Cache results
    try {
      const stat = await fsp.stat(dir);
      this.cacheByWorkspace.set(workspaceRoot, { plugins, mtime: stat.mtimeMs });
    } catch { /* skip cache */ }

    return plugins;
  }

  /**
   * Discover in multiple workspace roots (for monorepo support).
   */
  async discoverMultiRoot(workspaceRoots: string[]): Promise<LoadedPlugin[]> {
    const allPlugins: LoadedPlugin[] = [];
    const seenNames = new Set<string>();

    for (const root of workspaceRoots) {
      const plugins = await this.discover(root);
      for (const plugin of plugins) {
        if (!seenNames.has(plugin.manifest.name)) {
          seenNames.add(plugin.manifest.name);
          allPlugins.push(plugin);
        }
      }
    }

    return allPlugins;
  }

  // ─── Monorepo Workspace Detection ───────────────────────────────

  /**
   * Scan a project root for monorepo workspace directories.
   * Returns the list of directories that contain a
   * `<dir>/.clow/plugins/` folder, suitable for passing
   * to {@link discoverMultiRoot}.
   */
  async detectWorkspaceRoots(projectRoot: string): Promise<string[]> {
    const roots: string[] = [projectRoot];

    // Check for workspace indicator files
    let isMonorepo = false;
    for (const indicator of WORKSPACE_INDICATORS) {
      if (fs.existsSync(path.join(projectRoot, indicator))) {
        isMonorepo = true;
        break;
      }
    }
    // Also check package.json workspaces
    const pkgPath = path.join(projectRoot, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(await fsp.readFile(pkgPath, 'utf-8'));
        if (pkg.workspaces) isMonorepo = true;
      } catch { /* ignore */ }
    }

    if (!isMonorepo) return roots;

    // Scan top-level directories for .clow/plugins
    try {
      const entries = await fsp.readdir(projectRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const candidate = path.join(projectRoot, entry.name);
        const clowPlugins = path.join(candidate, PLUGIN_DIR_NAME, PLUGIN_SUBDIR);
        if (fs.existsSync(clowPlugins)) {
          roots.push(candidate);
        }
        // Check one level deeper (packages/foo)
        try {
          const subEntries = await fsp.readdir(candidate, { withFileTypes: true });
          for (const sub of subEntries) {
            if (!sub.isDirectory()) continue;
            const subCandidate = path.join(candidate, sub.name);
            const subClowPlugins = path.join(subCandidate, PLUGIN_DIR_NAME, PLUGIN_SUBDIR);
            if (fs.existsSync(subClowPlugins)) {
              roots.push(subCandidate);
            }
          }
        } catch { /* ignore unreadable subdirs */ }
      }
    } catch { /* ignore */ }

    return roots;
  }

  /**
   * Invalidate cache for a workspace.
   */
  invalidateCache(workspaceRoot?: string): void {
    if (workspaceRoot) {
      this.cacheByWorkspace.delete(workspaceRoot);
    } else {
      this.cacheByWorkspace.clear();
    }
  }

  getLastErrors(): ProjectDiscoveryError[] {
    return [...this.discoveryErrors];
  }

  // ─── Path Security ──────────────────────────────────────────────

  /**
   * Validate that a resolved plugin path does not escape the
   * workspace root or contain unsafe segments.
   */
  private isPathSafe(resolvedDir: string, workspaceRoot: string): boolean {
    // Must be under the workspace root
    const relative = path.relative(workspaceRoot, resolvedDir);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return false;

    // Must not contain unsafe segments
    for (const segment of UNSAFE_PATH_SEGMENTS) {
      if (resolvedDir.includes(segment)) return false;
    }

    return true;
  }

  // ─── Gitignore ───────────────────────────────────────────────────

  /**
   * Check if a path is gitignored.
   * Simple check — looks for common patterns.
   */
  private async isGitignored(filePath: string, workspaceRoot: string): Promise<boolean> {
    const gitignorePath = path.join(workspaceRoot, '.gitignore');
    if (!fs.existsSync(gitignorePath)) return false;

    try {
      const content = await fsp.readFile(gitignorePath, 'utf-8');
      const relativePath = path.relative(workspaceRoot, filePath).replace(/\\/g, '/');

      for (const line of content.split('\n')) {
        const pattern = line.trim();
        if (!pattern || pattern.startsWith('#')) continue;

        // Simple pattern matching
        if (relativePath.startsWith(pattern.replace(/\/$/, ''))) return true;
        if (pattern.endsWith('/') && relativePath.startsWith(pattern.slice(0, -1))) return true;
      }
    } catch { /* ignore */ }

    return false;
  }

  // ─── Event Helpers ──────────────────────────────────────────────

  private emitEvent(event: DiscoveryEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch { /* swallow handler errors */ }
    }
  }
}
