/**
 * PermissionStorage.ts — Persisted permission rules (user / workspace / tier)
 * Atomic writes via lockfile + temp + rename to prevent corruption.
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as lockfile from 'proper-lockfile';
import type { PermissionRule, PermissionScope } from './types.js';
import type { PermissionContext } from './PermissionContext.js';
import { TIERS, type TierName } from '../../tenancy/tiers.js';

const CLOW_HOME = path.join(os.homedir(), '.clow');
const PERMISSIONS_DIR = path.join(CLOW_HOME, 'permissions');

function sanitizeHash(p: string): string {
  let h = 0;
  for (let i = 0; i < p.length; i++) h = ((h << 5) - h + p.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

export class PermissionStorage {
  // ─── User Rules (global) ────────────────────────────────────────────

  async loadUserRules(): Promise<PermissionRule[]> {
    return this.loadJson(path.join(PERMISSIONS_DIR, 'user.json'));
  }

  async saveUserRules(rules: PermissionRule[]): Promise<void> {
    await this.atomicWrite(path.join(PERMISSIONS_DIR, 'user.json'), rules);
  }

  async addUserRule(rule: PermissionRule): Promise<void> {
    const rules = await this.loadUserRules();
    rules.push(rule);
    await this.saveUserRules(rules);
  }

  async removeUserRule(ruleId: string): Promise<void> {
    const rules = await this.loadUserRules();
    await this.saveUserRules(rules.filter((r) => r.id !== ruleId));
  }

  // ─── Workspace Rules (per project) ──────────────────────────────────

  private workspacePath(workspaceRoot: string): string {
    return path.join(PERMISSIONS_DIR, 'workspaces', `${sanitizeHash(workspaceRoot)}.json`);
  }

  async loadWorkspaceRules(workspaceRoot: string): Promise<PermissionRule[]> {
    return this.loadJson(this.workspacePath(workspaceRoot));
  }

  async saveWorkspaceRules(workspaceRoot: string, rules: PermissionRule[]): Promise<void> {
    await this.atomicWrite(this.workspacePath(workspaceRoot), rules);
  }

  async addWorkspaceRule(workspaceRoot: string, rule: PermissionRule): Promise<void> {
    const rules = await this.loadWorkspaceRules(workspaceRoot);
    rules.push(rule);
    await this.saveWorkspaceRules(workspaceRoot, rules);
  }

  // ─── Tier Defaults ──────────────────────────────────────────────────

  loadTierRules(tier: string): PermissionRule[] {
    // Tier ONE: no agent, no plan mode
    const tierConfig = TIERS[tier as TierName];
    if (!tierConfig) return [];

    const rules: PermissionRule[] = [];

    if (!tierConfig.features.includes('agent_tool')) {
      rules.push({
        id: `tier-deny-agent-${tier}`,
        toolName: 'Agent',
        decision: 'deny',
        scope: 'tier',
        source: 'tier',
        createdAt: 0,
        reason: `Agent tool not available in ${tier} tier`,
      });
    }
    if (!tierConfig.features.includes('plan_mode')) {
      rules.push({
        id: `tier-deny-planmode-${tier}`,
        toolName: 'EnterPlanMode',
        decision: 'deny',
        scope: 'tier',
        source: 'tier',
        createdAt: 0,
        reason: `Plan mode not available in ${tier} tier`,
      });
    }

    return rules;
  }

  // ─── Aggregate All ──────────────────────────────────────────────────

  async loadAllForContext(ctx: PermissionContext): Promise<PermissionRule[]> {
    const [user, workspace] = await Promise.all([
      this.loadUserRules(),
      this.loadWorkspaceRules(ctx.workspaceRoot),
    ]);
    const tier = ctx.tier ? this.loadTierRules(ctx.tier) : [];
    const session = [...ctx.getSessionRules()];

    // Order: tier (lowest) → user → workspace → session (highest)
    return [...tier, ...user, ...workspace, ...session];
  }

  // ─── Atomic Write (lockfile + temp + rename) ────────────────────────

  private async atomicWrite(filePath: string, data: PermissionRule[]): Promise<void> {
    const dir = path.dirname(filePath);
    await fsp.mkdir(dir, { recursive: true });

    const tmpPath = filePath + '.tmp.' + Date.now();
    const json = JSON.stringify(data, null, 2);

    try {
      // Write to temp file
      await fsp.writeFile(tmpPath, json, { mode: 0o600 });

      // Acquire lock
      let release: (() => Promise<void>) | undefined;
      try {
        release = await lockfile.lock(filePath, {
          retries: { retries: 5, minTimeout: 50, maxTimeout: 500 },
          lockfilePath: filePath + '.lock',
        });
      } catch {
        // Lock failed — proceed without (best effort)
      }

      // Rename (atomic on most filesystems)
      await fsp.rename(tmpPath, filePath);

      if (release) await release();
    } catch (err) {
      // Cleanup temp file
      try { await fsp.unlink(tmpPath); } catch {}
      throw err;
    }
  }

  // ─── Read JSON ────────────────────────────────────────────────────

  private async loadJson(filePath: string): Promise<PermissionRule[]> {
    try {
      const raw = await fsp.readFile(filePath, 'utf-8');
      const data = JSON.parse(raw);
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }
}
