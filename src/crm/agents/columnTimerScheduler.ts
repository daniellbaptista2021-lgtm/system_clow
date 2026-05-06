/**
 * columnTimerScheduler — funil v2 timer-driven (PR 7.0).
 *
 * Roda como sub-tick do scheduler central a cada 60 segundos. Gated por
 * isSchedulerWorker() (so worker 0 em PM2 cluster).
 *
 * 3 categorias de disparo:
 *
 *   A) ENTRY_DELAY: card recem-promovido pra coluna com agent_entry_delay_minutes
 *      > 0. Apos N min sem mensagem do bot, dispara o agente pra mandar a
 *      mensagem inicial ([SYSTEM:entry_message]).
 *
 *   B) NO_RESPONSE_CHASE: bot mandou msg, cliente nao respondeu. Conforme
 *      passa o tempo, dispara cobrancas escalonadas configuradas em
 *      agent_no_response_chase_steps_json (ex: [30, 120, 360] minutos).
 *
 *   C) FOLLOWUP_STEPS: card na coluna "Follow Up". Dispara mensagens
 *      escalonadas conforme agent_followup_steps_hours_json (ex: [24, 48, 72]
 *      horas). Apos step 3 + 24h sem resposta, dispara final_delete.
 *
 * Cada disparo usa cluster.setNxEx pra evitar duplicacao multi-worker.
 *
 * Limite global: 50 cards processados por categoria por tick.
 */
import { logger } from '../../utils/logger.js';
import { getCluster } from '../../utils/clusterStore.js';
import { getCrmDb } from '../schema.js';
import * as store from '../store.js';
import { applyTagSystem, cardHasTag } from './tools/tags.js';
import { runFromInactivityFire } from './columnAgentRunner.js';
import type { Card, BoardColumn, Channel2 } from '../types.js';

const LOCK_TTL_S = 120;
const MAX_PER_CATEGORY = 50;

interface CardColumnRow {
  card_id: string;
  card_title: string;
  card_board_id: string;
  contact_id: string | null;
  column_id: string;
  column_name: string;
  agent_role: string | null;
  agent_role_type: string | null;
  agent_entry_delay_minutes: number | null;
  agent_no_response_chase_steps_json: string | null;
  agent_followup_steps_hours_json: string | null;
  last_bot_message_at: number | null;
  last_client_message_at: number | null;
  column_changed_at: number | null;
  followup_origin_column_id: string | null;
}

function loadFullCard(row: CardColumnRow): { card: Card; column: BoardColumn } | null {
  try {
    const db = getCrmDb();
    const cardRow = db.prepare(`SELECT * FROM crm_cards WHERE id = ?`).get(row.card_id) as any;
    const colRow = db.prepare(`SELECT * FROM crm_columns WHERE id = ?`).get(row.column_id) as any;
    if (!cardRow || !colRow) return null;
    // Adapta pra interfaces (nao tem hydrater publico — uso minimal)
    const card: Card = {
      id: cardRow.id, tenantId: cardRow.tenant_id, boardId: cardRow.board_id,
      columnId: cardRow.column_id, title: cardRow.title, description: cardRow.description,
      contactId: cardRow.contact_id, ownerAgentId: cardRow.owner_agent_id,
      valueCents: cardRow.value_cents ?? 0, probability: cardRow.probability ?? 0,
      labels: [], dueDate: cardRow.due_date, position: cardRow.position ?? 0,
      customFields: {}, createdAt: cardRow.created_at, updatedAt: cardRow.updated_at,
      lastActivityAt: cardRow.last_activity_at, unreadCount: cardRow.unread_count ?? 0,
      lastInboundAt: cardRow.last_inbound_at,
      lastBotMessageAt: cardRow.last_bot_message_at,
      lastClientMessageAt: cardRow.last_client_message_at,
      followupOriginColumnId: cardRow.followup_origin_column_id,
      columnChangedAt: cardRow.column_changed_at,
    };
    const column: BoardColumn = {
      id: colRow.id, boardId: colRow.board_id, name: colRow.name,
      position: colRow.position, color: colRow.color,
      createdAt: colRow.created_at,
      agentEnabled: !!colRow.agent_enabled, agentName: colRow.agent_name,
      agentSystemPrompt: colRow.agent_system_prompt,
      agentRole: colRow.agent_role,
      agentRoleType: colRow.agent_role_type,
      agentPromoteToColumnId: colRow.agent_promote_to_column_id,
      agentInactivityTimeoutMinutes: colRow.agent_inactivity_timeout_minutes,
      agentMaxTurns: colRow.agent_max_turns,
      agentActiveHoursStart: colRow.agent_active_hours_start,
      agentActiveHoursEnd: colRow.agent_active_hours_end,
      agentPromotionCriteria: colRow.agent_promotion_criteria,
      agentEntryDelayMinutes: colRow.agent_entry_delay_minutes,
      agentNoResponseChaseStepsJson: colRow.agent_no_response_chase_steps_json,
      agentFollowupStepsHoursJson: colRow.agent_followup_steps_hours_json,
    };
    return { card, column };
  } catch {
    return null;
  }
}

