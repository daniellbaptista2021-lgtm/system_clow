/**
 * auditLog.ts — Append-only audit logger for security events
 *
 * Logs ALL sensitive actions to JSONL files:
 *   - Login attempts (success/failure)
 *   - Session creation/deletion
 *   - Tool usage (especially Bash, Write, Edit)
 *   - Admin actions (tenant CRUD, quota changes)
 *   - Rate limit violations
 *   - Blocked commands
 *
 * Files: ~/.clow/audit/YYYY-MM-DD.jsonl
 * Retention: Files are never auto-deleted (manual cleanup or external rotation).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ════════════════════════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════════════════════════

export type AuditAction =
  | 'login_success'
  | 'login_failure'
  | 'session_create'
  | 'session_delete'
  | 'session_message'
  | 'tool_use'
  | 'tool_blocked'
  | 'bash_blocked'
  | 'rate_limit_exceeded'
  | 'quota_exceeded'
  | 'tenant_create'
  | 'tenant_update'
  | 'tenant_suspend'
  | 'api_key_create'
  | 'api_key_revoke'
  | 'admin_action'
  | 'security_violation';

export interface AuditEntry {
  ts: string;
  epoch: number;
  action: AuditAction;
  tenantId: string;
  sessionId?: string;
  ip?: string;
  details?: Record<string, unknown>;
}

// ════════════════════════════════════════════════════════════════════════════
// Audit Logger
// ════════════════════════════════════════════════════════════════════════════

const auditDir = path.join(os.homedir(), '.clow', 'audit');

function ensureAuditDir(): void {
  if (!fs.existsSync(auditDir)) {
    fs.mkdirSync(auditDir, { recursive: true });
  }
}

function getAuditFilePath(): string {
  const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  return path.join(auditDir, `${date}.jsonl`);
}

/**
 * Log an audit event. Fire-and-forget — never throws.
 */
export function audit(
  action: AuditAction,
  tenantId: string,
  details?: Record<string, unknown>,
  sessionId?: string,
  ip?: string,
): void {
  try {
    ensureAuditDir();

    const entry: AuditEntry = {
      ts: new Date().toISOString(),
      epoch: Date.now(),
      action,
      tenantId,
      ...(sessionId ? { sessionId } : {}),
      ...(ip ? { ip } : {}),
      ...(details ? { details } : {}),
    };

    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(getAuditFilePath(), line, 'utf-8');
  } catch {
    // Never crash — audit is best-effort
  }
}

/**
 * Read recent audit entries (for admin dashboard).
 */
export function readRecentAuditEntries(limit: number = 100): AuditEntry[] {
  try {
    ensureAuditDir();
    const filePath = getAuditFilePath();
    if (!fs.existsSync(filePath)) return [];

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);

    return lines
      .slice(-limit)
      .map(line => {
        try { return JSON.parse(line) as AuditEntry; }
        catch { return null; }
      })
      .filter((e): e is AuditEntry => e !== null)
      .reverse(); // Most recent first
  } catch {
    return [];
  }
}

/**
 * Get audit stats for a tenant.
 */
export function getAuditStats(tenantId: string): {
  totalActions: number;
  loginAttempts: number;
  blockedActions: number;
  sessionsCreated: number;
} {
  const entries = readRecentAuditEntries(1000).filter(e => e.tenantId === tenantId);

  return {
    totalActions: entries.length,
    loginAttempts: entries.filter(e => e.action.startsWith('login_')).length,
    blockedActions: entries.filter(e =>
      e.action === 'tool_blocked' || e.action === 'bash_blocked' ||
      e.action === 'rate_limit_exceeded' || e.action === 'security_violation'
    ).length,
    sessionsCreated: entries.filter(e => e.action === 'session_create').length,
  };
}
