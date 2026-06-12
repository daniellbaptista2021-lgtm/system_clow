/**
 * Tools do funil de Follow Up (PR 7.0).
 *
 * 3 tools:
 *   - mover_para_followup    — qualquer agente. Move card pra coluna "Follow Up"
 *                              do mesmo board, salva origem em
 *                              followup_origin_column_id, aplica tag.
 *   - voltou_para_vendedor   — followupper apenas. Move pra "Vendedor",
 *                              limpa origem, aplica tag voltou_do_followup.
 *   - deletar_card_final     — followupper apenas. Manda msg final + agenda
 *                              delecao em 1h.
 *
 * Usa helper movimentação direta no DB (nao usa executePromotion porque
 * destino é column lookup-by-name, nao agentPromoteToColumnId).
 */
import { logger } from '../../../utils/logger.js';
import * as store from '../../store.js';
import { getCrmDb } from '../../schema.js';
import {
  upsertCardAgentState,
  recordAgentMetric,
} from '../../store/cardAgentStateStore.js';
import { applyTagSystem } from './tags.js';
import type { ToolDef } from './types.js';

/** Acha coluna por nome no board do card (case-insensitive). */
function findColByName(tenantId: string, boardId: string, name: string) {
  const cols = store.listColumns(tenantId, boardId);
  const target = cols.find((c) => c.name.toLowerCase() === name.toLowerCase());
  return target;
}

const moverParaFollowup: ToolDef = {
  name: 'mover_para_followup',
  description: 'Move o card pra coluna "Follow Up" do board atual. Use quando cliente sumir apos chase_step_3 (6h sem resposta). Salva a origem pra dashboard, aplica tag movido_para_followup.',
  roles: ['*'],
  parameters: {
    type: 'object',
    properties: {
      motivo: { type: 'string', description: 'Razao curta — ex: "sumiu na qualificacao", "sumiu apos cotacao"' },
    },
    required: ['motivo'],
  },
  execute(args, ctx) {
    const motivo = String(args.motivo || '').trim() || 'sem_motivo';
    const target = findColByName(ctx.tenantId, ctx.card.boardId!, 'Follow Up');
    if (!target) {
      return { ok: false, error: 'coluna_follow_up_nao_existe_no_board' };
    }
    if (target.id === ctx.column.id) {
      return { ok: true, result: 'already_in_followup' };
    }
    try {
      // Salva origem em crm_cards.followup_origin_column_id ANTES de mover
      const db = getCrmDb();
      db.prepare(`UPDATE crm_cards SET followup_origin_column_id = ?, column_changed_at = ? WHERE id = ?`)
        .run(ctx.column.id, Date.now(), ctx.card.id);
      store.moveCard(ctx.tenantId, ctx.card.id, target.id);
    } catch (err: any) {
      logger.warn(`[tool.mover_para_followup] move falhou: ${err?.message}`);
      return { ok: false, error: `move_failed: ${err?.message}` };
    }

    upsertCardAgentState({
      cardId: ctx.card.id,
      columnId: target.id,
      currentAgentRole: 'followupper',
      tenantId: ctx.tenantId,
      turnsCount: 0,
      inactivityTimerAt: null,
      inactivityFireCount: 0,
      status: 'active',
    });
    applyTagSystem(ctx.card.id, 'movido_para_followup');
    recordAgentMetric({
      tenantId: ctx.tenantId, columnId: ctx.column.id, cardId: ctx.card.id,
      event: 'promoted', reason: `mover_para_followup: ${motivo}`,
    });
    logger.info(`[tool.mover_para_followup] card=${ctx.card.id} from=${ctx.column.name} → Follow Up`);
    return { ok: true, result: { moved_to: { id: target.id, name: target.name } } };
  },
};

const voltouParaVendedor: ToolDef = {
  name: 'voltou_para_vendedor',
  description: 'Move o card de volta pra coluna "Vendedor" (cliente respondeu durante Follow Up). Limpa followup_origin_column_id, aplica tag voltou_do_followup.',
  roles: ['followupper'],
  parameters: {
    type: 'object',
    properties: {
      motivo: { type: 'string', description: 'Resumo curto da volta' },
    },
    required: ['motivo'],
  },
  execute(args, ctx) {
    const motivo = String(args.motivo || '').trim() || 'cliente_voltou';
    const target = findColByName(ctx.tenantId, ctx.card.boardId!, 'Vendedor');
    if (!target) return { ok: false, error: 'coluna_vendedor_nao_existe' };
    try {
      const db = getCrmDb();
      db.prepare(`UPDATE crm_cards SET followup_origin_column_id = NULL, column_changed_at = ? WHERE id = ?`)
        .run(Date.now(), ctx.card.id);
      store.moveCard(ctx.tenantId, ctx.card.id, target.id);
    } catch (err: any) {
      return { ok: false, error: `move_failed: ${err?.message}` };
    }
    upsertCardAgentState({
      cardId: ctx.card.id,
      columnId: target.id,
      currentAgentRole: 'vendedor',
      tenantId: ctx.tenantId,
      turnsCount: 0,
      status: 'active',
    });
    applyTagSystem(ctx.card.id, 'voltou_do_followup');
    recordAgentMetric({
      tenantId: ctx.tenantId, columnId: ctx.column.id, cardId: ctx.card.id,
      event: 'promoted', reason: `voltou_para_vendedor: ${motivo}`,
    });
    return { ok: true, result: { moved_to: { id: target.id, name: target.name } } };
  },
};

const deletarCardFinal: ToolDef = {
  name: 'deletar_card_final',
  description: 'Marca card pra delecao final (apos 72h+24h sem resposta no Follow Up). Manda msg final pro cliente, aplica tag final_delete_scheduled, agenda delecao em 1 hora via state.inactivityTimerAt. Card sera deletado pelo scheduler.',
  roles: ['followupper'],
  parameters: {
    type: 'object',
    properties: {
      motivo: { type: 'string', description: 'Razao' },
    },
    required: ['motivo'],
  },
  execute(args, ctx) {
    const motivo = String(args.motivo || '').trim() || 'sem_resposta_final';
    const deleteAt = Date.now() + 60 * 60 * 1000; // 1 hora
    upsertCardAgentState({
      cardId: ctx.card.id,
      columnId: ctx.column.id,
      currentAgentRole: ctx.role,
      tenantId: ctx.tenantId,
      inactivityTimerAt: deleteAt,
      status: 'done',
    });
    applyTagSystem(ctx.card.id, 'final_delete_scheduled');
    recordAgentMetric({
      tenantId: ctx.tenantId, columnId: ctx.column.id, cardId: ctx.card.id,
      event: 'lost', reason: `final_delete: ${motivo}`,
    });
    logger.info(`[tool.deletar_card_final] card=${ctx.card.id} agendado pra deletar em 1h`);
    return { ok: true, result: { delete_at: deleteAt, motivo } };
  },
};

export const FOLLOWUP_TOOLS: ToolDef[] = [
  moverParaFollowup,
  voltouParaVendedor,
  deletarCardFinal,
];