function pickChannel(tenantId: string): Channel2 | null {
  try {
    const channels = store.listChannels(tenantId).filter((c) => c.status === 'active');
    return (channels[0] as any) ?? null;
  } catch {
    return null;
  }
}

// ─── A) ENTRY_DELAY ────────────────────────────────────────────────────────

/** Cards onde column tem entry_delay > 0, e ja passou esse tempo desde
 *  card chegar na coluna, e bot ainda nao mandou msg desde column_changed. */
export function findEntryDelayCards(nowMs = Date.now()): CardColumnRow[] {
  const db = getCrmDb();
  return db.prepare(`
    SELECT
      c.id AS card_id, c.title AS card_title, c.board_id AS card_board_id,
      c.contact_id, c.column_id,
      c.last_bot_message_at, c.last_client_message_at,
      c.column_changed_at, c.followup_origin_column_id,
      col.name AS column_name,
      col.agent_role, col.agent_role_type,
      col.agent_entry_delay_minutes,
      col.agent_no_response_chase_steps_json,
      col.agent_followup_steps_hours_json
    FROM crm_cards c
    JOIN crm_columns col ON col.id = c.column_id
    WHERE col.agent_enabled = 1
      AND col.agent_role IS NOT NULL
      AND COALESCE(col.agent_entry_delay_minutes, 0) > 0
      AND c.column_changed_at IS NOT NULL
      AND (c.column_changed_at + (col.agent_entry_delay_minutes * 60000)) <= ?
      AND (c.last_bot_message_at IS NULL OR c.last_bot_message_at < c.column_changed_at)
    LIMIT ?
  `).all(nowMs, MAX_PER_CATEGORY) as CardColumnRow[];
}

// ─── A.2) UNRESPONDED INBOUND (safety net) ────────────────────────────────
//
// Daniel 2026-05-05: cliente mandou msg, bot deveria responder via fluxo
// inbound (handleInboundForAI), mas algo crashou (worker reload, LLM timeout,
// etc). Sem essa rede, o card fica orfao: chase nao pega (last_bot IS NULL),
// entry_delay nao pega (Lead tem delay=0).
//
// Critério: agente ativo + cliente mandou msg ha >= UNRESPONDED_GRACE_MIN
// minutos e o bot ainda nao respondeu (last_bot < last_in OR IS NULL).
// Lock por (cardId + last_inbound_at) — TTL 24h evita flood; novo inbound
// gera nova chave automaticamente.

const UNRESPONDED_GRACE_MIN = 3; // tempo de tolerancia pro fluxo normal completar (debounce 8s + LLM ate 30s)
const UNRESPONDED_LOCK_TTL_S = 24 * 60 * 60;

