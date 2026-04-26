/**
 * Outbound webhooks — Onda 23.
 *
 * Emit-subscribe pattern: modules call emit('event.name', payload) and every
 * webhook subscribed to that event receives a POST with HMAC-SHA256 signature.
 *
 * Failed deliveries retry up to 5 times with exponential backoff (tick-driven).
 */

import { randomBytes, createHmac } from 'crypto';
import { getCrmDb } from './schema.js';

function nid(prefix: string): string { return prefix + '_' + randomBytes(6).toString('hex'); }
const now = () => Date.now();

export type WebhookEvent =
  | 'contact.created' | 'contact.updated' | 'contact.deleted'
  | 'card.created' | 'card.updated' | 'card.moved' | 'card.won' | 'card.lost' | 'card.deleted'
  | 'activity.logged'
  | 'proposal.sent' | 'proposal.signed' | 'proposal.rejected'
  | 'appointment.created' | 'appointment.cancelled'
  | 'task.created' | 'task.completed'
  | 'campaign.sent'
  | 'form.submitted';

export interface OutboundWebhook {
  id: string;
  tenantId: string;
  name: string;
  url: string;
  events: WebhookEvent[];
  secret?: string;
  enabled: boolean;
  totalSent: number;
  totalFailed: number;
  lastAttemptAt?: number;
  lastStatus?: number;
  createdAt: number;
}

function rowToWh(r: any): OutboundWebhook {
  return {
    id: r.id, tenantId: r.tenant_id, name: r.name, url: r.url,
    events: JSON.parse(r.events_json || '[]'), secret: r.secret ?? undefined,
    enabled: r.enabled === 1, totalSent: r.total_sent || 0, totalFailed: r.total_failed || 0,
    lastAttemptAt: r.last_attempt_at ?? undefined, lastStatus: r.last_status ?? undefined,
    createdAt: r.created_at,
  };
}

export function createOutboundWebhook(tenantId: string, input: {
  name: string; url: string; events: WebhookEvent[]; secret?: string;
}): OutboundWebhook {
  const id = nid('crm_ohk');
  getCrmDb().prepare(`
    INSERT INTO crm_outbound_webhooks
      (id, tenant_id, name, url, events_json, secret, enabled, total_sent, total_failed, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, 0, 0, ?)
  `).run(id, tenantId, input.name, input.url, JSON.stringify(input.events),
    input.secret || randomBytes(24).toString('base64url'), now());
  return getOutboundWebhook(tenantId, id)!;
}

export function getOutboundWebhook(tenantId: string, id: string): OutboundWebhook | null {
  const r = getCrmDb().prepare('SELECT * FROM crm_outbound_webhooks WHERE id = ? AND tenant_id = ?').get(id, tenantId) as any;
  return r ? rowToWh(r) : null;
}

export function listOutboundWebhooks(tenantId: string): OutboundWebhook[] {
  return (getCrmDb().prepare('SELECT * FROM crm_outbound_webhooks WHERE tenant_id = ? ORDER BY created_at DESC').all(tenantId) as any[])
    .map(rowToWh);
}

export function updateOutboundWebhook(tenantId: string, id: string, patch: Partial<OutboundWebhook>): OutboundWebhook | null {
  const ex = getOutboundWebhook(tenantId, id);
  if (!ex) return null;
  const merged = { ...ex, ...patch };
  getCrmDb().prepare(
    'UPDATE crm_outbound_webhooks SET name=?, url=?, events_json=?, secret=?, enabled=? WHERE id=? AND tenant_id=?'
  ).run(merged.name, merged.url, JSON.stringify(merged.events),
    merged.secret ?? null, merged.enabled ? 1 : 0, id, tenantId);
  return getOutboundWebhook(tenantId, id);
}

export function deleteOutboundWebhook(tenantId: string, id: string): boolean {
  return getCrmDb().prepare('DELETE FROM crm_outbound_webhooks WHERE id = ? AND tenant_id = ?').run(id, tenantId).changes > 0;
}

export function listDeliveries(tenantId: string, webhookId: string, limit = 50): any[] {
  const ex = getOutboundWebhook(tenantId, webhookId);
  if (!ex) return [];
  return getCrmDb().prepare(
    'SELECT * FROM crm_webhook_deliveries WHERE webhook_id = ? ORDER BY created_at DESC LIMIT ?'
  ).all(webhookId, limit) as any[];
}

/**
 * Fire an event. Called from anywhere (store.ts, proposals.ts, etc.).
 * Does NOT block — queues delivery rows and lets scheduler retry.
 */
