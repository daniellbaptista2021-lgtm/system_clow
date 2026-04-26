/**
 * PermissionContext.ts — Permission state that travels with every check
 * Propagated through query loop, sub-agents, hooks.
 * Session-scoped rules live here (die with session).
 */

import { randomUUID } from 'crypto';
import stringify from 'json-stable-stringify';
import * as crypto from 'crypto';
import type {
  PermissionMode,
  PermissionRule,
  PermissionSource,
  PermissionAuditEntry,
} from './types.js';

export interface PermissionContextSnapshot {
  mode: PermissionMode;
  sessionRules: PermissionRule[];
  timestamp: number;
}

export class PermissionContext {
  private sessionRules: PermissionRule[] = [];
  private deniedThisTurn: Set<string> = new Set();
  private auditLog: PermissionAuditEntry[] = [];
  private prePlanMode: PermissionMode | undefined;

  constructor(
    public readonly sessionId: string,
    public readonly tenantId: string | undefined,
    public readonly workspaceRoot: string,
    private _mode: PermissionMode,
    public readonly tier: string | undefined,
    public readonly isInteractive: boolean,
    public readonly parentContext?: PermissionContext,
    public readonly agentDepth: number = 0,
  ) {}

  // ─── Mode ───────────────────────────────────────────────────────────

  getMode(): PermissionMode { return this._mode; }

  setMode(mode: PermissionMode, _source: PermissionSource): void {
    if (mode === 'plan') {
      this.prePlanMode = this._mode;
    }
    this._mode = mode;
  }

  restorePrePlanMode(): void {
    if (this.prePlanMode) {
      this._mode = this.prePlanMode;
      this.prePlanMode = undefined;
    } else {
      this._mode = 'default';
    }
  }

  getPrePlanMode(): PermissionMode | undefined { return this.prePlanMode; }

  // ─── Session Rules ──────────────────────────────────────────────────

  addSessionRule(rule: PermissionRule): void {
    // Dedup: remove existing rule with same tool+pattern
    this.sessionRules = this.sessionRules.filter(
      (r) => !(r.toolName === rule.toolName && r.pattern === rule.pattern),
    );
    this.sessionRules.push(rule);
  }

  removeSessionRule(ruleId: string): void {
    this.sessionRules = this.sessionRules.filter((r) => r.id !== ruleId);
  }

  getSessionRules(): readonly PermissionRule[] {
    return this.sessionRules;
  }

  clearSessionRules(): void {
    this.sessionRules = [];
  }

  // ─── Denial Tracking ────────────────────────────────────────────────

  markDenied(toolName: string, input: unknown): void {
    this.deniedThisTurn.add(this.hashCall(toolName, input));
  }

  wasDeniedThisTurn(toolName: string, input: unknown): boolean {
    return this.deniedThisTurn.has(this.hashCall(toolName, input));
  }

  resetTurnState(): void {
    this.deniedThisTurn.clear();
  }

  private hashCall(toolName: string, input: unknown): string {
    const normalized = stringify(input) || '';
    return crypto.createHash('sha256')
      .update(`${toolName}|${normalized}`)
      .digest('hex')
      .slice(0, 16);
  }

  // ─── Sub-Agent Inheritance ──────────────────────────────────────────

  forkForSubagent(restrictMode?: PermissionMode): PermissionContext {
    const childMode = restrictMode || this._mode;
    const child = new PermissionContext(
      this.sessionId,
      this.tenantId,
      this.workspaceRoot,
      childMode,
      this.tier,
      false, // sub-agents are non-interactive (delegate to parent)
      this, // parent reference
      this.agentDepth + 1,
    );
    // Inherit session rules (read-only copy — child can't modify parent's)
    for (const rule of this.sessionRules) {
      child.addSessionRule({ ...rule });
    }
    return child;
  }

  // ─── Snapshot / Restore ─────────────────────────────────────────────

  snapshot(): PermissionContextSnapshot {
    return {
      mode: this._mode,
      sessionRules: this.sessionRules.map((r) => ({ ...r })),
      timestamp: Date.now(),
    };
  }

  restore(snap: PermissionContextSnapshot): void {
    this._mode = snap.mode;
    this.sessionRules = snap.sessionRules.map((r) => ({ ...r }));
  }

  // ─── Audit Log ──────────────────────────────────────────────────────

  recordDecision(entry: PermissionAuditEntry): void {
    this.auditLog.push(entry);
    // Keep last 1000 entries
    if (this.auditLog.length > 1000) {
      this.auditLog = this.auditLog.slice(-500);
    }
  }

  getAuditLog(): readonly PermissionAuditEntry[] {
    return this.auditLog;
  }

  getAuditLogSize(): number {
    return this.auditLog.length;
  }
}
