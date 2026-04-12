/**
 * HookTrust.ts — Workspace trust for hook execution
 *
 * Based on Claude Code's hookTrust.ts (~200 lines)
 *
 * Prevents malicious hooks from running when opening untrusted repositories.
 * A workspace must be explicitly trusted before its hooks can execute.
 *
 * Features:
 *   - Per-workspace trust tracking
 *   - Trust file persistence (~/.clow/trust/<hash>.json)
 *   - Trust with expiry (optional)
 *   - Revoke trust
 *   - List all trusted workspaces
 *   - Interactive trust prompt bypass (for CI/non-interactive)
 *   - Trust verification on every hook fire
 *   - Trust levels (full/limited/none)
 *   - Trust inheritance from parent workspaces
 *   - Trust audit log
 *   - Trust policy configuration
 *   - Auto-trust for CI environments
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Trust levels define what hooks are allowed to do */
type TrustLevel = 'full' | 'limited' | 'none';

interface TrustRecord {
  workspace: string;
  trusted: boolean;
  at: number;
  expiresAt?: number;
  trustedBy?: string;
  level: TrustLevel;
  parentWorkspace?: string;
  inheritedFrom?: string;
}

/** An entry in the trust audit log */
interface TrustAuditEntry {
  action: 'grant' | 'revoke' | 'deny' | 'inherit' | 'expire' | 'auto-trust' | 'policy-check';
  workspace: string;
  level: TrustLevel;
  at: number;
  reason?: string;
  actor?: string;
}

/** Policy that controls trust behavior */
interface TrustPolicy {
  /** Whether to auto-trust CI environments */
  autoTrustCI: boolean;
  /** Default trust level for auto-trusted workspaces */
  ciTrustLevel: TrustLevel;
  /** Whether child workspaces inherit parent trust */
  inheritParentTrust: boolean;
  /** Default expiry in ms for granted trust (0 = no expiry) */
  defaultExpiryMs: number;
  /** Maximum trust level that can be granted */
  maxTrustLevel: TrustLevel;
  /** Workspace path patterns to always trust */
  alwaysTrustPatterns: string[];
  /** Workspace path patterns to never trust */
  neverTrustPatterns: string[];
  /** Maximum number of audit log entries to retain */
  maxAuditEntries: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const TRUST_DIR = 'trust';
const AUDIT_FILE = 'trust-audit.jsonl';
const POLICY_FILE = 'trust-policy.json';

const DEFAULT_POLICY: TrustPolicy = {
  autoTrustCI: true,
  ciTrustLevel: 'limited',
  inheritParentTrust: true,
  defaultExpiryMs: 0,
  maxTrustLevel: 'full',
  alwaysTrustPatterns: [],
  neverTrustPatterns: [],
  maxAuditEntries: 1000,
};

const TRUST_LEVEL_HIERARCHY: Record<TrustLevel, number> = {
  none: 0,
  limited: 1,
  full: 2,
};

// ════════════════════════════════════════════════════════════════════════════
// HookTrust Class
// ════════════════════════════════════════════════════════════════════════════

export class HookTrust {
  private policy: TrustPolicy;
  private auditBuffer: TrustAuditEntry[] = [];
  private auditFlushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly clowHome: string = path.join(os.homedir(), '.clow')) {
    this.policy = { ...DEFAULT_POLICY };
  }

  /**
   * Check if hooks should be skipped due to trust.
   * Returns true if hooks should NOT run.
   */
  async shouldSkipDueToTrust(workspace: string, isInteractive: boolean): Promise<boolean> {
    // Check policy-based auto-trust for CI
    if (!isInteractive && this.policy.autoTrustCI) {
      await this.auditLog({
        action: 'auto-trust',
        workspace: path.resolve(workspace),
        level: this.policy.ciTrustLevel,
        at: Date.now(),
        reason: 'CI/non-interactive environment auto-trust',
      });
      return false;
    }

    // Non-interactive mode without auto-trust: skip hooks for safety
    if (!isInteractive) return true;

    // Check never-trust patterns
    const resolved = path.resolve(workspace);
    if (this.matchesPatterns(resolved, this.policy.neverTrustPatterns)) {
      await this.auditLog({
        action: 'deny',
        workspace: resolved,
        level: 'none',
        at: Date.now(),
        reason: 'Matched never-trust pattern',
      });
      return true;
    }

    // Check always-trust patterns
    if (this.matchesPatterns(resolved, this.policy.alwaysTrustPatterns)) {
      await this.auditLog({
        action: 'auto-trust',
        workspace: resolved,
        level: 'full',
        at: Date.now(),
        reason: 'Matched always-trust pattern',
      });
      return false;
    }

    return !(await this.isTrusted(workspace));
  }