export async function emit(tenantId: string, event: WebhookEvent, payload: Record<string, any>): Promise<void> {
  const db = getCrmDb();
  const hooks = db.prepare(`
    SELECT * FROM crm_outbound_webhooks
    WHERE tenant_id = ? AND enabled = 1 AND events_json LIKE ?
  `).all(tenantId, '%"' + event + '"%') as any[];

  for (const hookRow of hooks) {
    const hook = rowToWh(hookRow);
    if (!hook.events.includes(event)) continue; // exact match check

    const deliveryId = nid('crm_whd');
    const t = now();
    db.prepare(`
      INSERT INTO crm_webhook_deliveries
        (id, webhook_id, event, payload_json, attempt_count, next_retry_at, created_at)
      VALUES (?, ?, ?, ?, 0, ?, ?)
    `).run(deliveryId, hook.id, event, JSON.stringify({ event, tenantId, timestamp: t, ...payload }), t, t);

    // Fire-and-forget immediate delivery attempt
    void attemptDelivery(deliveryId).catch(err => console.warn('[ohk immediate]', deliveryId, err?.message));
  }
}

async function attemptDelivery(deliveryId: string): Promise<void> {
  const db = getCrmDb();
  const row = db.prepare('SELECT * FROM crm_webhook_deliveries WHERE id = ?').get(deliveryId) as any;
  if (!row) return;
  const hook = db.prepare('SELECT * FROM crm_outbound_webhooks WHERE id = ?').get(row.webhook_id) as any;
  if (!hook || hook.enabled !== 1) return;

  const body = row.payload_json;
  const sig = hook.secret ? createHmac('sha256', hook.secret).update(body).digest('hex') : '';
  const attemptCount = (row.attempt_count || 0) + 1;

  let status = 0;
  let responseBody = '';
  try {
    const r = await fetch(hook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Clow-Event': row.event,
        'X-Clow-Delivery': deliveryId,
        ...(sig ? { 'X-Clow-Signature': sig } : {}),
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    status = r.status;
    responseBody = (await r.text()).slice(0, 500);
  } catch (err: any) {
    status = 0;
    responseBody = (err?.message || 'fetch_error').slice(0, 500);
  }

  const success = status >= 200 && status < 300;
  const nextRetryAt = success ? null : computeBackoff(attemptCount);
  const final = success || attemptCount >= 5;

  db.prepare(`
    UPDATE crm_webhook_deliveries
    SET attempt_count = ?, http_status = ?, response_body = ?, last_tried_at = ?,
        next_retry_at = ?, succeeded_at = ?
    WHERE id = ?
  `).run(attemptCount, status, responseBody, now(),
    final ? null : nextRetryAt, success ? now() : null, deliveryId);

  db.prepare(`
    UPDATE crm_outbound_webhooks SET
      total_sent = total_sent + CASE WHEN ? THEN 1 ELSE 0 END,
      total_failed = total_failed + CASE WHEN ? THEN 1 ELSE 0 END,
      last_attempt_at = ?, last_status = ?
    WHERE id = ?
  `).run(success ? 1 : 0, (!success && final) ? 1 : 0, now(), status, hook.id);
}

function computeBackoff(attempt: number): number {
  // 30s, 2min, 10min, 30min, 1h
  const steps = [30, 120, 600, 1800, 3600];
  const s = steps[Math.min(attempt - 1, steps.length - 1)] || 3600;
  return now() + s * 1000;
}

export async function tickRetries(): Promise<void> {
  const db = getCrmDb();
  const due = db.prepare(`
    SELECT id FROM crm_webhook_deliveries
    WHERE succeeded_at IS NULL AND next_retry_at IS NOT NULL AND next_retry_at <= ?
      AND attempt_count < 5
    LIMIT 50
  `).all(now()) as any[];

  for (const r of due) {
    try { await attemptDelivery(r.id); } catch { /* logged in attemptDelivery */ }
  }
}

export function deliveryStats(tenantId: string): { pending: number; failed: number; succeeded: number } {
  const db = getCrmDb();
  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN d.succeeded_at IS NULL AND d.attempt_count < 5 THEN 1 ELSE 0 END) pending,
      SUM(CASE WHEN d.succeeded_at IS NULL AND d.attempt_count >= 5 THEN 1 ELSE 0 END) failed,
      SUM(CASE WHEN d.succeeded_at IS NOT NULL THEN 1 ELSE 0 END) succeeded
    FROM crm_webhook_deliveries d
    JOIN crm_outbound_webhooks w ON w.id = d.webhook_id
    WHERE w.tenant_id = ?
  `).get(tenantId) as any;
  return { pending: row?.pending || 0, failed: row?.failed || 0, succeeded: row?.succeeded || 0 };
}
