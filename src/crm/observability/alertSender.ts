/**
 * alertSender — manda alertas críticos pelo WhatsApp pro Daniel.
 *
 * Daniel 2026-05-07 (Fase 3.3): quando o snapshot de saúde tem alertas
 * críticos (cards plantados, validator pegando muito, etc), envia
 * mensagem WhatsApp pro número configurado. Deduplicação via cluster
 * store: cada alerta único só dispara uma vez a cada N horas.
 *
 * Configuração via env:
 *  - CLOW_ALERT_PHONE: número (com DDI/DDD) pra receber alertas. Se
 *    vazio/ausente, alertas só vão pro log (comportamento default).
 *  - CLOW_ALERT_CHANNEL_ID: id do crm_channel pra usar. Se ausente,
 *    pega o primeiro canal ativo do CLOW_ALERT_TENANT_ID.
 *  - CLOW_ALERT_TENANT_ID: tenant do canal (default PV Corretora).
 *  - CLOW_ALERT_DEDUPE_HOURS: TTL de deduplicação (default 4h).
 *
 * Failure-mode: qualquer erro (canal inválido, Z-API offline) só loga
 * — não trava o tick do scheduler.
 */

import { createHash } from 'crypto';
import { logger } from '../../utils/logger.js';
import { getCluster } from '../../utils/clusterStore.js';
import { sendOutbound } from '../inbox.js';
import * as store from '../store.js';
import type { ClowHealthSnapshot } from './healthMetrics.js';

const DEFAULT_TENANT = 'be5f5042-d939-447d-8777-5ac841e7aa07';
const DEFAULT_DEDUPE_HOURS = 4;

/** Hash curto pra usar como dedupe key. */
function hashAlert(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** Lê config das envs. Retorna null se desabilitado. */
function readConfig(): {
  phone: string;
  tenantId: string;
  channelId: string | null;
  dedupeHours: number;
} | null {
  const phone = process.env.CLOW_ALERT_PHONE?.trim();
  if (!phone) return null;
  return {
    phone: phone.replace(/\D/g, ''), // só dígitos
    tenantId: process.env.CLOW_ALERT_TENANT_ID?.trim() || DEFAULT_TENANT,
    channelId: process.env.CLOW_ALERT_CHANNEL_ID?.trim() || null,
    dedupeHours: Number(process.env.CLOW_ALERT_DEDUPE_HOURS) || DEFAULT_DEDUPE_HOURS,
  };
}

/** Resolve o canal a usar pra enviar. */
function resolveChannel(tenantId: string, explicitId: string | null): any | null {
  try {
    if (explicitId) {
      const channels = store.listChannels(tenantId);
      const ch = channels.find((c: any) => c.id === explicitId);
      if (ch) return ch;
      logger.warn(`[alert-sender] channel ${explicitId} não encontrado no tenant ${tenantId}`);
    }
    const channels = store.listChannels(tenantId).filter((c: any) => c.status === 'active');
    return channels[0] ?? null;
  } catch (err: any) {
    logger.warn('[alert-sender] resolveChannel err:', err?.message);
    return null;
  }
}

/** Monta corpo da mensagem WhatsApp a partir dos alertas + snapshot. */
function buildMessage(alerts: string[], snap: ClowHealthSnapshot): string {
  const lines: string[] = [];
  lines.push('🚨 *Clow — alerta de saúde*');
  lines.push('');
  for (const a of alerts) lines.push(a);
  lines.push('');
  lines.push('📊 *Resumo (24h):*');
  const blocks = Object.values(snap.validator_blocks_24h).reduce((a, b) => a + b, 0);
  const fails = Object.values(snap.tool_failures_24h).reduce((a, b) => a + b, 0);
  lines.push(`• Validator: ${blocks} bloqueios`);
  lines.push(`• Meta-leak: ${snap.meta_commentary_blocked_24h} bloqueados`);
  lines.push(`• Tool fails: ${fails}`);
  lines.push(`• Bursts: ${snap.bursts_outbound_60s_24h.total_messages} msgs em ${snap.bursts_outbound_60s_24h.affected_cards} cards`);
  lines.push(`• Promovidos: ${snap.pipeline_summary.promoted_to_lancar_venda_24h} | Perdidos: ${snap.pipeline_summary.marked_lost_24h}`);
  lines.push('');
  lines.push('_curl http://localhost:3001/health/clow-dashboard pra detalhes._');
  return lines.join('\n');
}

/** Envia alertas se config setada e há alertas novos.
 *  Retorna número de alertas enviados (0 se nada novo ou desabilitado). */
export async function maybeSendAlerts(snap: ClowHealthSnapshot): Promise<number> {
  if (snap.alerts.length === 0) return 0;
  const cfg = readConfig();
  if (!cfg) return 0; // disabled — só log

  // Dedupe: só envia se TODO o conjunto de alertas for novo OU ao menos
  // um alerta da lista atual ainda não foi enviado nas últimas N horas.
  // Hash é do conjunto inteiro pra evitar spam quando o mesmo combo
  // permanece. Se mudar (ex: adicionou ou tirou alerta), envia de novo.
  const fingerprint = hashAlert(snap.alerts.sort().join('|'));
  const cluster = await getCluster();
  const dedupeKey = `clow_alert_dedupe:${fingerprint}`;
  const ttlSeconds = cfg.dedupeHours * 3600;
  const acquired = await cluster.setNxEx(dedupeKey, '1', ttlSeconds).catch(() => false);
  if (!acquired) {
    logger.debug(`[alert-sender] dedupe — alertas iguais já foram enviados nas últimas ${cfg.dedupeHours}h`);
    return 0;
  }

  const channel = resolveChannel(cfg.tenantId, cfg.channelId);
  if (!channel) {
    logger.warn('[alert-sender] nenhum canal ativo encontrado — alertas só no log');
    return 0;
  }

  const text = buildMessage(snap.alerts, snap);
  try {
    const result = await sendOutbound(channel, { to: cfg.phone, text });
    if (!result.ok) {
      logger.warn(`[alert-sender] envio falhou: ${result.error}`);
      return 0;
    }
    logger.info(`[alert-sender] ${snap.alerts.length} alerta(s) enviado(s) pra ${cfg.phone.slice(0, 4)}…${cfg.phone.slice(-2)}`);
    return snap.alerts.length;
  } catch (err: any) {
    logger.warn('[alert-sender] sendOutbound throw:', err?.message);
    return 0;
  }
}
