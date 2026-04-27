// CRM subscriptions module — split out from the legacy monolithic file in a refactor.
// Edit this file directly; scripts/split-routes.cjs is retained only as a record
// of how the original was decomposed (it ran once against the .ts.bak snapshot).
import { Hono } from 'hono';
import * as store from '.././store.js';
import { encryptJson, decryptJson, maskSecret } from '.././crypto.js';
import { sendOutbound } from '.././inbox.js';
import * as automations from '.././automations.js';
import { markPaid } from '.././billing.js';
import * as assignment from '.././assignment.js';
import * as lineItems from '.././lineItems.js';
import * as analytics from '.././analytics.js';
import * as reports from '.././reports.js';
import { getCrmDb } from '.././schema.js';
import { toCSV, toPDF, type ReportKind } from '.././reportsExport.js';
import * as proposalsMod from '.././proposals.js';
import * as em from '.././emailMarketing.js';
import * as forms from '.././forms.js';
import * as tasksMod from '.././tasks.js';
import * as cal from '.././calendar.js';
import * as collab from '.././collaboration.js';
import * as search from '.././search.js';
import * as ohk from '.././outboundWebhooks.js';
import * as extint from '.././integrations.js';
import * as push from '.././push.js';
import * as ai from '.././ai.js';
import * as docs from '.././documents.js';
import * as gam from '.././gamification.js';
import * as lgpd from '.././lgpd.js';
import * as softDel from '.././softDelete.js';
import * as rl from '.././rateLimiter.js';
import * as sec from '.././security.js';
import { cache } from '.././queryCache.js';
import { contactLoader, agentLoader } from '.././dataLoader.js';
import { dbInfo, tableStats, explain, vacuum, applyPerformancePragmas } from '.././connectionInfo.js';
import * as bulkOps from '.././bulkOps.js';
import { fieldSelectionMiddleware } from '.././fieldSelector.js';
import { encodeCursor, decodeCursor } from '.././cursor.js';
import * as mobile from '.././mobile.js';
import { subscribe, formatSseFrame } from '.././events.js';
import { findTenantByApiKeyHash, hashApiKey } from '../../tenancy/tenantStore.js';
import { readMedia } from '.././media.js';
import type { BoardType, ChannelType, BillingCycle, AgentRole } from '.././types.js';
/**
 * CRM REST API routes — mounted at /v1/crm.
 *
 * All routes require tenant authentication (tenantId comes from context,
 * set by tenantAuth middleware). Every query is scoped automatically.
 *
 * Conventions:
 *   - 200 ok  | 201 created | 204 no content
 *   - 400 bad input | 401 unauth (handled by middleware) | 404 not found
 *   - JSON in/out, never form-encoded
 *   - IDs returned in responses; client never invents them
 */

// ─── Helpers ────────────────────────────────────────────────────────────
function tenantOf(c: any): string {
  const t = c.get?.('tenantId') || c.get?.('tenant_id');
  return t || 'default';
}

function badRequest(c: any, msg: string, details?: unknown) {
  return c.json({ error: 'bad_request', message: msg, details }, 400);
}
function notFound(c: any, what: string) {
  return c.json({ error: 'not_found', message: `${what} not found` }, 404);
}
function ok(c: any, data: unknown, status = 200) {
  return c.json(data, status);
}

/** Hydrated kanban view: board + columns + cards grouped by column. */

function parseWin(c: any): { from?: number; to?: number } {
  const from = c.req.query('from');
  const to   = c.req.query('to');
  const w: { from?: number; to?: number } = {};
  if (from && /^\d+$/.test(from)) w.from = Number(from);
  if (to   && /^\d+$/.test(to))   w.to   = Number(to);
  return w;
}

function parseWin2(c: any): { from?: number; to?: number } {
  const from = c.req.query('from');
  const to   = c.req.query('to');
  const w: { from?: number; to?: number } = {};
  if (from && /^\d+$/.test(from)) w.from = Number(from);
  if (to   && /^\d+$/.test(to))   w.to   = Number(to);
  return w;
}

async function deliverReport(c: any, kind: ReportKind, rows: any[], title: string): Promise<Response> {
  const fmt = (c.req.query('format') || 'json').toLowerCase();
  if (fmt === 'csv') {
    const csv = toCSV(kind, rows);
    return new Response(csv, {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${kind}-${Date.now()}.csv"`,
      },
    });
  }
  if (fmt === 'pdf') {
    const pdf = await toPDF(kind, rows, { title });
    return new Response(new Uint8Array(pdf), {
      status: 200,
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': `attachment; filename="${kind}-${Date.now()}.pdf"`,
      },
    });
  }
  return ok(c, { kind, rows, count: rows.length });
}

