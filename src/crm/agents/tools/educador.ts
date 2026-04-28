/**
 * Tools do role 'educador' — substitui Cotador + Closer (PR 5.2 Onda 62).
 *
 * Educador eh consultor SDR que:
 *   - Educa cliente sobre beneficios EM VIDA do produto SulAmerica
 *   - Gera desejo de protecao (sem inventar valor, sem inventar desconto)
 *   - Promove pro Finalizador quando cliente sinaliza decisao clara
 *
 * NAO cota (nao chama gerar_cotacao_sulamerica).
 * NAO consulta margem (nao tem tool consultar_margem_desconto).
 * NAO inventa preco em R$ — Daniel humano faz isso na proposta.
 */
import { validatePromotionTarget, executePromotion } from './common.js';
import type { ToolDef } from './types.js';

const promoverFechamento: ToolDef = {
  name: 'promover_fechamento',
  description: 'Move o card pra coluna do Finalizador (Lançar venda). So chame quando: (1) cliente disse explicitamente "quero", "vamos lá", "manda os dados", "fecha aí" ou equivalente, (2) cliente entendeu que recebe a proposta antes de pagar, (3) houve 2-3 turnos de conversa educativa antes do fechamento, (4) NENHUM desconto foi prometido, (5) NENHUM valor em R$ foi mencionado por voce.',
  roles: ['educador'],
  parameters: {
    type: 'object',
    properties: {
      motivo: { type: 'string', description: 'Resumo: o que o cliente disse e qual foi a decisao' },
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

export const EDUCADOR_TOOLS: ToolDef[] = [promoverFechamento];
