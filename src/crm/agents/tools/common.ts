/**
 * Tools comuns — disponiveis pra qualquer role (qualificador / cotador /
 * closer / finalizador / custom). PR 3 da Onda 62.
 */
import { logger } from '../../../utils/logger.js';
import * as store from '../../store.js';
import * as outbound from '../../outboundWebhooks.js';
import {
  recordAgentMetric,
  setCardAgentStatus,
  upsertCardAgentState,
  getCardAgentState,
} from '../../store/cardAgentStateStore.js';
import { maskAllSensitive, decryptAllSensitive, listSensitiveFields, type SensitiveBag } from '../piiCrypto.js';
import type { ToolDef, ToolContext, ToolResult } from './types.js';

const J = {
  parse<T>(s: unknown, fb: T): T {
    if (typeof s !== 'string') return fb;
    try { return JSON.parse(s) as T; } catch { return fb; }
  },
};

// ─── escalar_humano ──────────────────────────────────────────────────────

const escalarHumano: ToolDef = {
  name: 'escalar_humano',
  description: 'Pausa o atendimento automático e notifica o time humano. Use quando o cliente pediu humano explicitamente, xingou, demonstrou frustração intensa, ou você ficou sem saber como prosseguir.',
  roles: ['*'],
  parameters: {
    type: 'object',
    properties: {
      motivo: { type: 'string', description: 'Razão objetiva da escalação (1 frase).' },
    },
    required: ['motivo'],
  },
  async execute(args, ctx) {
    const motivo = String(args.motivo || '').trim() || 'sem_motivo';
    setCardAgentStatus(ctx.card.id, 'escalated');
    recordAgentMetric({
      tenantId: ctx.tenantId, columnId: ctx.column.id, cardId: ctx.card.id,
      event: 'escalated', reason: motivo,
      turnsInColumn: ctx.state.turnsCount,
    });
    // Outbound webhook pro tenant (Telegram/WhatsApp/email do Daniel etc)
    try {
      await outbound.emit(ctx.tenantId, 'agent.escalated', {
        cardId: ctx.card.id,
        cardTitle: ctx.card.title,
        contactPhone: ctx.customerPhone,
        columnId: ctx.column.id,
        columnName: ctx.column.name,
        role: ctx.role,
        reason: motivo,
        turnsInColumn: ctx.state.turnsCount,
      });
    } catch (err: any) {
      logger.warn('[tool.escalar_humano] outbound emit falhou:', err?.message);
    }
    logger.info(`[tool.escalar_humano] card=${ctx.card.id} reason="${motivo}"`);
    return { ok: true, result: 'escalated', userVisible:
      'Vou te transferir pra um especialista humano. Já já alguém da equipe entra em contato! 🙏' };
  },
};

// ─── marcar_perdido ──────────────────────────────────────────────────────

const marcarPerdido: ToolDef = {
  name: 'marcar_perdido',
  description: 'Marca o lead como perdido (cliente sem interesse, fora de orçamento, etc). Move pra coluna "Perdidos" se existir, senão marca status=done com reason=lost.',
  roles: ['*'],
  parameters: {
    type: 'object',
    properties: {
      motivo: { type: 'string', description: 'Razão da perda (sem_interesse / preço / etc)' },
    },
    required: ['motivo'],
  },
  async execute(args, ctx) {
    const motivo = String(args.motivo || '').trim() || 'sem_motivo';

    // Procura coluna Perdidos no mesmo board (case-insensitive)
    const cols = store.listColumns(ctx.tenantId, ctx.card.boardId!);
    const lostCol = cols.find((c) =>
      c.isTerminal && /perdid|lost/i.test(c.name)
    ) || cols.find((c) => /perdid|lost/i.test(c.name));

    if (lostCol && lostCol.id !== ctx.card.columnId) {
      try { store.moveCard(ctx.tenantId, ctx.card.id, lostCol.id); }
      catch (err: any) {
        logger.warn('[tool.marcar_perdido] moveCard falhou:', err?.message);
      }
    }
    // status=done — sai do funil de qualquer forma
    upsertCardAgentState({
      cardId: ctx.card.id,
      columnId: lostCol?.id ?? ctx.card.columnId!,
      currentAgentRole: ctx.role,
      tenantId: ctx.tenantId,
      status: 'done',
    });
    recordAgentMetric({
      tenantId: ctx.tenantId, columnId: ctx.column.id, cardId: ctx.card.id,
      event: 'lost', reason: motivo,
      turnsInColumn: ctx.state.turnsCount,
    });
    logger.info(`[tool.marcar_perdido] card=${ctx.card.id} motivo="${motivo}" movedTo=${lostCol?.name ?? '(sem coluna)'}`);
    return { ok: true, result: 'marked_lost', userVisible: null as any };
  },
};

