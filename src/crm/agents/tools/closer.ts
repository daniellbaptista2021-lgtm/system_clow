/**
 * Tools do role 'closer' — converte o lead. Chama promote pro Finalizador
 * quando o cliente fecha.
 */
import { validatePromotionTarget, executePromotion } from './common.js';
import type { ToolDef } from './types.js';

const consultarMargemDesconto: ToolDef = {
  name: 'consultar_margem_desconto',
  description: 'Retorna a margem maxima de desconto que voce pode oferecer pra um plano. Hardcoded em 10% nesta versao — config por tenant vem em PR futuro.',
  roles: ['closer'],
  parameters: {
    type: 'object',
    properties: {
      plano: { type: 'string', description: 'Nome do plano cotado' },
    },
    required: ['plano'],
  },
  execute(_args, _ctx) {
    return {
      ok: true,
      result: {
        margem_pct: 10,
        observacao: 'Margem default 10% — configuravel por tenant no futuro.',
      },
    };
  },
};

const promoverFechamento: ToolDef = {
  name: 'promover_fechamento',
  description: 'Move o card pra coluna de Fechamento (finalizador). So chame quando: (1) cliente disse explicitamente que quer fechar, (2) plano especifico acordado (sem duvida entre 2), (3) forma de pagamento mencionada.',
  roles: ['closer'],
  parameters: {
    type: 'object',
    properties: {
      motivo: { type: 'string', description: 'Resumo: plano + valor + pagamento' },
    },
    required: ['motivo'],
  },
  execute(args, ctx) {
    const motivo = String(args.motivo || '').trim() || 'sem_motivo';
    const v = validatePromotionTarget(ctx);
    if (v.alreadyPromoted) return { ok: true, result: 'already_promoted' };
    if (!v.ok || !v.target) return { ok: false, error: v.error || 'invalid_target' };
    return executePromotion(ctx, v.target, motivo, 'finalizador');
  },
};

export const CLOSER_TOOLS: ToolDef[] = [consultarMargemDesconto, promoverFechamento];
