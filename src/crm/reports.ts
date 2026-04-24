/**
 * CRM Reports — Onda 14 (Seq 3).
 *
 * Pure functions that compute report data. Scope by tenantId. Time filters
 * (epoch ms) optional. Results are raw JSON; formatting for CSV/PDF lives
 * in reportsExport.ts.
 *
 * Reports:
 *   - salesByPeriod   : won deals aggregated by day|week|month
 *   - activitiesByAgent: count of activities per agent, per type
 *   - leadSources     : contacts grouped by source with conversion rate
 *   - lostReasons     : cards in lost columns grouped by lost_reason
 */

import { getCrmDb } from './schema.js';

type Window = { from?: number; to?: number };
type Bucket = 'day' | 'week' | 'month';

function whereTs(col: string, w: Window): { sql: string; params: number[] } {
  const parts: string[] = [];
  const params: number[] = [];
  if (w.from != null) { parts.push(`${col} >= ?`); params.push(w.from); }
  if (w.to   != null) { parts.push(`${col} <= ?`); params.push(w.to); }
  return { sql: parts.length ? ' AND ' + parts.join(' AND ') : '', params };
}

function bucketStart(ts: number, b: Bucket): number {
  const d = new Date(ts);
  if (b === 'day')   return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  if (b === 'month') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const day = d.getUTCDay() || 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - (day - 1));
}

function bucketLabel(ts: number, b: Bucket): string {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return b === 'month' ? `${y}-${m}` : `${y}-${m}-${day}`;
}

// ─── 1) Sales by period ─────────────────────────────────────────────────
export interface SalesRow {
  bucket: string;
  bucketStart: number;
  dealsWon: number;
  totalValueCents: number;
  avgDealValueCents: number;
}

export function salesByPeriod(
  tenantId: string,
  opts: Window & { bucket?: Bucket; boardId?: string } = {},
): SalesRow[] {
  const db = getCrmDb();
  const bucket = opts.bucket ?? 'day';
  const ts = whereTs('a.created_at', opts);
  const boardFilter = opts.boardId ? 'AND c.board_id = ?' : '';
  const boardParams = opts.boardId ? [opts.boardId] : [];

  const rows = db.prepare(`
    SELECT a.card_id, a.content, a.created_at, c.value_cents
    FROM crm_activities a
    JOIN crm_cards c ON c.id = a.card_id
    JOIN crm_columns col ON col.id = c.column_id
    WHERE a.tenant_id = ? AND a.type = 'stage_change'
      AND c.tenant_id = ? ${boardFilter}
      AND col.stage_type = 'won'
      ${ts.sql}
    ORDER BY a.card_id, a.created_at DESC
  `).all(tenantId, tenantId, ...boardParams, ...ts.params) as any[];

  // Pick last stage_change per card (the close event)
  const moveRegex = /Movido de (\S+) para (\S+)/;
  const seen = new Set<string>();
  const closes: Array<{ ts: number; valueCents: number }> = [];
  for (const r of rows) {
    if (seen.has(r.card_id)) continue;
    seen.add(r.card_id);
    const m = moveRegex.exec(r.content || '');
    if (!m) continue;
    closes.push({ ts: r.created_at, valueCents: r.value_cents });
  }

  const byBucket = new Map<number, SalesRow>();
  for (const cl of closes) {
    const start = bucketStart(cl.ts, bucket);
    const row = byBucket.get(start) || {
      bucket: bucketLabel(start, bucket),
      bucketStart: start,
      dealsWon: 0, totalValueCents: 0, avgDealValueCents: 0,
    };
    row.dealsWon++;
    row.totalValueCents += cl.valueCents;
    byBucket.set(start, row);
  }
  const list = Array.from(byBucket.values()).sort((a, b) => a.bucketStart - b.bucketStart);
  for (const r of list) r.avgDealValueCents = r.dealsWon > 0 ? Math.round(r.totalValueCents / r.dealsWon) : 0;
  return list;
}

// ─── 2) Activities by agent ─────────────────────────────────────────────
export interface AgentActivityRow {
  agentId: string;
  agentName: string;
  totalActivities: number;
  byType: Record<string, number>;
}

