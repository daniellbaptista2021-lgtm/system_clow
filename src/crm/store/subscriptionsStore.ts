// CRM subscriptionsStore module — split out from the legacy monolithic file in a refactor.
// Edit this file directly; scripts/split-store.cjs is retained only as a record
// of how the original was decomposed (it ran once against the .ts.bak snapshot).
import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import { getCrmDb } from '.././schema.js';
import type {
  Board, BoardColumn, Contact, Card, Activity, Agent, Channel2,
  Subscription, Automation, InventoryItem, BoardType, ActivityType,
  Channel, MediaType, ChannelType, ChannelStatus, BillingCycle, SubscriptionStatus, AgentRole,
} from '.././types.js';
import type { Segment, SegmentFilter, BulkContactOp } from '.././types.js';
import type { Swimlane, Checklist, ChecklistItem, BoardSettings, ColumnStageType } from '.././types.js';
import type { Team, AgentPermissions, AgentMetricsPro, SlaRule,
              Label, QuickReply, InboxRule } from '.././types.js';
import type { ActivityFilter, ReminderChannel, ReminderStatus, ReminderPro } from '.././types.js';
import type { InventoryCategory, InventoryVariant, InventoryMovement,
              Proposal, ProposalStatus, ProposalTemplate } from '.././types.js';
import type { StripeConnectAccount, InvoicePro, InvoiceStatus, Coupon, DunningLog, MrrSnapshot } from '.././types.js';
import type { AutomationLog, AssignmentRule, AssignmentConditions, AssignmentLog } from '.././types.js';
import type { ChannelTemplate, ChannelHealth, ChannelMetrics } from '.././types.js';
import { now, getAutoAssign, getCommitStock, getPublish, getEmit, nid, J, HEADER_ALIASES } from './_internals.js';
import type { ImportResult, EvalContext } from './_internals.js';


export function createSubscription(tenantId: string, input: {
  contactId: string; cardId?: string; planName: string; amountCents: number;
  cycle: BillingCycle; nextChargeAt: number;
}): Subscription {
  const db = getCrmDb();
  const s: Subscription = {
    id: nid('crm_sub'), tenantId, contactId: input.contactId, cardId: input.cardId,
    planName: input.planName, amountCents: input.amountCents, cycle: input.cycle,
    nextChargeAt: input.nextChargeAt, status: 'active', remindersSent: 0, createdAt: now(),
  };
  db.prepare(`
    INSERT INTO crm_subscriptions (id, tenant_id, contact_id, card_id, plan_name, amount_cents,
      cycle, next_charge_at, status, reminders_sent, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, ?)
  `).run(s.id, s.tenantId, s.contactId, s.cardId ?? null, s.planName, s.amountCents,
    s.cycle, s.nextChargeAt, s.createdAt);
  return s;
}

export function listSubscriptions(tenantId: string, status?: SubscriptionStatus): Subscription[] {
  const db = getCrmDb();
  const rows = status
    ? db.prepare('SELECT * FROM crm_subscriptions WHERE tenant_id = ? AND status = ? ORDER BY next_charge_at ASC').all(tenantId, status) as any[]
    : db.prepare('SELECT * FROM crm_subscriptions WHERE tenant_id = ? ORDER BY next_charge_at ASC').all(tenantId) as any[];
  return rows.map(rowToSubscription);
}

export function listSubscriptionsDue(beforeTs: number = now()): Subscription[] {
  const db = getCrmDb();
  const rows = db.prepare(`
    SELECT * FROM crm_subscriptions WHERE status = 'active' AND next_charge_at <= ?
    ORDER BY next_charge_at ASC
  `).all(beforeTs) as any[];
  return rows.map(rowToSubscription);
}

