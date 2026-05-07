/**
 * healthMetrics — snapshot de saúde do System Clow.
 *
 * Daniel 2026-05-07 (Fase 3 do plano de hardening): visibilidade do
 * estado da pipeline + qualidade dos bots. Roda a cada 5 min no
 * scheduler do worker 0 e loga JSON estruturado. Também exposto via
 * endpoint HTTP `/health/clow-dashboard`.
 *
 * Métricas:
 *  - cards_waiting_client_reply: cards onde cliente respondeu por
 *    último e bot está demorando (>30min, >2h)
 *  - blocks_24h: contagem dos bloqueios do outputValidator por reason
 *  - tool_failures_24h: tools falhando por name
 *  - meta_blocked_24h: meta-commentary bloqueado pelo regex
 *  - bursts_60s_24h: 2 outbounds do bot em <60s pro mesmo card
 *  - column_load: cards ativos por coluna (Atendimento, Lançar venda,
 *    Aguardando pagamento, Clientes Pagos, Follow Up)
 *  - last_ticks: histórico dos últimos 5 ticks via crm_agent_metrics
 */

import { getCrmDb } from '../schema.js';
import { logger } from '../../utils/logger.js';

const PV_TENANT = 'be5f5042-d939-447d-8777-5ac841e7aa07';
const PV_BOARD = 'crm_board_048c4738a15b';

export interface ClowHealthSnapshot {
  collected_at: string;
  tenant_id: string;
  cards_waiting_client_reply: {
    total: number;
    over_30min: number;
    over_2h: number;
    over_24h: number;
    sample_titles_over_30min: string[];
  };
  column_load: Array<{ name: string; cards: number; agent_enabled: boolean }>;
  validator_blocks_24h: Record<string, number>;
  tool_failures_24h: Record<string, number>;
  meta_commentary_blocked_24h: number;
  bursts_outbound_60s_24h: {
    total_messages: number;
    affected_cards: number;
  };
  pipeline_summary: {
    new_cards_24h: number;
    promoted_to_lancar_venda_24h: number;
    moved_to_followup_24h: number;
    marked_lost_24h: number;
  };
  alerts: string[];
}

/** Coleta o snapshot completo de saúde. Síncrono — usa better-sqlite3
 *  bindings. Retorna em <100ms mesmo com milhares de cards. */
