/**
 * cardAgentStateStore — CRUD pras tabelas crm_card_agent_state e
 * crm_agent_metrics introduzidas na migration 004.
 *
 * card_agent_state eh 1:1 com card (PK card_id). Quando o card muda
 * de coluna ou role, atualizamos a row existente (preserva turns_count,
 * collected_data, promotion_log).
 *
 * agent_metrics eh append-only — cada evento relevante eh uma linha
 * nova. Lido pelo dashboard no PR 7. Nao ha update/delete em uso normal.
 */
import { getCrmDb } from '../schema.js';
import type {
  CardAgentState,
  CardAgentStatus,
  CardAgentPromotionEntry,
  ColumnAgentRole,
  AgentMetric,
  AgentMetricEvent,
} from '../types.js';
import { randomBytes } from 'node:crypto';

const J = {
  parse<T>(s: string | null | undefined, fallback: T): T {
    if (!s) return fallback;
    try { return JSON.parse(s) as T; } catch { return fallback; }
  },
  stringify(v: unknown): string { return JSON.stringify(v); },
};

function now(): number { return Date.now(); }
function newMetricId(): string { return 'agent_m_' + randomBytes(6).toString('hex'); }

// ─── card_agent_state ────────────────────────────────────────────────

function rowToState(r: any): CardAgentState {
  return {
    cardId: r.card_id,
    columnId: r.column_id,
    currentAgentRole: r.current_agent_role as ColumnAgentRole,
    turnsCount: r.turns_count,
    lastClientMessageAt: r.last_client_message_at ?? undefined,
    lastAgentMessageAt: r.last_agent_message_at ?? undefined,
    inactivityTimerAt: r.inactivity_timer_at ?? undefined,
    inactivityFireCount: r.inactivity_fire_count ?? 0,
    status: r.status as CardAgentStatus,
    collectedData: J.parse(r.collected_data, undefined as Record<string, unknown> | undefined),
    promotionLog: J.parse(r.promotion_log, undefined as CardAgentPromotionEntry[] | undefined),
    tenantId: r.tenant_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function getCardAgentState(cardId: string): CardAgentState | null {
  const db = getCrmDb();
  const r = db.prepare(`SELECT * FROM crm_card_agent_state WHERE card_id = ?`).get(cardId) as any;
  return r ? rowToState(r) : null;
}

interface UpsertInput {
  cardId: string;
  columnId: string;
  currentAgentRole: ColumnAgentRole;
  tenantId: string;
  // optional patches
  turnsCount?: number;
  lastClientMessageAt?: number;
  lastAgentMessageAt?: number;
  inactivityTimerAt?: number | null;
  inactivityFireCount?: number;
  status?: CardAgentStatus;
  collectedData?: Record<string, unknown>;
  promotionLog?: CardAgentPromotionEntry[];
}

/**
 * Insert se nao existir, update se existir. Os campos colunaId e role
 * sao reescritos pra refletir o estado atual (importante quando o card
 * eh promovido — o estado MIGRA pra nova coluna na mesma row).
 */
export function upsertCardAgentState(input: UpsertInput): CardAgentState {
  const db = getCrmDb();
  const existing = getCardAgentState(input.cardId);
  const ts = now();
  if (existing) {
    const merged: CardAgentState = {
      ...existing,
      columnId: input.columnId,
      currentAgentRole: input.currentAgentRole,
      tenantId: input.tenantId,
      turnsCount: input.turnsCount ?? existing.turnsCount,
      lastClientMessageAt: input.lastClientMessageAt ?? existing.lastClientMessageAt,
      lastAgentMessageAt: input.lastAgentMessageAt ?? existing.lastAgentMessageAt,
      inactivityTimerAt: input.inactivityTimerAt === null
        ? undefined
        : (input.inactivityTimerAt ?? existing.inactivityTimerAt),
      status: input.status ?? existing.status,
      collectedData: input.collectedData ?? existing.collectedData,
      promotionLog: input.promotionLog ?? existing.promotionLog,
      updatedAt: ts,
    };
    merged.inactivityFireCount = input.inactivityFireCount ?? existing.inactivityFireCount ?? 0;
    db.prepare(`
      UPDATE crm_card_agent_state SET
        column_id = ?, current_agent_role = ?, tenant_id = ?,
        turns_count = ?, last_client_message_at = ?, last_agent_message_at = ?,
        inactivity_timer_at = ?, inactivity_fire_count = ?, status = ?,
        collected_data = ?, promotion_log = ?,
        updated_at = ?
      WHERE card_id = ?
    `).run(
      merged.columnId, merged.currentAgentRole, merged.tenantId,
      merged.turnsCount, merged.lastClientMessageAt ?? null, merged.lastAgentMessageAt ?? null,
      merged.inactivityTimerAt ?? null, merged.inactivityFireCount, merged.status,
      merged.collectedData ? J.stringify(merged.collectedData) : null,
      merged.promotionLog ? J.stringify(merged.promotionLog) : null,
      merged.updatedAt, merged.cardId,
    );
    return merged;
  }
  const fresh: CardAgentState = {
    cardId: input.cardId,
    columnId: input.columnId,
    currentAgentRole: input.currentAgentRole,
    turnsCount: input.turnsCount ?? 0,
    lastClientMessageAt: input.lastClientMessageAt,
    lastAgentMessageAt: input.lastAgentMessageAt,
    inactivityTimerAt: input.inactivityTimerAt ?? undefined,
    inactivityFireCount: input.inactivityFireCount ?? 0,
    status: input.status ?? 'active',
    collectedData: input.collectedData,
    promotionLog: input.promotionLog,
    tenantId: input.tenantId,
    createdAt: ts,
    updatedAt: ts,
  };
  db.prepare(`
    INSERT INTO crm_card_agent_state (
      card_id, column_id, current_agent_role,
      turns_count, last_client_message_at, last_agent_message_at,
      inactivity_timer_at, inactivity_fire_count, status, collected_data, promotion_log,
      tenant_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    fresh.cardId, fresh.columnId, fresh.currentAgentRole,
    fresh.turnsCount, fresh.lastClientMessageAt ?? null, fresh.lastAgentMessageAt ?? null,
    fresh.inactivityTimerAt ?? null, fresh.inactivityFireCount, fresh.status,
    fresh.collectedData ? J.stringify(fresh.collectedData) : null,
    fresh.promotionLog ? J.stringify(fresh.promotionLog) : null,
    fresh.tenantId, fresh.createdAt, fresh.updatedAt,
  );
  return fresh;
}

/**
 * Incrementa turns_count atomicamente e atualiza timestamps.
 *
 * Onda 62 PR 4: side='client' tambem RESETA o timer de inatividade (re-arma
 * com agent_inactivity_timeout_minutes da coluna ATUAL via JOIN) E zera
 * inactivity_fire_count. Tudo numa unica UPDATE — sem janela de race
 * onde cliente responde mas o timer ja apontava pro passado.
 */
export function recordAgentTurn(cardId: string, side: 'client' | 'agent'): void {
  const db = getCrmDb();
  const ts = now();
  if (side === 'client') {
    db.prepare(`
      UPDATE crm_card_agent_state SET
        turns_count = turns_count + 1,
        last_client_message_at = ?,
        inactivity_timer_at = ? + COALESCE(
          (SELECT agent_inactivity_timeout_minutes FROM crm_columns WHERE id = column_id),
          20
        ) * 60000,
        inactivity_fire_count = 0,
        updated_at = ?
      WHERE card_id = ?
    `).run(ts, ts, ts, cardId);
  } else {
    db.prepare(`
      UPDATE crm_card_agent_state SET
        last_agent_message_at = ?,
        updated_at = ?
      WHERE card_id = ?
    `).run(ts, ts, cardId);
  }
}

/** Incrementa o contador de disparos de inatividade. Retorna o novo valor. */
export function incrementInactivityFireCount(cardId: string): number {
  const db = getCrmDb();
  db.prepare(`
    UPDATE crm_card_agent_state SET
      inactivity_fire_count = inactivity_fire_count + 1,
      updated_at = ?
    WHERE card_id = ?
  `).run(now(), cardId);
  const r = db.prepare(`SELECT inactivity_fire_count FROM crm_card_agent_state WHERE card_id = ?`)
    .get(cardId) as { inactivity_fire_count?: number } | undefined;
  return r?.inactivity_fire_count ?? 0;
}

/** Limpa o timer (e.g., apos card promovido — proxima coluna re-arma se quiser). */
export function clearInactivityTimer(cardId: string): void {
  const db = getCrmDb();
  db.prepare(`
    UPDATE crm_card_agent_state SET
      inactivity_timer_at = NULL,
      inactivity_fire_count = 0,
      updated_at = ?
    WHERE card_id = ?
  `).run(now(), cardId);
}

export function setCardAgentStatus(cardId: string, status: CardAgentStatus): void {
  const db = getCrmDb();
  db.prepare(`
    UPDATE crm_card_agent_state SET status = ?, updated_at = ? WHERE card_id = ?
  `).run(status, now(), cardId);
}

// ─── agent_metrics (append-only) ─────────────────────────────────────

export interface RecordMetricInput {
  tenantId: string;
  columnId: string;
  cardId: string;
  event: AgentMetricEvent;
  reason?: string;
  durationInColumnSeconds?: number;
  turnsInColumn?: number;
}

export function recordAgentMetric(input: RecordMetricInput): AgentMetric {
  const db = getCrmDb();
  const m: AgentMetric = {
    id: newMetricId(),
    tenantId: input.tenantId,
    columnId: input.columnId,
    cardId: input.cardId,
    event: input.event,
    reason: input.reason,
    durationInColumnSeconds: input.durationInColumnSeconds,
    turnsInColumn: input.turnsInColumn,
    occurredAt: now(),
  };
  db.prepare(`
    INSERT INTO crm_agent_metrics (
      id, tenant_id, column_id, card_id, event, reason,
      duration_in_column_seconds, turns_in_column, occurred_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    m.id, m.tenantId, m.columnId, m.cardId, m.event, m.reason ?? null,
    m.durationInColumnSeconds ?? null, m.turnsInColumn ?? null, m.occurredAt,
  );
  return m;
}

export function listAgentMetricsForCard(cardId: string, limit = 200): AgentMetric[] {
  const db = getCrmDb();
  const rows = db.prepare(`
    SELECT * FROM crm_agent_metrics WHERE card_id = ? ORDER BY occurred_at DESC LIMIT ?
  `).all(cardId, limit) as any[];
  return rows.map((r) => ({
    id: r.id, tenantId: r.tenant_id, columnId: r.column_id, cardId: r.card_id,
    event: r.event as AgentMetricEvent, reason: r.reason ?? undefined,
    durationInColumnSeconds: r.duration_in_column_seconds ?? undefined,
    turnsInColumn: r.turns_in_column ?? undefined,
    occurredAt: r.occurred_at,
  }));
}