export interface UnrespondedFire {
  row: CardColumnRow;
  lastInboundAt: number;
}

export function findUnrespondedInboundCards(nowMs = Date.now()): UnrespondedFire[] {
  const db = getCrmDb();
  const cutoff = nowMs - UNRESPONDED_GRACE_MIN * 60_000;
  const rows = db.prepare(`
    SELECT
      c.id AS card_id, c.title AS card_title, c.board_id AS card_board_id,
      c.contact_id, c.column_id,
      c.last_bot_message_at, c.last_client_message_at,
      c.column_changed_at, c.followup_origin_column_id,
      c.last_inbound_at AS last_inbound_at,
      col.name AS column_name,
      col.agent_role, col.agent_role_type,
      col.agent_entry_delay_minutes,
      col.agent_no_response_chase_steps_json,
      col.agent_followup_steps_hours_json
    FROM crm_cards c
    JOIN crm_columns col ON col.id = c.column_id
    WHERE col.agent_enabled = 1
      AND col.agent_role IS NOT NULL
      AND c.last_inbound_at IS NOT NULL
      AND c.last_inbound_at <= ?
      AND (c.last_bot_message_at IS NULL OR c.last_bot_message_at < c.last_inbound_at)
      AND c.deleted_at IS NULL
    LIMIT ?
  `).all(cutoff, MAX_PER_CATEGORY) as Array<CardColumnRow & { last_inbound_at: number }>;
  return rows.map((r) => ({ row: r, lastInboundAt: r.last_inbound_at }));
}

async function dispatchUnresponded(fire: UnrespondedFire): Promise<void> {
  const cluster = await getCluster();
  const lockKey = `col-timer:${fire.row.card_id}:unresponded:${fire.lastInboundAt}`;
  const ok = await cluster.setNxEx(lockKey, '1', UNRESPONDED_LOCK_TTL_S);
  if (!ok) return;

  const loaded = loadFullCard(fire.row);
  if (!loaded) return;
  const channel = pickChannel(loaded.card.tenantId);
  if (!channel) return;

  logger.info(`[col-timer unresponded] safety net firing card=${fire.row.card_id} column="${fire.row.column_name}" lastIn=${new Date(fire.lastInboundAt).toISOString()}`);

  void runFromInactivityFire({
    channel, card: loaded.card, column: loaded.column,
    fireCount: 0, elapsedMin: Math.floor((Date.now() - fire.lastInboundAt) / 60000),
  }).catch((err: any) => logger.warn(`[col-timer unresponded] err: ${err?.message}`));
}

// ─── B) NO_RESPONSE_CHASE ──────────────────────────────────────────────────

export interface ChaseFire {
  row: CardColumnRow;
  stepIdx: number;
  stepMinutes: number;
}

/** Cards onde bot mandou msg, cliente nao respondeu, e algum step de chase
 *  esta vencido (e ainda nao foi disparado — verificacao por tag). */