export function collectClowHealthSnapshot(tenantId = PV_TENANT): ClowHealthSnapshot {
  const db = getCrmDb();
  const now = Date.now();
  const _30min = now - 30 * 60_000;
  const _2h = now - 2 * 60 * 60_000;
  const _24h = now - 24 * 60 * 60_000;

  // ─── Cards aguardando resposta do bot ────────────────────────────
  // Cliente mandou last (last_inbound_at > last_bot_message_at) e bot não respondeu.
  const waitingRows = db.prepare(`
    SELECT c.id, c.title, c.last_inbound_at as last_in,
           COALESCE(c.last_bot_message_at, 0) as last_bot
    FROM crm_cards c
    JOIN crm_columns col ON col.id = c.column_id
    WHERE c.tenant_id = ?
      AND c.deleted_at IS NULL
      AND (c.status IS NULL OR c.status = 'active')
      AND col.agent_enabled = 1
      AND c.last_inbound_at IS NOT NULL
      AND c.last_inbound_at > COALESCE(c.last_bot_message_at, 0)
  `).all(tenantId) as Array<{ id: string; title: string; last_in: number; last_bot: number }>;

  let over30 = 0, over2h = 0, over24h = 0;
  const sample30: string[] = [];
  for (const r of waitingRows) {
    if (r.last_in <= _30min) over30++;
    if (r.last_in <= _2h) over2h++;
    if (r.last_in <= _24h) over24h++;
    if (r.last_in <= _30min && sample30.length < 5) sample30.push(r.title);
  }

  // ─── Carga por coluna ────────────────────────────────────────────
  const columnRows = db.prepare(`
    SELECT col.name, col.agent_enabled,
           (SELECT COUNT(*) FROM crm_cards c
            WHERE c.column_id = col.id
              AND c.deleted_at IS NULL
              AND (c.status IS NULL OR c.status = 'active')) as cards
    FROM crm_columns col
    WHERE col.board_id = ?
    ORDER BY col.position
  `).all(PV_BOARD) as Array<{ name: string; agent_enabled: number; cards: number }>;

  // ─── Bloqueios do validator nas últimas 24h ──────────────────────
  // event=blocked com reason começando com 'output_validator_'
  const validatorRows = db.prepare(`
    SELECT reason, COUNT(*) as n
    FROM crm_agent_metrics
    WHERE tenant_id = ?
      AND event = 'blocked'
      AND occurred_at >= ?
      AND reason LIKE 'output_validator_%'
    GROUP BY reason
  `).all(tenantId, _24h) as Array<{ reason: string; n: number }>;
  const validatorBlocks: Record<string, number> = {};
  for (const r of validatorRows) {
    // reason exemplo: 'output_validator_price_off_table'
    const key = r.reason.replace(/^output_validator_/, '').replace(/_persistent.*$|_inactivity.*$/, '');
    validatorBlocks[key] = (validatorBlocks[key] ?? 0) + r.n;
  }

  // ─── Tool failures nas últimas 24h ───────────────────────────────
  const toolFailRows = db.prepare(`
    SELECT reason, COUNT(*) as n
    FROM crm_agent_metrics
    WHERE tenant_id = ?
      AND event = 'tool_failed'
      AND occurred_at >= ?
    GROUP BY reason
    ORDER BY n DESC
    LIMIT 20
  `).all(tenantId, _24h) as Array<{ reason: string; n: number }>;
  const toolFailures: Record<string, number> = {};
  for (const r of toolFailRows) {
    // Extrai só o nome da tool: "tool=X args_keys=[...] ok=false"
    const m = r.reason.match(/tool=([\w_]+)/);
    const name = m ? m[1]! : r.reason.slice(0, 40);
    toolFailures[name] = (toolFailures[name] ?? 0) + r.n;
  }

  // ─── Meta-commentary blocked 24h ─────────────────────────────────
  const metaBlocked = db.prepare(`
    SELECT COUNT(*) as n FROM crm_agent_metrics
    WHERE tenant_id = ?
      AND event = 'blocked'
      AND occurred_at >= ?
      AND (reason = 'meta_commentary' OR reason = 'meta_commentary_inactivity')
  `).get(tenantId, _24h) as { n: number };

  // ─── Bursts outbound 60s nas últimas 24h ─────────────────────────
  const burstsRow = db.prepare(`
    SELECT COUNT(*) as msgs, COUNT(DISTINCT card_id) as cards
    FROM crm_activities a
    WHERE a.tenant_id = ?
      AND a.type = 'message_out'
      AND a.created_at >= ?
      AND EXISTS (
        SELECT 1 FROM crm_activities a2
        WHERE a2.card_id = a.card_id
          AND a2.type = 'message_out'
          AND a2.id != a.id
          AND ABS(a2.created_at - a.created_at) < 60000
      )
  `).get(tenantId, _24h) as { msgs: number; cards: number };

  // ─── Pipeline summary 24h ────────────────────────────────────────
  const newCards = db.prepare(`
    SELECT COUNT(*) as n FROM crm_cards
    WHERE tenant_id = ? AND created_at >= ? AND deleted_at IS NULL
  `).get(tenantId, _24h) as { n: number };

  // Promovidos pra Lançar venda — via stage_change activity
  const promotedRow = db.prepare(`
    SELECT COUNT(*) as n FROM crm_activities
    WHERE tenant_id = ? AND created_at >= ?
      AND type = 'stage_change'
      AND content LIKE '%Lançar venda%' COLLATE NOCASE
  `).get(tenantId, _24h) as { n: number };

  const followupRow = db.prepare(`
    SELECT COUNT(*) as n FROM crm_activities
    WHERE tenant_id = ? AND created_at >= ?
      AND type = 'stage_change'
      AND content LIKE '%Follow Up%'
  `).get(tenantId, _24h) as { n: number };

  const lostRow = db.prepare(`
    SELECT COUNT(*) as n FROM crm_agent_metrics
    WHERE tenant_id = ? AND occurred_at >= ?
      AND event = 'lost'
  `).get(tenantId, _24h) as { n: number };

  // ─── Alertas críticos ────────────────────────────────────────────
  const alerts: string[] = [];
  if (over2h > 0) {
    alerts.push(`⚠ ${over2h} cliente(s) esperando bot há mais de 2h`);
  }
  if (over24h > 0) {
    alerts.push(`🔴 ${over24h} cliente(s) esperando bot há mais de 24h`);
  }
  const totalValidatorBlocks = Object.values(validatorBlocks).reduce((a, b) => a + b, 0);
  if (totalValidatorBlocks > 20) {
    alerts.push(`⚠ ${totalValidatorBlocks} bloqueios do validator nas últimas 24h — bot vazando muito`);
  }
  if (metaBlocked.n > 30) {
    alerts.push(`⚠ ${metaBlocked.n} meta-commentary bloqueados nas últimas 24h — adicionar patterns`);
  }
  if (burstsRow.msgs > 20) {
    alerts.push(`⚠ ${burstsRow.msgs} mensagens em rajada nas últimas 24h (${burstsRow.cards} cards)`);
  }
  const atendimentoLoad = columnRows.find((r) => r.name === 'Atendimento')?.cards ?? 0;
  if (atendimentoLoad > 100) {
    alerts.push(`⚠ Atendimento com ${atendimentoLoad} cards ativos — fila acumulando`);
  }

  return {
    collected_at: new Date(now).toISOString(),
    tenant_id: tenantId,
    cards_waiting_client_reply: {
      total: waitingRows.length,
      over_30min: over30,
      over_2h: over2h,
      over_24h: over24h,
      sample_titles_over_30min: sample30,
    },
    column_load: columnRows.map((r) => ({
      name: r.name,
      cards: r.cards,
      agent_enabled: r.agent_enabled === 1,
    })),
    validator_blocks_24h: validatorBlocks,
    tool_failures_24h: toolFailures,
    meta_commentary_blocked_24h: metaBlocked.n,
    bursts_outbound_60s_24h: {
      total_messages: burstsRow.msgs,
      affected_cards: burstsRow.cards,
    },
    pipeline_summary: {
      new_cards_24h: newCards.n,
      promoted_to_lancar_venda_24h: promotedRow.n,
      moved_to_followup_24h: followupRow.n,
      marked_lost_24h: lostRow.n,
    },
    alerts,
  };
}

