/**
 * Tools do role 'vendedor_funeral' (PR 6.0, Onda 62).
 *
 * Substitui o antigo 'educador' (PR 5.2) e 'cotador'/'closer' (PR 5.1).
 * Vendedor Funeral COTA, APRESENTA VALOR, RESPONDE OBJEÇÕES, FECHA A
 * VENDA. Não SDR, não educador — é VENDEDOR de fato, com autoridade
 * pra conduzir a venda do plano funeral SulAmérica AP Flex SOZINHO.
 *
 * Tools expostas:
 *   - gerar_cotacao_sulamerica: cota + retorna mensagem oficial pronta
 *     pra mandar pro cliente (palavra-por-palavra). Educador (PR 5.2)
 *     NAO tinha essa tool — agora Vendedor TEM.
 *   - promover_para_coletor_dados: avanca pro Coletor de Dados quando
 *     cliente sinalizou fechamento.
 */
import { logger } from '../../../utils/logger.js';
import { validatePromotionTarget, executePromotion } from './common.js';
import { buildQuotation } from '../quotation/quotationEngine.js';
import {
  getCardAgentState,
  upsertCardAgentState,
  recordAgentMetric,
} from '../../store/cardAgentStateStore.js';
import * as outbound from '../../outboundWebhooks.js';
import type { ToolDef } from './types.js';
import type { QualificationData, Modalidade } from '../../types.js';