export function findChaseCards(nowMs = Date.now()): ChaseFire[] {
  const db = getCrmDb();
  const rows = db.prepare(`
    SELECT
      c.id AS card_id, c.title AS card_title, c.board_id AS card_board_id,
      c.contact_id, c.column_id,
      c.last_bot_message_at, c.last_client_message_at,
      c.column_changed_at, c.followup_origin_column_id,
      col.name AS column_name,
      col.agent_role, col.agent_role_type,
      col.agent_entry_delay_minutes,
      col.agent_no_response_chase_steps_json,
      col.agent_followup_steps_hours_json
    FROM crm_cards c
    JOIN crm_columns col ON col.id = c.column_id
    WHERE col.agent_enabled = 1
      AND col.agent_role IS NOT NULL
      AND col.agent_no_response_chase_steps_json IS NOT NULL
      AND c.last_bot_message_at IS NOT NULL
      AND (c.last_client_message_at IS NULL OR c.last_client_message_at < c.last_bot_message_at)
    LIMIT 1000
  `).all() as CardColumnRow[];

  const fires: ChaseFire[] = [];
  for (const row of rows) {
    let steps: number[];
    try {
      steps = JSON.parse(row.agent_no_response_chase_steps_json || '[]');
      if (!Array.isArray(steps) || !steps.every((n) => typeof n === 'number')) continue;
    } catch {
      continue;
    }
    const elapsedMin = Math.floor((nowMs - (row.last_bot_message_at || 0)) / 60000);
    for (let i = 0; i < steps.length; i++) {
      const tag = `sem_resposta_step_${i + 1}`;
      if (elapsedMin >= steps[i]! && !cardHasTag(row.card_id, tag)) {
        fires.push({ row, stepIdx: i, stepMinutes: steps[i]! });
        break; // 1 fire por card por tick
      }
    }
    if (fires.length >= MAX_PER_CATEGORY) break;
  }
  return fires;
}

// ─── C) FOLLOWUP_STEPS ─────────────────────────────────────────────────────

export interface FollowupFire {
  row: CardColumnRow;
  stepIdx: number;
  stepHours: number;
  isFinalDelete: boolean;
}

export function findFollowupCards(nowMs = Date.now()): FollowupFire[] {
  const db = getCrmDb();
  const rows = db.prepare(`
    SELECT
      c.id AS card_id, c.title AS card_title, c.board_id AS card_board_id,
      c.contact_id, c.column_id,
      c.last_bot_message_at, c.last_client_message_at,
      c.column_changed_at, c.followup_origin_column_id,
      col.name AS column_name,
      col.agent_role, col.agent_role_type,
      col.agent_entry_delay_minutes,
      col.agent_no_response_chase_steps_json,
      col.agent_followup_steps_hours_json
    FROM crm_cards c
    JOIN crm_columns col ON col.id = c.column_id
    WHERE col.agent_enabled = 1
      AND col.name = 'Follow Up'
      AND col.agent_followup_steps_hours_json IS NOT NULL
      AND c.column_changed_at IS NOT NULL
    LIMIT 1000
  `).all() as CardColumnRow[];

  const fires: FollowupFire[] = [];
  for (const row of rows) {
    let steps: number[];
    try {
      steps = JSON.parse(row.agent_followup_steps_hours_json || '[]');
      if (!Array.isArray(steps) || !steps.every((n) => typeof n === 'number')) continue;
    } catch {
      continue;
    }
    const elapsedHours = (nowMs - (row.column_changed_at || 0)) / 3600_000;

    // Steps regulares
    let pickedRegular = false;
    for (let i = 0; i < steps.length; i++) {
      const tag = `followup_${steps[i]}h`;
      if (elapsedHours >= steps[i]! && !cardHasTag(row.card_id, tag)) {
        fires.push({ row, stepIdx: i, stepHours: steps[i]!, isFinalDelete: false });
        pickedRegular = true;
        break;
      }
    }
    if (pickedRegular) continue;

    // Final delete: 24h apos ultimo step (ex: 72h + 24h = 96h)
    const lastStep = steps[steps.length - 1] ?? 72;
    const finalDeleteAtHours = lastStep + 24;
    if (
      elapsedHours >= finalDeleteAtHours &&
      !cardHasTag(row.card_id, 'final_delete_scheduled') &&
      !cardHasTag(row.card_id, 'final_delete_done')
    ) {
      fires.push({ row, stepIdx: steps.length, stepHours: finalDeleteAtHours, isFinalDelete: true });
    }

    if (fires.length >= MAX_PER_CATEGORY) break;
  }
  return fires;
}

// ─── Dispatch ──────────────────────────────────────────────────────────────

