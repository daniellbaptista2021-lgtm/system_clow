/**
 * Central de Alertas — engine.
 *
 * Unifica os alertas "standing" (baseados em tempo) do CRM num único canal:
 *   • persiste em crm_alerts (histórico + badge de não-lidas)
 *   • publica via SSE ('alert') → sino/toast/som no app aberto (Onda 60)
 *   • dispara web push → celular/aba fechada
 *
 * Idempotência: cada alerta tem um `dedupKey` estável; INSERT OR IGNORE
 * sobre UNIQUE(tenant_id, dedup_key) impede duplicar no mesmo bucket de dia.
 * O scheduler chama tickStandingAlerts() a cada 60s — só alertas NOVOS
 * (changes>0) emitem SSE/push, então não há spam.
 *
 * Escopo: TODOS os tenants (queries globais por tenant_id, igual ao
 * billing/due scheduler). SSE e push já são isolados por tenant.
 *
 * NÃO trata "nova mensagem": isso já é feito pelo fluxo message.in em
 * store/cardsStore.ts (SSE + push) e derivado ao vivo de unread_count.
 */
import { randomBytes } from 'crypto';
import { getCrmDb } from './schema.js';
import { publish } from './events.js';
import * as push from './push.js';
import { logger } from '../utils/logger.js';

const DAY = 86_400_000;
const now = () => Date.now();
function aid(): string { return 'crm_alert_' + randomBytes(7).toString('hex'); }

/** Bucket de dia (UTC) — estabiliza dedupKey pra re-alertar 1×/dia. */
function dayBucket(ts: number = now()): string {
  return String(Math.floor(ts / DAY));
}

export type AlertType =
  | 'task_due' | 'task_overdue'
  | 'billing_due' | 'billing_overdue'
  | 'due_date'
  | 'reminder' | 'system';

export type AlertSeverity = 'info' | 'warning' | 'urgent';

export interface AlertInput {
  tenantId: string;
  type: AlertType;
  severity?: AlertSeverity;
  title: string;
  body?: string;
  cardId?: string;
  contactId?: string;
  refId?: string;
  url?: string;
  dedupKey: string;
  meta?: Record<string, unknown>;
  /** quando true, não dispara web push (usado p/ eventos já push'ados em outro lugar) */
  skipPush?: boolean;
  /** push direcionado a 1 agente; se ausente, broadcast pro tenant */
  pushAgentId?: string;
}

export interface Alert {
  id: string;
  tenantId: string;
  type: AlertType;
  severity: AlertSeverity;
  title: string;
  body?: string;
  cardId?: string;
  contactId?: string;
  refId?: string;
  url?: string;
  read: boolean;
  meta?: Record<string, unknown>;
  createdAt: number;
}

function rowToAlert(r: any): Alert {
  return {
    id: r.id, tenantId: r.tenant_id, type: r.type, severity: r.severity || 'info',
    title: r.title, body: r.body ?? undefined,
    cardId: r.card_id ?? undefined, contactId: r.contact_id ?? undefined,
    refId: r.ref_id ?? undefined, url: r.url ?? undefined,
    read: r.read === 1,
    meta: r.meta ? safeJson(r.meta) : undefined,
    createdAt: r.created_at,
  };
}
function safeJson(s: string): any { try { return JSON.parse(s); } catch { return undefined; } }

/**
 * Cria (ou ignora se já existe) um alerta e — se novo — publica via SSE +
 * dispara web push. Best-effort: nunca lança.
 */
export async function emitAlert(input: AlertInput): Promise<Alert | null> {
  try {
    const db = getCrmDb();
    const id = aid();
    const ts = now();
    const sev = input.severity || 'info';
    const res = db.prepare(`
      INSERT OR IGNORE INTO crm_alerts
        (id, tenant_id, type, severity, title, body, card_id, contact_id, ref_id, url, dedup_key, read, meta, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(
      id, input.tenantId, input.type, sev, input.title, input.body ?? null,
      input.cardId ?? null, input.contactId ?? null, input.refId ?? null,
      input.url ?? null, input.dedupKey, input.meta ? JSON.stringify(input.meta) : null, ts,
    );

    // Já existia (mesmo dedupKey) → nada a fazer, sem SSE/push duplicado.
    if (res.changes === 0) return null;

    const row = db.prepare('SELECT * FROM crm_alerts WHERE id = ?').get(id);
    const alert = rowToAlert(row);

    // 1) SSE in-app (app aberto: sino + toast + som via Onda 60)
    try { publish(input.tenantId, 'alert', alert); } catch { /* noop */ }

    // 2) Web push (celular/aba fechada)
    if (!input.skipPush) {
      const payload = {
        title: input.title,
        body: input.body || '',
        url: input.url || (input.cardId ? `/crm/#card=${input.cardId}` : '/crm/'),
        data: { type: input.type, alertId: alert.id, cardId: input.cardId, severity: sev },
      };
      try {
        if (input.pushAgentId) {
          void push.sendToAgent(input.tenantId, input.pushAgentId, payload).catch(() => {});
        } else {
          void push.broadcastToTenant(input.tenantId, payload).catch(() => {});
        }
      } catch { /* push opcional */ }
    }
    return alert;
  } catch (e: any) {
    logger.warn('[alerts.emit]', e?.message);
    return null;
  }
}

