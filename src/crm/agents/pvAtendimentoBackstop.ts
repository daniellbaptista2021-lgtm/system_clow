import { logger } from '../../utils/logger.js';
import { getCrmDb } from '../schema.js';
import * as store from '../store.js';
import {
  getCardAgentState,
  upsertCardAgentState,
} from '../store/cardAgentStateStore.js';

const PV_TENANT_ID = 'be5f5042-d939-447d-8777-5ac841e7aa07';
const ATENDIMENTO_COLUMN_ID = 'crm_col_591b12179732';
const NILSON_COLUMN_ID = 'crm_col_1b2d068e26b3';

interface QualifiedRow {
  card_id: string;
  title: string;
  nome: string;
  idade: number;
  tipo_plano: string;
}

export function promoteQualifiedPvAtendimentoBacklog(limit = 100): number {
  const db = getCrmDb();
  const rows = db.prepare(`
    SELECT
      c.id AS card_id,
      c.title,
      json_extract(s.collected_data, '$.qualification.nome') AS nome,
      json_extract(s.collected_data, '$.qualification.idade') AS idade,
      json_extract(s.collected_data, '$.qualification.tipo_plano') AS tipo_plano
    FROM crm_cards c
    JOIN crm_card_agent_state s ON s.card_id = c.id
    WHERE c.tenant_id = ?
      AND c.column_id = ?
      AND c.deleted_at IS NULL
      AND COALESCE(c.status, 'active') = 'active'
      AND COALESCE(json_extract(s.collected_data, '$.qualification.nome'), '') <> ''
      AND COALESCE(json_extract(s.collected_data, '$.qualification.idade'), 0) > 0
      AND COALESCE(json_extract(s.collected_data, '$.qualification.tipo_plano'), '') <> ''
    ORDER BY c.updated_at ASC
    LIMIT ?
  `).all(PV_TENANT_ID, ATENDIMENTO_COLUMN_ID, limit) as QualifiedRow[];

  let moved = 0;
  for (const row of rows) {
    try {
      const movedCard = store.moveCard(PV_TENANT_ID, row.card_id, NILSON_COLUMN_ID);
      if (!movedCard) continue;

      const state = getCardAgentState(row.card_id);
      upsertCardAgentState({
        cardId: row.card_id,
        columnId: NILSON_COLUMN_ID,
        currentAgentRole: 'vendedor_funeral',
        tenantId: PV_TENANT_ID,
        turnsCount: 0,
        inactivityTimerAt: null,
        inactivityFireCount: 0,
        promotionLog: [
          ...(Array.isArray(state?.promotionLog) ? state.promotionLog : []),
          {
            fromColumnId: ATENDIMENTO_COLUMN_ID,
            toColumnId: NILSON_COLUMN_ID,
            fromRole: 'qualificador',
            toRole: 'vendedor_funeral',
            reason: 'backstop: dados mínimos já coletados',
            at: Date.now(),
          },
        ],
        status: 'active',
      });
      moved++;
      logger.warn(
        `[pv-atendimento-backstop] card=${row.card_id} "${row.title}" ` +
          `movido para Nilson (nome=${row.nome}, idade=${row.idade}, tipo=${row.tipo_plano})`,
      );
    } catch (err: any) {
      logger.warn(`[pv-atendimento-backstop] falhou card=${row.card_id}: ${err?.message}`);
    }
  }
  return moved;
}