async function dispatchEntry(row: CardColumnRow): Promise<void> {
  const cluster = await getCluster();
  const lockKey = `col-timer:${row.card_id}:entry:0`;
  const ok = await cluster.setNxEx(lockKey, '1', LOCK_TTL_S);
  if (!ok) return;

  const loaded = loadFullCard(row);
  if (!loaded) return;
  const channel = pickChannel(loaded.card.tenantId);
  if (!channel) return;

  applyTagSystem(row.card_id, 'entry_dispatched');
  // Reusa runFromInactivityFire — o runner trata "instrucao [SYSTEM]"
  void runFromInactivityFire({
    channel, card: loaded.card, column: loaded.column,
    fireCount: 0, elapsedMin: 0,
  }).catch((err: any) => logger.warn(`[col-timer entry] err: ${err?.message}`));
}

async function dispatchChase(fire: ChaseFire): Promise<void> {
  const cluster = await getCluster();
  const lockKey = `col-timer:${fire.row.card_id}:chase:${fire.stepIdx}`;
  const ok = await cluster.setNxEx(lockKey, '1', LOCK_TTL_S);
  if (!ok) return;

  const loaded = loadFullCard(fire.row);
  if (!loaded) return;
  const channel = pickChannel(loaded.card.tenantId);
  if (!channel) return;

  applyTagSystem(fire.row.card_id, `sem_resposta_step_${fire.stepIdx + 1}`);
  // tags semanticas
  const semanticMap: Record<number, string> = { 30: 'sem_resposta_30m', 120: 'sem_resposta_2h', 360: 'sem_resposta_6h' };
  const semanticTag = semanticMap[fire.stepMinutes];
  if (semanticTag) applyTagSystem(fire.row.card_id, semanticTag);

  void runFromInactivityFire({
    channel, card: loaded.card, column: loaded.column,
    fireCount: fire.stepIdx + 1, elapsedMin: fire.stepMinutes,
  }).catch((err: any) => logger.warn(`[col-timer chase] err: ${err?.message}`));

  // FIX 2026-05-06 (Daniel) — após último step do chase em colunas com agente
  // qualificador (Lead) ou vendedor (Atendimento Humano), mover automaticamente
  // pro Follow Up. Cliente sumiu por 48h+ → deixa o followupper recuperar.
  // Agendado pra rodar APÓS o run da mensagem (1 tick adiante via setTimeout).
  let stepsLen = 0;
  try {
    const allSteps = JSON.parse(fire.row.agent_no_response_chase_steps_json || '[]');
    if (Array.isArray(allSteps)) stepsLen = allSteps.length;
  } catch { /* noop */ }
  const isLastStep = stepsLen > 0 && fire.stepIdx === stepsLen - 1;
  const role = (fire.row.agent_role || '').toLowerCase();
  if (isLastStep && (role === 'qualificador' || role === 'vendedor')) {
    setTimeout(() => {
      void promoteToFollowUp(loaded.card.tenantId, loaded.card.id, loaded.card.boardId, loaded.column.id)
        .catch((err: any) => logger.warn(`[col-timer auto-promote-followup] err: ${err?.message}`));
    }, 5000); // 5s grace pro envio da mensagem completar
  }
}

/** Move card pra coluna "Follow Up" do mesmo board, automaticamente — usado
 *  quando cliente passou do último chase step em Lead/Atendimento Humano. */
async function promoteToFollowUp(
  tenantId: string,
  cardId: string,
  boardId: string,
  fromColumnId: string,
): Promise<void> {
  const db = getCrmDb();
  // Acha Follow Up do mesmo board
  const fu = db.prepare(
    `SELECT id FROM crm_columns WHERE board_id = ? AND name = 'Follow Up' LIMIT 1`,
  ).get(boardId) as { id: string } | undefined;
  if (!fu) {
    logger.warn(`[auto-promote-followup] Follow Up nao encontrado em board=${boardId}`);
    return;
  }
  if (fu.id === fromColumnId) return; // ja esta em Follow Up

  // Lock pra evitar promote duplicado
  const cluster = await getCluster();
  const lockKey = `col-timer:auto-followup:${cardId}`;
  const ok = await cluster.setNxEx(lockKey, '1', 600);
  if (!ok) return;

  // Marca origem (pro followupper saber de onde veio) + persiste
  db.prepare(
    `UPDATE crm_cards SET followup_origin_column_id = ?, column_changed_at = ? WHERE id = ?`,
  ).run(fromColumnId, Date.now(), cardId);

  store.moveCard(tenantId, cardId, fu.id);
  applyTagSystem(cardId, 'movido_para_followup');
  logger.info(`[auto-promote-followup] card=${cardId} ${fromColumnId} → Follow Up (origem persistida)`);
}

