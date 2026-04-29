/**
 * Tools do role 'qualificador' — coleta dados pra cotacao + promove.
 */
import { logger } from '../../../utils/logger.js';
import {
  upsertCardAgentState,
  getCardAgentState,
} from '../../store/cardAgentStateStore.js';
import { validatePromotionTarget, executePromotion } from './common.js';
import type { ToolDef } from './types.js';

const salvarDadosQualificacao: ToolDef = {
  name: 'salvar_dados_qualificacao',
  description: 'Salva dados estruturados de qualificacao do lead (nome, idade, tipo de plano, composicao familiar, observacoes). Faz merge com o que ja existe — passe so os campos que voce confirmou agora.',
  roles: ['qualificador'],
  parameters: {
    type: 'object',
    properties: {
      nome: { type: 'string', description: 'Nome do cliente como ele apresentou' },
      idade: { type: 'number', description: 'Idade do titular' },
      tipo_plano: { type: 'string', description: 'Tipo de plano de interesse (funeral / vida / saude / etc)' },
      composicao_familiar: { type: 'string', description: 'Resumo da composicao familiar — ex: "casal + 2 filhos"' },
      observacoes: { type: 'string', description: 'Notas relevantes sobre o lead' },
    },
  },
  execute(args, ctx) {
    const fresh = getCardAgentState(ctx.card.id) ?? ctx.state;
    const collected = (fresh.collectedData ?? {}) as Record<string, unknown>;
    const qualification = {
      ...((collected.qualification as Record<string, unknown>) ?? {}),
      ...Object.fromEntries(
        Object.entries(args).filter(([_, v]) => v !== undefined && v !== null && v !== ''),
      ),
    };
    upsertCardAgentState({
      cardId: ctx.card.id,
      columnId: ctx.column.id,
      currentAgentRole: ctx.role,
      tenantId: ctx.tenantId,
      collectedData: { ...collected, qualification },
    });
    logger.info(`[tool.salvar_dados_qualificacao] card=${ctx.card.id} fields=[${Object.keys(args).join(',')}]`);
    return { ok: true, result: { saved: Object.keys(args), qualification } };
  },
};

const promoverQualificado: ToolDef = {
  name: 'promover_qualificado',
  description: 'Move o card pra coluna do Educador (PR 5.2). So chame quando o checklist de qualificacao estiver 100% completo: nome, idade titular (<=74), composicao familiar identificada, idades de TODOS os dependentes, e cliente confirmou intencao real (nao "to so pesquisando").',
  roles: ['qualificador'],
  parameters: {
    type: 'object',
    properties: {
      motivo: { type: 'string', description: 'Resumo do que foi qualificado, 1 frase.' },
    },
    required: ['motivo'],
  },
  execute(args, ctx) {
    const motivo = String(args.motivo || '').trim() || 'sem_motivo';
    const v = validatePromotionTarget(ctx);
    if (v.alreadyPromoted) return { ok: true, result: 'already_promoted' };
    if (!v.ok || !v.target) {
      return { ok: false, error: v.error || 'invalid_target' };
    }
    return executePromotion(ctx, v.target, motivo, 'educador');
  },
};

export const QUALIFICADOR_TOOLS: ToolDef[] = [
  salvarDadosQualificacao,
  promoverQualificado,
];
