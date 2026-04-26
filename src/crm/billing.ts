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
async function sendUpcomingReminders(): Promise<void> {
  const db = getCrmDb();
  const now = Date.now();
  for (const days of REMINDER_DAYS) {
    const windowStart = now + (days * 86400_000) - 30 * 60_000; // ±30min window
    const windowEnd = now + (days * 86400_000) + 30 * 60_000;
    const rows = db.prepare(`
      SELECT * FROM crm_subscriptions
      WHERE status = 'active' AND next_charge_at >= ? AND next_charge_at <= ? AND reminders_sent <= ?
    `).all(windowStart, windowEnd, REMINDER_DAYS.length - REMINDER_DAYS.indexOf(days)) as any[];
    for (const r of rows) {
      try { await sendBillingReminder(rowToSub(r), days); }
      catch (e: any) { console.warn('[billing reminder] failed', e.message); }
    }
  }
}

async function sendBillingReminder(sub: Subscription, days: number): Promise<void> {
  const tenantId = sub.tenantId;
  const contact = store.getContact(tenantId, sub.contactId);
  if (!contact) return;
  const due = new Date(sub.nextChargeAt).toLocaleDateString('pt-BR');
  const msg = days === 0
    ? `💸 Olá ${contact.name.split(/\s+/)[0]}! Hoje vence sua assinatura "${sub.planName}" — ${fmtMoney(sub.amountCents)}. Aguardamos seu pagamento. Qualquer dúvida, é só responder esta mensagem.`
    : days === 1
    ? `📅 Olá ${contact.name.split(/\s+/)[0]}! Amanhã (${due}) vence sua assinatura "${sub.planName}" — ${fmtMoney(sub.amountCents)}. Para evitar interrupção, regularize antes do vencimento.`
    : `🔔 Olá ${contact.name.split(/\s+/)[0]}! Em ${days} dias (${due}) vence sua assinatura "${sub.planName}" — ${fmtMoney(sub.amountCents)}.`;

  // Pick first active channel
  const channels = store.listChannels(tenantId).filter(c => c.status === 'active');
  if (contact.phone && channels[0]) {
    await sendOutbound(channels[0], {
      to: contact.phone, text: msg, contactId: contact.id, cardId: sub.cardId,
    });
  }

  // Log + bump reminders_sent
  store.logActivity(tenantId, {
    cardId: sub.cardId, contactId: sub.contactId,
    type: 'billing', channel: channels[0] ? (channels[0].type === 'meta' ? 'whatsapp_meta' : 'whatsapp_zapi') : 'manual',
    content: `Lembrete cobrança T-${days}d enviado: ${sub.planName} ${fmtMoney(sub.amountCents)}`,
  });
  store.updateSubscription(tenantId, sub.id, { remindersSent: sub.remindersSent + 1 });
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
      console.warn('[billing charge] failed', e.message);
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
  };
}

/** Manual: mark a subscription as paid (called via API/button) */
export function markPaid(tenantId: string, subId: string): Subscription | null {
  const db = getCrmDb();
  const r = db.prepare('SELECT * FROM crm_subscriptions WHERE id = ? AND tenant_id = ?').get(subId, tenantId) as any;
  if (!r) return null;
  const sub = rowToSub(r);
  store.logActivity(tenantId, {
    cardId: sub.cardId, contactId: sub.contactId,
    type: 'billing', channel: 'manual',
    content: `✅ Pagamento confirmado: ${sub.planName} ${fmtMoney(sub.amountCents)}`,
  });
  // Reset reminders + (re)activate
  return store.updateSubscription(tenantId, subId, {
    remindersSent: 0,
    status: 'active',
  });
}