async function dispatchFollowup(fire: FollowupFire): Promise<void> {
  const cluster = await getCluster();
  const lockKey = `col-timer:${fire.row.card_id}:followup:${fire.stepIdx}${fire.isFinalDelete ? ':del' : ''}`;
  const ok = await cluster.setNxEx(lockKey, '1', LOCK_TTL_S);
  if (!ok) return;

  const loaded = loadFullCard(fire.row);
  if (!loaded) return;
  const channel = pickChannel(loaded.card.tenantId);
  if (!channel) return;

  if (fire.isFinalDelete) {
    applyTagSystem(fire.row.card_id, 'final_delete_scheduled');
  } else {
    applyTagSystem(fire.row.card_id, `followup_${fire.stepHours}h`);
  }

  void runFromInactivityFire({
    channel, card: loaded.card, column: loaded.column,
    fireCount: fire.isFinalDelete ? 99 : fire.stepIdx + 1,
    elapsedMin: fire.stepHours * 60,
  }).catch((err: any) => logger.warn(`[col-timer followup] err: ${err?.message}`));
}

/** D) FINAL FOLLOW-UP EXECUTOR — fim do ciclo do followupper.
 *
 *  Daniel 2026-05-06: ao invés de soft-delete (que sumia o card), mover pra
 *  coluna "Resolvido" do board "Atendimento" (board de suporte do tenant).
 *  Card sai do Pipeline de Vendas mas continua arquivado pro corretor
 *  consultar histórico futuro.
 *
 *  Disparo via tag final_delete_scheduled (mantida pra compat com rows
 *  já agendadas) + condição de tempo (cas.inactivity_timer_at venceu).
 */
async function executeFinalDeletes(nowMs = Date.now()): Promise<void> {
  try {
    const db = getCrmDb();
    const rows = db.prepare(`
      SELECT cas.card_id, cas.tenant_id, c.board_id, c.column_id
      FROM crm_card_agent_state cas
      JOIN crm_card_tags t ON t.card_id = cas.card_id AND t.tag = 'final_delete_scheduled'
      JOIN crm_cards c ON c.id = cas.card_id
      WHERE cas.inactivity_timer_at IS NOT NULL AND cas.inactivity_timer_at <= ?
        AND c.deleted_at IS NULL
      LIMIT 50
    `).all(nowMs) as Array<{ card_id: string; tenant_id: string; board_id: string; column_id: string }>;

    for (const r of rows) {
      try {
        applyTagSystem(r.card_id, 'final_delete_done'); // tag mantida pra histórico
        await moveToResolvido(r.tenant_id, r.card_id, r.column_id);
      } catch (err: any) {
        logger.warn(`[col-timer final-followup] card=${r.card_id} err: ${err?.message}`);
      }
    }
  } catch (err: any) {
    logger.warn(`[col-timer final-followup] tick err: ${err?.message}`);
  }
}

/** Move card cross-board pro "Resolvido" do board Atendimento (type='support').
 *  Atualiza board_id E column_id. Loga stage_change + emite evento card_moved. */
