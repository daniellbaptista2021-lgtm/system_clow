/**
 * CRM Pipeline Analytics — Onda 13 (Seq 2).
 *
 * Pure functions that compute metrics from crm_cards + crm_columns + crm_activities.
 * All queries scope by tenantId. Time filters are optional (epoch ms).
 *
 * Exported endpoints (see routes.ts):
 *   GET /v1/crm/boards/:boardId/analytics/funnel
 *   GET /v1/crm/boards/:boardId/analytics/stage-times
 *   GET /v1/crm/boards/:boardId/analytics/velocity?bucket=day|week|month
 *   GET /v1/crm/boards/:boardId/analytics/win-rate
 *   GET /v1/crm/boards/:boardId/analytics/compare?prevFrom=&prevTo=
 */

import { getCrmDb } from './schema.js';

type Window = { from?: number; to?: number };
type Bucket = 'day' | 'week' | 'month';

// ─── Helpers ────────────────────────────────────────────────────────────
function whereTs(col: string, w: Window): { sql: string; params: number[] } {
  const parts: string[] = [];
  const params: number[] = [];
  if (w.from != null) { parts.push(`${col} >= ?`); params.push(w.from); }
  if (w.to   != null) { parts.push(`${col} <= ?`); params.push(w.to); }
  return { sql: parts.length ? ' AND ' + parts.join(' AND ') : '', params };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[idx];
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
}

function bucketStart(ts: number, bucket: Bucket): number {
  const d = new Date(ts);
  if (bucket === 'day')   return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  if (bucket === 'month') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  // week: start on Monday UTC
  const day = d.getUTCDay() || 7; // Sun=0 -> 7
  const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - (day - 1));
  return monday;
}

function bucketLabel(ts: number, bucket: Bucket): string {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  if (bucket === 'month') return `${y}-${m}`;
  return `${y}-${m}-${day}`;
}

// ─── 1) Funnel ──────────────────────────────────────────────────────────
export interface FunnelRow {
  columnId: string;
  name: string;
  position: number;
  stageType: string;
  cardCount: number;
  totalValueCents: number;
}

/** Cards currently in each column, with totals. */
export function funnel(tenantId: string, boardId: string, win: Window = {}): FunnelRow[] {
  const db = getCrmDb();
  const ts = whereTs('c.created_at', win);
  const rows = db.prepare(`
    SELECT
      col.id AS column_id,
      col.name AS name,
      col.position AS position,
      COALESCE(col.stage_type, 'open') AS stage_type,
      COUNT(c.id) AS card_count,
      COALESCE(SUM(c.value_cents), 0) AS total_value_cents
    FROM crm_columns col
    LEFT JOIN crm_cards c
      ON c.column_id = col.id
      AND c.tenant_id = ?
      ${ts.sql}
    WHERE col.board_id = ?
    GROUP BY col.id, col.name, col.position, col.stage_type
    ORDER BY col.position ASC
  `).all(tenantId, ...ts.params, boardId) as any[];

  return rows.map(r => ({
    columnId: r.column_id,
    name: r.name,
    position: r.position,
    stageType: r.stage_type,
    cardCount: r.card_count,
    totalValueCents: r.total_value_cents,
  }));
}

// ─── 2) Stage Times ─────────────────────────────────────────────────────
export interface StageTimeRow {
  columnId: string;
  name: string;
  stageType: string;
  avgSeconds: number;
  medianSeconds: number;
  p90Seconds: number;
  sampleCount: number;
}

/**
 * Time cards spend in each column, derived from stage_change activities.
 *
 * Strategy:
 *   - For each card, reconstruct the column timeline: (columnId, enteredAt).
 *   - The first entry is the card's initial column (created_at).
 *   - Each subsequent stage_change activity parses "Movido de X para Y" from content.
 *   - Time in stage = nextEnteredAt - currentEnteredAt (or now for open cards).
 */
