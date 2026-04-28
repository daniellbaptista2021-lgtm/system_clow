/**
 * Tools do role 'cotador' — gera cotacao SulAmerica AP Flex (PR 5.1) +
 * promove pro Vendedor (closer).
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
  description: 'Gera cotacao SulAmerica AP Flex baseada nos dados do lead. Usa qualification do collected_data automaticamente — voce so precisa passar dados que o cliente DEU AGORA e nao estavam salvos. Retorna mensagem formatada palavra-por-palavra (use userVisible direto, NAO reformule). Salva snapshot em collected_data.last_quotation pra closer/finalizador acessarem.',
  roles: ['cotador'],
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
        description: 'Outros dependentes alem dos categorizados (cada um adiciona R$ 10).',
      },
    },
  },
  async execute(args, ctx) {
    // 1) Le qualification ja salvo + merge com args
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

    // 2) Pipeline da engine
    const result = buildQuotation({
      tenantId: ctx.tenantId,
      productType: 'acidentes_pessoais',
      qualification: merged,
      customerName: savedQual.nomeTitular || ctx.card.title || undefined,
    });

    // 3) Erros graciosos: escala humano automaticamente
    if (!result.ok) {
      logger.warn(`[tool.gerar_cotacao_sulamerica] erro=${result.error} tenant=${ctx.tenantId.slice(0, 8)}`);
      try {
        await outbound.emit(ctx.tenantId, 'agent.escalated', {
          cardId: ctx.card.id,
          cardTitle: ctx.card.title,
          contactPhone: ctx.customerPhone,
          columnId: ctx.column.id,
          role: 'cotador',
          reason: `quotation_failed: ${result.error}`,
        });
      } catch (err: any) {
        logger.warn('[tool.gerar_cotacao_sulamerica] outbound emit fail:', err?.message);
      }
      recordAgentMetric({
        tenantId: ctx.tenantId, columnId: ctx.column.id, cardId: ctx.card.id,
        event: 'escalated', reason: `quotation_failed: ${result.error}`,
      });
      return { ok: false, error: result.error || 'quotation_failed' };
    }

    // 4) Salva snapshot
    upsertCardAgentState({
      cardId: ctx.card.id,
      columnId: ctx.column.id,
      currentAgentRole: ctx.role,
      tenantId: ctx.tenantId,
      collectedData: { ...collected, qualification: merged, last_quotation: result.snapshot },
    });

    // 5) Metric
    recordAgentMetric({
      tenantId: ctx.tenantId, columnId: ctx.column.id, cardId: ctx.card.id,
      event: 'tool_called',
      reason: `quotation_generated tenant=${ctx.tenantId.slice(0, 8)} modalidade=${result.modalidade} total_cents=${result.totalCents}`,
    });

    return {
      ok: true,
      result: {
        message: result.message,
        modalidade: result.modalidade,
        total_cents: result.totalCents,
      },
      // userVisible: o LLM manda direto, sem reformular (regras de marca aplicadas)
      userVisible: result.message,
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

export const COTADOR_TOOLS: ToolDef[] = [gerarCotacaoSulamerica, promoverVendedor];