// ─── marcar_morno ────────────────────────────────────────────────────────

const marcarMorno: ToolDef = {
  name: 'marcar_morno',
  description: 'Marca o cliente como "morno" (interesse vago) e agenda follow-up automático em 2 dias. Use quando cliente desconversa, demora a responder, ou demonstra interesse mas sem urgência.',
  roles: ['*'],
  parameters: {
    type: 'object',
    properties: {},
  },
  async execute(_args, ctx) {
    // Tag "morno" no contato
    if (ctx.card.contactId) {
      const c = store.getContact?.(ctx.tenantId, ctx.card.contactId)
        ?? (store as any).findContactByPhone?.(ctx.tenantId, ctx.customerPhone);
      if (c) {
        const newTags = Array.from(new Set([...(c.tags ?? []), 'morno']));
        try { store.updateContact(ctx.tenantId, c.id, { tags: newTags }); }
        catch (err: any) { logger.warn('[tool.marcar_morno] updateContact falhou:', err?.message); }
      }
    }
    // inactivityTimerAt = D+2. PR 4 vai ler e disparar.
    const followupAt = Date.now() + 2 * 24 * 60 * 60 * 1000;
    upsertCardAgentState({
      cardId: ctx.card.id,
      columnId: ctx.column.id,
      currentAgentRole: ctx.role,
      tenantId: ctx.tenantId,
      inactivityTimerAt: followupAt,
    });
    logger.info(`[tool.marcar_morno] card=${ctx.card.id} followup=${new Date(followupAt).toISOString()}`);
    return { ok: true, result: { tagged: 'morno', followup_at: followupAt } };
  },
};

// ─── agendar_followup ────────────────────────────────────────────────────

const agendarFollowup: ToolDef = {
  name: 'agendar_followup',
  description: 'Agenda um follow-up automático pro cliente em uma data específica. Usa ISO 8601 (ex: 2026-05-01T14:00:00Z). PR 4 vai disparar o agente nessa hora.',
  roles: ['*'],
  parameters: {
    type: 'object',
    properties: {
      quando: { type: 'string', description: 'ISO 8601 timestamp (UTC ou com TZ)' },
    },
    required: ['quando'],
  },
  execute(args, ctx) {
    const quando = String(args.quando || '');
    const t = Date.parse(quando);
    if (!Number.isFinite(t) || t < Date.now() - 1000) {
      return { ok: false, error: 'data_invalida_ou_passada' };
    }
    // Limita a 60 dias no futuro pra evitar follow-up "pra nunca"
    const max = Date.now() + 60 * 24 * 60 * 60 * 1000;
    const final = Math.min(t, max);
    upsertCardAgentState({
      cardId: ctx.card.id,
      columnId: ctx.column.id,
      currentAgentRole: ctx.role,
      tenantId: ctx.tenantId,
      inactivityTimerAt: final,
    });
    logger.info(`[tool.agendar_followup] card=${ctx.card.id} at=${new Date(final).toISOString()}`);
    return { ok: true, result: { scheduled_at: final } };
  },
};

// ─── consultar_historico ─────────────────────────────────────────────────

const consultarHistorico: ToolDef = {
  name: 'consultar_historico',
  description: 'Retorna as últimas N mensagens trocadas com o cliente, formatadas. Útil quando precisa relembrar contexto antigo que saiu do contexto atual.',
  roles: ['*'],
  parameters: {
    type: 'object',
    properties: {
      turnos: { type: 'number', description: 'Quantas mensagens retornar (1-50). Default 20.' },
    },
  },
  execute(args, ctx) {
    const limit = Math.min(50, Math.max(1, Number(args.turnos) || 20));
    if (!ctx.card.contactId) return { ok: true, result: { history: [] } };
    const acts = store.listActivitiesByContact(ctx.tenantId, ctx.card.contactId, 1000);
    const msgs = acts
      .filter((a) => a.type === 'message_in' || a.type === 'message_out')
      .slice(-limit);
    return {
      ok: true,
      result: {
        history: msgs.map((a) => ({
          role: a.type === 'message_out' ? 'agente' : 'cliente',
          text: a.content || '',
          at: a.createdAt,
        })),
      },
    };
  },
};

// ─── ler_dados_card ──────────────────────────────────────────────────────

