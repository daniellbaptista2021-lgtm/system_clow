// CRM stats module — split out from the legacy monolithic file in a refactor.
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



export function registerStatsRoutes(app: Hono): void {
  app.get('/reports/sales', async (c) => {
    const tid = tenantOf(c);
    const win = parseWin2(c);
    const bucket = (c.req.query('bucket') || 'day') as any;
    if (!['day', 'week', 'month'].includes(bucket)) return badRequest(c, 'bucket must be day|week|month');
    const rows = reports.salesByPeriod(tid, { ...win, bucket, boardId: c.req.query('boardId') || undefined });
    return deliverReport(c, 'sales', rows, 'Relatório de Vendas');
  });
  app.get('/reports/agent-activities', async (c) => {
    const tid = tenantOf(c);
    const rows = reports.activitiesByAgent(tid, parseWin2(c));
    return deliverReport(c, 'agents', rows, 'Atividades por Agente');
  });
  app.get('/reports/lead-sources', async (c) => {
    const tid = tenantOf(c);
    const rows = reports.leadSources(tid, parseWin2(c));
    return deliverReport(c, 'sources', rows, 'Origem de Leads');
  });
  app.get('/reports/lost-reasons', async (c) => {
    const tid = tenantOf(c);
    const rows = reports.lostReasons(tid, c.req.query('boardId') || undefined, parseWin2(c));
    return deliverReport(c, 'lost-reasons', rows, 'Razões de Perda');
  });
  app.get('/scheduled-reports', (c) => {
    const tid = tenantOf(c);
    const rows = getCrmDb().prepare(
      'SELECT * FROM crm_scheduled_reports WHERE tenant_id = ? ORDER BY created_at DESC'
    ).all(tid);
    return ok(c, { scheduledReports: rows });
  });
  app.post('/scheduled-reports', async (c) => {
    const tid = tenantOf(c);
    const body = await c.req.json().catch(() => ({})) as any;
    const name = String(body.name || '').trim();
    const kind = String(body.kind || '');
    const interval = String(body.interval || '');
    const format = String(body.format || 'pdf');
    const email = String(body.emailTo || '').trim();
    if (!name) return badRequest(c, 'name required');
    if (!['sales', 'agents', 'sources', 'lost-reasons'].includes(kind)) return badRequest(c, 'invalid kind');
    if (!['daily', 'weekly', 'monthly'].includes(interval)) return badRequest(c, 'invalid interval');
    if (!['pdf', 'csv'].includes(format)) return badRequest(c, 'format must be pdf or csv');
    if (!email || !email.includes('@')) return badRequest(c, 'valid emailTo required');

    const id = 'crm_sched_' + Math.random().toString(36).slice(2, 14);
    const next = computeFirstRunAt(interval);
    getCrmDb().prepare(`
      INSERT INTO crm_scheduled_reports (id, tenant_id, name, kind, interval, format, email_to, board_id, next_run_at, enabled, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    `).run(id, tid, name, kind, interval, format, email, body.boardId || null, next, Date.now());
    return ok(c, { id, nextRunAt: next }, 201);
  });
  app.patch('/scheduled-reports/:id', async (c) => {
    const tid = tenantOf(c);
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({})) as any;
    const sets: string[] = [];
    const params: any[] = [];
    for (const [k, col] of [['name','name'],['emailTo','email_to'],['enabled','enabled'],['interval','interval'],['format','format']]) {
      if (body[k] !== undefined) { sets.push(`${col} = ?`); params.push(body[k]); }
    }
    if (sets.length === 0) return badRequest(c, 'no fields to update');
    params.push(id, tid);
    const r = getCrmDb().prepare(`UPDATE crm_scheduled_reports SET ${sets.join(', ')} WHERE id = ? AND tenant_id = ?`).run(...params);
    return r.changes > 0 ? ok(c, { ok: true }) : notFound(c, 'schedule');
  });
  app.delete('/scheduled-reports/:id', (c) => {
    const tid = tenantOf(c);
    const r = getCrmDb().prepare('DELETE FROM crm_scheduled_reports WHERE id = ? AND tenant_id = ?').run(c.req.param('id'), tid);
    return r.changes > 0 ? c.body(null, 204) : notFound(c, 'schedule');
  });
  app.post('/scheduled-reports/:id/run', async (c) => {
    const tid = tenantOf(c);
    const id = c.req.param('id');
    const row = getCrmDb().prepare('SELECT * FROM crm_scheduled_reports WHERE id = ? AND tenant_id = ?').get(id, tid) as any;
    if (!row) return notFound(c, 'schedule');
    // Force next_run_at = now so next scheduler tick picks it up. Or call directly?
    // Call directly for immediate feedback.
    const { tick: runReports } = await import('.././reportsScheduler.js');
    getCrmDb().prepare('UPDATE crm_scheduled_reports SET next_run_at = ? WHERE id = ?').run(Date.now() - 1, id);
    await runReports();
    return ok(c, { ok: true, triggered: id });
  });
  app.get('/stats', (c) => {
    const tid = tenantOf(c);
    const boards = store.listBoards(tid);
    const totalCards = boards.reduce((acc, b) => acc + store.listCardsByBoard(tid, b.id).length, 0);
    const allCards = boards.flatMap(b => store.listCardsByBoard(tid, b.id));
    const totalValueCents = allCards.reduce((acc, c) => acc + c.valueCents, 0);
    const weightedValueCents = allCards.reduce((acc, c) => acc + (c.valueCents * c.probability / 100), 0);
    return ok(c, {
      boards: boards.length,
      totalCards,
      totalValueCents,
      weightedValueCents,
      totalContacts: store.listContacts(tid, { limit: 1000 }).length,
      totalAgents: store.listAgents(tid).length,
      totalChannels: store.listChannels(tid).length,
      totalSubscriptionsActive: store.listSubscriptions(tid, 'active').length,
    });
  });
  app.get('/goals', (c) => {
    const tid = tenantOf(c);
    const opts: any = {};
    if (c.req.query('agentId')) opts.agentId = c.req.query('agentId');
    if (c.req.query('teamId'))  opts.teamId = c.req.query('teamId');
    return ok(c, { goals: gam.listGoals(tid, opts) });
  });
  app.post('/goals', async (c) => {
    const tid = tenantOf(c);
    const body = await c.req.json().catch(() => ({})) as any;
    if (!body.kind || !body.target || !body.period) return badRequest(c, 'kind + target + period required');
    try {
      return ok(c, { goal: gam.createGoal(tid, body) }, 201);
    } catch (err: any) { return badRequest(c, err.message); }
  });
  app.get('/goals/:id', (c) => {
    const g = gam.getGoal(tenantOf(c), c.req.param('id'));
    return g ? ok(c, { goal: g }) : notFound(c, 'goal');
  });
  app.patch('/goals/:id', async (c) => {
    const tid = tenantOf(c);
    const body = await c.req.json().catch(() => ({})) as any;
    const g = gam.updateGoal(tid, c.req.param('id'), body);
    return g ? ok(c, { goal: g }) : notFound(c, 'goal');
  });
  app.delete('/goals/:id', (c) => {
    return gam.deleteGoal(tenantOf(c), c.req.param('id')) ? c.body(null, 204) : notFound(c, 'goal');
  });
  app.get('/goals/:id/progress', (c) => {
    const p = gam.goalProgress(tenantOf(c), c.req.param('id'));
    return p ? ok(c, p) : notFound(c, 'goal');
  });
  app.get('/badges', (c) => ok(c, { badges: gam.listBadges(tenantOf(c)) }));
  app.post('/badges', async (c) => {
    const tid = tenantOf(c);
    const body = await c.req.json().catch(() => ({})) as any;
    if (!body.name || !body.criteria) return badRequest(c, 'name + criteria required');
    return ok(c, { badge: gam.createBadge(tid, body) }, 201);
  });
  app.delete('/badges/:id', (c) => {
    return gam.deleteBadge(tenantOf(c), c.req.param('id')) ? c.body(null, 204) : notFound(c, 'badge');
  });
  app.post('/badges/seed-defaults', (c) => {
    gam.seedDefaultBadges(tenantOf(c));
    return ok(c, { seeded: true });
  });
  app.post('/badges/evaluate', (c) => {
    return ok(c, gam.evaluateAllBadges(tenantOf(c)));
  });
}