  /**
   * Check if a workspace is trusted.
   */
  async isTrusted(workspace: string): Promise<boolean> {
    const level = await this.getTrustLevel(workspace);
    return level !== 'none';
  }

  /**
   * Get the trust level for a workspace.
   */
  async getTrustLevel(workspace: string): Promise<TrustLevel> {
    const resolved = path.resolve(workspace);

    // Direct trust check
    const directLevel = await this.getDirectTrustLevel(resolved);
    if (directLevel !== 'none') return directLevel;

    // Check inherited trust from parent
    if (this.policy.inheritParentTrust) {
      const inheritedLevel = await this.getInheritedTrustLevel(resolved);
      if (inheritedLevel !== 'none') {
        await this.auditLog({
          action: 'inherit',
          workspace: resolved,
          level: inheritedLevel,
          at: Date.now(),
          reason: 'Inherited from parent workspace',
        });
        return inheritedLevel;
      }
    }

    return 'none';
  }

  /**
   * Get trust level from the direct trust record for this workspace.
   */
  private async getDirectTrustLevel(resolvedWorkspace: string): Promise<TrustLevel> {
    const trustFile = this.trustFilePath(resolvedWorkspace);
    if (!fs.existsSync(trustFile)) return 'none';

    try {
      const data = JSON.parse(await fsp.readFile(trustFile, 'utf-8')) as TrustRecord;

      // Verify workspace path matches
      if (data.workspace !== resolvedWorkspace) return 'none';

      // Check expiry
      if (data.expiresAt && Date.now() > data.expiresAt) {
        await this.auditLog({
          action: 'expire',
          workspace: resolvedWorkspace,
          level: data.level ?? 'full',
          at: Date.now(),
          reason: 'Trust expired',
        });
        await this.revoke(resolvedWorkspace);
        return 'none';
      }

      if (data.trusted !== true) return 'none';

      return data.level ?? 'full';
    } catch {
      return 'none';
    }
  }

  /**
   * Check parent directories for inherited trust.
   */
  private async getInheritedTrustLevel(resolvedWorkspace: string): Promise<TrustLevel> {
    let current = path.dirname(resolvedWorkspace);
    const root = path.parse(resolvedWorkspace).root;

    // Walk up directory tree until root
    while (current !== root && current !== path.dirname(current)) {
      const level = await this.getDirectTrustLevel(current);
      if (level !== 'none') {
        // Inherited trust is capped at 'limited' for safety
        return level === 'full' ? 'limited' : level;
      }
      current = path.dirname(current);
    }

    return 'none';
  }

  /**
   * Trust a workspace.
   */
  async trust(
    workspace: string,
    options?: {
      expiresInMs?: number;
      trustedBy?: string;
      level?: TrustLevel;
    },
  ): Promise<void> {
    const resolved = path.resolve(workspace);
    const level = options?.level ?? 'full';

    // Enforce max trust level from policy
    const effectiveLevel = this.capTrustLevel(level);

    // Check never-trust patterns
    if (this.matchesPatterns(resolved, this.policy.neverTrustPatterns)) {
      await this.auditLog({
        action: 'deny',
        workspace: resolved,
        level: effectiveLevel,
        at: Date.now(),
        reason: 'Workspace matches never-trust pattern; trust denied',
        actor: options?.trustedBy,
      });
      return;
    }

    const trustFile = this.trustFilePath(resolved);
    await fsp.mkdir(path.dirname(trustFile), { recursive: true });

    const expiryMs = options?.expiresInMs ?? this.policy.defaultExpiryMs;

    const record: TrustRecord = {
      workspace: resolved,
      trusted: true,
      at: Date.now(),
      expiresAt: expiryMs > 0 ? Date.now() + expiryMs : undefined,
      trustedBy: options?.trustedBy,
      level: effectiveLevel,
    };

    await fsp.writeFile(trustFile, JSON.stringify(record, null, 2));

    await this.auditLog({
      action: 'grant',
      workspace: resolved,
      level: effectiveLevel,
      at: Date.now(),
      reason: `Trust granted${expiryMs > 0 ? ` (expires in ${Math.round(expiryMs / 60000)}m)` : ''}`,
      actor: options?.trustedBy,
    });
  }

