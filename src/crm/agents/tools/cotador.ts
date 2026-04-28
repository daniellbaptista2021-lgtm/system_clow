/**
 * Tools do role 'cotador' — gera cotacao real (PR 5) + promove pro Vendedor (closer).
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
import type { ProductType, QualificationData } from '../../types.js';

const gerarCotacao: ToolDef = {
  name: 'gerar_cotacao',
  description: 'Gera cotacao personalizada baseada nos planos cadastrados pelo tenant + dados do lead. Usa qualification do collected_data automaticamente — voce pode passar dados extras (idade, regiao etc) pra sobreescrever ou complementar. Salva snapshot em collected_data.last_quotation pra closer/finalizador acessarem depois.',
  roles: ['cotador'],
  parameters: {
    type: 'object',
    properties: {
      product_type: {
        type: 'string',
        description: 'Tipo do produto. Default: pega de qualification.tipoPlano. Valores: funeral / vida / saude / auto / residencial / outro',
        enum: ['funeral', 'vida', 'saude', 'auto', 'residencial', 'outro'],
      },
      idade: { type: 'number', description: 'Idade do titular (sobreescreve qualification.idade)' },
      numero_dependentes: { type: 'number', description: 'Quantidade de dependentes (sobreescreve qualification)' },
      regiao: {
        type: 'string',
        description: '"rio" | "fora_do_rio" | "desconhecida". Se cliente nao falou, usa "desconhecida".',
        enum: ['rio', 'fora_do_rio', 'desconhecida'],
      },
    },
  },
  async execute(args, ctx) {
    // 1) Lê qualification ja salvo + merge com args
    const fresh = getCardAgentState(ctx.card.id) ?? ctx.state;
    const collected = (fresh.collectedData ?? {}) as Record<string, unknown>;
    const savedQual = (collected.qualification ?? {}) as Record<string, unknown>;

    // Resolve product_type: arg > qualification.tipoPlano > 'funeral' (default seguro pra PV)
    const productType = (
      (typeof args.product_type === 'string' && args.product_type) ||
      (typeof savedQual.tipo_plano === 'string' && savedQual.tipo_plano) ||
      'funeral'
    ) as ProductType;

    const merged: QualificationData = {
      idade: typeof args.idade === 'number'
        ? args.idade
        : (typeof savedQual.idade === 'number' ? savedQual.idade : undefined),
      composicaoFamiliar: typeof savedQual.composicao_familiar === 'string'
        ? savedQual.composicao_familiar : undefined,
      tipoPlano: productType,
      numeroDependentes: typeof args.numero_dependentes === 'number'
        ? args.numero_dependentes
        : (typeof savedQual.numero_dependentes === 'number' ? savedQual.numero_dependentes : undefined),
      regiao: (typeof args.regiao === 'string'
        ? args.regiao
        : 'desconhecida') as QualificationData['regiao'],
    };

    // 2) Pipeline da engine
    const result = buildQuotation({
      tenantId: ctx.tenantId,
      productType,
      qualification: merged,
      customerName: ctx.card.title || undefined,
    });

    // 3) Erros graciosos: escala humano automaticamente
    if (!result.ok) {
      logger.warn(`[tool.gerar_cotacao] erro=${result.error} tenant=${ctx.tenantId.slice(0, 8)}`);
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
        logger.warn('[tool.gerar_cotacao] outbound emit fail:', err?.message);
      }
      recordAgentMetric({
        tenantId: ctx.tenantId, columnId: ctx.column.id, cardId: ctx.card.id,
        event: 'escalated', reason: `quotation_failed: ${result.error}`,
      });
      return { ok: false, error: result.error || 'quotation_failed' };
    }

    // 4) Salva snapshot em collected_data.last_quotation
    upsertCardAgentState({
      cardId: ctx.card.id,
      columnId: ctx.column.id,
      currentAgentRole: ctx.role,
      tenantId: ctx.tenantId,
      collectedData: { ...collected, last_quotation: result.snapshot },
    });

    // 5) Metric
    recordAgentMetric({
      tenantId: ctx.tenantId, columnId: ctx.column.id, cardId: ctx.card.id,
      event: 'tool_called',
      reason: `quotation_generated tenant=${ctx.tenantId.slice(0, 8)} type=${productType} plans_returned=${result.plans!.length}`,
    });

    // 6) Retorna mensagem pronta + lista de planos (LLM usa pra responder)
    return {
      ok: true,
      result: {
        message: result.message,
        plans: result.plans!.map((p) => ({
          name: p.plan.name,
          base_price_cents: p.basePriceCents,
          outside_rio_price_cents: p.outsideRioPriceCents,
        })),
      },
      // userVisible facilita: LLM pode chamar enviar_mensagem, mas se preferir,
      // retorna o texto direto pra enviar ao cliente sem reformular.
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

export const COTADOR_TOOLS: ToolDef[] = [gerarCotacao, promoverVendedor];
