// CRM inventory module — split out from the legacy monolithic file in a refactor.
// Edit this file directly; scripts/split-routes.cjs is retained only as a record
// of how the original was decomposed (it ran once against the .ts.bak snapshot).
import { Hono } from 'hono';
import { tenantOf } from './_helpers.js';
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



export function registerInventoryRoutes(app: Hono): void {
  app.get('/inventory', (c) => ok(c, { items: store.listInventory(tenantOf(c)) }));
  app.post('/inventory', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (!body.sku || !body.name) return badRequest(c, 'sku and name required');
    try {
      const item = store.createInventoryItem(tenantOf(c), body);
      return ok(c, { item }, 201);
    } catch (e: any) {
      if (e.message.includes('UNIQUE')) return badRequest(c, 'sku already exists');
      throw e;
    }
  });
  app.post('/inventory/:id/stock', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.delta !== 'number') return badRequest(c, 'delta (number) required');
    const upd = store.updateInventoryStock(tenantOf(c), c.req.param('id'), body.delta);
    return upd ? ok(c, { item: upd }) : notFound(c, 'inventory item');
  });
  app.post('/inventory/categories', async (c) => {
    const body = await c.req.json().catch(() => ({})) as any;
    if (!body.name) return badRequest(c, 'name required');
    return ok(c, { category: store.createInvCategory(tenantOf(c), body) }, 201);
  });
  app.get('/inventory/categories', (c) => ok(c, { categories: store.listInvCategories(tenantOf(c)) }));
  app.delete('/inventory/categories/:id', (c) => store.deleteInvCategory(tenantOf(c), c.req.param('id')) ? c.body(null, 204) : notFound(c, 'category'));
  app.post('/inventory/:id/variants', async (c) => {
    const body = await c.req.json().catch(() => ({})) as any;
    if (!body.sku || !body.name) return badRequest(c, 'sku + name required');
    return ok(c, { variant: store.createVariant(tenantOf(c), { ...body, inventoryId: c.req.param('id') }) }, 201);
  });
  app.get('/inventory/:id/variants', (c) => ok(c, { variants: store.listVariants(tenantOf(c), c.req.param('id')) }));
  app.delete('/inventory/variants/:id', (c) => store.deleteVariant(tenantOf(c), c.req.param('id')) ? c.body(null, 204) : notFound(c, 'variant'));
  app.post('/inventory/:id/movements', async (c) => {
    const body = await c.req.json().catch(() => ({})) as any;
    if (typeof body.delta !== 'number') return badRequest(c, 'delta (number) required');
    return ok(c, { movement: store.recordMovement(tenantOf(c), { ...body, inventoryId: c.req.param('id') }) }, 201);
  });
  app.get('/inventory/:id/movements', (c) => ok(c, { movements: store.listMovements(tenantOf(c), c.req.param('id'), parseInt(c.req.query('limit') || '100', 10)) }));
  app.get('/inventory/alerts/low-stock', (c) => ok(c, { items: store.lowStockAlerts(tenantOf(c)) }));
  app.get('/proposals/:id', (c) => {
    const p = store.getProposal(tenantOf(c), c.req.param('id'));
    return p ? ok(c, { proposal: p }) : notFound(c, 'proposal');
  });
  app.post('/proposals/:id/status', async (c) => {
    const body = await c.req.json().catch(() => ({})) as any;
    const st = body.status;
    if (!['draft','sent','viewed','accepted','rejected','expired'].includes(st)) return badRequest(c, 'invalid status');
    const p = store.updateProposalStatus(tenantOf(c), c.req.param('id'), st, { signedBy: body.signed_by, signedIp: body.signed_ip });
    return p ? ok(c, { proposal: p }) : notFound(c, 'proposal');
  });
  app.post('/proposals/:id/sign', async (c) => {
    const body = await c.req.json().catch(() => ({})) as any;
    if (!body.signed_by) return badRequest(c, 'signed_by (nome/email) required');
    const signedIp = c.req.header('x-forwarded-for') || c.req.header('cf-connecting-ip') || undefined;
    const p = store.updateProposalStatus(tenantOf(c), c.req.param('id'), 'accepted', { signedBy: body.signed_by, signedIp });
    return p ? ok(c, { proposal: p }) : notFound(c, 'proposal');
  });
  app.post('/proposals/:id/send-email', async (c) => {
    const tid = tenantOf(c);
    const body = await c.req.json().catch(() => ({})) as any;
    const to = String(body.to || '').trim();
    if (!to || !to.includes('@')) return badRequest(c, 'valid to email required');
    try {
      const r = await proposalsMod.sendByEmail(tid, c.req.param('id'), {
        to, baseUrl: baseUrlOf(c), attachPdf: body.attachPdf !== false,
      });
      return r.ok ? ok(c, r) : c.json({ error: 'send_failed', message: r.error }, 502);
    } catch (err: any) { return c.json({ error: 'exception', message: err.message }, 500); }
  });
  app.post('/proposals/:id/send-whatsapp', async (c) => {
    const tid = tenantOf(c);
    const body = await c.req.json().catch(() => ({})) as any;
    const channelId = String(body.channelId || '').trim();
    if (!channelId) return badRequest(c, 'channelId required');
    try {
      const r = await proposalsMod.sendByWhatsApp(tid, c.req.param('id'), {
        channelId, toPhone: body.toPhone, baseUrl: baseUrlOf(c),
      });
      return r.ok ? ok(c, r) : c.json({ error: 'send_failed', message: r.error }, 502);
    } catch (err: any) { return c.json({ error: 'exception', message: err.message }, 500); }
  });
  app.post('/proposals/:id/clone', (c) => {
    const tid = tenantOf(c);
    const p = proposalsMod.cloneAsNewVersion(tid, c.req.param('id'));
    return p ? ok(c, { proposal: p }, 201) : notFound(c, 'proposal');
  });
  app.get('/proposals/:id/events', (c) => {
    const tid = tenantOf(c);
    return ok(c, { events: proposalsMod.listEvents(tid, c.req.param('id')) });
  });
  app.get('/proposals/:id/public-link', (c) => {
    const tid = tenantOf(c);
    try {
      const token = proposalsMod.ensurePublicToken(tid, c.req.param('id'));
      return ok(c, { token, url: `${baseUrlOf(c)}/p/proposals/${token}` });
    } catch { return notFound(c, 'proposal'); }
  });
  app.post('/proposals/:id/accept-admin', async (c) => {
    const tid = tenantOf(c);
    const body = await c.req.json().catch(() => ({})) as any;
    const p = store.updateProposalStatus(tid, c.req.param('id'), 'accepted', {
      signedBy: body.signed_by || 'admin', signedIp: c.req.header('x-forwarded-for') || 'admin',
    });
    if (!p) return notFound(c, 'proposal');
    proposalsMod.onAccept(tid, c.req.param('id'));
    return ok(c, { proposal: p });
  });
  app.get('/document-templates', (c) => {
    const kind = c.req.query('kind') as any;
    return ok(c, { templates: docs.listTemplates(tenantOf(c), kind) });
  });
  app.post('/document-templates', async (c) => {
    const tid = tenantOf(c);
    const body = await c.req.json().catch(() => ({})) as any;
    if (!body.name || !body.bodyHtml) return badRequest(c, 'name + bodyHtml required');
    return ok(c, { template: docs.createTemplate(tid, body) }, 201);
  });
  app.get('/document-templates/:id', (c) => {
    const t = docs.getTemplate(tenantOf(c), c.req.param('id'));
    return t ? ok(c, { template: t }) : notFound(c, 'template');
  });
  app.patch('/document-templates/:id', async (c) => {
    const tid = tenantOf(c);
    const body = await c.req.json().catch(() => ({})) as any;
    const t = docs.updateTemplate(tid, c.req.param('id'), body);
    return t ? ok(c, { template: t }) : notFound(c, 'template');
  });
  app.delete('/document-templates/:id', (c) => {
    return docs.deleteTemplate(tenantOf(c), c.req.param('id')) ? c.body(null, 204) : notFound(c, 'template');
  });
  app.get('/documents', (c) => {
    const tid = tenantOf(c);
    const opts: any = {};
    if (c.req.query('contactId'))  opts.contactId = c.req.query('contactId');
    if (c.req.query('cardId'))     opts.cardId = c.req.query('cardId');
    if (c.req.query('templateId')) opts.templateId = c.req.query('templateId');
    if (c.req.query('status'))     opts.status = c.req.query('status');
    return ok(c, { documents: docs.listDocuments(tid, opts) });
  });
  app.post('/documents', async (c) => {
    const tid = tenantOf(c);
    const body = await c.req.json().catch(() => ({})) as any;
    if (!body.title) return badRequest(c, 'title required');
    if (!body.bodyHtml && !body.templateId) return badRequest(c, 'bodyHtml or templateId required');
    try {
      return ok(c, { document: docs.createDocument(tid, body) }, 201);
    } catch (err: any) { return badRequest(c, err.message); }
  });
  app.get('/documents/:id', (c) => {
    const d = docs.getDocument(tenantOf(c), c.req.param('id'));
    return d ? ok(c, { document: d }) : notFound(c, 'document');
  });
  app.patch('/documents/:id', async (c) => {
    const tid = tenantOf(c);
    const body = await c.req.json().catch(() => ({})) as any;
    const d = docs.updateDocument(tid, c.req.param('id'), body);
    return d ? ok(c, { document: d }) : notFound(c, 'document');
  });
  app.delete('/documents/:id', (c) => {
    return docs.deleteDocument(tenantOf(c), c.req.param('id')) ? c.body(null, 204) : notFound(c, 'document');
  });
  app.post('/documents/:id/clone', (c) => {
    const d = docs.cloneAsNewVersion(tenantOf(c), c.req.param('id'));
    return d ? ok(c, { document: d }, 201) : notFound(c, 'document');
  });
  app.get('/documents/:id/events', (c) => {
    return ok(c, { events: docs.listEvents(tenantOf(c), c.req.param('id')) });
  });
  app.get('/documents/:id/public-link', (c) => {
    const d = docs.getDocument(tenantOf(c), c.req.param('id'));
    if (!d) return notFound(c, 'document');
    const proto = c.req.header('x-forwarded-proto') || 'https';
    const host = c.req.header('host') || 'localhost';
    return ok(c, { token: d.publicToken, url: `${proto}://${host}/p/docs/${d.publicToken}` });
  });
  app.post('/documents/:id/send-email', async (c) => {
    const tid = tenantOf(c);
    const body = await c.req.json().catch(() => ({})) as any;
    if (!body.to) return badRequest(c, 'to required');
    const proto = c.req.header('x-forwarded-proto') || 'https';
    const host = c.req.header('host') || 'localhost';
    const r = await docs.sendByEmail(tid, c.req.param('id'), {
      to: body.to, baseUrl: `${proto}://${host}`, attachPdf: body.attachPdf !== false,
    });
    return r.ok ? ok(c, r) : c.json({ error: 'send_failed', message: r.error }, 502);
  });
  app.post('/documents/:id/send-whatsapp', async (c) => {
    const tid = tenantOf(c);
    const body = await c.req.json().catch(() => ({})) as any;
    if (!body.channelId) return badRequest(c, 'channelId required');
    const proto = c.req.header('x-forwarded-proto') || 'https';
    const host = c.req.header('host') || 'localhost';
    const r = await docs.sendByWhatsApp(tid, c.req.param('id'), {
      channelId: body.channelId, toPhone: body.toPhone, baseUrl: `${proto}://${host}`,
    });
    return r.ok ? ok(c, r) : c.json({ error: 'send_failed', message: r.error }, 502);
  });
  app.get('/documents/:id/pdf', async (c) => {
    const d = docs.getDocument(tenantOf(c), c.req.param('id'));
    if (!d) return notFound(c, 'document');
    const pdf = await docs.renderPDF(d);
    return new Response(new Uint8Array(pdf), {
      status: 200,
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': `attachment; filename="${d.title.replace(/[^a-zA-Z0-9_\-]/g, '_')}-v${d.version}.pdf"`,
      },
    });
  });
}