async function moveToResolvido(
  tenantId: string,
  cardId: string,
  fromColumnId: string,
): Promise<void> {
  const db = getCrmDb();

  // Acha "Resolvido" no board de suporte (type='support') do tenant
  const target = db.prepare(`
    SELECT col.id as column_id, col.board_id, col.name as col_name, b.name as board_name
    FROM crm_columns col
    JOIN crm_boards b ON b.id = col.board_id
    WHERE b.tenant_id = ?
      AND b.type = 'support'
      AND col.name = 'Resolvido'
    LIMIT 1
  `).get(tenantId) as { column_id: string; board_id: string; col_name: string; board_name: string } | undefined;

  if (!target) {
    logger.warn(`[move-to-resolvido] Resolvido não encontrado em tenant=${tenantId.slice(0, 8)} — fallback soft-delete`);
    const t = Date.now();
    db.prepare(`UPDATE crm_cards SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`).run(t, t, cardId);
    return;
  }

  if (target.column_id === fromColumnId) return; // já está

  // Cross-board move precisa atualizar board_id + column_id atomicamente
  const cluster = await getCluster();
  const lockKey = `col-timer:final-move:${cardId}`;
  const ok = await cluster.setNxEx(lockKey, '1', 600);
  if (!ok) return;

  // Posição no final da coluna alvo
  const posRow = db.prepare(
    `SELECT COALESCE(MAX(position), -1) + 1 as p FROM crm_cards WHERE column_id = ? AND deleted_at IS NULL`,
  ).get(target.column_id) as { p: number };

  const now = Date.now();
  db.prepare(
    `UPDATE crm_cards SET board_id = ?, column_id = ?, position = ?, column_changed_at = ?, updated_at = ? WHERE id = ?`,
  ).run(target.board_id, target.column_id, posRow.p, now, now, cardId);

  // Loga stage_change manualmente (moveCard normal não cobre cross-board)
  try {
    store.logActivity(tenantId, {
      cardId,
      type: 'stage_change',
      channel: 'manual',
      content: `Movido de ${fromColumnId} para ${target.column_id} (Follow Up final → Resolvido)`,
    });
  } catch (err: any) {
    logger.warn(`[move-to-resolvido] logActivity falhou: ${err?.message}`);
  }

  logger.info(`[move-to-resolvido] card=${cardId} → ${target.board_name}/${target.col_name}`);
}

// ─── Public tick ──────────────────────────────────────────────────────────

export async function tickColumnTimers(): Promise<void> {
  const t0 = Date.now();
  let entryCount = 0, chaseCount = 0, fuCount = 0, unrespCount = 0;
  try {
    const entry = findEntryDelayCards();
    for (const r of entry) { await dispatchEntry(r); entryCount++; }

    // DISABLED 2026-05-05 — safety net disparou bot em cards velhos onde LLM
    // gerou meta-commentary que passou pelo filtro looksLikeMetaCommentary,
    // vazando relato interno pro cliente (3 vendas perdidas reportado pelo
    // Daniel). Reabilitar SO depois de endurecer o filtro de meta_commentary
    // E garantir guard adicional aqui (ex: nao disparar se card ja teve
    // qualquer activity nas ultimas N horas sem bot resposta — provavel sinal
    // de prompt bug nao de crash de worker).
    // const unresp = findUnrespondedInboundCards();
    // for (const f of unresp) { await dispatchUnresponded(f); unrespCount++; }

    const chase = findChaseCards();
    for (const f of chase) { await dispatchChase(f); chaseCount++; }

    const fu = findFollowupCards();
    for (const f of fu) { await dispatchFollowup(f); fuCount++; }

    await executeFinalDeletes();
  } catch (err: any) {
    logger.warn(`[columnTimerScheduler.tick] err: ${err?.message}`);
  }
  if (entryCount + chaseCount + fuCount + unrespCount > 0) {
    logger.info(`[col-timer] tick took ${Date.now() - t0}ms — entry=${entryCount} unresp=${unrespCount} chase=${chaseCount} fu=${fuCount}`);
  }
}