export function updateSubscription(tenantId: string, subId: string, patch: Partial<Omit<Subscription, 'id' | 'tenantId' | 'createdAt'>>): Subscription | null {
  const db = getCrmDb();
  const r = db.prepare('SELECT * FROM crm_subscriptions WHERE id = ? AND tenant_id = ?').get(subId, tenantId) as any;
  if (!r) return null;
  const existing = rowToSubscription(r);
  const upd = { ...existing, ...patch };
  db.prepare(`
    UPDATE crm_subscriptions SET plan_name = ?, amount_cents = ?, cycle = ?, next_charge_at = ?,
      status = ?, reminders_sent = ?, cancelled_at = ?, last_paid_at = ?
    WHERE id = ? AND tenant_id = ?
  `).run(upd.planName, upd.amountCents, upd.cycle, upd.nextChargeAt, upd.status,
    upd.remindersSent, upd.cancelledAt ?? null, upd.lastPaidAt ?? null, subId, tenantId);
  return upd;
}

function rowToSubscription(r: any): Subscription {
  return {
    id: r.id, tenantId: r.tenant_id, contactId: r.contact_id, cardId: r.card_id ?? undefined,
    planName: r.plan_name, amountCents: r.amount_cents, cycle: r.cycle as BillingCycle,
    nextChargeAt: r.next_charge_at, status: r.status as SubscriptionStatus,
    remindersSent: r.reminders_sent, createdAt: r.created_at, cancelledAt: r.cancelled_at ?? undefined,
    lastPaidAt: r.last_paid_at ?? undefined,
  };
}

export function setStripeConnect(tenantId: string, stripeAccountId: string, init: Partial<StripeConnectAccount> = {}): StripeConnectAccount {
  const db = getCrmDb();
  const t = now();
  db.prepare(`INSERT INTO crm_stripe_connect (tenant_id, stripe_account_id, status, charges_enabled, payouts_enabled, onboarded_at, created_at)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT(tenant_id) DO UPDATE SET
      stripe_account_id=excluded.stripe_account_id,
      status=excluded.status,
      charges_enabled=excluded.charges_enabled,
      payouts_enabled=excluded.payouts_enabled,
      onboarded_at=excluded.onboarded_at`)
    .run(tenantId, stripeAccountId, init.status || 'pending',
         init.chargesEnabled ? 1 : 0, init.payoutsEnabled ? 1 : 0,
         init.onboardedAt ?? null, t);
  return { tenantId, stripeAccountId, status: init.status || 'pending',
    chargesEnabled: !!init.chargesEnabled, payoutsEnabled: !!init.payoutsEnabled,
    onboardedAt: init.onboardedAt, createdAt: t };
}

export function getStripeConnect(tenantId: string): StripeConnectAccount | null {
  const r = getCrmDb().prepare('SELECT * FROM crm_stripe_connect WHERE tenant_id=?').get(tenantId) as any;
  if (!r) return null;
  return { tenantId: r.tenant_id, stripeAccountId: r.stripe_account_id,
    status: r.status, chargesEnabled: !!r.charges_enabled, payoutsEnabled: !!r.payouts_enabled,
    onboardedAt: r.onboarded_at ?? undefined, createdAt: r.created_at };
}

function rowToInvoice(r: any): InvoicePro {
  return {
    id: r.id, tenantId: r.tenant_id,
    subscriptionId: r.subscription_id ?? undefined, contactId: r.contact_id ?? undefined,
    amountCents: r.amount_cents, status: r.status as InvoiceStatus,
    dueAt: r.due_at ?? undefined, paidAt: r.paid_at ?? undefined,
    pdfUrl: r.pdf_url ?? undefined, stripeInvoiceId: r.stripe_invoice_id ?? undefined,
    paymentMethod: r.payment_method ?? undefined, createdAt: r.created_at,
  };
}

export function createInvoice(tenantId: string, input: {
  subscriptionId?: string; contactId?: string; amountCents: number;
  dueAt?: number; stripeInvoiceId?: string;
}): InvoicePro {
  const inv: InvoicePro = { id: nid('crm_inv'), tenantId,
    subscriptionId: input.subscriptionId, contactId: input.contactId,
    amountCents: input.amountCents, status: 'pending',
    dueAt: input.dueAt, stripeInvoiceId: input.stripeInvoiceId,
    createdAt: now() };
  getCrmDb().prepare('INSERT INTO crm_invoices (id,tenant_id,subscription_id,contact_id,amount_cents,status,due_at,stripe_invoice_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(inv.id, tenantId, inv.subscriptionId ?? null, inv.contactId ?? null,
         inv.amountCents, inv.status, inv.dueAt ?? null, inv.stripeInvoiceId ?? null, inv.createdAt);
  return inv;
}