const gerarCotacaoSulamerica: ToolDef = {
  name: 'gerar_cotacao_sulamerica',
  description: 'Cota o plano funeral SulAmerica AP Flex e retorna mensagem oficial pronta pra mandar pro cliente (palavra-por-palavra do template). Le qualification do collected_data automaticamente — voce so precisa passar dados que o cliente DEU AGORA e nao estavam salvos. Salva snapshot em collected_data.last_quotation. Use userVisible direto, NAO reformule.',
  roles: ['vendedor_funeral', 'vendedor', 'cotador'],
  parameters: {
    type: 'object',
    properties: {
      idade_titular: {
        type: 'number',
        description: 'Idade do titular (sobreescreve qualification.idadeTitular). Titular precisa ter <= 74 anos.',
      },
      modalidade: {
        type: 'string',
        description: 'Forca uma modalidade especifica. Default: deduz da composicao familiar.',
        enum: ['individual', 'casal', 'familiar', 'familiar_ampliado'],
      },
      tem_conjuge: { type: 'boolean', description: 'Cliente tem conjuge no plano?' },
      idade_conjuge: { type: 'number' },
      filhos_menores_21: {
        type: 'array',
        description: 'Filhos com idade <= 21 (entram sem custo extra). Array de { idade }.',
        items: { type: 'object' },
      },
      filhos_maiores_21: {
        type: 'array',
        description: 'Filhos com idade > 21 (cada um adiciona R$ 8). Array de { idade }.',
        items: { type: 'object' },
      },
      tem_pais: { type: 'boolean', description: 'Tem pais como dependentes? Forca Familiar Ampliado.' },
      tem_sogros: { type: 'boolean', description: 'Tem sogros como dependentes? Forca Familiar Ampliado.' },
      dependentes_extras: {
        type: 'number',
        description: 'Outros dependentes (sobrinho, cunhada, etc — cada um adiciona R$ 10).',
      },
    },
  },
  async execute(args, ctx) {
    const fresh = getCardAgentState(ctx.card.id) ?? ctx.state;
    const collected = (fresh.collectedData ?? {}) as Record<string, unknown>;
    const savedQual = (collected.qualification ?? {}) as Partial<QualificationData>;

    const merged: QualificationData = {
      ...savedQual,
      idadeTitular: typeof args.idade_titular === 'number' ? args.idade_titular : savedQual.idadeTitular,
      modalidade: (args.modalidade as Modalidade | undefined) ?? savedQual.modalidade,
      conjuge: args.tem_conjuge === true
        ? { idade: typeof args.idade_conjuge === 'number' ? args.idade_conjuge : savedQual.conjuge?.idade }
        : (savedQual.conjuge ?? undefined),
      filhosMenores21: Array.isArray(args.filhos_menores_21)
        ? (args.filhos_menores_21 as Array<{ idade: number }>)
        : savedQual.filhosMenores21,
      filhosMaiores21: Array.isArray(args.filhos_maiores_21)
        ? (args.filhos_maiores_21 as Array<{ idade: number }>)
        : savedQual.filhosMaiores21,
      pais: typeof args.tem_pais === 'boolean' ? args.tem_pais : savedQual.pais,
      sogros: typeof args.tem_sogros === 'boolean' ? args.tem_sogros : savedQual.sogros,
      dependentesExtras: typeof args.dependentes_extras === 'number'
        ? args.dependentes_extras
        : savedQual.dependentesExtras,
      tipoPlano: 'acidentes_pessoais',
    };

    const result = buildQuotation({
      tenantId: ctx.tenantId,
      productType: 'acidentes_pessoais',
      qualification: merged,
      customerName: savedQual.nomeTitular || ctx.card.title || undefined,
    });

    if (!result.ok) {
      logger.warn(`[tool.gerar_cotacao_sulamerica] erro=${result.error}`);
      try {
        await outbound.emit(ctx.tenantId, 'agent.escalated', {
          cardId: ctx.card.id,
          cardTitle: ctx.card.title,
          contactPhone: ctx.customerPhone,
          columnId: ctx.column.id,
          role: 'vendedor_funeral',
          reason: `quotation_failed: ${result.error}`,
        });
      } catch { /* non-blocking */ }
      recordAgentMetric({
        tenantId: ctx.tenantId, columnId: ctx.column.id, cardId: ctx.card.id,
        event: 'escalated', reason: `quotation_failed: ${result.error}`,
      });
      return { ok: false, error: result.error || 'quotation_failed' };
    }

    upsertCardAgentState({
      cardId: ctx.card.id,
      columnId: ctx.column.id,
      currentAgentRole: ctx.role,
      tenantId: ctx.tenantId,
      collectedData: { ...collected, qualification: merged, last_quotation: result.snapshot },
    });

    recordAgentMetric({
      tenantId: ctx.tenantId, columnId: ctx.column.id, cardId: ctx.card.id,
      event: 'tool_called',
      reason: `quotation_generated modalidade=${result.modalidade} total_cents=${result.totalCents}`,
    });

    return {
      ok: true,
      result: {
        message: result.message,
        modalidade: result.modalidade,
        total_cents: result.totalCents,
      },
      userVisible: result.message,
    };
  },
};

const promoverParaColetorDados: ToolDef = {
  name: 'promover_para_coletor_dados',
  description: 'Move o card pra coluna do Coletor de Dados (Lançar venda). So chame quando o cliente sinalizou fechamento CLARO ("quero", "vamos lá", "manda os dados", "fecha aí" ou equivalente) E entendeu que recebe a proposta antes de pagar. NUNCA promova sem cliente confirmar.',
  roles: ['vendedor_funeral', 'vendedor', 'cotador'],
  parameters: {
    type: 'object',
    properties: {
      motivo: { type: 'string', description: 'Resumo: o que cliente disse e qual modalidade fechou' },
    },
    required: ['motivo'],
  },
  execute(args, ctx) {
    const motivo = String(args.motivo || '').trim() || 'sem_motivo';
    const v = validatePromotionTarget(ctx);
    if (v.alreadyPromoted) return { ok: true, result: 'already_promoted' };
    if (!v.ok || !v.target) return { ok: false, error: v.error || 'invalid_target' };
    return executePromotion(ctx, v.target, motivo, 'coletor_dados');
  },
};

export const VENDEDOR_FUNERAL_TOOLS: ToolDef[] = [
  gerarCotacaoSulamerica,
  promoverParaColetorDados,
];