export function stageTimes(tenantId: string, boardId: string, win: Window = {}): StageTimeRow[] {
  const db = getCrmDb();

  const cols = db.prepare(
    'SELECT id, name, position, COALESCE(stage_type, \'open\') AS stage_type FROM crm_columns WHERE board_id = ? ORDER BY position ASC'
  ).all(boardId) as any[];
  const colsById = new Map<string, any>(cols.map(c => [c.id, c]));

  const ts = whereTs('created_at', win);
  const cards = db.prepare(`
    SELECT id, column_id, created_at
    FROM crm_cards
    WHERE tenant_id = ? AND board_id = ?${ts.sql}
    ORDER BY created_at ASC
  `).all(tenantId, boardId, ...ts.params) as any[];

  if (cards.length === 0) {
    return cols.map(c => ({
      columnId: c.id, name: c.name, stageType: c.stage_type,
      avgSeconds: 0, medianSeconds: 0, p90Seconds: 0, sampleCount: 0,
    }));
  }

  const cardIds = cards.map(c => c.id);
  const placeholders = cardIds.map(() => '?').join(',');
  const moves = db.prepare(`
    SELECT card_id, content, created_at
    FROM crm_activities
    WHERE tenant_id = ? AND type = 'stage_change' AND card_id IN (${placeholders})
    ORDER BY card_id ASC, created_at ASC
  `).all(tenantId, ...cardIds) as any[];

  // Group moves by card
  const movesByCard = new Map<string, Array<{ toColumnId: string; ts: number }>>();
  const moveRegex = /Movido de (\S+) para (\S+)/;
  for (const m of moves) {
    const match = moveRegex.exec(m.content || '');
    if (!match) continue;
    const toColumnId = match[2];
    const arr = movesByCard.get(m.card_id) || [];
    arr.push({ toColumnId, ts: m.created_at });
    movesByCard.set(m.card_id, arr);
  }

  // Accumulate durations per column
  const durationsByColumn = new Map<string, number[]>();
  const nowTs = Date.now();

  for (const card of cards) {
    const history: Array<{ columnId: string; ts: number }> = [
      { columnId: card.column_id, ts: card.created_at }, // initial landing
    ];
    const cardMoves = movesByCard.get(card.id) || [];
    // The very first move in activities is redundant if column didn't change, but we append moves as-is
    for (const mv of cardMoves) history.push({ columnId: mv.toColumnId, ts: mv.ts });

    // Reconstruct: the initial column is wrong if the card was moved,
    // because we only know the CURRENT column_id. If the card has any moves,
    // the initial column is the "from" of the first move.
    if (cardMoves.length > 0) {
      const firstMoveMatch = moveRegex.exec((moves.find(m => m.card_id === card.id && m.created_at === cardMoves[0].ts)?.content) || '');
      if (firstMoveMatch) {
        history[0] = { columnId: firstMoveMatch[1], ts: card.created_at };
      }
    }

    for (let i = 0; i < history.length; i++) {
      const entry = history[i];
      const nextTs = i + 1 < history.length ? history[i + 1].ts : nowTs;
      const durSec = Math.max(0, Math.floor((nextTs - entry.ts) / 1000));
      const arr = durationsByColumn.get(entry.columnId) || [];
      arr.push(durSec);
      durationsByColumn.set(entry.columnId, arr);
    }
  }

  return cols.map(c => {
    const durations = (durationsByColumn.get(c.id) || []).slice().sort((a, b) => a - b);
    const avg = durations.length > 0
      ? Math.round(durations.reduce((s, v) => s + v, 0) / durations.length)
      : 0;
    return {
      columnId: c.id,
      name: c.name,
      stageType: c.stage_type,
      avgSeconds: avg,
      medianSeconds: median(durations),
      p90Seconds: percentile(durations, 0.9),
      sampleCount: durations.length,
    };
  });
}

// ─── 3) Velocity ────────────────────────────────────────────────────────
export interface VelocityRow {
  bucket: string;           // YYYY-MM-DD or YYYY-MM
  bucketStart: number;      // epoch ms
  wonCount: number;
  lostCount: number;
  wonValueCents: number;
  lostValueCents: number;
}

/** Deals closed per time bucket (based on when stage_change moved card to a terminal column). */
export function velocity(tenantId: string, boardId: string, bucket: Bucket, win: Window = {}): VelocityRow[] {
  const db = getCrmDb();

  // Terminal columns on this board
  const terminals = db.prepare(
    'SELECT id, COALESCE(stage_type, \'open\') AS stage_type FROM crm_columns WHERE board_id = ? AND is_terminal = 1'
  ).all(boardId) as any[];
  if (terminals.length === 0) return [];
  const terminalsById = new Map<string, string>(terminals.map(t => [t.id, t.stage_type]));
  const terminalIds = Array.from(terminalsById.keys());
  const placeholders = terminalIds.map(() => '?').join(',');

  // Find stage_change activities that moved a card INTO a terminal column
  const ts = whereTs('a.created_at', win);
  const moves = db.prepare(`
    SELECT a.card_id, a.content, a.created_at, c.value_cents
    FROM crm_activities a
    JOIN crm_cards c ON c.id = a.card_id
    WHERE a.tenant_id = ?
      AND a.type = 'stage_change'
      AND c.tenant_id = ?
      AND c.board_id = ?
      ${ts.sql}
    ORDER BY a.card_id, a.created_at ASC
  `).all(tenantId, tenantId, boardId, ...ts.params) as any[];

  const moveRegex = /Movido de (\S+) para (\S+)/;
  // For each card: find the LAST move into a terminal column (closed deal).
  // If the card re-opened after (unlikely but possible), skip.
  const closedByCard = new Map<string, { stageType: string; ts: number; valueCents: number }>();
  const lastMoveByCard = new Map<string, { toColumnId: string; ts: number }>();

  for (const m of moves) {
    const match = moveRegex.exec(m.content || '');
    if (!match) continue;
    const toColumnId = match[2];
    lastMoveByCard.set(m.card_id, { toColumnId, ts: m.created_at });
  }

  for (const [cardId, last] of lastMoveByCard) {
    const stageType = terminalsById.get(last.toColumnId);
    if (!stageType || (stageType !== 'won' && stageType !== 'lost')) continue;
    const card = moves.find(x => x.card_id === cardId);
    closedByCard.set(cardId, { stageType, ts: last.ts, valueCents: card?.value_cents ?? 0 });
  }

  const byBucket = new Map<number, VelocityRow>();
  for (const [, close] of closedByCard) {
    const start = bucketStart(close.ts, bucket);
    const row = byBucket.get(start) || {
      bucket: bucketLabel(start, bucket),
      bucketStart: start,
      wonCount: 0, lostCount: 0,
      wonValueCents: 0, lostValueCents: 0,
    };
    if (close.stageType === 'won') {
      row.wonCount++;
      row.wonValueCents += close.valueCents;
    } else {
      row.lostCount++;
      row.lostValueCents += close.valueCents;
    }
    byBucket.set(start, row);
  }

  return Array.from(byBucket.values()).sort((a, b) => a.bucketStart - b.bucketStart);
}