// ─── Scheduled reports CRUD ─────────────────────────────────────────────

function computeFirstRunAt(interval: string): number {
  const d = new Date();
  // Schedule first run at 08:00 UTC next day/week/month
  d.setUTCHours(8, 0, 0, 0);
  if (interval === 'daily')   d.setUTCDate(d.getUTCDate() + 1);
  if (interval === 'weekly')  d.setUTCDate(d.getUTCDate() + 7);
  if (interval === 'monthly') d.setUTCMonth(d.getUTCMonth() + 1);
  return d.getTime();
}

// Onda 48: marcar card como lido (zera badge WhatsApp)

// Onda 59: reordenar card dentro/entre colunas — recalcula posicoes sequenciais
// body: { toColumnId, beforeCardId?: string (move pra antes desse card),
//         atIndex?: number (alternativa: posicao 0..N) }

// ─── Onda 55: refresh manual de fotos de perfil WhatsApp (Z-API) ──────
// POST /contacts/refresh-photos { force?: boolean }
//   force=false (default): só busca fotos de contatos sem avatar_url
//   force=true: busca de TODOS, sobrescreve URLs antigas (links Z-API expiram)
// Resposta: { ok, updated, skipped, noPhoto, errors, total }

/**
 * Channels store ENCRYPTED credentials. The API never returns raw credentials.
 * Instead, returns masked summaries so the UI shows what's configured.
 */

interface MetaCreds {
  accessToken: string;
  phoneNumberId: string;
  businessAccountId?: string;
  appId?: string;
  verifyToken?: string;
  apiVersion?: string;
}
interface ZapiCreds {
  instanceId: string;
  token: string;
  clientToken?: string;
  baseUrl?: string;
}

function maskedChannel(ch: any) {
  let creds: any = null;
  try { creds = decryptJson(ch.credentialsEncrypted); } catch { /* corrupted */ }
  const cred_summary = creds ? (
    ch.type === 'meta' ? {
      phoneNumberId: creds.phoneNumberId,
      accessToken: maskSecret(creds.accessToken || ''),
      businessAccountId: creds.businessAccountId,
      appId: creds.appId,
      apiVersion: creds.apiVersion || 'v22.0',
    } : {
      instanceId: creds.instanceId,
      token: maskSecret(creds.token || ''),
      clientToken: creds.clientToken ? maskSecret(creds.clientToken) : null,
      baseUrl: creds.baseUrl || 'https://api.z-api.io',
    }
  ) : null;
  return {
    id: ch.id, type: ch.type, name: ch.name, status: ch.status,
    phoneNumber: ch.phoneNumber, phoneNumberId: ch.phoneNumberId,
    webhookSecret: ch.webhookSecret, // needed by client for webhook URL
    lastInboundAt: ch.lastInboundAt, createdAt: ch.createdAt,
    credentials: cred_summary,
  };
}

// Onda 53: /me — info do tenant atual + limites WhatsApp

// POST /v1/crm/media/process — multipart file field
// Retorna: { kind: 'audio|image|pdf|text|unknown', content: '...' }

// Stripe Connect: tenant conecta SUA conta Stripe

// Invoices

// Coupons

// Dunning

// Subscriptions Pro ops

// MRR Dashboard

function baseUrlOf(c: any): string {
  const proto = c.req.header('x-forwarded-proto') || 'https';
  const host = c.req.header('host') || 'localhost';
  return `${proto}://${host}`;
}

// Keep onAccept hook in sync: when status is set to 'accepted' via admin
// endpoint (not just public sign), also trigger conversion.

// Sequences (drip)

// Unsubscribe management (admin-level)

// Inbound webhooks

// Public contact API — authenticated, simpler subset for integrations

function parseTaskOpts(c: any): any {
  const opts: any = {};
  const status = c.req.query('status');
  const type = c.req.query('type');
  const priority = c.req.query('priority');
  const agentId = c.req.query('agentId');
  const cardId = c.req.query('cardId');
  const contactId = c.req.query('contactId');
  const dueBefore = c.req.query('dueBefore');
  const dueAfter = c.req.query('dueAfter');
  if (status)     opts.status = status;
  if (type)       opts.type = type;
  if (priority)   opts.priority = priority;
  if (agentId)    opts.agentId = agentId;
  if (cardId)     opts.cardId = cardId;
  if (contactId)  opts.contactId = contactId;
  if (dueBefore && /^\d+$/.test(dueBefore)) opts.dueBefore = Number(dueBefore);
  if (dueAfter && /^\d+$/.test(dueAfter))   opts.dueAfter = Number(dueAfter);
  return opts;
}

// "Minhas tarefas" views