  /**
   * Revoke trust for a workspace.
   */
  async revoke(workspace: string): Promise<void> {
    const resolved = path.resolve(workspace);
    const trustFile = this.trustFilePath(resolved);

    try {
      await fsp.unlink(trustFile);
    } catch { /* ignore */ }

    await this.auditLog({
      action: 'revoke',
      workspace: resolved,
      level: 'none',
      at: Date.now(),
      reason: 'Trust revoked',
    });
  }

  /**
   * List all trusted workspaces.
   */
  async listTrusted(): Promise<TrustRecord[]> {
    const trustDir = path.join(this.clowHome, TRUST_DIR);
    if (!fs.existsSync(trustDir)) return [];

    const records: TrustRecord[] = [];

    try {
      const files = await fsp.readdir(trustDir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const content = await fsp.readFile(path.join(trustDir, file), 'utf-8');
          const record = JSON.parse(content) as TrustRecord;
          if (record.trusted) records.push(record);
        } catch {}
      }
    } catch {}

    return records.sort((a, b) => b.at - a.at);
  }

  /**
   * List trusted workspaces filtered by trust level.
   */
  async listByLevel(level: TrustLevel): Promise<TrustRecord[]> {
    const all = await this.listTrusted();
    return all.filter(r => (r.level ?? 'full') === level);
  }

  /**
   * Revoke all trust.
   */
  async revokeAll(): Promise<number> {
    const trustDir = path.join(this.clowHome, TRUST_DIR);
    if (!fs.existsSync(trustDir)) return 0;

    let count = 0;
    try {
      const files = await fsp.readdir(trustDir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try { await fsp.unlink(path.join(trustDir, file)); count++; } catch {}
      }
    } catch {}

    await this.auditLog({
      action: 'revoke',
      workspace: '*',
      level: 'none',
      at: Date.now(),
      reason: `Revoked all trust (${count} workspaces)`,
    });

    return count;
  }

  /**
   * Revoke expired trust records.
   */
  async revokeExpired(): Promise<number> {
    const all = await this.listTrusted();
    let count = 0;

    for (const record of all) {
      if (record.expiresAt && Date.now() > record.expiresAt) {
        await this.revoke(record.workspace);
        count++;
      }
    }

    return count;
  }

  // ─── Trust Policy ───────────────────────────────────────────────

  /**
   * Load trust policy from disk.
   */
  async loadPolicy(): Promise<TrustPolicy> {
    const policyPath = path.join(this.clowHome, POLICY_FILE);

    if (!fs.existsSync(policyPath)) {
      this.policy = { ...DEFAULT_POLICY };
      return this.policy;
    }

    try {
      const content = await fsp.readFile(policyPath, 'utf-8');
      const loaded = JSON.parse(content) as Partial<TrustPolicy>;
      this.policy = { ...DEFAULT_POLICY, ...loaded };
    } catch {
      this.policy = { ...DEFAULT_POLICY };
    }

    return this.policy;
  }

  /**
   * Save trust policy to disk.
   */
  async savePolicy(policy: Partial<TrustPolicy>): Promise<void> {
    this.policy = { ...this.policy, ...policy };
    const policyPath = path.join(this.clowHome, POLICY_FILE);
    await fsp.mkdir(path.dirname(policyPath), { recursive: true });
    await fsp.writeFile(policyPath, JSON.stringify(this.policy, null, 2));
  }

  /**
   * Get the current trust policy.
   */
  getPolicy(): Readonly<TrustPolicy> {
    return { ...this.policy };
  }

  /**
   * Update specific policy fields.
   */
  async updatePolicy(updates: Partial<TrustPolicy>): Promise<void> {
    await this.savePolicy(updates);
  }

  // ─── Trust Audit Log ────────────────────────────────────────────

  /**
   * Get recent audit log entries.
   */
  async getAuditLog(limit: number = 50): Promise<TrustAuditEntry[]> {
    const auditPath = path.join(this.clowHome, AUDIT_FILE);
    if (!fs.existsSync(auditPath)) return [];

    try {
      const content = await fsp.readFile(auditPath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());
      const entries: TrustAuditEntry[] = [];

      for (const line of lines) {
        try {
          entries.push(JSON.parse(line) as TrustAuditEntry);
        } catch { /* skip malformed lines */ }
      }

      // Return most recent entries
      return entries.slice(-limit);
    } catch {
      return [];
    }
  }

  /**
   * Get audit log entries for a specific workspace.
   */
  async getWorkspaceAuditLog(workspace: string, limit: number = 20): Promise<TrustAuditEntry[]> {
    const resolved = path.resolve(workspace);
    const all = await this.getAuditLog(500);
    return all.filter(e => e.workspace === resolved).slice(-limit);
  }

  /**
   * Clear the audit log.
   */
  async clearAuditLog(): Promise<void> {
    const auditPath = path.join(this.clowHome, AUDIT_FILE);
    try { await fsp.unlink(auditPath); } catch { /* ignore */ }
    this.auditBuffer = [];
  }

  private async auditLog(entry: TrustAuditEntry): Promise<void> {
    this.auditBuffer.push(entry);

    // Debounced flush
    if (this.auditFlushTimer) clearTimeout(this.auditFlushTimer);
    this.auditFlushTimer = setTimeout(() => {
      this.flushAuditLog().catch(() => { /* ignore */ });
    }, 500);
  }

  private async flushAuditLog(): Promise<void> {
    if (this.auditBuffer.length === 0) return;

    const auditPath = path.join(this.clowHome, AUDIT_FILE);
    await fsp.mkdir(path.dirname(auditPath), { recursive: true });

    const lines = this.auditBuffer.map(e => JSON.stringify(e)).join('\n') + '\n';
    this.auditBuffer = [];

    try {
      await fsp.appendFile(auditPath, lines);

      // Trim audit log if too large
      const stat = await fsp.stat(auditPath);
      if (stat.size > 1_000_000) { // 1MB
        const content = await fsp.readFile(auditPath, 'utf-8');
        const allLines = content.split('\n').filter(l => l.trim());
        const trimmed = allLines.slice(-this.policy.maxAuditEntries);
        await fsp.writeFile(auditPath, trimmed.join('\n') + '\n');
      }
    } catch { /* ignore write errors */ }
  }

  // ─── Auto-Trust for CI ──────────────────────────────────────────

  /**
   * Check if the current environment is a CI environment.
   */
  static isCI(): boolean {
    return !!(
      process.env.CI ||
      process.env.CONTINUOUS_INTEGRATION ||
      process.env.GITHUB_ACTIONS ||
      process.env.GITLAB_CI ||
      process.env.JENKINS_URL ||
      process.env.CIRCLECI ||
      process.env.TRAVIS ||
      process.env.BUILDKITE ||
      process.env.CODEBUILD_BUILD_ID ||
      process.env.TF_BUILD
    );
  }

  /**
   * Auto-trust the given workspace if running in CI.
   * Returns true if trust was auto-granted.
   */
  async autoTrustIfCI(workspace: string): Promise<boolean> {
    if (!HookTrust.isCI()) return false;
    if (!this.policy.autoTrustCI) return false;

    const resolved = path.resolve(workspace);

    // Check if already trusted
    if (await this.isTrusted(resolved)) return true;

    // Auto-trust with CI level
    await this.trust(resolved, {
      level: this.policy.ciTrustLevel,
      trustedBy: 'ci-auto-trust',
      expiresInMs: 24 * 60 * 60 * 1000, // 24 hours for CI
    });

    return true;
  }

  // ─── Internal ────────────────────────────────────────────────────

  private trustFilePath(workspace: string): string {
    const resolved = path.resolve(workspace);
    const hash = crypto.createHash('sha256')
      .update(resolved)
      .digest('hex').slice(0, 16);
    return path.join(this.clowHome, TRUST_DIR, `${hash}.json`);
  }

  /**
   * Cap trust level to the policy maximum.
   */
  private capTrustLevel(requested: TrustLevel): TrustLevel {
    const maxRank = TRUST_LEVEL_HIERARCHY[this.policy.maxTrustLevel];
    const requestedRank = TRUST_LEVEL_HIERARCHY[requested];

    if (requestedRank <= maxRank) return requested;
    return this.policy.maxTrustLevel;
  }

  /**
   * Check if a workspace path matches any of the given glob-like patterns.
   * Simple pattern matching: supports * as wildcard.
   */
  private matchesPatterns(workspacePath: string, patterns: string[]): boolean {
    for (const pattern of patterns) {
      if (this.simpleMatch(pattern, workspacePath)) return true;
    }
    return false;
  }

  /**
   * Simple glob matching (supports * as wildcard for any characters).
   */
  private simpleMatch(pattern: string, str: string): boolean {
    // Normalize path separators
    const normPattern = pattern.replace(/\\/g, '/');
    const normStr = str.replace(/\\/g, '/');

    // Convert simple glob to regex
    const escaped = normPattern
      .replace(/[.+^${}()|[\]]/g, '\\$&')
      .replace(/\*/g, '.*');
    const re = new RegExp(`^${escaped}$`, 'i');
    return re.test(normStr);
  }
}
