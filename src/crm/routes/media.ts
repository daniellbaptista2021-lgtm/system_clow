// CRM media module — split out from the legacy monolithic file in a refactor.
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



export function registerMediaRoutes(app: Hono): void {
  app.get('/media/:tenantId/:date/:filename', (c) => {
    const tid = tenantOf(c);
    const reqTenant = c.req.param('tenantId');
    if (reqTenant !== tid) return c.text('forbidden', 403);
    const file = readMedia(tid, c.req.param('date'), c.req.param('filename'));
    if (!file) return c.text('not_found', 404);
    return new Response(file.bytes, {
      status: 200,
      headers: {
        'Content-Type': file.mime,
        'Cache-Control': 'private, max-age=86400',
        'Content-Length': String(file.bytes.length),
      },
    });
  });
  app.post('/media/upload', async (c) => {
    const tid = tenantOf(c);
    const formData = await c.req.formData();
    const file = formData.get('file');
    if (!file || typeof file === 'string') return badRequest(c, 'file required');
    const bytes = Buffer.from(await (file as any).arrayBuffer());
    const filename = (file as any).name || 'upload.bin';
    const mime = (file as any).type || 'application/octet-stream';
    const saved = (await import('.././media.js')).saveMedia(tid, bytes, { mime, suggestedFilename: filename });
    // Return full URL with tenantId path
    return ok(c, { url: saved.publicUrl, bytes: saved.bytes, mime: saved.mime }, 201);
  });
  app.post('/media/process', async (c) => {
    const formData = await c.req.formData();
    const file = formData.get('file');
    if (!file || typeof file === 'string') return badRequest(c, 'file required');
    const bytes = Buffer.from(await (file as any).arrayBuffer());
    const filename = (file as any).name || 'upload.bin';
    const mime = (file as any).type || 'application/octet-stream';
    try {
      const { processMedia } = await import('../../notifications/openaiMedia.js');
      const result = await processMedia(bytes, mime, filename);
      return ok(c, { kind: result.kind, content: result.content, filename, mime, bytes: bytes.length });
    } catch (err: any) {
      return c.json({ error: 'process_failed', message: err?.message }, 500);
    }
  });
  app.post('/media/bulk-process', async (c) => {
    const fd = await c.req.formData();
    const files = fd.getAll('files');
    if (!files.length) return badRequest(c, 'files[] required');
    const { processMedia } = await import('../../notifications/openaiMedia.js');
    const results: any[] = [];
    for (const f of files) {
      if (typeof f === 'string') continue;
      const bytes = Buffer.from(await (f as any).arrayBuffer());
      const filename = (f as any).name || 'upload.bin';
      const mime = (f as any).type || 'application/octet-stream';
      try {
        const r = await processMedia(bytes, mime, filename);
        results.push({ filename, kind: r.kind, content: r.content, bytes: bytes.length });
      } catch (err: any) {
        results.push({ filename, error: err.message });
      }
    }
    return ok(c, { results });
  });
  app.get('/ai/cards/:id/score', (c) => {
    const tid = tenantOf(c);
    const force = c.req.query('refresh') === 'true';
    const existing = force ? null : ai.getInsight(tid, 'card', c.req.param('id'), 'score');
    const fresh = existing && existing.staleAt && existing.staleAt > Date.now() ? existing : ai.leadScore(tid, c.req.param('id'));
    return fresh ? ok(c, { insight: fresh }) : notFound(c, 'card');
  });
  app.post('/ai/cards/:id/next-step', async (c) => {
    const tid = tenantOf(c);
    try {
      const ins = await ai.nextStep(tid, c.req.param('id'));
      return ins ? ok(c, { insight: ins }) : notFound(c, 'card');
    } catch (err: any) { return c.json({ error: 'ai_failed', message: err.message }, 502); }
  });
  app.post('/ai/cards/:id/summary', async (c) => {
    const tid = tenantOf(c);
    try {
      const ins = await ai.summarizeConversation(tid, c.req.param('id'));
      return ins ? ok(c, { insight: ins }) : notFound(c, 'card');
    } catch (err: any) { return c.json({ error: 'ai_failed', message: err.message }, 502); }
  });
  app.get('/ai/cards/:id/sentiment', (c) => {
    const tid = tenantOf(c);
    const ins = ai.sentimentForCard(tid, c.req.param('id'));
    return ins ? ok(c, { insight: ins }) : notFound(c, 'card');
  });
  app.post('/ai/sentiment', async (c) => {
    // Stateless sentiment on arbitrary text
    const body = await c.req.json().catch(() => ({})) as any;
    if (!body.text) return badRequest(c, 'text required');
    return ok(c, ai.sentimentForText(body.text));
  });
  app.get('/ai/cards/:id/classify', (c) => {
    const tid = tenantOf(c);
    const ins = ai.classifyLead(tid, c.req.param('id'));
    return ins ? ok(c, { insight: ins }) : notFound(c, 'card');
  });
  app.get('/ai/cards/:id/insights', (c) => {
    const tid = tenantOf(c);
    return ok(c, { insights: ai.getAllInsights(tid, 'card', c.req.param('id')) });
  });
  app.get('/ai/forecast', (c) => {
    const tid = tenantOf(c);
    const boardId = c.req.query('boardId');
    const horizonDays = Number(c.req.query('horizonDays')) || 30;
    const opts: any = { horizonDays };
    if (boardId) opts.boardId = boardId;
    return ok(c, ai.forecast(tid, opts));
  });
  app.post('/ai/batch-score', async (c) => {
    const body = await c.req.json().catch(() => ({})) as any;
    const limit = Math.min(50, Number(body.limit) || 10);
    const r = await ai.tickAutoScore(limit);
    return ok(c, r);
  });
}
