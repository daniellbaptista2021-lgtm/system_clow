/**
 * outboundRateLimit.ts — sliding-window rate limit pra envio de mensagens
 * WhatsApp por destinatario. Z-API/Meta banem o numero do tenant se a
 * gente burstar (~1 msg/s seguro). Sem isso, um bug em loop do agente
 * pode banir o numero do cliente.
 *
 * Implementacao in-memory (Map<phone, timestamps[]>) — single-process.
 * Em PM2 cluster (2 workers), cada worker tem seu proprio contador, ou
 * seja, o teto efetivo eh 2x. Aceitavel pra MVP; pra cluster real, migrar
 * pra Redis SETNX/INCR com TTL.
 *
 * Politica default: 60 msgs/minuto por numero. Configuravel via
 * env CLOW_WPP_OUTBOUND_RATE_PER_MIN.
 */

import { logger } from '../utils/logger.js';
import { maskPhone } from '../utils/redact.js';

const DEFAULT_LIMIT_PER_MIN = Number(process.env.CLOW_WPP_OUTBOUND_RATE_PER_MIN) || 60;
const WINDOW_MS = 60_000;

const sends = new Map<string, number[]>();

// Limpa entradas obsoletas (>1min) periodicamente pra evitar
// crescimento sem fim do Map. Roda a cada 5min — leve.
setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [k, ts] of sends.entries()) {
    const filtered = ts.filter((t) => t > cutoff);
    if (filtered.length === 0) sends.delete(k);
    else if (filtered.length !== ts.length) sends.set(k, filtered);
  }
}, 5 * 60_000).unref();

/**
 * Normaliza phone (so digitos) pra usar como chave estavel
 * — `5521990423520` e `+55 21 99042-3520` sao a mesma pessoa.
 */
function normalizePhone(phone: string): string {
  return String(phone).replace(/\D/g, '');
}

/**
 * Tenta consumir uma "vaga" pro destinatario. Retorna { ok: true } se
 * abaixo do limite (e marca o send), ou { ok: false, retryAfterMs } se
 * estouraria. Caller pode dropar OU fazer setTimeout pra reenviar.
 */
export function tryConsume(phone: string): { ok: true } | { ok: false; retryAfterMs: number; current: number; limit: number } {
  const key = normalizePhone(phone);
  if (!key) return { ok: true }; // numero invalido — deixa passar pro caller falhar com erro real
  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  const arr = (sends.get(key) ?? []).filter((t) => t > cutoff);
  if (arr.length >= DEFAULT_LIMIT_PER_MIN) {
    // Quanto tempo ate o mais antigo sair da janela
    const retryAfterMs = Math.max(1, arr[0] + WINDOW_MS - now);
    return { ok: false, retryAfterMs, current: arr.length, limit: DEFAULT_LIMIT_PER_MIN };
  }
  arr.push(now);
  sends.set(key, arr);
  return { ok: true };
}

/**
 * Versao "blocking" — se estourar, retorna sleep promise ate poder
 * mandar. Usar so quando o caller quer enfileirar (ex: chase com
 * janela de 1min). Pra fluxo conversacional (resposta a cliente),
 * usar tryConsume direto e dropar.
 */
export async function consumeOrWait(phone: string, maxWaitMs = 5_000): Promise<{ waited: number }> {
  const r = tryConsume(phone);
  if (r.ok) return { waited: 0 };
  const wait = Math.min(r.retryAfterMs, maxWaitMs);
  logger.warn(`[outbound-ratelimit] ${maskPhone(phone)} hit ${r.current}/${r.limit}, waiting ${wait}ms`);
  await new Promise((res) => setTimeout(res, wait));
  // Tenta de novo (1x). Se ainda nao, deixa passar pro caller decidir
  const r2 = tryConsume(phone);
  return { waited: wait + (r2.ok ? 0 : 0) };
}

/** Pra testes — limpa estado interno. */
export function _resetForTests() {
  sends.clear();
}