// ICS feed URL (permission grant to sub to calendar app)

// Scheduling links (Calendly-style)

// Calendar integrations (Google/Outlook/CalDAV tokens)

// Card comments

// Chat rooms

// Contact notes

// Mentions inbox

// Unified timeline per contact

// Global full-text search

// Structured card/contact search

// Admin utility: rebuild FTS indices

// Saved views CRUD

// Bulk actions

// Outbound webhooks CRUD

// External integrations

// Trigger sync (batch import)

// Mobile compact endpoints

// Batch scoring (useful after migration or dashboard open)

// Templates

// Documents CRUD

// Repository by contact

// Goals CRUD

// Badges catalog

// Agent badges

// Consents

// Portability — export

// Right to erasure

// Access log

// Retention policies

// Deletion requests

// Cursor-paginated contact listing

// Migration history view

// Bulk operations

function actorOf(c: any): string | undefined {
  return c.req.header('x-actor-agent-id') || c.get?.('agentId') || undefined;
}
function ipOf(c: any): string {
  return c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.req.header('x-real-ip') || 'unknown';
}

// ─── RBAC ───────────────────────────────────────────────────────────────

// ─── 2FA ─────────────────────────────────────────────────────────────────

// ─── Sessions ───────────────────────────────────────────────────────────

// ─── IP whitelist ────────────────────────────────────────────────────────

// ─── Audit log ───────────────────────────────────────────────────────────

// Lazy-hydrated pipeline: uses DataLoader to batch contact fetch

// ─── Board settings ──────────────────────────────────────────

// ─── Swimlanes ───────────────────────────────────────────────

// ─── Checklists ─────────────────────────────────────────────

// Used by the System Clow shell to open CRM in-app without asking the user
// for an API key. When user logs into System Clow (workspace), this endpoint
// gives them the CRM key for their tenant.
//
// Today: admin session token → admin tenant key
// Tomorrow (multi-tenant SaaS): tenant session token → that tenant's key



