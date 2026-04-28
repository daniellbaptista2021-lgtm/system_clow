/**
 * inactivityScheduler — varre cards com timer de inatividade vencido e
 * dispara o agente de coluna pra agir (cobrar, marcar morno, promover
 * com tag 'frio', ou marcar perdido).
 *
 * Roda como sub-tick do scheduler central (a cada 30s) — gated por
 * isSchedulerWorker() (NODE_APP_INSTANCE === '0' em PM2 cluster).
 *
 * Cluster-safety em camadas:
 *   1. Worker gate — so worker 0 chama tickInactivity()
 *   2. Per-card lock via clusterStore.setNxEx(crm:inact:fire:{cardId}, 120s)
 *      — defesa adicional caso CLOW_FORCE_SCHEDULER seja usado em prod
 *      ou alguem mude o gate.
 *
 * Fluxo de cada disparo:
 *   1. SELECT cards elegiveis (status=active, timer vencido, agente ativo)
 *   2. Pra cada card:
 *      a. Tenta lock distribuido — falhou: skip silencioso
 *      b. Checa horario ativo do card (timezone BR) — fora: postpone
 *         pra proximo dia inicio
 *      c. Incrementa fire_count atomico
 *      d. Se fire_count >= 3: forca marcar_morno + clear timer + return
 *      e. Senao: dispatcha runFromInactivityFire(card, fireCount)
 *      f. NAO limpa timer apos run — runner.recordAgentTurn('agent') ja
 *         atualizou o estado, e proximo client msg re-arma via JOIN.
 *         Se cliente nao responder, timer nao re-arma; novo fire so se
 *         agente setar manualmente um followup.
 *
 * Scheduler nao bloqueia o tick se um card demora — usa Promise.allSettled
 * com timeout por card (60s).
 */
import { logger } from '../../utils/logger.js';
import { getCluster } from '../../utils/clusterStore.js';
import { getCrmDb } from '../schema.js';
import * as store from '../store.js';
import {
  incrementInactivityFireCount,
  upsertCardAgentState,
  recordAgentMetric,
  clearInactivityTimer,
} from '../store/cardAgentStateStore.js';
import { runFromInactivityFire } from './columnAgentRunner.js';
import { getCurrentHourMinuteBRT, isWithinActiveHours } from './columnAgentRunner.js';
import type { Channel2 } from '../types.js';

const INACTIVITY_LOCK_TTL_S = 120; // 2 min: budget pra LLM + send
const PER_CARD_TIMEOUT_MS = 60_000;
const MAX_CARDS_PER_TICK = 50;
const FIRE_COUNT_FORCE_MORNO = 3; // 3a vez = morno automatico

interface EligibleRow {
  card_id: string;
  column_id: string;
  tenant_id: string;
  inactivity_timer_at: number;
  inactivity_fire_count: number;
  turns_count: number;
  hours_start: string;
  hours_end: string;
  board_id: string;
}

/** Busca cards com timer vencido e agente de coluna ativo. */
export function findEligibleCards(nowMs = Date.now()): EligibleRow[] {
  const db = getCrmDb();
  return db.prepare(`
    SELECT
      cas.card_id          AS card_id,
      cas.column_id        AS column_id,
      cas.tenant_id        AS tenant_id,
      cas.inactivity_timer_at AS inactivity_timer_at,
      cas.inactivity_fire_count AS inactivity_fire_count,
      cas.turns_count      AS turns_count,
      c.agent_active_hours_start AS hours_start,
      c.agent_active_hours_end   AS hours_end,
      c.board_id           AS board_id
    FROM crm_card_agent_state cas
    JOIN crm_columns c ON c.id = cas.column_id
    WHERE cas.status = 'active'
      AND cas.inactivity_timer_at IS NOT NULL
      AND cas.inactivity_timer_at <= ?
      AND c.agent_enabled = 1
    ORDER BY cas.inactivity_timer_at ASC
    LIMIT ?
  `).all(nowMs, MAX_CARDS_PER_TICK) as any as EligibleRow[];
}

/**
 * Posterga o timer pra proxima janela ativa. Hoje considera 24h (sem
 * weekend exclusion). Se now=23:30 e janela=08:00-21:00, retorna
 * tomorrow 08:00 BRT em ms UTC.
 */
