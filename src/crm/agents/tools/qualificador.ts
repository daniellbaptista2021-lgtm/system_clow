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
  description: 'Salva dados estruturados de qualificacao do lead (nome, idade, sexo, tipo de plano, composicao familiar, forma_pagamento, observacoes). Faz merge com o que ja existe — passe so os campos que voce confirmou agora.',
  roles: ['qualificador', 'cotador', 'vendedor', 'vendedor_funeral'],
  parameters: {
    type: 'object',
    properties: {
      nome: { type: 'string', description: 'Nome do cliente como ele apresentou' },
      idade: { type: 'number', description: 'Idade do titular' },
      sexo: { type: 'string', enum: ['MASCULINO', 'FEMININO'], description: 'Sexo do titular pra cotacao SulAmerica (formato exato).' },
      tipo_plano: { type: 'string', description: 'Tipo de plano de interesse (funeral / vida / saude / etc)' },
      composicao_familiar: { type: 'string', description: 'Resumo da composicao familiar — ex: "casal + 2 filhos"' },
      forma_pagamento: { type: 'string', enum: ['cartao', 'boleto', 'pix'], description: 'Forma de pagamento escolhida no fechamento.' },
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

// PR 6.0: tool nova com nome semantico "promover_para_vendedor_funeral".
// Mantemos alias legacy "promover_qualificado" pra prompts antigos no DB
// que ainda nao foram regenerados — ambos funcionam identicamente.
const promoverParaVendedorFuneral: ToolDef = {
  name: 'promover_para_vendedor_funeral',
  description: 'Move o card pra coluna do Vendedor Funeral. SO chame quando o cliente: (1) escolheu o plano FUNERAL (nao quis o plano completo com vida/doencas/cirurgia), (2) confirmou nome, (3) informou idade <= 74, (4) deu composicao familiar completa (cônjuge / filhos / pais / sogros / extras com idades), (5) demonstrou interesse real.',
  roles: ['qualificador'],
  parameters: {
    type: 'object',
    properties: {
      motivo: { type: 'string', description: 'Resumo da qualificacao (modalidade provavel + composicao).' },
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
    return executePromotion(ctx, v.target, motivo, 'vendedor_funeral');
  },
};

// Alias legacy — prompts antigos no DB ainda chamam "promover_qualificado"
// ate o admin regenerar via gen-activate-pv-funnel.mjs. Mesmo comportamento.
const promoverQualificadoLegacy: ToolDef = {
  ...promoverParaVendedorFuneral,
  name: 'promover_qualificado',
  description: '[ALIAS LEGACY] Mesmo que promover_para_vendedor_funeral. Mantido pra prompts antigos no DB.',
};

export const QUALIFICADOR_TOOLS: ToolDef[] = [
  salvarDadosQualificacao,
  promoverParaVendedorFuneral,
  promoverQualificadoLegacy,
];
