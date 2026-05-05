// CRM automationsStore module — split out from the legacy monolithic file in a refactor.
// Edit this file directly; scripts/split-store.cjs is retained only as a record
// of how the original was decomposed (it ran once against the .ts.bak snapshot).
import { randomUUID, randomBytes } from 'crypto';
import type Database from 'better-sqlite3';
import { getCrmDb } from '.././schema.js';
import type {
  Board, BoardColumn, Contact, Card, Activity, Agent, Channel2,
  Subscription, Automation, InventoryItem, BoardType, ActivityType,
  Channel, MediaType, ChannelType, ChannelStatus, BillingCycle, SubscriptionStatus, AgentRole,
} from '.././types.js';
import type { Segment, SegmentFilter, BulkContactOp } from '.././types.js';
import type { Swimlane, Checklist, ChecklistItem, BoardSettings, ColumnStageType } from '.././types.js';
import type { Team, AgentPermissions, AgentMetricsPro, SlaRule,
              Label, QuickReply, InboxRule } from '.././types.js';
import type { ActivityFilter, ReminderChannel, ReminderStatus, ReminderPro } from '.././types.js';
import type { InventoryCategory, InventoryVariant, InventoryMovement,
              Proposal, ProposalStatus, ProposalTemplate } from '.././types.js';
import type { StripeConnectAccount, InvoicePro, InvoiceStatus, Coupon, DunningLog, MrrSnapshot } from '.././types.js';
import type { AutomationLog, AssignmentRule, AssignmentConditions, AssignmentLog } from '.././types.js';
import type { ChannelTemplate, ChannelHealth, ChannelMetrics } from '.././types.js';
import { now, getAutoAssign, getCommitStock, getPublish, getEmit, nid, J, HEADER_ALIASES } from './_internals.js';
import type { ImportResult, EvalContext } from './_internals.js';


export function setAutomationSchedule(tenantId: string, id: string, cron: string | null, nextRunAt?: number): boolean {
  return getCrmDb().prepare('UPDATE crm_automations SET schedule_cron=?, next_run_at=? WHERE id=? AND tenant_id=?')
    .run(cron, nextRunAt ?? null, id, tenantId).changes > 0;
}

export function listScheduledAutomations(nowTs: number = Date.now()): any[] {
  return getCrmDb().prepare('SELECT * FROM crm_automations WHERE schedule_cron IS NOT NULL AND enabled=1 AND next_run_at<=?').all(nowTs) as any[];
}

export function logAutomationRun(tenantId: string, automationId: string, input: { triggerPayload?: any; actionsExecuted: number; success: boolean; error?: string; durationMs?: number }): AutomationLog {
  const log: AutomationLog = { id: nid('crm_aulog'), tenantId, automationId,
    firedAt: now(), triggerPayload: input.triggerPayload,
    actionsExecuted: input.actionsExecuted, success: input.success,
    error: input.error, durationMs: input.durationMs };
  getCrmDb().prepare('INSERT INTO crm_automation_logs (id,tenant_id,automation_id,fired_at,trigger_payload_json,actions_executed,success,error,duration_ms) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(log.id, tenantId, automationId, log.firedAt, JSON.stringify(log.triggerPayload || null),
         log.actionsExecuted, log.success ? 1 : 0, log.error ?? null, log.durationMs ?? null);
  getCrmDb().prepare('UPDATE crm_automations SET last_run_at=?, run_count=COALESCE(run_count,0)+1 WHERE id=?').run(log.firedAt, automationId);
  return log;
}

export function listAutomationLogs(tenantId: string, automationId: string, limit: number = 50): AutomationLog[] {
  return (getCrmDb().prepare('SELECT * FROM crm_automation_logs WHERE tenant_id=? AND automation_id=? ORDER BY fired_at DESC LIMIT ?')
    .all(tenantId, automationId, Math.min(limit, 500)) as any[])
    .map((r: any) => ({ id: r.id, tenantId: r.tenant_id, automationId: r.automation_id,
      firedAt: r.fired_at, triggerPayload: r.trigger_payload_json ? JSON.parse(r.trigger_payload_json) : undefined,
      actionsExecuted: r.actions_executed, success: !!r.success, error: r.error ?? undefined, durationMs: r.duration_ms ?? undefined }));
}

export function setAutomationWebhook(tenantId: string, id: string): string {
  // 256 bits de entropia (64 chars hex). Antes era nid('auto_wh') = 12 hex
  // ≈ 48 bits, brute-forçável em ~1.3M reqs. Secrets antigos no DB
  // continuam válidos até serem rotacionados via novo POST /webhook.
  const secret = randomBytes(32).toString('hex');
  getCrmDb().prepare('UPDATE crm_automations SET webhook_secret=? WHERE id=? AND tenant_id=?').run(secret, id, tenantId);
  return secret;
}

export function findAutomationByWebhook(secret: string): any | null {
  return (getCrmDb().prepare('SELECT * FROM crm_automations WHERE webhook_secret=?').get(secret) as any) || null;
}
