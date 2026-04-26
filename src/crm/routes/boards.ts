// CRM boards module — split out from the legacy monolithic file in a refactor.
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



export function registerBoardsRoutes(app: Hono): void {
  app.get('/boards', (c) => ok(c, { boards: store.listBoards(tenantOf(c)) }));
  app.post('/boards', async (c) => {
    const tid = tenantOf(c);
    const body = await c.req.json().catch(() => ({}));
    if (!body.name || typeof body.name !== 'string') return badRequest(c, 'name required');
    const validTypes: BoardType[] = ['sales', 'support', 'post_sales', 'billing', 'custom'];
    if (body.type && !validTypes.includes(body.type)) return badRequest(c, `type must be one of: ${validTypes.join(', ')}`);
    const board = store.createBoard(tid, { name: body.name, type: body.type, description: body.description });
    return ok(c, { board }, 201);
  });
  app.get('/boards/:id', (c) => {
    const b = store.getBoard(tenantOf(c), c.req.param('id'));
    return b ? ok(c, { board: b }) : notFound(c, 'board');
  });
  app.patch('/boards/:id', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const updated = store.updateBoard(tenantOf(c), c.req.param('id'), body);
    return updated ? ok(c, { board: updated }) : notFound(c, 'board');
  });
  app.delete('/boards/:id', (c) => {
    const ok2 = store.deleteBoard(tenantOf(c), c.req.param('id'));
    return ok2 ? c.body(null, 204) : notFound(c, 'board');
  });
  app.get('/boards/:id/pipeline', (c) => {
    const tid = tenantOf(c);
    const boardId = c.req.param('id');
    const board = store.getBoard(tid, boardId);
    if (!board) return notFound(c, 'board');
    const columns = store.listColumns(tid, boardId);
    let cards = store.listCardsByBoard(tid, boardId);

    // ONDA 39 — channel filter: keep only cards with activities from selected channel
    const channelFilter = c.req.query('channelId');
    if (channelFilter) {
      const db = getCrmDb();
      const cardIdsWithChannel = new Set(
        (db.prepare(`
          SELECT DISTINCT card_id FROM crm_activities
          WHERE tenant_id = ? AND card_id IS NOT NULL AND metadata_json LIKE ?
        `).all(tid, '%"channelId":"' + channelFilter + '"%') as any[])
          .map((r: any) => r.card_id),
      );
      cards = cards.filter(card => cardIdsWithChannel.has(card.id));
    }
    // Hydrate contact names for each card (single pass, indexed)
    const contactIds = [...new Set(cards.map(c => c.contactId).filter(Boolean) as string[])];
    const contactsById: Record<string, ReturnType<typeof store.getContact>> = {};
    for (const cid of contactIds) {
      const contact = store.getContact(tid, cid);
      if (contact) contactsById[cid] = contact;
    }
    const cardsByColumn: Record<string, any[]> = {};
    for (const col of columns) cardsByColumn[col.id] = [];
    for (const card of cards) {
      const enriched = {
        ...card,
        contact: card.contactId ? {
          id: contactsById[card.contactId]?.id,
          name: contactsById[card.contactId]?.name,
          phone: contactsById[card.contactId]?.phone,
          avatarUrl: contactsById[card.contactId]?.avatarUrl,
        } : null,
      };
      if (cardsByColumn[card.columnId]) cardsByColumn[card.columnId].push(enriched);
    }
    return ok(c, { board, columns, cardsByColumn });
  });
  app.get('/boards/:boardId/analytics/funnel', (c) => {
    const tid = tenantOf(c);
    const boardId = c.req.param('boardId');
    if (!store.getBoard(tid, boardId)) return notFound(c, 'board');
    const rows = analytics.funnel(tid, boardId, parseWin(c));
    const totalCards = rows.reduce((s, r) => s + r.cardCount, 0);
    const totalValueCents = rows.reduce((s, r) => s + r.totalValueCents, 0);
    return ok(c, { boardId, stages: rows, totalCards, totalValueCents });
  });
  app.get('/boards/:boardId/analytics/stage-times', (c) => {
    const tid = tenantOf(c);
    const boardId = c.req.param('boardId');
    if (!store.getBoard(tid, boardId)) return notFound(c, 'board');
    return ok(c, { boardId, stages: analytics.stageTimes(tid, boardId, parseWin(c)) });
  });
  app.get('/boards/:boardId/analytics/velocity', (c) => {
    const tid = tenantOf(c);
    const boardId = c.req.param('boardId');
    if (!store.getBoard(tid, boardId)) return notFound(c, 'board');
    const b = (c.req.query('bucket') || 'day') as 'day' | 'week' | 'month';
    if (!['day', 'week', 'month'].includes(b)) return badRequest(c, 'bucket must be day|week|month');
    return ok(c, { boardId, bucket: b, points: analytics.velocity(tid, boardId, b, parseWin(c)) });
  });
  app.get('/boards/:boardId/analytics/win-rate', (c) => {
    const tid = tenantOf(c);
    const boardId = c.req.param('boardId');
    if (!store.getBoard(tid, boardId)) return notFound(c, 'board');
    return ok(c, { boardId, ...analytics.winRate(tid, boardId, parseWin(c)) });
  });
  app.get('/boards/:boardId/analytics/compare', (c) => {
    const tid = tenantOf(c);
    const boardId = c.req.param('boardId');
    if (!store.getBoard(tid, boardId)) return notFound(c, 'board');
    const cur = parseWin(c);
    const prv: { from?: number; to?: number } = {};
    const prvFrom = c.req.query('prevFrom');
    const prvTo   = c.req.query('prevTo');
    if (prvFrom && /^\d+$/.test(prvFrom)) prv.from = Number(prvFrom);
    if (prvTo   && /^\d+$/.test(prvTo))   prv.to   = Number(prvTo);
    return ok(c, { boardId, ...analytics.compare(tid, boardId, cur, prv) });
  });
  app.get('/boards/:boardId/columns', (c) => {
    return ok(c, { columns: store.listColumns(tenantOf(c), c.req.param('boardId')) });
  });
  app.post('/boards/:boardId/columns', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (!body.name) return badRequest(c, 'name required');
    const col = store.createColumn(tenantOf(c), {
      boardId: c.req.param('boardId'),
      name: body.name,
      color: body.color,
      isTerminal: !!body.isTerminal,
      autoRule: body.autoRule,
    });
    return col ? ok(c, { column: col }, 201) : notFound(c, 'board');
  });
  app.patch('/columns/:id', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const upd = store.updateColumn(tenantOf(c), c.req.param('id'), body);
    return upd ? ok(c, { column: upd }) : notFound(c, 'column');
  });
  app.delete('/columns/:id', (c) => {
    const ok2 = store.deleteColumn(tenantOf(c), c.req.param('id'));
    return ok2 ? c.body(null, 204) : notFound(c, 'column');
  });
  app.get('/boards/:id/pipeline-fast', async (c) => {
    const tid = tenantOf(c);
    const boardId = c.req.param('id');
    const board = store.getBoard(tid, boardId);
    if (!board) return notFound(c, 'board');

    // Cache the heavy query
    const cacheKey = cache.keyOf('pipeline', tid, { boardId });
    const result = await cache.wrap(cacheKey, async () => {
      const columns = store.listColumns(tid, boardId);
      const cards = store.listCardsByBoard(tid, boardId);

      // Lazy hydration via DataLoader — single batched query
      const loader = contactLoader(tid);
      const contactIds = [...new Set(cards.map(c2 => c2.contactId).filter(Boolean) as string[])];
      const contacts = await loader.loadMany(contactIds);
      const contactMap = new Map<string, any>();
      contacts.forEach((ct, i) => contactMap.set(contactIds[i], ct));

      const cardsByColumn: Record<string, any[]> = {};
      for (const col of columns) cardsByColumn[col.id] = [];
      for (const card of cards) {
        const ct = card.contactId ? contactMap.get(card.contactId) : null;
        const enriched = {
          ...card,
          contact: ct ? { id: ct.id, name: ct.name, phone: ct.phone, avatarUrl: ct.avatar_url } : null,
        };
        if (cardsByColumn[card.columnId]) cardsByColumn[card.columnId].push(enriched);
      }
      return { board, columns, cardsByColumn };
    }, { ttl: 30_000, tags: ['pipeline:' + tid, 'board:' + boardId] });

    return ok(c, result);
  });
  app.patch('/columns/:id/wip-limit', async (c) => {
    const body = await c.req.json().catch(() => ({})) as any;
    const limit = body.wip_limit === null ? null : (typeof body.wip_limit === 'number' ? body.wip_limit : null);
    const ok2 = store.setColumnWipLimit(tenantOf(c), c.req.param('id'), limit);
    return ok2 ? ok(c, { ok: true }) : notFound(c, 'column');
  });
  app.patch('/columns/:id/stage-type', async (c) => {
    const body = await c.req.json().catch(() => ({})) as any;
    const st = body.stage_type as any;
    if (!['open','won','lost','paused'].includes(st)) return badRequest(c, 'stage_type invalid');
    const ok2 = store.setColumnStageType(tenantOf(c), c.req.param('id'), st);
    return ok2 ? ok(c, { ok: true }) : notFound(c, 'column');
  });
  app.patch('/boards/:id/settings', async (c) => {
    const body = await c.req.json().catch(() => ({})) as any;
    const r = store.updateBoardSettings(tenantOf(c), c.req.param('id'), body);
    return r ? ok(c, { board: r }) : notFound(c, 'board');
  });
  app.post('/boards/:id/swimlanes', async (c) => {
    const body = await c.req.json().catch(() => ({})) as any;
    if (!body.name) return badRequest(c, 'name required');
    const sl = store.createSwimlane(tenantOf(c), c.req.param('id'), body);
    return sl ? ok(c, { swimlane: sl }, 201) : notFound(c, 'board');
  });
  app.get('/boards/:id/swimlanes', (c) => {
    return ok(c, { swimlanes: store.listSwimlanes(tenantOf(c), c.req.param('id')) });
  });
}