const lerDadosCard: ToolDef = {
  name: 'ler_dados_card',
  description: 'Retorna os dados estruturados ja coletados pelo agente neste card (qualificacao + lista de campos sensitive ja preenchidos, mascarados). Se voce eh o role finalizador e precisa do valor REAL de algum campo sensitive (pra validar/usar), passa unmask=true.',
  roles: ['*'],
  parameters: {
    type: 'object',
    properties: {
      unmask: { type: 'boolean', description: 'Se true, retorna dados sensitive em CLARO. SO funciona se role=finalizador.' },
    },
  },
  execute(args, ctx) {
    const wantsUnmask = args.unmask === true;
    const fresh = getCardAgentState(ctx.card.id) ?? ctx.state;
    const collected = (fresh.collectedData ?? {}) as Record<string, unknown>;
    const qualification = collected.qualification ?? null;
    const sensitive = (collected.sensitive ?? null) as SensitiveBag | null;

    let sensitiveOut: Record<string, string> | Record<string, unknown>;
    if (wantsUnmask) {
      if (ctx.role !== 'finalizador') {
        // Defesa em profundidade: outros roles nunca veem PII em claro
        return { ok: false, error: 'unmask_only_for_finalizador' };
      }
      // Decifra tudo (so role finalizador chega aqui)
      sensitiveOut = decryptAllSensitive(sensitive);
    } else {
      sensitiveOut = maskAllSensitive(sensitive);
    }

    return {
      ok: true,
      result: {
        contact: {
          name: ctx.card.title,
          phone: ctx.customerPhone,
        },
        qualification,
        sensitive: sensitiveOut,
        sensitive_fields_filled: listSensitiveFields(sensitive),
        column: { id: ctx.column.id, name: ctx.column.name, role: ctx.role },
        turns: fresh.turnsCount,
      },
    };
  },
};

export const COMMON_TOOLS: ToolDef[] = [
  escalarHumano,
  marcarPerdido,
  marcarMorno,
  agendarFollowup,
  consultarHistorico,
  lerDadosCard,
];

/** Helper compartilhado pra promote_*: valida coluna destino e mantem
 *  idempotencia. Devolve { ok, error?, target? }. */
export interface ValidatedPromotion {
  ok: boolean;
  error?: string;
  alreadyPromoted?: boolean;
  target?: BoardColumnLike;
}
type BoardColumnLike = { id: string; name: string; boardId: string };

export function validatePromotionTarget(ctx: ToolContext): ValidatedPromotion {
  // Idempotencia: state ja avancou? Cardja moveu nesta interacao?
  const fresh = getCardAgentState(ctx.card.id);
  if (fresh && fresh.columnId !== ctx.column.id) {
    return { ok: true, alreadyPromoted: true };
  }
  const targetId = ctx.column.agentPromoteToColumnId;
  if (!targetId) {
    return { ok: false, error: 'promote_target_not_configured' };
  }
  const cols = store.listColumns(ctx.tenantId, ctx.card.boardId!);
  const target = cols.find((c) => c.id === targetId);
  if (!target) {
    return { ok: false, error: 'target_column_not_found_in_board' };
  }
  return { ok: true, target: { id: target.id, name: target.name, boardId: target.boardId } };
}

/** Executa de fato a promocao: move card, atualiza state, append promotionLog,
 *  grava metric. Re-usado por todos os promote_*. */
export function executePromotion(
  ctx: ToolContext,
  target: BoardColumnLike,
  motivo: string,
  toRole: import('../../types.js').ColumnAgentRole,
  extra?: Record<string, unknown>,
): ToolResult {
  try {
    store.moveCard(ctx.tenantId, ctx.card.id, target.id);
  } catch (err: any) {
    return { ok: false, error: `move_card_failed: ${err?.message || 'unknown'}` };
  }
  const fresh = getCardAgentState(ctx.card.id) ?? ctx.state;
  const log = Array.isArray(fresh.promotionLog) ? [...fresh.promotionLog] : [];
  log.push({
    fromColumnId: ctx.column.id,
    toColumnId: target.id,
    fromRole: ctx.role,
    toRole,
    reason: motivo,
    at: Date.now(),
  });
  upsertCardAgentState({
    cardId: ctx.card.id,
    columnId: target.id,
    currentAgentRole: toRole,
    tenantId: ctx.tenantId,
    turnsCount: 0, // reset turns na nova coluna
    inactivityTimerAt: null, // PR 4: nova coluna re-arma se quiser
    inactivityFireCount: 0,
    promotionLog: log,
    status: 'active',
  });
  recordAgentMetric({
    tenantId: ctx.tenantId, columnId: ctx.column.id, cardId: ctx.card.id,
    event: 'promoted',
    reason: extra?.tag ? `${motivo}|tag=${extra.tag}` : motivo,
    turnsInColumn: ctx.state.turnsCount,
  });
  return {
    ok: true,
    result: {
      moved_to: { id: target.id, name: target.name },
      from_role: ctx.role,
      to_role: toRole,
      ...(extra ?? {}),
    },
  };
}

// re-export pra cada role
void J; // silence unused on inicial sem uso