export function listInvoices(tenantId: string, opts: { status?: InvoiceStatus; subscriptionId?: string; contactId?: string; limit?: number } = {}): InvoicePro[] {
  const conds: string[] = ['tenant_id = ?'];
  const args: any[] = [tenantId];
  if (opts.status) { conds.push('status = ?'); args.push(opts.status); }
  if (opts.subscriptionId) { conds.push('subscription_id = ?'); args.push(opts.subscriptionId); }
  if (opts.contactId) { conds.push('contact_id = ?'); args.push(opts.contactId); }
  const sql = `SELECT * FROM crm_invoices WHERE ${conds.join(' AND ')} ORDER BY created_at DESC LIMIT ?`;
  args.push(Math.min(opts.limit || 200, 1000));
  return (getCrmDb().prepare(sql).all(...args) as any[]).map(rowToInvoice);
}

export function markInvoicePaid(tenantId: string, id: string, paymentMethod?: string): InvoicePro | null {
  const db = getCrmDb();
  db.prepare('UPDATE crm_invoices SET status=?, paid_at=?, payment_method=? WHERE id=? AND tenant_id=?')
    .run('paid', Date.now(), paymentMethod ?? null, id, tenantId);
  const r = db.prepare('SELECT * FROM crm_invoices WHERE id=? AND tenant_id=?').get(id, tenantId) as any;
  return r ? rowToInvoice(r) : null;
}

function rowToCoupon(r: any): Coupon {
  return { id: r.id, tenantId: r.tenant_id, code: r.code,
    discountPercent: r.discount_percent ?? undefined,
    discountCents: r.discount_cents ?? undefined,
    maxRedemptions: r.max_redemptions ?? undefined,
    timesRedeemed: r.times_redeemed,
    validUntil: r.valid_until ?? undefined,
    active: !!r.active, createdAt: r.created_at };
}

export function createCoupon(tenantId: string, input: Omit<Coupon,'id'|'tenantId'|'timesRedeemed'|'createdAt'>): Coupon {
  const c: Coupon = { id: nid('crm_cpn'), tenantId, ...input, timesRedeemed: 0, createdAt: now() };
  getCrmDb().prepare('INSERT INTO crm_coupons (id,tenant_id,code,discount_percent,discount_cents,max_redemptions,times_redeemed,valid_until,active,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(c.id, tenantId, c.code,
         c.discountPercent ?? null, c.discountCents ?? null,
         c.maxRedemptions ?? null, 0, c.validUntil ?? null, c.active ? 1 : 0, c.createdAt);
  return c;
}

export function listCoupons(tenantId: string): Coupon[] {
  return (getCrmDb().prepare('SELECT * FROM crm_coupons WHERE tenant_id=? ORDER BY created_at DESC').all(tenantId) as any[]).map(rowToCoupon);
}

export function redeemCoupon(tenantId: string, code: string): { ok: boolean; coupon?: Coupon; error?: string } {
  const db = getCrmDb();
  const r = db.prepare('SELECT * FROM crm_coupons WHERE tenant_id=? AND code=? AND active=1').get(tenantId, code) as any;
  if (!r) return { ok: false, error: 'coupon_not_found' };
  if (r.valid_until && r.valid_until < Date.now()) return { ok: false, error: 'coupon_expired' };
  if (r.max_redemptions && r.times_redeemed >= r.max_redemptions) return { ok: false, error: 'max_redemptions_reached' };
  db.prepare('UPDATE crm_coupons SET times_redeemed=times_redeemed+1 WHERE id=?').run(r.id);
  return { ok: true, coupon: rowToCoupon({ ...r, times_redeemed: r.times_redeemed + 1 }) };
}

export function deleteCoupon(tenantId: string, id: string): boolean {
  return getCrmDb().prepare('DELETE FROM crm_coupons WHERE id=? AND tenant_id=?').run(id, tenantId).changes > 0;
}