// ─── 4) Win Rate ────────────────────────────────────────────────────────
export interface WinRateSummary {
  total: number;
  won: number;
  lost: number;
  open: number;
  winRate: number;              // won / (won + lost), 0..1
  lossRate: number;             // lost / (won + lost), 0..1
  avgDealValueCents: number;    // avg value across won cards
  avgCycleSeconds: number;      // avg time from created_at to close for won cards
  totalRevenueCents: number;    // sum of value across won cards
}

/** Win/loss rate over a time window. Uses card created_at to define membership. */
export function winRate(tenantId: string, boardId: string, win: Window = {}): WinRateSummary {
  const db = getCrmDb();
  const ts = whereTs('c.created_at', win);

  const rows = db.prepare(`
    SELECT c.id, c.value_cents, c.created_at, col.is_terminal, COALESCE(col.stage_type, 'open') AS stage_type
    FROM crm_cards c
    JOIN crm_columns col ON col.id = c.column_id
    WHERE c.tenant_id = ? AND c.board_id = ?${ts.sql}
  `).all(tenantId, boardId, ...ts.params) as any[];

  let won = 0, lost = 0, open = 0;
  let revenue = 0;
  const wonCardIds: string[] = [];
  for (const r of rows) {
    if (r.is_terminal === 1 && r.stage_type === 'won') { won++; revenue += r.value_cents; wonCardIds.push(r.id); }
    else if (r.is_terminal === 1 && r.stage_type === 'lost') lost++;
    else open++;
  }

  // Cycle time: for each won card, time from created_at to last stage_change into a won column
  let totalCycleSec = 0;
  let cycleCount = 0;
  if (wonCardIds.length > 0) {
    const placeholders = wonCardIds.map(() => '?').join(',');
    const closeTimes = db.prepare(`
      SELECT a.card_id, MAX(a.created_at) AS closed_at, c.created_at AS opened_at
      FROM crm_activities a
      JOIN crm_cards c ON c.id = a.card_id
      WHERE a.tenant_id = ? AND a.type = 'stage_change' AND a.card_id IN (${placeholders})
      GROUP BY a.card_id
    `).all(tenantId, ...wonCardIds) as any[];
    for (const ct of closeTimes) {
      if (ct.closed_at && ct.opened_at) {
        totalCycleSec += Math.max(0, Math.floor((ct.closed_at - ct.opened_at) / 1000));
        cycleCount++;
      }
    }
  }

  const closed = won + lost;
  return {
    total: rows.length,
    won, lost, open,
    winRate:  closed > 0 ? won / closed  : 0,
    lossRate: closed > 0 ? lost / closed : 0,
    avgDealValueCents: won > 0 ? Math.round(revenue / won) : 0,
    avgCycleSeconds: cycleCount > 0 ? Math.round(totalCycleSec / cycleCount) : 0,
    totalRevenueCents: revenue,
  };
}

// ─── 5) Compare (period over period) ────────────────────────────────────
export interface ComparePayload {
  current: WinRateSummary & { from?: number; to?: number };
  previous: WinRateSummary & { from?: number; to?: number };
  deltas: {
    won: number;
    lost: number;
    winRateDelta: number;              // current.winRate - previous.winRate
    revenueDeltaCents: number;         // current.totalRevenueCents - previous.totalRevenueCents
    avgDealValueDeltaCents: number;
    avgCycleSecondsDelta: number;
  };
}

export function compare(tenantId: string, boardId: string, current: Window, previous: Window): ComparePayload {
  const cur = winRate(tenantId, boardId, current);
  const prv = winRate(tenantId, boardId, previous);
  return {
    current:  { ...cur, from: current.from,  to: current.to  },
    previous: { ...prv, from: previous.from, to: previous.to },
    deltas: {
      won:  cur.won  - prv.won,
      lost: cur.lost - prv.lost,
      winRateDelta:             cur.winRate           - prv.winRate,
      revenueDeltaCents:        cur.totalRevenueCents - prv.totalRevenueCents,
      avgDealValueDeltaCents:   cur.avgDealValueCents - prv.avgDealValueCents,
      avgCycleSecondsDelta:     cur.avgCycleSeconds   - prv.avgCycleSeconds,
    },
  };
}
