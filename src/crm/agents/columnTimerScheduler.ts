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

/** D) FINAL DELETE EXECUTOR — apaga cards com tag final_delete_scheduled
 *  cujo deletar_card_final.delete_at ja passou. */
async function executeFinalDeletes(nowMs = Date.now()): Promise<void> {
  try {
    const db = getCrmDb();
    const rows = db.prepare(`
      SELECT cas.card_id FROM crm_card_agent_state cas
      JOIN crm_card_tags t ON t.card_id = cas.card_id AND t.tag = 'final_delete_scheduled'
      WHERE cas.inactivity_timer_at IS NOT NULL AND cas.inactivity_timer_at <= ?
      LIMIT 50
    `).all(nowMs) as Array<{ card_id: string }>;

    for (const r of rows) {
      try {
        applyTagSystem(r.card_id, 'final_delete_done');
        // Soft delete: hard DELETE cascateia FK pra crm_activities (perde
        // histórico inteiro da conversa). Card some das listagens via
        // filtro deleted_at IS NULL — preserva audit trail.
        const t = Date.now();
        db.prepare(`UPDATE crm_cards SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`).run(t, t, r.card_id);
        logger.info(`[col-timer final-delete] card=${r.card_id} soft-deleted`);
      } catch (err: any) {
        logger.warn(`[col-timer final-delete] err: ${err?.message}`);
      }
    }
  } catch (err: any) {
    logger.warn(`[col-timer final-delete] tick err: ${err?.message}`);
  }
}

// ─── Public tick ──────────────────────────────────────────────────────────

export async function tickColumnTimers(): Promise<void> {
  const t0 = Date.now();
  let entryCount = 0, chaseCount = 0, fuCount = 0;
  try {
    const entry = findEntryDelayCards();
    for (const r of entry) { await dispatchEntry(r); entryCount++; }

    const chase = findChaseCards();
    for (const f of chase) { await dispatchChase(f); chaseCount++; }

    const fu = findFollowupCards();
    for (const f of fu) { await dispatchFollowup(f); fuCount++; }

    await executeFinalDeletes();
  } catch (err: any) {
    logger.warn(`[columnTimerScheduler.tick] err: ${err?.message}`);
  }
  if (entryCount + chaseCount + fuCount > 0) {
    logger.info(`[col-timer] tick took ${Date.now() - t0}ms — entry=${entryCount} chase=${chaseCount} fu=${fuCount}`);
  }
}