export function logDunning(tenantId: string, subscriptionId: string, attempt: number, action: string, success: boolean, error?: string): DunningLog {
  const log: DunningLog = { id: nid('crm_dn'), tenantId, subscriptionId, attempt, action, success, error, createdAt: now() };
  getCrmDb().prepare('INSERT INTO crm_dunning_log (id,tenant_id,subscription_id,attempt,action,success,error,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(log.id, tenantId, subscriptionId, attempt, action, success ? 1 : 0, error ?? null, log.createdAt);
  return log;
}

export function listDunning(tenantId: string, subscriptionId: string): DunningLog[] {
  return (getCrmDb().prepare('SELECT * FROM crm_dunning_log WHERE tenant_id=? AND subscription_id=? ORDER BY created_at DESC').all(tenantId, subscriptionId) as any[])
    .map((r: any) => ({ id: r.id, tenantId: r.tenant_id, subscriptionId: r.subscription_id,
      attempt: r.attempt, action: r.action, success: !!r.success, error: r.error ?? undefined, createdAt: r.created_at }));
}

export function computeMrr(tenantId: string): MrrSnapshot {
  const db = getCrmDb();
  const now30d = Date.now() - 30*24*60*60*1000;

  // Active: status='active' e cycle=monthly/yearly
  const activeSubs = db.prepare("SELECT * FROM crm_subscriptions WHERE tenant_id=? AND status='active'").all(tenantId) as any[];
  const pastDueSubs = (db.prepare("SELECT COUNT(*) n FROM crm_subscriptions WHERE tenant_id=? AND status='past_due'").get(tenantId) as any).n;
  const trialSubs = (db.prepare("SELECT COUNT(*) n FROM crm_subscriptions WHERE tenant_id=? AND status='active' AND trial_until > ?").get(tenantId, Date.now()) as any).n;
  const cancelledMonth = (db.prepare("SELECT COUNT(*) n FROM crm_subscriptions WHERE tenant_id=? AND status='cancelled' AND cancelled_at >= ?").get(tenantId, now30d) as any).n;
  const newMonth = (db.prepare("SELECT COUNT(*) n FROM crm_subscriptions WHERE tenant_id=? AND created_at >= ?").get(tenantId, now30d) as any).n;

  let totalMrrCents = 0;
  for (const s of activeSubs) {
    const cents = s.amount_cents || 0;
    if (s.cycle === 'monthly') totalMrrCents += cents;
    else if (s.cycle === 'yearly') totalMrrCents += Math.round(cents / 12);
    else if (s.cycle === 'quarterly') totalMrrCents += Math.round(cents / 3);
    else if (s.cycle === 'weekly') totalMrrCents += Math.round(cents * 4.33);
    // one_time: exclui
  }

  const activeCount = activeSubs.length;
  const churnRate = activeCount > 0 ? cancelledMonth / (activeCount + cancelledMonth) : 0;
  const arpu = activeCount > 0 ? totalMrrCents / activeCount : 0;

  return {
    totalMrrCents,
    activeSubs: activeCount,
    trialSubs,
    pastDueSubs,
    cancelledMonth,
    newMonth,
    churnRate,
    averageRevenuePerUser: arpu,
  };
}

export function cancelSubscription(tenantId: string, id: string, reason?: string): boolean {
  const db = getCrmDb();
  return db.prepare("UPDATE crm_subscriptions SET status='cancelled', cancelled_at=?, cancel_reason=? WHERE id=? AND tenant_id=?")
    .run(Date.now(), reason ?? null, id, tenantId).changes > 0;
}

export function setSubscriptionTrial(tenantId: string, id: string, trialUntil: number): boolean {
  return getCrmDb().prepare('UPDATE crm_subscriptions SET trial_until=? WHERE id=? AND tenant_id=?')
    .run(trialUntil, id, tenantId).changes > 0;
}

export function setPaymentLink(tenantId: string, id: string, link: string): boolean {
  return getCrmDb().prepare('UPDATE crm_subscriptions SET payment_link=? WHERE id=? AND tenant_id=?')
    .run(link, id, tenantId).changes > 0;
}
