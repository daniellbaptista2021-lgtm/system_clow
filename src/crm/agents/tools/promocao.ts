/**
 * Tools de promoção do funil v2 (PR 7.0).
 *
 * 4 tools, uma por transicao:
 *   - promover_para_qualificado    (Qualificador → Cotador)
 *   - promover_para_vendedor       (Cotador → Vendedor)
 *   - promover_para_coletor        (Vendedor → Coletor)
 *   - promover_para_lancar_venda   (Coletor → Lançar Venda)
 *
 * Cada tool valida ctx.column.agentPromoteToColumnId, usa o helper
 * compartilhado executePromotion (define toRole + reseta turns + grava
 * promotionLog) e retorna o resultado.
 */
import { logger } from '../../../utils/logger.js';
import { validatePromotionTarget, executePromotion, sendUrgentWhatsAppAlert } from './common.js';
import * as store from '../../store.js';
import * as outbound from '../../outboundWebhooks.js';
import type { ToolDef } from './types.js';

function makePromote(name: string, allowedRoles: any[], toRole: any, description: string): ToolDef {
  return {
    name,
    description,
    roles: allowedRoles,
    parameters: {
      type: 'object',
      properties: {
        motivo: { type: 'string', description: 'Resumo do motivo da promocao' },
      },
      required: ['motivo'],
    },
    execute(args, ctx) {
      const motivo = String(args.motivo || '').trim() || 'sem_motivo';
      const v = validatePromotionTarget(ctx);
      if (v.alreadyPromoted) return { ok: true, result: 'already_promoted' };
      if (!v.ok || !v.target) return { ok: false, error: v.error || 'invalid_target' };
      logger.info(`[tool.${name}] card=${ctx.card.id} → ${v.target.name} (role=${toRole})`);
      return executePromotion(ctx, v.target, motivo, toRole);
    },
  };
}

const promoverParaQualificado = makePromote(
  'promover_para_qualificado',
  ['qualificador'],
  'cotador',
  'Move o card pra coluna do Cotador. Chame quando: (1) cliente escolheu plano FUNERAL (nao plano completo), (2) confirmou nome, (3) idade titular <= 74, (4) composicao familiar completa coletada, (5) interesse real demonstrado. NAO escreva mensagem com cotacao — Cotador vai fazer.',
);

const promoverParaVendedor = makePromote(
  'promover_para_vendedor',
  ['cotador'],
  'vendedor',
  'Move o card pra coluna do Vendedor. Chame imediatamente apos enviar a cotacao via gerar_cotacao_sulamerica + aplicar_tag(cotacao_enviada).',
);

const promoverParaColetor = makePromote(
  'promover_para_coletor',
  ['vendedor', 'vendedor_funeral'],
  'coletor',
  'Move o card pra coluna do Coletor de Dados. Chame quando cliente sinalizou fechamento CLARO ("quero", "vamos la", "manda os dados") E escolheu forma de pagamento.',
);

// FIX PR 7.3 (2026-04-29 reportado por Daniel): "Lancar Venda" e a unica
// coluna onde humano REALMENTE precisa ser avisado na hora — venda pronta,
// dados completos, falta so finalizar com a seguradora. As outras promocoes
// sao bot-to-bot. Aqui replicamos o padrao de escalar_humano: disparar
// urgent alert WhatsApp + outbound webhook ANTES de mover o card.
const promoverParaLancarVenda: ToolDef = {
  name: 'promover_para_lancar_venda',
  description: 'Move o card pra coluna "Lancar Venda" (humano finaliza com a seguradora). Chame so quando os 17 campos estiverem coletados, validados, e cliente autorizou LGPD.',
  roles: ['coletor', 'coletor_dados'],
  parameters: {
    type: 'object',
    properties: {
      motivo: { type: 'string', description: 'Resumo do motivo da promocao' },
    },
    required: ['motivo'],
  },
  async execute(args, ctx) {
    const motivo = String(args.motivo || '').trim() || 'sem_motivo';
    const v = validatePromotionTarget(ctx);
    if (v.alreadyPromoted) return { ok: true, result: 'already_promoted' };
    if (!v.ok || !v.target) return { ok: false, error: v.error || 'invalid_target' };

    // Resolve nome do contato pra inclusao na notificacao
    let contactName: string | undefined;
    try {
      const c = ctx.card.contactId ? store.getContact?.(ctx.tenantId, ctx.card.contactId) : null;
      contactName = c?.name;
    } catch { /* noop */ }

    // 1) WhatsApp urgent alert pro corretor (URGENT_ALERT_PHONE)
    if (process.env.URGENT_ALERT_PHONE) {
      void sendUrgentWhatsAppAlert(ctx, `VENDA PRONTA: ${motivo}`, contactName).catch((err: any) => {
        logger.warn('[tool.promover_para_lancar_venda] urgent alert falhou:', err?.message);
      });
    } else {
      logger.warn('[tool.promover_para_lancar_venda] URGENT_ALERT_PHONE nao setado — corretor NAO sera notificado por WhatsApp');
    }

    // 2) Outbound webhook (n8n / automacoes externas podem reagir)
    try {
      await outbound.emit(ctx.tenantId, 'agent.lancar_venda', {
        cardId: ctx.card.id,
        cardTitle: ctx.card.title,
        contactName,
        contactPhone: ctx.customerPhone,
        fromColumnId: ctx.column.id,
        fromColumnName: ctx.column.name,
        toColumnId: v.target.id,
        toColumnName: v.target.name,
        reason: motivo,
        turnsInColumn: ctx.state.turnsCount,
      });
    } catch (err: any) {
      logger.warn('[tool.promover_para_lancar_venda] outbound emit falhou:', err?.message);
    }

    logger.info(`[tool.promover_para_lancar_venda] card=${ctx.card.id} → ${v.target.name} (alert=${!!process.env.URGENT_ALERT_PHONE})`);
    return executePromotion(ctx, v.target, motivo, 'custom');
  },
};

export const PROMOCAO_TOOLS: ToolDef[] = [
  promoverParaQualificado,
  promoverParaVendedor,
  promoverParaColetor,
  promoverParaLancarVenda,
];
