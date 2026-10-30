/**
 * Kiwify → EVOX: as regras (sem banco). A rota mora em kiwifyRoutes.ts.
 *
 * Venda aprovada cria a conta no plano do link de checkout; cancelamento,
 * reembolso e chargeback encerram o acesso. A validação da assinatura e os
 * nomes dos eventos vêm do Território Próprio, que recebe vendas reais da
 * mesma Kiwify desde 08/2026 (src/lib/kiwify.ts de lá).
 */
import crypto from 'crypto';
import type { PlanoIa } from '../tenancy/usoIa.js';

// ─── Autenticidade ──────────────────────────────────────────────────────
// A Kiwify não publica o algoritmo. Chega `?signature=` (HMAC do corpo cru
// com o token, sha1 ou sha256) ou o token puro no corpo/header.

const igual = (a: string, b: string) => {
  const A = Buffer.from(a), B = Buffer.from(b);
  return A.length === B.length && crypto.timingSafeEqual(A, B);
};

export function validarKiwify(corpoCru: string, assinatura: string | null, tokenHeader: string | null, segredo: string): string | null {
  if (!segredo) return null;
  if (assinatura) {
    for (const alg of ['sha1', 'sha256']) {
      const esperado = crypto.createHmac(alg, segredo).update(corpoCru, 'utf8').digest('hex');
      if (igual(assinatura.toLowerCase(), esperado)) return `hmac-${alg}`;
    }
    return null;
  }
  if (tokenHeader && igual(tokenHeader, segredo)) return 'token-header';
  try {
    const t = JSON.parse(corpoCru)?.token;
    if (typeof t === 'string' && igual(t, segredo)) return 'token-corpo';
  } catch { /* corpo não-JSON */ }
  return null;
}

// ─── Evento ─────────────────────────────────────────────────────────────

export type EventoKiwify =
  | 'compra_aprovada' | 'compra_recusada' | 'compra_reembolsada' | 'chargeback'
  | 'assinatura_atrasada' | 'assinatura_cancelada' | 'assinatura_renovada' | 'ignorado';

const MAPA: Record<string, EventoKiwify> = {
  compra_aprovada: 'compra_aprovada', order_approved: 'compra_aprovada', paid: 'compra_aprovada',
  compra_recusada: 'compra_recusada', order_rejected: 'compra_recusada', order_refused: 'compra_recusada', refused: 'compra_recusada',
  compra_reembolsada: 'compra_reembolsada', order_refunded: 'compra_reembolsada', refunded: 'compra_reembolsada',
  chargeback: 'chargeback', chargedback: 'chargeback',
  subscription_late: 'assinatura_atrasada', assinatura_atrasada: 'assinatura_atrasada',
  subscription_canceled: 'assinatura_cancelada', subscription_cancelled: 'assinatura_cancelada', assinatura_cancelada: 'assinatura_cancelada',
  subscription_renewed: 'assinatura_renovada', assinatura_renovada: 'assinatura_renovada',
};

/** Código do link de checkout de cada plano (painel da Kiwify → Links). */
export const LINKS_DOS_PLANOS: Record<string, PlanoIa> = {
  qp9Xp4v: 'essencial',
  u2MmyBH: 'completo',
};

const txt = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

export interface VendaKiwify {
  evento: EventoKiwify;
  chave: string;
  orderId: string | null;
  subscriptionId: string | null;
  email: string | null;
  nome: string | null;
  telefone: string | null;
  produto: string | null;
  plano: PlanoIa | null;
  ehEvox: boolean;
}

export function lerVenda(p: any): VendaKiwify {
  const bruto = txt(p?.webhook_event_type) ?? txt(p?.trigger) ?? txt(p?.event) ?? txt(p?.order_status) ?? '';
  const evento = MAPA[bruto.toLowerCase()] ?? MAPA[String(p?.order_status || '').toLowerCase()] ?? 'ignorado';
  const cli = p?.Customer || {};
  const orderId = txt(p?.order_id) ?? txt(p?.order_ref);
  const subscriptionId = txt(p?.subscription_id) ?? txt(p?.Subscription?.id);
  const produto = txt(p?.Product?.product_name);
  const link = txt(p?.checkout_link);
  const nomePlano = String(p?.Subscription?.plan?.name || '').toLowerCase();
  const plano: PlanoIa | null = (link && LINKS_DOS_PLANOS[link])
    || (/complet/.test(nomePlano) ? 'completo' : /essencial/.test(nomePlano) ? 'essencial' : null);
  const eventId = txt(p?.webhook_event_id) ?? txt(p?.event_id);
  return {
    evento,
    chave: eventId ? `kiwify:${eventId}` : `kiwify:${orderId ?? subscriptionId ?? 'sem-id'}:${evento}`,
    orderId, subscriptionId,
    email: txt(cli.email)?.toLowerCase() ?? null,
    nome: txt(cli.full_name) ?? txt(cli.first_name),
    telefone: txt(cli.mobile) ?? txt(cli.phone),
    produto,
    plano,
    // O webhook pode estar ligado a "todos os produtos": venda do Território
    // Próprio não pode virar conta no EVOX. Vale o link do plano ou o nome.
    ehEvox: Boolean((link && LINKS_DOS_PLANOS[link]) || /evox/i.test(produto || '') || /evox/i.test(nomePlano)),
  };
}

/** O que fazer com a conta. */
export function acaoDaVenda(v: VendaKiwify): 'liberar' | 'encerrar' | 'registrar' {
  if (v.evento === 'compra_aprovada' || v.evento === 'assinatura_renovada') return 'liberar';
  if (v.evento === 'assinatura_cancelada' || v.evento === 'compra_reembolsada' || v.evento === 'chargeback') return 'encerrar';
  return 'registrar'; // recusada, atrasada: a Kiwify ainda tenta cobrar
}

/**
 * Aviso de encerramento que fala de OUTRA assinatura não vale para esta.
 * Lição do Território (13/10/2026): o cliente trocou de assinatura na Kiwify,
 * o atraso da ANTIGA chegou, casou pelo e-mail e derrubou quem estava em dia.
 */
export function ehDeOutraAssinatura(guardada: string | null | undefined, v: VendaKiwify): boolean {
  if (!guardada) return false;
  const ids = [v.subscriptionId, v.orderId].filter(Boolean);
  return ids.length > 0 && !ids.includes(guardada);
}
