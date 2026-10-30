/**
 * Subscriptions runtime — recurring billing scheduler.
 *
 * Tick every 60s (alongside main scheduler):
 *   1. Reminders T-3d, T-1d, T-0 (configurable per tenant via env)
 *   2. On due date: log billing activity + advance next_charge_at
 *   3. If reminders > 3 without acknowledged payment → mark past_due
 *
 * Note: this does NOT actually charge a card. It logs + notifies.
 * Real payment integration (Stripe/Pagar.me/etc) is a separate concern;
 * this module gives the customer a heads-up via WhatsApp + the user
 * (you) confirms the payment manually via API.
 */

import { getCrmDb } from './schema.js';
import * as store from './store.js';
import { sendOutbound } from './inbox.js';
import type { Subscription, BillingCycle } from './types.js';
import { logger } from '../utils/logger.js';

const REMINDER_DAYS = [3, 1, 0]; // T-3d, T-1d, on the day

function fmtMoney(cents: number): string {
  return `R$ ${(cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function advanceDate(currentMs: number, cycle: BillingCycle): number {
  const d = new Date(currentMs);
  switch (cycle) {
    case 'weekly': d.setDate(d.getDate() + 7); break;
    case 'monthly': d.setMonth(d.getMonth() + 1); break;
    case 'quarterly': d.setMonth(d.getMonth() + 3); break;
    case 'yearly': d.setFullYear(d.getFullYear() + 1); break;
    case 'one_time': return Number.MAX_SAFE_INTEGER; // never recur
  }
  return d.getTime();
}

/** Tick called by the main scheduler. */
export async function processBillingTick(): Promise<void> {
  await Promise.allSettled([
    sendUpcomingReminders(),
    chargeDue(),
    flagPastDue(),
  ]);
}

// ─── 1. Reminders T-3d / T-1d / T-0 ─────────────────────────────────────
//
// Cada etapa sai UMA vez. Antes a janela de cada etapa durava 1h, o tick
// roda a cada minuto e a regra era "reminders_sent <= N": o mesmo "vence
// amanhã" saía três vezes seguidas (achado no teste de 29/10/2026). E se o
// servidor estivesse desligado naquela hora, a etapa nunca saía.
//
// Agora reminders_sent guarda até qual etapa já foi avisada (1 = T-3,
// 2 = T-1, 3 = no dia), e cada assinatura recebe só a etapa mais próxima do
// vencimento que ainda não recebeu.

const diaBrasilia = (ms: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(ms));

/** Dias de calendário (Brasília) até o vencimento: 0 = hoje, 1 = amanhã. */
export function diasAteVencer(nextChargeAt: number, agora: number): number {
  return Math.round((Date.parse(diaBrasilia(nextChargeAt)) - Date.parse(diaBrasilia(agora))) / 86400_000);
}

/** Índice da etapa que vale agora (0 = T-3, 1 = T-1, 2 = no dia), ou -1. */
export function etapaDoLembrete(nextChargeAt: number, agora: number): number {
  const dias = diasAteVencer(nextChargeAt, agora);
  if (dias < 0) return -1; // já venceu: quem cuida é o chargeDue
  let etapa = -1;
  REMINDER_DAYS.forEach((d, i) => { if (dias <= d) etapa = i; });
  return etapa;
}

/** Manda o lembrete desta etapa? Só se ela (ou uma mais próxima) ainda não saiu. */
export function deveLembrar(remindersSent: number, etapa: number): boolean {
  return etapa >= 0 && remindersSent <= etapa;
}

async function sendUpcomingReminders(): Promise<void> {
  const db = getCrmDb();
  const now = Date.now();
  const ate = now + (REMINDER_DAYS[0] + 1) * 86400_000;
  const rows = db.prepare(`
    SELECT * FROM crm_subscriptions
    WHERE status = 'active' AND deleted_at IS NULL
      AND next_charge_at >= ? AND next_charge_at <= ? AND reminders_sent < ?
  `).all(now - 86400_000, ate, REMINDER_DAYS.length) as any[];
  for (const r of rows) {
    const etapa = etapaDoLembrete(r.next_charge_at, now);
    if (!deveLembrar(r.reminders_sent, etapa)) continue;
    try { await sendBillingReminder(rowToSub(r), diasAteVencer(r.next_charge_at, now), etapa + 1); }
    catch (e: any) { logger.warn('[billing reminder] failed', e.message); }
  }
}

async function sendBillingReminder(sub: Subscription, days: number, etapaAvisada: number): Promise<void> {
  const tenantId = sub.tenantId;
  const contact = store.getContact(tenantId, sub.contactId);
  if (!contact) return;
  const due = new Date(sub.nextChargeAt).toLocaleDateString('pt-BR');
  const msg = days === 0
    ? `💸 Olá ${contact.name.split(/\s+/)[0]}! Hoje vence sua assinatura "${sub.planName}" — ${fmtMoney(sub.amountCents)}. Aguardamos seu pagamento. Qualquer dúvida, é só responder esta mensagem.`
    : days === 1
    ? `📅 Olá ${contact.name.split(/\s+/)[0]}! Amanhã (${due}) vence sua assinatura "${sub.planName}" — ${fmtMoney(sub.amountCents)}. Para evitar interrupção, regularize antes do vencimento.`
    : `🔔 Olá ${contact.name.split(/\s+/)[0]}! Em ${days} dias (${due}) vence sua assinatura "${sub.planName}" — ${fmtMoney(sub.amountCents)}.`;

  // Marca ANTES de mandar: se o envio demorar mais que um tick, o tick
  // seguinte não manda a mesma etapa de novo.
  store.updateSubscription(tenantId, sub.id, { remindersSent: etapaAvisada });

  // Pick first active channel
  const channels = store.listChannels(tenantId).filter(c => c.status === 'active');
  if (contact.phone && channels[0]) {
    await sendOutbound(channels[0], {
      to: contact.phone, text: msg, contactId: contact.id, cardId: sub.cardId,
    });
  }

  // Log
  store.logActivity(tenantId, {
    cardId: sub.cardId, contactId: sub.contactId,
    type: 'billing', channel: channels[0] ? (channels[0].type === 'meta' ? 'whatsapp_meta' : 'whatsapp_evolution') : 'manual',
    content: `Lembrete cobrança T-${days}d enviado: ${sub.planName} ${fmtMoney(sub.amountCents)}`,
  });
}

// ─── 2. Charge due (advance next_charge_at + log) ───────────────────────
async function chargeDue(): Promise<void> {
  const due = store.listSubscriptionsDue(Date.now());
  for (const sub of due) {
    try {
      // Log "due" activity (you confirm payment manually via API later)
      store.logActivity(sub.tenantId, {
        cardId: sub.cardId, contactId: sub.contactId,
        type: 'billing', channel: 'manual',
        content: `📌 Vencimento: ${sub.planName} ${fmtMoney(sub.amountCents)}. Marque como pago via API quando confirmar.`,
      });

      if (sub.cycle === 'one_time') {
        store.updateSubscription(sub.tenantId, sub.id, { status: 'past_due' });
      } else {
        // Advance to next cycle, reset reminder counter
        store.updateSubscription(sub.tenantId, sub.id, {
          nextChargeAt: advanceDate(sub.nextChargeAt, sub.cycle),
          remindersSent: 0,
        });
      }
    } catch (e: any) {
      logger.warn('[billing charge] failed', e.message);
    }
  }
}

// ─── 3. Past due: 3+ reminders without confirm ──────────────────────────
async function flagPastDue(): Promise<void> {
  const db = getCrmDb();
  // Reminders sent ≥3 AND next_charge_at < now-7d
  db.prepare(`
    UPDATE crm_subscriptions SET status = 'past_due'
    WHERE status = 'active' AND reminders_sent >= 3 AND next_charge_at < ?
  `).run(Date.now() - 7 * 86400_000);
}

function rowToSub(r: any): Subscription {
  return {
    id: r.id, tenantId: r.tenant_id, contactId: r.contact_id, cardId: r.card_id ?? undefined,
    planName: r.plan_name, amountCents: r.amount_cents, cycle: r.cycle,
    nextChargeAt: r.next_charge_at, status: r.status,
    remindersSent: r.reminders_sent, createdAt: r.created_at,
    cancelledAt: r.cancelled_at ?? undefined,
    lastPaidAt: r.last_paid_at ?? undefined,
  };
}

/** Manual: mark a subscription as paid (called via API/button).
 *  - Avanca next_charge_at pro proximo ciclo (monthly/weekly/etc).
 *  - Reseta reminders, mantem status active.
 *  - one_time: marca como cancelled (pago e fim).
 *  Sem isso, nextChargeAt ficava na mesma data passada e o botao
 *  "Marcar como pago" aparecia eternamente no card. */
export function markPaid(tenantId: string, subId: string): Subscription | null {
  const db = getCrmDb();
  const r = db.prepare('SELECT * FROM crm_subscriptions WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL').get(subId, tenantId) as any;
  if (!r) return null;
  const sub = rowToSub(r);
  store.logActivity(tenantId, {
    cardId: sub.cardId, contactId: sub.contactId,
    type: 'billing', channel: 'manual',
    content: `✅ Pagamento confirmado: ${sub.planName} ${fmtMoney(sub.amountCents)} (prox: ${new Date(advanceDate(sub.nextChargeAt, sub.cycle)).toLocaleDateString('pt-BR')})`,
  });
  const paidAt = Date.now();
  if (sub.cycle === 'one_time') {
    return store.updateSubscription(tenantId, subId, {
      remindersSent: 0,
      status: 'cancelled',
      cancelledAt: paidAt,
      lastPaidAt: paidAt,
    });
  }
  // Avanca a partir de NOW (nao da data antiga) pra evitar acumulo de
  // ciclos vencidos quando a sub estava muito atrasada. Caso o user
  // marque pago antes do vencimento, avanca a partir do nextChargeAt
  // original pra preservar o calendario.
  const baseMs = sub.nextChargeAt < Date.now() ? Date.now() : sub.nextChargeAt;
  return store.updateSubscription(tenantId, subId, {
    remindersSent: 0,
    status: 'active',
    nextChargeAt: advanceDate(baseMs, sub.cycle),
    lastPaidAt: paidAt,
  });
}
