/**
 * types.ts — Permission system vocabulary
 * Every type in the permission system is defined here. No ambiguity.
 */

// ─── Core Enums ─────────────────────────────────────────────────────────────

export type PermissionDecision = 'allow' | 'deny' | 'ask';
export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'dontAsk' | 'auto' | 'plan';
export type PermissionScope = 'session' | 'workspace' | 'user' | 'tier';
export type PermissionSource = 'user' | 'rule' | 'mode' | 'tool' | 'hook' | 'classifier' | 'tier';

// ─── Rule ───────────────────────────────────────────────────────────────────

export interface PermissionRule {
  id: string;
  toolName: string;        // 'Bash', 'FileWrite', '*'
  pattern?: string;        // 'git *', '*.test.ts'
  decision: PermissionDecision;
  scope: PermissionScope;
  source: PermissionSource;
  createdAt: number;
  expiresAt?: number;
  reason?: string;
  metadata?: Record<string, unknown>;
}

// ─── Decision Reason ────────────────────────────────────────────────────────

export interface PermissionDecisionReason {
  type: PermissionSource;
  ruleId?: string;
  pattern?: string;
  message: string;
  confidence?: number;
}

// ─── Result ─────────────────────────────────────────────────────────────────

export interface PermissionResult {
  behavior: PermissionDecision;
  decisionReason: PermissionDecisionReason;
  updatedInput?: unknown;
  message?: string;
}

// ─── Prompt ─────────────────────────────────────────────────────────────────

export interface PermissionPromptOption {
  key: string;
  label: string;
  decision: PermissionDecision;
  persistAs?: PermissionScope;
  pattern?: string;
}

export interface PromptResult {
  decision: PermissionDecision;
  persistRule?: PermissionRule;
  remember: boolean;
}

// ─── Audit ──────────────────────────────────────────────────────────────────

export interface PermissionAuditEntry {
  timestamp: number;
  sessionId: string;
  toolName: string;
  toolInput: unknown;
  decision: PermissionDecision;
  decisionReason: PermissionDecisionReason;
  durationMs: number;
  userOverride?: boolean;
}

// ─── Rule Helpers ───────────────────────────────────────────────────────────

export interface RuleConflict {
  ruleA: PermissionRule;
  ruleB: PermissionRule;
  description: string;
}

export interface RuleSuggestion {
  rule: Omit<PermissionRule, 'id' | 'createdAt'>;
  prompt: string;
  defaultChoice?: 'accept' | 'reject';
}