export function activitiesByAgent(tenantId: string, win: Window = {}): AgentActivityRow[] {
  const db = getCrmDb();
  const ts = whereTs('a.created_at', win);

  const rows = db.prepare(`
    SELECT
      COALESCE(a.created_by_agent_id, 'unassigned') AS agent_id,
      COALESCE(ag.name, 'Sem agente')               AS agent_name,
      a.type                                        AS type,
      COUNT(*)                                      AS cnt
    FROM crm_activities a
    LEFT JOIN crm_agents ag ON ag.id = a.created_by_agent_id
    WHERE a.tenant_id = ? ${ts.sql}
    GROUP BY agent_id, type
    ORDER BY agent_id, type
  `).all(tenantId, ...ts.params) as any[];

  const byAgent = new Map<string, AgentActivityRow>();
  for (const r of rows) {
    const row = byAgent.get(r.agent_id) || {
      agentId: r.agent_id, agentName: r.agent_name, totalActivities: 0, byType: {} as Record<string, number>,
    };
    row.totalActivities += r.cnt;
    row.byType[r.type] = r.cnt;
    byAgent.set(r.agent_id, row);
  }
  return Array.from(byAgent.values()).sort((a, b) => b.totalActivities - a.totalActivities);
}

// ─── 3) Lead sources ────────────────────────────────────────────────────
export interface LeadSourceRow {
  source: string;
  contactCount: number;
  cardsOpen: number;
  cardsWon: number;
  cardsLost: number;
  conversionRate: number;       // won / (won + lost), 0..1
  totalRevenueCents: number;
}

export function leadSources(tenantId: string, win: Window = {}): LeadSourceRow[] {
  const db = getCrmDb();
  const ts = whereTs('c.created_at', win);

  // Count contacts per source
  const contacts = db.prepare(`
    SELECT COALESCE(NULLIF(source, ''), 'unknown') AS source, COUNT(*) AS cnt
    FROM crm_contacts c
    WHERE c.tenant_id = ? ${ts.sql}
    GROUP BY source
  `).all(tenantId, ...ts.params) as any[];

  // Join cards → contacts → source
  const ts2 = whereTs('card.created_at', win);
  const cards = db.prepare(`
    SELECT
      COALESCE(NULLIF(ct.source, ''), 'unknown') AS source,
      COALESCE(col.stage_type, 'open')           AS stage_type,
      card.value_cents                           AS value_cents
    FROM crm_cards card
    JOIN crm_contacts ct ON ct.id = card.contact_id
    JOIN crm_columns col ON col.id = card.column_id
    WHERE card.tenant_id = ? AND ct.tenant_id = ? ${ts2.sql}
  `).all(tenantId, tenantId, ...ts2.params) as any[];

  const bySource = new Map<string, LeadSourceRow>();
  for (const c of contacts) {
    bySource.set(c.source, {
      source: c.source, contactCount: c.cnt,
      cardsOpen: 0, cardsWon: 0, cardsLost: 0,
      conversionRate: 0, totalRevenueCents: 0,
    });
  }
  for (const card of cards) {
    const row = bySource.get(card.source) || {
      source: card.source, contactCount: 0,
      cardsOpen: 0, cardsWon: 0, cardsLost: 0,
      conversionRate: 0, totalRevenueCents: 0,
    };
    if (card.stage_type === 'won')       { row.cardsWon++;  row.totalRevenueCents += card.value_cents; }
    else if (card.stage_type === 'lost') { row.cardsLost++; }
    else                                  { row.cardsOpen++; }
    bySource.set(card.source, row);
  }
  const list = Array.from(bySource.values());
  for (const r of list) {
    const closed = r.cardsWon + r.cardsLost;
    r.conversionRate = closed > 0 ? r.cardsWon / closed : 0;
  }
  return list.sort((a, b) => b.contactCount - a.contactCount);
}

// ─── 4) Lost reasons ────────────────────────────────────────────────────
export interface LostReasonRow {
  reason: string;
  cardCount: number;
  totalValueLostCents: number;
  avgValueLostCents: number;
}

export function lostReasons(tenantId: string, boardId: string | undefined, win: Window = {}): LostReasonRow[] {
  const db = getCrmDb();
  const ts = whereTs('c.created_at', win);
  const boardFilter = boardId ? 'AND c.board_id = ?' : '';
  const boardParams = boardId ? [boardId] : [];

  const rows = db.prepare(`
    SELECT
      COALESCE(NULLIF(c.lost_reason, ''), 'unknown') AS reason,
      COUNT(*)                                       AS cnt,
      COALESCE(SUM(c.value_cents), 0)                AS total_cents
    FROM crm_cards c
    JOIN crm_columns col ON col.id = c.column_id
    WHERE c.tenant_id = ? AND (col.stage_type = 'lost' OR (c.lost_reason IS NOT NULL AND c.lost_reason != '')) ${boardFilter} ${ts.sql}
    GROUP BY reason
    ORDER BY cnt DESC
  `).all(tenantId, ...boardParams, ...ts.params) as any[];

  return rows.map(r => ({
    reason: r.reason,
    cardCount: r.cnt,
    totalValueLostCents: r.total_cents,
    avgValueLostCents: r.cnt > 0 ? Math.round(r.total_cents / r.cnt) : 0,
  }));
}