// ─── Leitura / badge ──────────────────────────────────────────────────────

export interface ListAlertsOpts {
  limit?: number;
  type?: AlertType;
  unreadOnly?: boolean;
  before?: number; // paginação por created_at
}

export function listAlerts(tenantId: string, opts: ListAlertsOpts = {}): Alert[] {
  const db = getCrmDb();
  const wh: string[] = ['tenant_id = ?'];
  const params: any[] = [tenantId];
  if (opts.type) { wh.push('type = ?'); params.push(opts.type); }
  if (opts.unreadOnly) { wh.push('read = 0'); }
  if (opts.before != null) { wh.push('created_at < ?'); params.push(opts.before); }
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const rows = db.prepare(`
    SELECT * FROM crm_alerts WHERE ${wh.join(' AND ')}
    ORDER BY created_at DESC LIMIT ?
  `).all(...params, limit) as any[];
  return rows.map(rowToAlert);
}

export function unreadCount(tenantId: string): number {
  const db = getCrmDb();
  const r = db.prepare('SELECT COUNT(*) AS n FROM crm_alerts WHERE tenant_id = ? AND read = 0').get(tenantId) as { n: number };
  return r?.n || 0;
}

export function markRead(tenantId: string, id: string): boolean {
  const db = getCrmDb();
  const r = db.prepare('UPDATE crm_alerts SET read = 1 WHERE id = ? AND tenant_id = ? AND read = 0').run(id, tenantId);
  return r.changes > 0;
}

export function markAllRead(tenantId: string): number {
  const db = getCrmDb();
  const r = db.prepare('UPDATE crm_alerts SET read = 1 WHERE tenant_id = ? AND read = 0').run(tenantId);
  return r.changes;
}

/** Resumo de conversas não-lidas — derivado ao vivo de crm_cards.unread_count. */
export interface UnreadConversation {
  cardId: string;
  contactName?: string;
  count: number;
  lastInboundAt?: number;
}
export function unreadConversations(tenantId: string, limit = 50): UnreadConversation[] {
  const db = getCrmDb();
  const rows = db.prepare(`
    SELECT c.id AS card_id, c.unread_count AS count, c.last_inbound_at AS last_inbound_at,
           ct.name AS contact_name, c.title AS title
    FROM crm_cards c
    LEFT JOIN crm_contacts ct ON ct.id = c.contact_id
    WHERE c.tenant_id = ? AND COALESCE(c.unread_count, 0) > 0
    ORDER BY c.last_inbound_at DESC
    LIMIT ?
  `).all(tenantId, Math.min(limit, 200)) as any[];
  return rows.map(r => ({
    cardId: r.card_id,
    contactName: r.contact_name || r.title || undefined,
    count: r.count || 0,
    lastInboundAt: r.last_inbound_at ?? undefined,
  }));
}

// ─── Computação dos alertas "standing" (chamado pelo scheduler 60s) ─────────

