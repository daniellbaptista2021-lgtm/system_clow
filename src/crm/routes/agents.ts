// CRM agents module — split out from the legacy monolithic file in a refactor.
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
import { logger } from '../../utils/logger.js';
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



export function registerAgentsRoutes(app: Hono): void {
  app.get('/agents', (c) => ok(c, { agents: store.listAgents(tenantOf(c)) }));
  app.post('/agents', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (!body.name || !body.email) return badRequest(c, 'name and email required');
    const validRoles: AgentRole[] = ['owner', 'admin', 'agent', 'viewer'];
    if (body.role && !validRoles.includes(body.role)) return badRequest(c, `role invalid (${validRoles.join(', ')})`);
    try {
      const a = store.createAgent(tenantOf(c), body);
      return ok(c, { agent: a }, 201);
    } catch (e: any) {
      if (e.message.includes('UNIQUE')) return badRequest(c, 'email already exists for this tenant');
      throw e;
    }
  });
  app.patch('/agents/:id', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const upd = store.updateAgent(tenantOf(c), c.req.param('id'), body);
    return upd ? ok(c, { agent: upd }) : notFound(c, 'agent');
  });
  app.delete('/agents/:id', (c) => {
    const ok2 = store.deleteAgent(tenantOf(c), c.req.param('id'));
    return ok2 ? c.body(null, 204) : notFound(c, 'agent');
  });
  app.get('/me', async (c) => {
    const tid = tenantOf(c);
    try {
      const { getTenant } = await import('../../tenancy/tenantStore.js');
      const { TIERS } = await import('../../tenancy/tiers.js');
      const t = getTenant(tid);
      const channels = store.listChannels(tid);
      const zapiCount = channels.filter((ch: any) => ch.type === 'zapi').length;
      const metaCount = channels.filter((ch: any) => ch.type === 'meta').length;
      const totalUsed = zapiCount + metaCount;

      // Tenant nao encontrado: retorna fallback 200 (nunca derruba o front)
      if (!t) {
        logger.warn('[/me] tenant not found tid=' + tid + ' — using fallback');
        return c.json({
          ok: true,
          _fallback: true,
          tenant: { id: tid, email: null, name: null, tier: 'unknown', status: 'unknown', hasStripe: false },
          whatsapp: { included: 1, max: 999, zapiCount, metaCount, totalUsed, extraPaid: 0, available: Math.max(0, 999 - totalUsed), pricePerExtraBrl: 100 },
        });
      }

      const tierCfg = TIERS[t.tier as keyof typeof TIERS];

      // Buscar add-on Stripe (numero extras pagos) com timeout 3s
      let extraPaid = 0;
      if (t.stripe_subscription_id && process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_WHATSAPP_ADDON) {
        try {
          const Stripe = (await import('stripe')).default;
          const sk = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-12-18.acacia' as any, timeout: 3000 });
          const sub = await sk.subscriptions.retrieve(t.stripe_subscription_id);
          const addonItem = sub.items.data.find((it: any) => it.price.id === process.env.STRIPE_PRICE_WHATSAPP_ADDON);
          if (addonItem) extraPaid = addonItem.quantity || 0;
        } catch (err: any) {
          logger.warn('[/me] subscription check failed:', err.message);
        }
      }

      // Tier desconhecido: tambem retorna fallback amplo (assume business)
      const max = tierCfg?.max_whatsapp_numbers || 999;
      const included = tierCfg?.included_whatsapp_numbers || 1;

      return c.json({
        ok: true,
        tenant: {
          id: t.id,
          email: t.email,
          name: t.name,
          tier: t.tier,
          status: t.status,
          hasStripe: !!t.stripe_customer_id,
        },
        whatsapp: {
          included,
          max,
          zapiCount,
          metaCount,
          totalUsed,
          extraPaid,
          available: Math.max(0, max + extraPaid - totalUsed),
          pricePerExtraBrl: 100,
        },
      });
    } catch (err: any) {
      logger.error('[/me] handler error:', err && err.stack || err);
      return c.json({
        ok: true,
        _fallback: true,
        _error: err?.message || 'internal',
        tenant: { id: tid, email: null, name: null, tier: 'unknown', status: 'unknown', hasStripe: false },
        whatsapp: { included: 1, max: 999, zapiCount: 0, metaCount: 0, totalUsed: 0, extraPaid: 0, available: 999, pricePerExtraBrl: 100 },
      });
    }
  });
  app.post('/assignment/evaluate', async (c) => {
    const body = await c.req.json().catch(() => ({})) as any;
    if (!body.card) return badRequest(c, 'card required');
    return ok(c, store.evaluateAssignment(tenantOf(c), { card: body.card, contact: body.contact, channel: body.channel, keyword: body.keyword }));
  });
  app.get('/assignment/sla-violations', (c) => ok(c, { violations: store.slaViolations(tenantOf(c)) }));
  app.post('/stripe-connect', async (c) => {
    const body = await c.req.json().catch(() => ({})) as any;
    if (!body.stripe_account_id) return badRequest(c, 'stripe_account_id required');
    const acc = store.setStripeConnect(tenantOf(c), body.stripe_account_id, {
      status: body.status, chargesEnabled: body.charges_enabled,
      payoutsEnabled: body.payouts_enabled, onboardedAt: body.onboarded_at ?? Date.now(),
    });
    return ok(c, { account: acc });
  });
  app.get('/stripe-connect', (c) => {
    const acc = store.getStripeConnect(tenantOf(c));
    return acc ? ok(c, { account: acc }) : c.json({ connected: false }, 200);
  });
  app.get('/mrr', (c) => ok(c, store.computeMrr(tenantOf(c))));
  app.post('/public-api/contacts', async (c) => {
    const tid = tenantOf(c);
    const body = await c.req.json().catch(() => ({})) as any;
    const name = String(body.name || '').trim();
    if (!name) return badRequest(c, 'name required');

    // Dedupe by email/phone
    const db = getCrmDb();
    let existing: any = null;
    if (body.email) {
      existing = db.prepare('SELECT id FROM crm_contacts WHERE tenant_id = ? AND LOWER(email) = LOWER(?)')
        .get(tid, String(body.email).trim());
    }
    if (!existing && body.phone) {
      existing = db.prepare('SELECT id FROM crm_contacts WHERE tenant_id = ? AND phone = ?')
        .get(tid, String(body.phone).trim());
    }

    if (existing) {
      const upd = store.updateContact(tid, existing.id, {
        ...(body.name ? { name: body.name } : {}),
        ...(body.email ? { email: body.email } : {}),
        ...(body.phone ? { phone: body.phone } : {}),
        ...(body.source ? { source: body.source } : {}),
        ...(body.tags ? { tags: body.tags } : {}),
        ...(body.customFields ? { customFields: body.customFields } : {}),
      } as any);
      return ok(c, { contact: upd, created: false });
    }

    const created = store.createContact(tid, {
      name, email: body.email, phone: body.phone,
      source: body.source || 'api',
      tags: body.tags || [],
      customFields: body.customFields || {},
    } as any);
    return ok(c, { contact: created, created: true }, 201);
  });
  app.get('/agents/:id/tasks', (c) => {
    const tid = tenantOf(c);
    return ok(c, { tasks: tasksMod.listTasks(tid, { ...parseTaskOpts(c), agentId: c.req.param('id') }) });
  });
  app.get('/agents/:id/tasks/stats', (c) => {
    const tid = tenantOf(c);
    return ok(c, { stats: tasksMod.tasksStats(tid, c.req.param('id')) });
  });
  app.get('/scheduling-links', (c) => ok(c, { links: cal.listSchedulingLinks(tenantOf(c)) }));
  app.post('/scheduling-links', async (c) => {
    const tid = tenantOf(c);
    const body = await c.req.json().catch(() => ({})) as any;
    if (!body.title || !body.availability || !body.durationMinutes) return badRequest(c, 'title, availability, durationMinutes required');
    return ok(c, { link: cal.createSchedulingLink(tid, body) }, 201);
  });
  app.get('/scheduling-links/:id', (c) => {
    const l = cal.getSchedulingLink(tenantOf(c), c.req.param('id'));
    return l ? ok(c, { link: l }) : notFound(c, 'link');
  });
  app.patch('/scheduling-links/:id', async (c) => {
    const tid = tenantOf(c);
    const body = await c.req.json().catch(() => ({})) as any;
    const l = cal.updateSchedulingLink(tid, c.req.param('id'), body);
    return l ? ok(c, { link: l }) : notFound(c, 'link');
  });
  app.delete('/scheduling-links/:id', (c) => {
    return cal.deleteSchedulingLink(tenantOf(c), c.req.param('id')) ? c.body(null, 204) : notFound(c, 'link');
  });
  app.get('/calendar-integrations', (c) => ok(c, { integrations: cal.listIntegrations(tenantOf(c)) }));
  app.post('/calendar-integrations', async (c) => {
    const tid = tenantOf(c);
    const body = await c.req.json().catch(() => ({})) as any;
    if (!body.provider || !['google','outlook','caldav','ics'].includes(body.provider)) return badRequest(c, 'invalid provider');
    return ok(c, { integration: cal.createIntegration(tid, body) }, 201);
  });
  app.delete('/calendar-integrations/:id', (c) => {
    return cal.deleteIntegration(tenantOf(c), c.req.param('id')) ? c.body(null, 204) : notFound(c, 'integration');
  });
  app.patch('/contact-notes/:id', async (c) => {
    const tid = tenantOf(c);
    const body = await c.req.json().catch(() => ({})) as any;
    const n = collab.updateContactNote(tid, c.req.param('id'), body);
    return n ? ok(c, { note: n }) : notFound(c, 'note');
  });
  app.delete('/contact-notes/:id', (c) => {
    return collab.deleteContactNote(tenantOf(c), c.req.param('id')) ? c.body(null, 204) : notFound(c, 'note');
  });
  app.get('/search', (c) => {
    const tid = tenantOf(c);
    const q = c.req.query('q') || '';
    const entities = (c.req.query('entities') || 'cards,contacts,activities,notes').split(',') as any[];
    const limit = Number(c.req.query('limit')) || 25;
    return ok(c, { hits: search.globalSearch(tid, q, { entities, limit }) });
  });
  app.post('/search/cards', async (c) => {
    const tid = tenantOf(c);
    const body = await c.req.json().catch(() => ({})) as any;
    return ok(c, { cards: search.filteredCards(tid, body) });
  });
  app.post('/search/contacts', async (c) => {
    const tid = tenantOf(c);
    const body = await c.req.json().catch(() => ({})) as any;
    return ok(c, { contacts: search.filteredContacts(tid, body) });
  });
  app.post('/search/rebuild-fts', (c) => {
    return ok(c, { rebuilt: search.backfillFTS() });
  });
  app.get('/views', (c) => {
    const tid = tenantOf(c);
    const entity = c.req.query('entity');
    const agentId = c.req.query('agentId');
    const opts: any = {};
    if (entity)  opts.entity = entity;
    if (agentId) opts.agentId = agentId;
    return ok(c, { views: search.listSavedViews(tid, opts) });
  });
  app.post('/views', async (c) => {
    const tid = tenantOf(c);
    const body = await c.req.json().catch(() => ({})) as any;
    if (!body.name || !body.entity) return badRequest(c, 'name + entity required');
    if (!['cards', 'contacts', 'tasks', 'appointments'].includes(body.entity)) return badRequest(c, 'invalid entity');
    return ok(c, { view: search.createSavedView(tid, body) }, 201);
  });
  app.get('/views/:id', (c) => {
    const v = search.getSavedView(tenantOf(c), c.req.param('id'));
    return v ? ok(c, { view: v }) : notFound(c, 'view');
  });
  app.patch('/views/:id', async (c) => {
    const tid = tenantOf(c);
    const body = await c.req.json().catch(() => ({})) as any;
    const v = search.updateSavedView(tid, c.req.param('id'), body);
    return v ? ok(c, { view: v }) : notFound(c, 'view');
  });
  app.delete('/views/:id', (c) => {
    return search.deleteSavedView(tenantOf(c), c.req.param('id')) ? c.body(null, 204) : notFound(c, 'view');
  });
  app.get('/outbound-webhooks-stats', (c) => {
    return ok(c, ohk.deliveryStats(tenantOf(c)));
  });
  app.get('/push/vapid-public-key', (c) => {
    const key = push.getVapidPublicKey();
    return key ? ok(c, { publicKey: key }) : c.json({ error: 'vapid_not_configured' }, 501);
  });
  app.post('/push/subscribe', async (c) => {
    const tid = tenantOf(c);
    const body = await c.req.json().catch(() => ({})) as any;
    if (!body.endpoint || !body.keys?.p256dh || !body.keys?.auth) return badRequest(c, 'endpoint + keys.{p256dh,auth} required');
    const sub = push.subscribe(tid, {
      endpoint: body.endpoint,
      p256dh: body.keys.p256dh,
      auth: body.keys.auth,
      agentId: body.agentId,
      ua: c.req.header('user-agent'),
    });
    return ok(c, { subscription: { id: sub.id, agentId: sub.agentId, enabled: sub.enabled } }, 201);
  });
  app.post('/push/unsubscribe', async (c) => {
    const tid = tenantOf(c);
    const body = await c.req.json().catch(() => ({})) as any;
    if (!body.endpoint) return badRequest(c, 'endpoint required');
    return push.unsubscribe(tid, body.endpoint) ? c.body(null, 204) : notFound(c, 'subscription');
  });
  app.post('/push/test', async (c) => {
    const tid = tenantOf(c);
    const body = await c.req.json().catch(() => ({})) as any;
    if (!body.agentId) return badRequest(c, 'agentId required');
    const r = await push.sendToAgent(tid, body.agentId, {
      title: body.title || 'Clow Test',
      body: body.body || 'Notificacao de teste',
      url: body.url || '/crm/',
    });
    return ok(c, r);
  });
  app.get('/mobile/today', (c) => {
    const tid = tenantOf(c);
    return ok(c, mobile.todayBundle(tid, c.req.query('agentId') || undefined));
  });
  app.get('/mobile/cards/:id', (c) => {
    const card = mobile.cardCompact(tenantOf(c), c.req.param('id'));
    return card ? ok(c, card) : notFound(c, 'card');
  });
  app.get('/mobile/agents/:id/dashboard', (c) => {
    return ok(c, mobile.agentDashboard(tenantOf(c), c.req.param('id')));
  });
  app.get('/gamification/leaderboard', (c) => {
    const tid = tenantOf(c);
    const kind = (c.req.query('kind') || 'deals_won') as any;
    const period = (c.req.query('period') || 'month') as any;
    if (!['deals_won','revenue','activities','tasks_completed','calls','meetings'].includes(kind)) return badRequest(c, 'invalid kind');
    if (!['day','week','month','quarter','year','all_time'].includes(period)) return badRequest(c, 'invalid period');
    return ok(c, { leaderboard: gam.computeLeaderboard(tid, kind, period), kind, period });
  });
  app.get('/gamification/dashboard', (c) => {
    const tid = tenantOf(c);
    const period = (c.req.query('period') || 'month') as any;
    return ok(c, gam.performanceDashboard(tid, period));
  });
  app.get('/agents/:id/badges', (c) => {
    return ok(c, { badges: gam.agentBadges(tenantOf(c), c.req.param('id')) });
  });
  app.post('/agents/:id/badges/:badgeId', async (c) => {
    const tid = tenantOf(c);
    const body = await c.req.json().catch(() => ({})) as any;
    const awarded = gam.awardBadge(tid, c.req.param('id'), c.req.param('badgeId'), body.evidence);
    return ok(c, { awarded });
  });
  app.get('/compliance/access-log', (c) => {
    const tid = tenantOf(c);
    const opts: any = {};
    if (c.req.query('agentId'))     opts.agentId = c.req.query('agentId');
    if (c.req.query('targetEntity')) opts.targetEntity = c.req.query('targetEntity');
    if (c.req.query('action'))      opts.action = c.req.query('action');
    if (c.req.query('from'))        opts.from = Number(c.req.query('from'));
    if (c.req.query('to'))          opts.to = Number(c.req.query('to'));
    if (c.req.query('limit'))       opts.limit = Number(c.req.query('limit'));
    return ok(c, { log: lgpd.queryAccessLog(tid, opts) });
  });
  app.get('/compliance/retention-policies', (c) => {
    return ok(c, { policies: lgpd.listRetentionPolicies(tenantOf(c)) });
  });
  app.post('/compliance/retention-policies', async (c) => {
    const tid = tenantOf(c);
    const body = await c.req.json().catch(() => ({})) as any;
    if (!body.entity || !body.daysToKeep) return badRequest(c, 'entity + daysToKeep required');
    return ok(c, { policy: lgpd.createRetentionPolicy(tid, body) }, 201);
  });
  app.patch('/compliance/retention-policies/:id', async (c) => {
    const tid = tenantOf(c);
    const body = await c.req.json().catch(() => ({})) as any;
    const p = lgpd.updateRetentionPolicy(tid, c.req.param('id'), body);
    return p ? ok(c, { policy: p }) : notFound(c, 'policy');
  });
  app.delete('/compliance/retention-policies/:id', (c) => {
    return lgpd.deleteRetentionPolicy(tenantOf(c), c.req.param('id')) ? c.body(null, 204) : notFound(c, 'policy');
  });
  app.get('/compliance/deletion-requests', (c) => {
    return ok(c, { requests: lgpd.listDeletionRequests(tenantOf(c), c.req.query('status') || undefined) });
  });
  app.post('/compliance/deletion-requests', async (c) => {
    const tid = tenantOf(c);
    const body = await c.req.json().catch(() => ({})) as any;
    if (!body.contactId || !body.requestedByEmail) return badRequest(c, 'contactId + requestedByEmail required');
    return ok(c, { request: lgpd.createDeletionRequest(tid, body) }, 201);
  });
  app.post('/compliance/deletion-requests/:id/cancel', (c) => {
    const ok2 = lgpd.cancelDeletionRequest(tenantOf(c), c.req.param('id'));
    return ok2 ? ok(c, { ok: true }) : notFound(c, 'request');
  });
  app.get('/trash', (c) => {
    return ok(c, { counts: softDel.countTrash(tenantOf(c)) });
  });
  app.get('/trash/:entity', (c) => {
    const tid = tenantOf(c);
    const entityMap: Record<string, string> = {
      cards: 'crm_cards', contacts: 'crm_contacts', activities: 'crm_activities',
      tasks: 'crm_tasks', appointments: 'crm_appointments',
      documents: 'crm_documents', proposals: 'crm_proposals',
    };
    const table = entityMap[c.req.param('entity')];
    if (!table) return badRequest(c, 'invalid entity');
    const limit = Number(c.req.query('limit')) || 100;
    return ok(c, { items: softDel.listTrash(table, tid, limit) });
  });
  app.post('/trash/:entity/:id/restore', (c) => {
    const tid = tenantOf(c);
    const entityMap: Record<string, string> = {
      cards: 'crm_cards', contacts: 'crm_contacts', activities: 'crm_activities',
      tasks: 'crm_tasks', appointments: 'crm_appointments',
      documents: 'crm_documents', proposals: 'crm_proposals',
    };
    const table = entityMap[c.req.param('entity')];
    if (!table) return badRequest(c, 'invalid entity');
    const ok2 = softDel.restore(table, tid, c.req.param('id'));
    return ok2 ? ok(c, { restored: true }) : notFound(c, 'row');
  });
  app.delete('/trash/:entity/:id/purge', (c) => {
    const tid = tenantOf(c);
    const entityMap: Record<string, string> = {
      cards: 'crm_cards', contacts: 'crm_contacts', activities: 'crm_activities',
      tasks: 'crm_tasks', appointments: 'crm_appointments',
      documents: 'crm_documents', proposals: 'crm_proposals',
    };
    const table = entityMap[c.req.param('entity')];
    if (!table) return badRequest(c, 'invalid entity');
    return softDel.purge(table, tid, c.req.param('id')) ? c.body(null, 204) : notFound(c, 'row');
  });
  app.get('/contacts-paginated', (c) => {
    const tid = tenantOf(c);
    const cursor = c.req.query('cursor') || undefined;
    const limit = Math.min(500, Number(c.req.query('limit')) || 50);
    const sortField = 'updated_at';
    const db = getCrmDb();
    const decoded = decodeCursor(cursor);
    let sql = 'SELECT * FROM crm_contacts WHERE tenant_id = ? AND deleted_at IS NULL';
    const params: any[] = [tid];
    if (decoded) {
      sql += ` AND (${sortField} < ? OR (${sortField} = ? AND id < ?))`;
      params.push(decoded.lastSort, decoded.lastSort, decoded.lastId);
    }
    sql += ` ORDER BY ${sortField} DESC, id DESC LIMIT ?`;
    params.push(limit + 1);
    const rows = db.prepare(sql).all(...params) as any[];
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && items.length > 0
      ? encodeCursor(items[items.length - 1][sortField], items[items.length - 1].id)
      : null;
    return ok(c, {
      contacts: items.map((r: any) => ({
        id: r.id, name: r.name, email: r.email, phone: r.phone,
        source: r.source, tags: JSON.parse(r.tags_json || '[]'),
        customFields: JSON.parse(r.custom_fields_json || '{}'),
        createdAt: r.created_at, updatedAt: r.updated_at,
      })),
      nextCursor, hasMore,
    });
  });
  app.get('/cards-paginated', (c) => {
    const tid = tenantOf(c);
    const cursor = c.req.query('cursor') || undefined;
    const limit = Math.min(500, Number(c.req.query('limit')) || 50);
    const boardId = c.req.query('boardId');
    const sortField = 'updated_at';
    const db = getCrmDb();
    const decoded = decodeCursor(cursor);
    let sql = 'SELECT * FROM crm_cards WHERE tenant_id = ? AND deleted_at IS NULL';
    const params: any[] = [tid];
    if (boardId) { sql += ' AND board_id = ?'; params.push(boardId); }
    if (decoded) {
      sql += ` AND (${sortField} < ? OR (${sortField} = ? AND id < ?))`;
      params.push(decoded.lastSort, decoded.lastSort, decoded.lastId);
    }
    sql += ` ORDER BY ${sortField} DESC, id DESC LIMIT ?`;
    params.push(limit + 1);
    const rows = db.prepare(sql).all(...params) as any[];
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && items.length > 0
      ? encodeCursor(items[items.length - 1][sortField], items[items.length - 1].id)
      : null;
    return ok(c, {
      cards: items.map((r: any) => ({
        id: r.id, boardId: r.board_id, columnId: r.column_id, title: r.title,
        contactId: r.contact_id, valueCents: r.value_cents, probability: r.probability,
        createdAt: r.created_at, updatedAt: r.updated_at,
      })),
      nextCursor, hasMore,
    });
  });
  app.get('/system/migrations', (c) => {
    const rows = getCrmDb().prepare('SELECT * FROM crm_migration_history').all() as any[];
    return ok(c, { migrations: rows });
  });
  app.get('/admin/rate-limit/tier', (c) => {
    const tid = tenantOf(c);
    return ok(c, rl.getTenantTier(tid));
  });
  app.post('/admin/rate-limit/tier', async (c) => {
    const tid = tenantOf(c);
    const body = await c.req.json().catch(() => ({})) as any;
    if (!body.tier) return badRequest(c, 'tier required');
    if (!['free', 'pro', 'business', 'unlimited'].includes(body.tier)) return badRequest(c, 'invalid tier');
    rl.setTenantTier(tid, body.tier, { perMin: body.perMin, perHour: body.perHour });
    return ok(c, rl.getTenantTier(tid));
  });
  app.get('/security/roles', (c) => ok(c, { roles: sec.listRoles(tenantOf(c)) }));
  app.post('/security/roles', async (c) => {
    const tid = tenantOf(c);
    const body = await c.req.json().catch(() => ({})) as any;
    if (!body.name || !Array.isArray(body.permissions)) return badRequest(c, 'name + permissions[] required');
    const role = sec.createRole(tid, body);
    sec.audit({ tenantId: tid, actorAgentId: actorOf(c), action: 'role.created', entity: 'agent_role', entityId: role.id, after: role, ip: ipOf(c), ua: c.req.header('user-agent') });
    return ok(c, { role }, 201);
  });
  app.delete('/security/roles/:id', (c) => {
    const tid = tenantOf(c);
    const role = sec.getRole(tid, c.req.param('id'));
    if (!role) return notFound(c, 'role');
    sec.deleteRole(tid, c.req.param('id'));
    sec.audit({ tenantId: tid, actorAgentId: actorOf(c), action: 'role.deleted', entity: 'agent_role', entityId: c.req.param('id'), before: role, ip: ipOf(c), ua: c.req.header('user-agent') });
    return c.body(null, 204);
  });
  app.post('/security/roles/seed-defaults', (c) => {
    sec.seedDefaultRoles(tenantOf(c));
    return ok(c, { seeded: true });
  });
  app.post('/security/agents/:agentId/roles/:roleId', (c) => {
    const tid = tenantOf(c);
    const okR = sec.assignRoleToAgent(tid, c.req.param('agentId'), c.req.param('roleId'));
    sec.audit({ tenantId: tid, actorAgentId: actorOf(c), action: 'role.assigned', entity: 'agent_role_assignment', entityId: c.req.param('agentId'), after: { roleId: c.req.param('roleId') }, ip: ipOf(c), ua: c.req.header('user-agent') });
    return okR ? ok(c, { assigned: true }) : notFound(c, 'role');
  });
  app.delete('/security/agents/:agentId/roles/:roleId', (c) => {
    const tid = tenantOf(c);
    const okR = sec.revokeRoleFromAgent(tid, c.req.param('agentId'), c.req.param('roleId'));
    sec.audit({ tenantId: tid, actorAgentId: actorOf(c), action: 'role.revoked', entity: 'agent_role_assignment', entityId: c.req.param('agentId'), before: { roleId: c.req.param('roleId') }, ip: ipOf(c), ua: c.req.header('user-agent') });
    return okR ? c.body(null, 204) : notFound(c, 'assignment');
  });
  app.get('/security/agents/:agentId/permissions', (c) => {
    const tid = tenantOf(c);
    const agentId = c.req.param('agentId');
    return ok(c, {
      roles: sec.agentRoles(tid, agentId),
      permissions: Array.from(sec.agentPermissions(tid, agentId)),
    });
  });
  app.get('/security/check/:agentId/:permission', (c) => {
    const tid = tenantOf(c);
    return ok(c, { granted: sec.hasPermission(tid, c.req.param('agentId'), c.req.param('permission') as any) });
  });
  app.post('/security/2fa/setup', async (c) => {
    const tid = tenantOf(c);
    const body = await c.req.json().catch(() => ({})) as any;
    if (!body.agentId) return badRequest(c, 'agentId required');
    const setup = sec.setup2FA(tid, body.agentId, body.issuer);
    sec.audit({ tenantId: tid, actorAgentId: actorOf(c), action: '2fa.setup_initiated', entity: 'agent_2fa', entityId: body.agentId, ip: ipOf(c), ua: c.req.header('user-agent') });
    return ok(c, setup);
  });
  app.post('/security/2fa/verify', async (c) => {
    const tid = tenantOf(c);
    const body = await c.req.json().catch(() => ({})) as any;
    if (!body.agentId || !body.code) return badRequest(c, 'agentId + code required');
    const r = sec.verify2FA(tid, body.agentId, body.code);
    if (r.ok) sec.audit({ tenantId: tid, actorAgentId: actorOf(c), action: '2fa.verified', entity: 'agent_2fa', entityId: body.agentId, ip: ipOf(c), ua: c.req.header('user-agent') });
    return r.ok ? ok(c, { verified: true }) : c.json({ error: r.error }, 401);
  });
  app.get('/security/2fa/status/:agentId', (c) => {
    return ok(c, { enabled: sec.is2FAEnabled(c.req.param('agentId')) });
  });
  app.delete('/security/2fa/:agentId', (c) => {
    const tid = tenantOf(c);
    const agentId = c.req.param('agentId');
    const deleted = sec.disable2FA(tid, agentId);
    if (deleted) sec.audit({ tenantId: tid, actorAgentId: actorOf(c), action: '2fa.disabled', entity: 'agent_2fa', entityId: agentId, ip: ipOf(c), ua: c.req.header('user-agent') });
    return deleted ? c.body(null, 204) : notFound(c, '2fa');
  });
  app.post('/security/sessions', async (c) => {
    const body = await c.req.json().catch(() => ({})) as any;
    if (!body.agentId) return badRequest(c, 'agentId required');
    const { session, token } = sec.createSession(body.agentId, {
      ttlHours: body.ttlHours, ip: ipOf(c), ua: c.req.header('user-agent'),
      deviceFingerprint: body.deviceFingerprint,
    });
    sec.audit({ tenantId: tenantOf(c), actorAgentId: body.agentId, action: 'session.created', entity: 'session', entityId: session.id, ip: ipOf(c), ua: c.req.header('user-agent') });
    return ok(c, { session, token }, 201);
  });
  app.get('/security/sessions/:agentId', (c) => {
    const activeOnly = c.req.query('activeOnly') !== 'false';
    return ok(c, { sessions: sec.listAgentSessions(c.req.param('agentId'), activeOnly) });
  });
  app.delete('/security/sessions/:id', (c) => {
    const tid = tenantOf(c);
    const ok2 = sec.revokeSession(c.req.param('id'));
    if (ok2) sec.audit({ tenantId: tid, actorAgentId: actorOf(c), action: 'session.revoked', entity: 'session', entityId: c.req.param('id'), ip: ipOf(c), ua: c.req.header('user-agent') });
    return ok2 ? c.body(null, 204) : notFound(c, 'session');
  });
  app.post('/security/agents/:agentId/revoke-all-sessions', (c) => {
    const tid = tenantOf(c);
    const n = sec.revokeAllAgentSessions(c.req.param('agentId'));
    sec.audit({ tenantId: tid, actorAgentId: actorOf(c), action: 'sessions.all_revoked', entity: 'agent', entityId: c.req.param('agentId'), after: { revokedCount: n }, ip: ipOf(c), ua: c.req.header('user-agent') });
    return ok(c, { revoked: n });
  });
  app.get('/security/ip-whitelist', (c) => ok(c, { entries: sec.listWhitelist(tenantOf(c)) }));
  app.post('/security/ip-whitelist', async (c) => {
    const tid = tenantOf(c);
    const body = await c.req.json().catch(() => ({})) as any;
    if (!body.cidr) return badRequest(c, 'cidr required');
    const id = sec.addIpToWhitelist(tid, body.cidr, body.label);
    sec.audit({ tenantId: tid, actorAgentId: actorOf(c), action: 'ip_whitelist.added', entity: 'ip_whitelist', entityId: id, after: { cidr: body.cidr }, ip: ipOf(c), ua: c.req.header('user-agent') });
    return ok(c, { id }, 201);
  });
  app.delete('/security/ip-whitelist/:id', (c) => {
    const tid = tenantOf(c);
    const okR = sec.removeFromWhitelist(tid, c.req.param('id'));
    if (okR) sec.audit({ tenantId: tid, actorAgentId: actorOf(c), action: 'ip_whitelist.removed', entity: 'ip_whitelist', entityId: c.req.param('id'), ip: ipOf(c), ua: c.req.header('user-agent') });
    return okR ? c.body(null, 204) : notFound(c, 'entry');
  });
  app.get('/security/ip-check', (c) => {
    const tid = tenantOf(c);
    const ip = c.req.query('ip') || ipOf(c);
    return ok(c, { ip, allowed: sec.isIpAllowed(tid, ip) });
  });
  app.get('/security/audit', (c) => {
    const tid = tenantOf(c);
    const opts: any = {};
    for (const k of ['actorAgentId', 'action', 'entity', 'entityId']) {
      if (c.req.query(k)) opts[k] = c.req.query(k);
    }
    if (c.req.query('from')) opts.from = Number(c.req.query('from'));
    if (c.req.query('to'))   opts.to = Number(c.req.query('to'));
    if (c.req.query('limit')) opts.limit = Number(c.req.query('limit'));
    return ok(c, { entries: sec.queryAudit(tid, opts) });
  });
  app.get('/admin/perf-stats', (c) => {
    return ok(c, {
      cache: cache.stats(),
      db: dbInfo(),
      tables: tableStats(),
    });
  });
  app.post('/admin/cache-clear', (c) => {
    cache.clear();
    return ok(c, { cleared: true });
  });
  app.post('/admin/cache-bust/:tag', (c) => {
    const n = cache.bustTag(c.req.param('tag'));
    return ok(c, { busted: n });
  });
  app.post('/admin/db-vacuum', (c) => {
    try { return ok(c, vacuum()); }
    catch (err: any) { return c.json({ error: 'vacuum_failed', message: err.message }, 500); }
  });
  app.post('/admin/db-apply-pragmas', (c) => {
    applyPerformancePragmas();
    return ok(c, { applied: true, info: dbInfo() });
  });
  app.post('/admin/explain', async (c) => {
    const body = await c.req.json().catch(() => ({})) as any;
    if (!body.sql) return badRequest(c, 'sql required');
    try { return ok(c, { plan: explain(body.sql, body.params || []) }); }
    catch (err: any) { return c.json({ error: 'explain_failed', message: err.message }, 400); }
  });
  app.post('/proposal-templates', async (c) => {
    const body = await c.req.json().catch(() => ({})) as any;
    if (!body.name || !Array.isArray(body.items)) return badRequest(c, 'name + items[] required');
    return ok(c, { template: store.createProposalTemplate(tenantOf(c), body) }, 201);
  });
  app.get('/proposal-templates', (c) => ok(c, { templates: store.listProposalTemplates(tenantOf(c)) }));
  app.delete('/proposal-templates/:id', (c) => store.deleteProposalTemplate(tenantOf(c), c.req.param('id')) ? c.body(null, 204) : notFound(c, 'template'));
  app.post('/teams', async (c) => {
    const body = await c.req.json().catch(() => ({})) as any;
    if (!body.name) return badRequest(c, 'name required');
    return ok(c, { team: store.createTeam(tenantOf(c), body) }, 201);
  });
  app.get('/teams', (c) => ok(c, { teams: store.listTeams(tenantOf(c)) }));
  app.get('/teams/:id', (c) => {
    const t = store.getTeam(tenantOf(c), c.req.param('id'));
    return t ? ok(c, { team: t }) : notFound(c, 'team');
  });
  app.patch('/teams/:id', async (c) => {
    const body = await c.req.json().catch(() => ({})) as any;
    const t = store.updateTeam(tenantOf(c), c.req.param('id'), body);
    return t ? ok(c, { team: t }) : notFound(c, 'team');
  });
  app.delete('/teams/:id', (c) => store.deleteTeam(tenantOf(c), c.req.param('id')) ? c.body(null, 204) : notFound(c, 'team'));
  app.patch('/agents/:id/permissions', async (c) => {
    const body = await c.req.json().catch(() => ({})) as any;
    return store.setAgentPermissions(tenantOf(c), c.req.param('id'), body) ? ok(c, { ok: true }) : notFound(c, 'agent');
  });
  app.patch('/agents/:id/team', async (c) => {
    const body = await c.req.json().catch(() => ({})) as any;
    return store.setAgentTeam(tenantOf(c), c.req.param('id'), body.team_id || null) ? ok(c, { ok: true }) : notFound(c, 'agent');
  });
  app.patch('/agents/:id/status', async (c) => {
    const body = await c.req.json().catch(() => ({})) as any;
    const st = body.status;
    if (!['online','away','offline'].includes(st)) return badRequest(c, 'invalid status');
    return store.setAgentStatus(tenantOf(c), c.req.param('id'), st) ? ok(c, { ok: true }) : notFound(c, 'agent');
  });
  app.get('/agents/metrics/pro', (c) => ok(c, { metrics: store.getAgentMetricsPro(tenantOf(c)) }));
  app.get('/agents/:id/metrics/pro', (c) => ok(c, { metrics: store.getAgentMetricsPro(tenantOf(c), c.req.param('id')) }));
  app.post('/sla-rules', async (c) => {
    const body = await c.req.json().catch(() => ({})) as any;
    if (!body.name || !body.maxResponseMins) return badRequest(c, 'name + maxResponseMins required');
    return ok(c, { rule: store.createSlaRule(tenantOf(c), { ...body, enabled: body.enabled !== false }) }, 201);
  });
  app.get('/sla-rules', (c) => ok(c, { rules: store.listSlaRules(tenantOf(c)) }));
  app.delete('/sla-rules/:id', (c) => store.deleteSlaRule(tenantOf(c), c.req.param('id')) ? c.body(null, 204) : notFound(c, 'rule'));
  app.post('/labels', async (c) => {
    const body = await c.req.json().catch(() => ({})) as any;
    if (!body.name) return badRequest(c, 'name required');
    return ok(c, { label: store.createLabel(tenantOf(c), body) }, 201);
  });
  app.get('/labels', (c) => ok(c, { labels: store.listLabels(tenantOf(c), c.req.query('scope') as any) }));
  app.patch('/labels/:id', async (c) => {
    const body = await c.req.json().catch(() => ({})) as any;
    const l = store.updateLabel(tenantOf(c), c.req.param('id'), body);
    return l ? ok(c, { label: l }) : notFound(c, 'label');
  });
  app.delete('/labels/:id', (c) => store.deleteLabel(tenantOf(c), c.req.param('id')) ? c.body(null, 204) : notFound(c, 'label'));
  app.post('/quick-replies', async (c) => {
    const body = await c.req.json().catch(() => ({})) as any;
    if (!body.title || !body.body) return badRequest(c, 'title + body required');
    return ok(c, { quickReply: store.createQuickReply(tenantOf(c), body) }, 201);
  });
  app.get('/quick-replies', (c) => ok(c, { quickReplies: store.listQuickReplies(tenantOf(c), c.req.query('category') || undefined) }));
  app.patch('/quick-replies/:id', async (c) => {
    const body = await c.req.json().catch(() => ({})) as any;
    const q = store.updateQuickReply(tenantOf(c), c.req.param('id'), body);
    return q ? ok(c, { quickReply: q }) : notFound(c, 'quick-reply');
  });
  app.delete('/quick-replies/:id', (c) => store.deleteQuickReply(tenantOf(c), c.req.param('id')) ? c.body(null, 204) : notFound(c, 'quick-reply'));
  app.post('/quick-replies/:id/use', (c) => { store.bumpQuickReplyUse(tenantOf(c), c.req.param('id')); return ok(c, { ok: true }); });
  app.post('/inbox-rules', async (c) => {
    const body = await c.req.json().catch(() => ({})) as any;
    if (!body.name) return badRequest(c, 'name required');
    return ok(c, { rule: store.createInboxRule(tenantOf(c), { ...body, priority: body.priority || 0, enabled: body.enabled !== false }) }, 201);
  });
  app.get('/inbox-rules', (c) => ok(c, { rules: store.listInboxRules(tenantOf(c)) }));
  app.delete('/inbox-rules/:id', (c) => store.deleteInboxRule(tenantOf(c), c.req.param('id')) ? c.body(null, 204) : notFound(c, 'rule'));
  app.patch('/swimlanes/:id', async (c) => {
    const body = await c.req.json().catch(() => ({})) as any;
    const sl = store.updateSwimlane(tenantOf(c), c.req.param('id'), body);
    return sl ? ok(c, { swimlane: sl }) : notFound(c, 'swimlane');
  });
  app.delete('/swimlanes/:id', (c) => {
    const ok2 = store.deleteSwimlane(tenantOf(c), c.req.param('id'));
    return ok2 ? c.body(null, 204) : notFound(c, 'swimlane');
  });
  app.patch('/checklists/:id', async (c) => {
    const body = await c.req.json().catch(() => ({})) as any;
    const cl = store.updateChecklist(tenantOf(c), c.req.param('id'), body);
    return cl ? ok(c, { checklist: cl }) : notFound(c, 'checklist');
  });
  app.post('/checklists/:id/items/:itemId/toggle', (c) => {
    const cl = store.toggleChecklistItem(tenantOf(c), c.req.param('id'), c.req.param('itemId'));
    return cl ? ok(c, { checklist: cl }) : notFound(c, 'checklist_or_item');
  });
  app.delete('/checklists/:id', (c) => {
    const ok2 = store.deleteChecklist(tenantOf(c), c.req.param('id'));
    return ok2 ? c.body(null, 204) : notFound(c, 'checklist');
  });
  app.get('/agents/metrics', (c) => {
    return ok(c, { agents: assignment.getAllAgentMetrics(tenantOf(c)) });
  });
  app.get('/agents/:id/metrics', (c) => {
    const m = assignment.getAgentMetrics(tenantOf(c), c.req.param('id'));
    return m ? ok(c, m) : notFound(c, 'agent');
  });
  app.get('/settings/assignment-strategy', (c) => {
    return ok(c, { strategy: assignment.getStrategy(tenantOf(c)) });
  });
  app.put('/settings/assignment-strategy', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (!['round_robin', 'load_balanced', 'manual'].includes(body.strategy)) {
      return badRequest(c, 'strategy must be: round_robin | load_balanced | manual');
    }
    assignment.setStrategy(tenantOf(c), body.strategy);
    return ok(c, { ok: true, strategy: body.strategy });
  });
  app.get('/events', async (c) => {
    const tokenQ = c.req.query('token');
    let tid = (c as any).get?.('tenantId');
    if (!tid && tokenQ) {
      const t = findTenantByApiKeyHash(hashApiKey(tokenQ));
      if (t) tid = t.id;
    }
    if (!tid) return c.text('unauthorized', 401);
    const tenantId = tid;
    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(enc.encode(': connected\n\n'));
        const heartbeat = setInterval(() => {
          try { controller.enqueue(enc.encode(': hb\n\n')); } catch { clearInterval(heartbeat); }
        }, 25_000);
        const unsub = subscribe(tenantId, {
          send: (event, data) => {
            try { controller.enqueue(enc.encode(formatSseFrame(event, data))); } catch {}
          },
          close: () => { clearInterval(heartbeat); try { controller.close(); } catch {} },
        });
        (c as any).req.raw?.signal?.addEventListener?.('abort', () => { clearInterval(heartbeat); unsub(); try { controller.close(); } catch {} });
      },
    });
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  });
}