/** Loga snapshot resumido em formato pronto pra grep. Chamado pelo
 *  scheduler (worker 0) a cada 5 min. Linhas curtas, sem dump completo
 *  do snapshot — pra dump completo use o endpoint HTTP. */
export function logHealthSnapshot(): void {
  try {
    const snap = collectClowHealthSnapshot();
    const summary = [
      `waiting=${snap.cards_waiting_client_reply.total} (>30m=${snap.cards_waiting_client_reply.over_30min}, >2h=${snap.cards_waiting_client_reply.over_2h})`,
      `validator_blocks=${Object.values(snap.validator_blocks_24h).reduce((a, b) => a + b, 0)}`,
      `meta_blocked=${snap.meta_commentary_blocked_24h}`,
      `tool_fails=${Object.values(snap.tool_failures_24h).reduce((a, b) => a + b, 0)}`,
      `bursts=${snap.bursts_outbound_60s_24h.total_messages}`,
      `promoted=${snap.pipeline_summary.promoted_to_lancar_venda_24h}`,
      `lost=${snap.pipeline_summary.marked_lost_24h}`,
    ].join(' ');
    logger.info(`[clow-health] ${summary}`);
    for (const alert of snap.alerts) {
      logger.warn(`[clow-health] ${alert}`);
    }
  } catch (err: any) {
    logger.warn('[clow-health] snapshot falhou:', err?.message);
  }
}
