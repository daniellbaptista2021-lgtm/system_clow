/**
 * Tools do role 'cotador' — gera cotacao + promove pro Vendedor (closer).
 *
 * gerar_cotacao e STUB no PR 3 (mock fixo). Implementacao real plugada
 * nos planos do tenant vem no PR 5.
 */
import { logger } from '../../../utils/logger.js';
import { validatePromotionTarget, executePromotion } from './common.js';
import type { ToolDef } from './types.js';

const gerarCotacao: ToolDef = {
  name: 'gerar_cotacao',
  description: 'Gera uma cotacao personalizada baseada nos dados do lead. STUB nesta versao — retorna 3 planos mock. Implementacao real (planos do tenant) vem no PR 5.',
  roles: ['cotador'],
  parameters: {
    type: 'object',
    properties: {
      idade: { type: 'number', description: 'Idade do titular' },
      tipo_plano: { type: 'string', description: 'funeral / vida / saude / etc' },
      composicao_familiar: { type: 'string', description: 'Resumo da composicao' },
    },
  },
  execute(args, _ctx) {
    // STUB — PR 5 substitui por consulta real aos planos do tenant
    const planos = [
      { nome: 'Plano Essencial', valor_mensal_brl: 29.90, cobertura_resumo: 'Funeral basico ate R$ 5.000' },
      { nome: 'Plano Familiar', valor_mensal_brl: 59.90, cobertura_resumo: 'Funeral familiar ate R$ 10.000, 4 dependentes' },
      { nome: 'Plano Premium', valor_mensal_brl: 99.90, cobertura_resumo: 'Funeral + assistencia 24h, 6 dependentes' },
    ];
    logger.info(`[tool.gerar_cotacao] STUB card=${args ? Object.keys(args).join(',') : 'no-args'}`);
    return {
      ok: true,
      result: {
        planos,
        observacao: 'STUB — valores ilustrativos. PR 5 vai plugar nos planos reais do tenant.',
      },
    };
  },
};

const promoverVendedor: ToolDef = {
  name: 'promover_vendedor',
  description: 'Move o card pra coluna do Vendedor (closer). Chame quando a cotacao foi enviada e o cliente reagiu (positivo, negativo, ou com duvida especifica). Se cliente sumiu apos cotacao por 20min, passe tag="frio" pro closer tentar ressuscitar.',
  roles: ['cotador'],
  parameters: {
    type: 'object',
    properties: {
      motivo: { type: 'string', description: 'Resumo do contexto da promocao' },
      tag: { type: 'string', description: 'Tag opcional pra contexto (ex: "frio")', enum: ['frio'] },
    },
    required: ['motivo'],
  },
  execute(args, ctx) {
    const motivo = String(args.motivo || '').trim() || 'sem_motivo';
    const tag = typeof args.tag === 'string' ? args.tag : undefined;
    const v = validatePromotionTarget(ctx);
    if (v.alreadyPromoted) return { ok: true, result: 'already_promoted' };
    if (!v.ok || !v.target) return { ok: false, error: v.error || 'invalid_target' };
    return executePromotion(ctx, v.target, motivo, 'closer', tag ? { tag } : undefined);
  },
};

export const COTADOR_TOOLS: ToolDef[] = [gerarCotacao, promoverVendedor];