export function registerSubscriptionsRoutes(app: Hono): void {
  app.get('/subscriptions', (c) => {
    const status = c.req.query('status') as any || undefined;
    return ok(c, { subscriptions: store.listSubscriptions(tenantOf(c), status) });
  });
  app.post('/subscriptions', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (!body.contactId || !body.planName || body.amountCents == null || !body.cycle || !body.nextChargeAt) {
      return badRequest(c, 'contactId, planName, amountCents, cycle, nextChargeAt required');
    }
    const validCycles: BillingCycle[] = ['weekly', 'monthly', 'quarterly', 'yearly', 'one_time'];
    if (!validCycles.includes(body.cycle)) return badRequest(c, `cycle invalid (${validCycles.join(', ')})`);
    const sub = store.createSubscription(tenantOf(c), body);
    return ok(c, { subscription: sub }, 201);
  });
  app.patch('/subscriptions/:id', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const upd = store.updateSubscription(tenantOf(c), c.req.param('id'), body);
    return upd ? ok(c, { subscription: upd }) : notFound(c, 'subscription');
  });
  app.post('/invoices', async (c) => {
    const body = await c.req.json().catch(() => ({})) as any;
    if (typeof body.amount_cents !== 'number') return badRequest(c, 'amount_cents required');
    return ok(c, { invoice: store.createInvoice(tenantOf(c), {
      subscriptionId: body.subscription_id, contactId: body.contact_id,
      amountCents: body.amount_cents, dueAt: body.due_at,
      stripeInvoiceId: body.stripe_invoice_id,
    }) }, 201);
  });
  app.get('/invoices', (c) => ok(c, { invoices: store.listInvoices(tenantOf(c), {
    status: c.req.query('status') as any,
    subscriptionId: c.req.query('subscription_id') || undefined,
    contactId: c.req.query('contact_id') || undefined,
    limit: parseInt(c.req.query('limit') || '200', 10),
  }) }));
  app.post('/invoices/:id/mark-paid', async (c) => {
    const body = await c.req.json().catch(() => ({})) as any;
    const inv = store.markInvoicePaid(tenantOf(c), c.req.param('id'), body.payment_method);
    return inv ? ok(c, { invoice: inv }) : notFound(c, 'invoice');
  });
  app.post('/coupons', async (c) => {
    const body = await c.req.json().catch(() => ({})) as any;
    if (!body.code) return badRequest(c, 'code required');
    return ok(c, { coupon: store.createCoupon(tenantOf(c), {
      code: body.code,
      discountPercent: body.discount_percent,
      discountCents: body.discount_cents,
      maxRedemptions: body.max_redemptions,
      validUntil: body.valid_until,
      active: body.active !== false,
    }) }, 201);
  });
  app.get('/coupons', (c) => ok(c, { coupons: store.listCoupons(tenantOf(c)) }));
  app.post('/coupons/:code/redeem', (c) => {
    const r = store.redeemCoupon(tenantOf(c), c.req.param('code'));
    return r.ok ? ok(c, { coupon: r.coupon }) : c.json({ error: r.error }, 400);
  });
  app.delete('/coupons/:id', (c) => store.deleteCoupon(tenantOf(c), c.req.param('id')) ? c.body(null, 204) : notFound(c, 'coupon'));
  app.get('/subscriptions/:id/dunning', (c) => ok(c, { log: store.listDunning(tenantOf(c), c.req.param('id')) }));
  app.post('/subscriptions/:id/cancel', async (c) => {
    const body = await c.req.json().catch(() => ({})) as any;
    return store.cancelSubscription(tenantOf(c), c.req.param('id'), body.reason) ? ok(c, { ok: true }) : notFound(c, 'subscription');
  });
  app.patch('/subscriptions/:id/trial', async (c) => {
    const body = await c.req.json().catch(() => ({})) as any;
    if (typeof body.trial_until !== 'number') return badRequest(c, 'trial_until (ms) required');
    return store.setSubscriptionTrial(tenantOf(c), c.req.param('id'), body.trial_until) ? ok(c, { ok: true }) : notFound(c, 'subscription');
  });
  app.patch('/subscriptions/:id/payment-link', async (c) => {
    const body = await c.req.json().catch(() => ({})) as any;
    if (!body.link) return badRequest(c, 'link required');
    return store.setPaymentLink(tenantOf(c), c.req.param('id'), body.link) ? ok(c, { ok: true }) : notFound(c, 'subscription');
  });
  // Lista subs vinculadas a um card (pelo cardId direto OU pelo
  // contactId do card). Usado pelo painel Vinculos do card pra
  // mostrar mensalidades junto com tarefas/documentos/propostas.
  app.get('/cards/:id/subscriptions', (c) => {
    const tid = tenantOf(c);
    const card = store.getCard(tid, c.req.param('id'));
    if (!card) return notFound(c, 'card');
    const all = store.listSubscriptions(tid);
    const subs = all.filter((s) =>
      s.cardId === card.id || (card.contactId && s.contactId === card.contactId),
    );
    return ok(c, { subscriptions: subs });
  });

  // Lista subs de um contato (todos os cards/sem card desse contato)
  app.get('/contacts/:id/subscriptions', (c) => {
    const tid = tenantOf(c);
    const contactId = c.req.param('id');
    const subs = store.listSubscriptions(tid).filter((s) => s.contactId === contactId);
    return ok(c, { subscriptions: subs });
  });

  app.post('/subscriptions/:id/mark-paid', (c) => {
    const r = markPaid(tenantOf(c), c.req.param('id'));
    return r ? ok(c, { subscription: r }) : notFound(c, 'subscription');
  });

  // Garante que a sub tem um card vinculado (pra abrir o painel de chat
  // do CRM com a conversa). Se ja tem, retorna direto. Se nao, cria um
  // card "Cobranca - {planName}" no primeiro board+coluna disponivel,
  // vincula a sub a ele, e retorna o cardId. Idempotente.
  app.post('/subscriptions/:id/ensure-card', async (c) => {
    const tid = tenantOf(c);
    const subId = c.req.param('id');
    const sub = store.listSubscriptions(tid).find((s) => s.id === subId);
    if (!sub) return notFound(c, 'subscription');
    if (sub.cardId) {
      // Verifica se card ainda existe (pode ter sido deletado)
      const exists = store.getCard(tid, sub.cardId);
      if (exists) return ok(c, { cardId: sub.cardId, created: false });
    }
    // Acha (ou cria) board padrao
    let boards = store.listBoards(tid);
    if (!boards.length) {
      store.seedDefaultBoards(tid);
      boards = store.listBoards(tid);
    }
    const board = boards[0]!;
    const cols = store.listColumns(tid, board.id);
    if (!cols.length) return badRequest(c, 'board sem colunas — crie uma coluna no board primeiro');
    const col = cols[0]!;
    const contact = store.getContact(tid, sub.contactId);
    const card = store.createCard(tid, {
      boardId: board.id,
      columnId: col.id,
      title: `Cobranca - ${sub.planName}`,
      contactId: sub.contactId,
      valueCents: sub.amountCents,
      contactName: contact?.name,
      contactPhone: contact?.phone,
    } as any);
    if (!card) return badRequest(c, 'falha ao criar card');
    store.updateSubscription(tid, sub.id, { cardId: card.id });
    return ok(c, { cardId: card.id, created: true });
  });
}