export function computeNextActiveStart(hoursStart: string, _hoursEnd: string): number {
  const [sh, sm] = hoursStart.split(':').map((s) => Number(s) || 0);
  // Pega "agora" em BRT pra calcular "amanha"
  const fmt = new Intl.DateTimeFormat('en-CA', { // 'en-CA' formato YYYY-MM-DD
    timeZone: 'America/Sao_Paulo',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const todayBRT = fmt.format(new Date()); // ex "2026-04-28"
  const [y, m, d] = todayBRT.split('-').map(Number);
  // Tomorrow BRT
  const tomorrow = new Date(Date.UTC(y, m - 1, d + 1, sh + 3, sm, 0)); // BRT = UTC-3
  return tomorrow.getTime();
}

/**
 * Tick — chamado pelo scheduler central a cada 30s no worker 0.
 * Idempotente, sem efeitos colaterais visiveis se nao houver cards
 * elegiveis.
 */
export async function tickInactivity(): Promise<{ processed: number; skipped: number }> {
  const eligible = findEligibleCards();
  if (eligible.length === 0) return { processed: 0, skipped: 0 };

  let processed = 0;
  let skipped = 0;
  const cluster = await getCluster();

  // Promise.allSettled — uma falha nao derruba o tick
  await Promise.allSettled(eligible.map(async (row) => {
    const lockKey = `crm:inact:fire:${row.card_id}`;
    const ok = await cluster.setNxEx(lockKey, '1', INACTIVITY_LOCK_TTL_S);
    if (!ok) { skipped++; return; }

    try {
      const result = await Promise.race([
        processOneCard(row),
        new Promise<'timeout'>((res) => setTimeout(() => res('timeout'), PER_CARD_TIMEOUT_MS)),
      ]);
      if (result === 'timeout') {
        logger.warn(`[inact-sched] card=${row.card_id} TIMEOUT — skipping`);
        skipped++;
      } else {
        processed++;
      }
    } catch (err: any) {
      logger.error(`[inact-sched] card=${row.card_id} fail:`, err?.message);
      skipped++;
    }
  }));

  if (processed > 0 || skipped > 0) {
    logger.info(`[inact-sched] tick processed=${processed} skipped=${skipped}`);
  }
  return { processed, skipped };
}

async function processOneCard(row: EligibleRow): Promise<'done'> {
  // 1) Horario ativo? Se nao, posterga
  if (!isWithinActiveHours(row.hours_start || '08:00', row.hours_end || '21:00', getCurrentHourMinuteBRT())) {
    const nextStart = computeNextActiveStart(row.hours_start || '08:00', row.hours_end || '21:00');
    upsertCardAgentState({
      cardId: row.card_id, columnId: row.column_id,
      currentAgentRole: 'custom', // role atual no DB nao muda — upsert preserva
      tenantId: row.tenant_id,
      inactivityTimerAt: nextStart,
    });
    logger.info(`[inact-sched] card=${row.card_id} OUT_OF_HOURS — postponed to ${new Date(nextStart).toISOString()}`);
    return 'done';
  }

  // 2) Incrementa fire_count atomico
  const newCount = incrementInactivityFireCount(row.card_id);
  const elapsedMs = Date.now() - (row.inactivity_timer_at || Date.now());
  const elapsedMin = Math.round(elapsedMs / 60000);

  // 3) Limite: 3a vez forca morno + clear timer (sem LLM)
  if (newCount >= FIRE_COUNT_FORCE_MORNO) {
    forceMornoNoLLM(row, newCount);
    return 'done';
  }

  // 4) Resolve channel + card pra dispatchar pro runner
  const card = store.getCard(row.tenant_id, row.card_id);
  if (!card) {
    logger.warn(`[inact-sched] card=${row.card_id} NOT_FOUND — clearing timer`);
    clearInactivityTimer(row.card_id);
    return 'done';
  }
  const channel = pickChannelForCard(row.tenant_id, card);
  if (!channel) {
    logger.warn(`[inact-sched] card=${row.card_id} no_channel — clearing timer`);
    clearInactivityTimer(row.card_id);
    return 'done';
  }
  const cols = store.listColumns(row.tenant_id, card.boardId!);
  const column = cols.find((c) => c.id === row.column_id);
  if (!column) {
    logger.warn(`[inact-sched] card=${row.card_id} column_gone — clearing timer`);
    clearInactivityTimer(row.card_id);
    return 'done';
  }

  // 5) Metric + dispatch
  recordAgentMetric({
    tenantId: row.tenant_id, columnId: row.column_id, cardId: row.card_id,
    event: 'inactive_timeout',
    reason: `fire_count=${newCount} elapsed_min=${elapsedMin}`,
    turnsInColumn: row.turns_count,
  });
  await runFromInactivityFire({
    channel, card, column,
    fireCount: newCount,
    elapsedMin,
  });
  return 'done';
}

/** 3a vez seguida sem resposta: forca marcar_morno SEM chamar LLM. */
function forceMornoNoLLM(row: EligibleRow, fireCount: number): void {
  // Tag 'morno' no contato
  const card = store.getCard(row.tenant_id, row.card_id);
  if (card?.contactId) {
    const c = store.getContact?.(row.tenant_id, card.contactId);
    if (c) {
      const newTags = Array.from(new Set([...(c.tags ?? []), 'morno']));
      try { store.updateContact(row.tenant_id, c.id, { tags: newTags }); }
      catch (err: any) { logger.warn('[inact-sched.forceMorno] updateContact fail:', err?.message); }
    }
  }
  // Reagenda pra D+2 (default morno) E reseta fire_count
  upsertCardAgentState({
    cardId: row.card_id, columnId: row.column_id,
    currentAgentRole: 'custom', tenantId: row.tenant_id,
    inactivityTimerAt: Date.now() + 2 * 24 * 60 * 60 * 1000,
    inactivityFireCount: 0,
    status: 'paused', // pausa o agente — reativacao manual ou na D+2
  });
  recordAgentMetric({
    tenantId: row.tenant_id, columnId: row.column_id, cardId: row.card_id,
    event: 'inactive_timeout',
    reason: `forced_morno fire_count=${fireCount}`,
    turnsInColumn: row.turns_count,
  });
  logger.info(`[inact-sched] card=${row.card_id} FORCED_MORNO (fire_count=${fireCount})`);
}

/** Heuristica: pega o canal mais "vivo" do tenant que faz match com o
 *  contato. Pra MVP usamos o primeiro canal active. PR futuro pode
 *  rastrear qual canal o cliente USOU originalmente (via activity log). */
function pickChannelForCard(tenantId: string, card: any): Channel2 | null {
  const channels = store.listChannels(tenantId);
  return channels.find((c: any) => c.status === 'active' && (c.type === 'zapi' || c.type === 'meta'))
    ?? channels[0]
    ?? null;
}