/** Tarefas abertas vencendo hoje ou atrasadas. */
async function tickTaskAlerts(): Promise<void> {
  const db = getCrmDb();
  const ts = now();
  const endOfToday = new Date(); endOfToday.setHours(23, 59, 59, 999);
  const rows = db.prepare(`
    SELECT id, tenant_id, title, due_at, card_id, contact_id, assigned_to_agent_id
    FROM crm_tasks
    WHERE status = 'open' AND due_at IS NOT NULL AND due_at <= ?
    LIMIT 500
  `).all(endOfToday.getTime()) as any[];
  const bucket = dayBucket(ts);
  for (const r of rows) {
    const overdue = r.due_at < ts;
    await emitAlert({
      tenantId: r.tenant_id,
      type: overdue ? 'task_overdue' : 'task_due',
      severity: overdue ? 'urgent' : 'warning',
      title: overdue ? '⏰ Tarefa atrasada' : '📋 Tarefa vence hoje',
      body: r.title,
      cardId: r.card_id ?? undefined,
      contactId: r.contact_id ?? undefined,
      refId: r.id,
      url: r.card_id ? `/crm/#card=${r.card_id}` : '/crm/#tab=tasks',
      dedupKey: `${overdue ? 'task_overdue' : 'task_due'}:${r.id}:${bucket}`,
      pushAgentId: r.assigned_to_agent_id ?? undefined,
    });
  }
}

/** Mensalidades vencendo (≤3 dias) ou atrasadas. */
async function tickBillingAlerts(): Promise<void> {
  const db = getCrmDb();
  const ts = now();
  const rows = db.prepare(`
    SELECT id, tenant_id, plan_name, amount_cents, next_charge_at, status, last_paid_at, contact_id, card_id
    FROM crm_subscriptions
    WHERE status IN ('active','past_due') AND next_charge_at <= ?
    ORDER BY next_charge_at ASC LIMIT 500
  `).all(ts + 3 * DAY) as any[];
  const bucket = dayBucket(ts);
  for (const r of rows) {
    // Já pago neste ciclo? (last_paid_at depois da janela de cobrança anterior)
    if (r.last_paid_at && r.last_paid_at >= r.next_charge_at - DAY) continue;
    const overdue = r.status === 'past_due' || r.next_charge_at < ts;
    const valor = (r.amount_cents != null) ? ` (R$ ${(r.amount_cents / 100).toFixed(2)})` : '';
    const venc = new Date(r.next_charge_at).toLocaleDateString('pt-BR');
    await emitAlert({
      tenantId: r.tenant_id,
      type: overdue ? 'billing_overdue' : 'billing_due',
      severity: overdue ? 'urgent' : 'warning',
      title: overdue ? '💰 Mensalidade atrasada' : '💰 Mensalidade vencendo',
      body: `${r.plan_name || 'Mensalidade'}${valor} — venc. ${venc}`,
      cardId: r.card_id ?? undefined,
      contactId: r.contact_id ?? undefined,
      refId: r.id,
      url: r.card_id ? `/crm/#card=${r.card_id}` : '/crm/#tab=subscriptions',
      dedupKey: `${overdue ? 'billing_overdue' : 'billing_due'}:${r.id}:${bucket}`,
    });
  }
}

/** Cards com data de vencimento (due_date) próxima (≤24h) ou vencida (até 7d atrás). */
async function tickCardDueDateAlerts(): Promise<void> {
  const db = getCrmDb();
  const ts = now();
  const rows = db.prepare(`
    SELECT c.id AS id, c.tenant_id AS tenant_id, c.title AS title, c.due_date AS due_date,
           c.contact_id AS contact_id, c.column_id AS column_id
    FROM crm_cards c
    JOIN crm_columns col ON col.id = c.column_id
    WHERE col.is_terminal = 0
      AND c.due_date IS NOT NULL
      AND c.due_date <= ? AND c.due_date >= ?
    LIMIT 500
  `).all(ts + DAY, ts - 7 * DAY) as any[];
  const bucket = dayBucket(ts);
  for (const r of rows) {
    const overdue = r.due_date < ts;
    const venc = new Date(r.due_date).toLocaleDateString('pt-BR');
    await emitAlert({
      tenantId: r.tenant_id,
      type: 'due_date',
      severity: overdue ? 'urgent' : 'warning',
      title: overdue ? '📅 Vencimento passou' : '📅 Vencimento próximo',
      body: `${r.title || 'Card'} — ${venc}`,
      cardId: r.id,
      contactId: r.contact_id ?? undefined,
      refId: r.id,
      url: `/crm/#card=${r.id}`,
      dedupKey: `due_date:${r.id}:${bucket}`,
    });
  }
}

/**
 * Tick principal — chamado pelo scheduler (worker 0). Best-effort:
 * cada sub-tick é isolado, falha de um não derruba os outros.
 */
export async function tickStandingAlerts(): Promise<void> {
  await Promise.allSettled([
    tickTaskAlerts(),
    tickBillingAlerts(),
    tickCardDueDateAlerts(),
  ]);
}
