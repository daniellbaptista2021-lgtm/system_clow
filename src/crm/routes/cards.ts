// CRM cards module — split out from the legacy monolithic file in a refactor.
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



export function registerCardsRoutes(app: Hono): void {
  app.post('/cards', async (c) => {
    const tid = tenantOf(c);
    const body = await c.req.json().catch(() => ({}));
    if (!body.boardId || !body.columnId || !body.title) {
      return badRequest(c, 'boardId, columnId, title required');
    }
    const card = store.createCard(tid, body);
    return card ? ok(c, { card }, 201) : notFound(c, 'board or column');
  });
  app.get('/cards/:id', (c) => {
    const tid = tenantOf(c);
    const card = store.getCard(tid, c.req.param('id'));
    if (!card) return notFound(c, 'card');
    // Include contact + recent activities for the side panel
    const contact = card.contactId ? store.getContact(tid, card.contactId) : null;
    const activities = store.listActivitiesByCard(tid, card.id, 1000);
    return ok(c, { card, contact, activities });
  });
  app.patch('/cards/:id', async (c) => {
    const tid = tenantOf(c);
    const cardId = c.req.param('id');
    const body = await c.req.json().catch(() => ({})) as any;

    // Onda 59: detecta mudanca de owner pra logar atividade
    let oldOwner: string | undefined;
    if ('ownerAgentId' in body) {
      const before = store.getCard(tid, cardId);
      oldOwner = before?.ownerAgentId;
    }

    const upd = store.updateCard(tid, cardId, body);
    if (!upd) return notFound(c, 'card');

    // Log de mudanca de owner
    if ('ownerAgentId' in body && oldOwner !== upd.ownerAgentId) {
      try {
        const agents = store.listAgents(tid);
        const oldName = agents.find(a => a.id === oldOwner)?.name || (oldOwner ? oldOwner.slice(0, 8) : 'ninguem');
        const newName = agents.find(a => a.id === upd.ownerAgentId)?.name || (upd.ownerAgentId ? upd.ownerAgentId.slice(0, 8) : 'ninguem');
        store.logActivity(tid, {
          cardId, contactId: upd.contactId, type: 'assignment', channel: 'manual',
          content: 'Atendente alterado: ' + oldName + ' -> ' + newName,
          metadata: { oldOwnerAgentId: oldOwner || null, newOwnerAgentId: upd.ownerAgentId || null },
        });
      } catch { /* silent */ }
    }
    return ok(c, { card: upd });
  });
  app.post('/cards/:id/mark-read', async (c) => {
    const tid = tenantOf(c);
    const ok2 = store.markCardRead(tid, c.req.param('id'));
    return ok(c, { ok: ok2 });
  });
  app.post('/cards/:id/move', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (!body.toColumnId) return badRequest(c, 'toColumnId required');
    const wip = store.checkWipLimit(tenantOf(c), body.toColumnId);
    if (!wip.allowed) return c.json({ error: 'wip_limit_reached', message: 'Coluna cheia (' + wip.current + '/' + wip.limit + '). Aumente o WIP ou mova outro card antes.', current: wip.current, limit: wip.limit }, 409);
    const moved = store.moveCard(tenantOf(c), c.req.param('id'), body.toColumnId, body.position);
    return moved ? ok(c, { card: moved }) : notFound(c, 'card');
  });
  app.post('/cards/:id/reorder', async (c) => {
    const tid = tenantOf(c);
    const cardId = c.req.param('id');
    const body = await c.req.json().catch(() => ({})) as any;
    const toColumnId = String(body.toColumnId || '').trim();
    if (!toColumnId) return badRequest(c, 'toColumnId required');

    const wip = store.checkWipLimit(tid, toColumnId);
    // Permite reorder dentro da mesma coluna mesmo no limite
    const card = store.getCard(tid, cardId);
    if (!card) return notFound(c, 'card');
    const sameCol = card.columnId === toColumnId;
    if (!sameCol && !wip.allowed) {
      return c.json({ error: 'wip_limit_reached', message: 'Coluna cheia (' + wip.current + '/' + wip.limit + ').', current: wip.current, limit: wip.limit }, 409);
    }

    const result = store.reorderCard(tid, cardId, toColumnId, {
      beforeCardId: body.beforeCardId ? String(body.beforeCardId) : undefined,
      atIndex: typeof body.atIndex === 'number' ? body.atIndex : undefined,
    });
    return result ? ok(c, { card: result }) : notFound(c, 'card');
  });
  app.post('/cards/:id/lose', async (c) => {
    const tid = tenantOf(c);
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({})) as any;
    const reason = String(body.reason || '').trim() || 'unknown';
    const toColumnId = body.toColumnId as string | undefined;
    const db = getCrmDb();
    const card = db.prepare('SELECT id FROM crm_cards WHERE id = ? AND tenant_id = ?').get(id, tid);
    if (!card) return notFound(c, 'card');
    db.prepare('UPDATE crm_cards SET lost_reason = ?, updated_at = ? WHERE id = ? AND tenant_id = ?')
      .run(reason, Date.now(), id, tid);
    if (toColumnId) store.moveCard(tid, id, toColumnId);
    return ok(c, { ok: true, cardId: id, reason });
  });
  app.post('/cards/:id/win', async (c) => {
    const tid = tenantOf(c);
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({})) as any;
    const reason = String(body.reason || '').trim() || null;
    const toColumnId = body.toColumnId as string | undefined;
    const db = getCrmDb();
    const card = db.prepare('SELECT id FROM crm_cards WHERE id = ? AND tenant_id = ?').get(id, tid);
    if (!card) return notFound(c, 'card');
    db.prepare('UPDATE crm_cards SET won_reason = ?, updated_at = ? WHERE id = ? AND tenant_id = ?')
      .run(reason, Date.now(), id, tid);
    if (toColumnId) store.moveCard(tid, id, toColumnId);
    return ok(c, { ok: true, cardId: id, reason });
  });
  app.delete('/cards/:id', (c) => {
    const ok2 = store.deleteCard(tenantOf(c), c.req.param('id'));
    return ok2 ? c.body(null, 204) : notFound(c, 'card');
  });
  app.post('/activities', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (!body.type || !body.content) return badRequest(c, 'type and content required');
    if (!body.cardId && !body.contactId) return badRequest(c, 'cardId or contactId required');
    const a = store.logActivity(tenantOf(c), {
      cardId: body.cardId, contactId: body.contactId,
      type: body.type, channel: body.channel || 'manual',
      content: body.content, mediaUrl: body.mediaUrl, mediaType: body.mediaType,
      direction: body.direction, createdByAgentId: body.createdByAgentId,
    });
    return ok(c, { activity: a }, 201);
  });
  app.post('/reminders', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (!body.content || !body.dueAt) return badRequest(c, 'content and dueAt required');
    const r = store.createReminder(tenantOf(c), body);
    return ok(c, { reminder: r }, 201);
  });
  app.post('/activities/search', async (c) => {
    const body = await c.req.json().catch(() => ({})) as any;
    const filter = (body.filter || {}) as any;
    const limit = body.limit || 200;
    const offset = body.offset || 0;
    return ok(c, { activities: store.listActivitiesFiltered(tenantOf(c), filter, limit, offset) });
  });
  app.post('/activities/pro', async (c) => {
    const body = await c.req.json().catch(() => ({})) as any;
    if (!body.type || !body.content) return badRequest(c, 'type + content required');
    return ok(c, { activity: store.createActivityPro(tenantOf(c), body) }, 201);
  });
  app.post('/activities/:id/mention', async (c) => {
    const body = await c.req.json().catch(() => ({})) as any;
    const ids = Array.isArray(body.agent_ids) ? body.agent_ids : [];
    if (!ids.length) return badRequest(c, 'agent_ids[] required');
    return store.addMentionsToActivity(tenantOf(c), c.req.param('id'), ids) ? ok(c, { ok: true }) : notFound(c, 'activity');
  });
  app.post('/reminders/pro', async (c) => {
    const body = await c.req.json().catch(() => ({})) as any;
    if (!body.title || !body.dueAt) return badRequest(c, 'title + dueAt required');
    return ok(c, { reminder: store.createReminderPro(tenantOf(c), body) }, 201);
  });
  app.get('/reminders/pro', (c) => {
    const agentId = c.req.query('agent_id') || undefined;
    const status = c.req.query('status') as any || undefined;
    const dueBefore = c.req.query('due_before') ? parseInt(c.req.query('due_before')!, 10) : undefined;
    return ok(c, { reminders: store.listRemindersPro(tenantOf(c), { agentId, status, dueBefore }) });
  });
  app.post('/reminders/:id/snooze', async (c) => {
    const body = await c.req.json().catch(() => ({})) as any;
    const until = body.until_ts || (body.until ? Date.parse(body.until) : null);
    if (!until) return badRequest(c, 'until_ts or until iso required');
    const r = store.snoozeReminder(tenantOf(c), c.req.param('id'), until);
    return r ? ok(c, { reminder: r }) : notFound(c, 'reminder');
  });
  app.post('/reminders/:id/done', (c) => {
    const r = store.completeReminderPro(tenantOf(c), c.req.param('id'));
    return r ? ok(c, { reminder: r }) : notFound(c, 'reminder');
  });
  app.get('/reminders/:id/history', (c) =>
    ok(c, { history: store.getReminderHistory(tenantOf(c), c.req.param('id')) }));

  // ═══ CHANNELS UPGRADE (health, metrics, templates) ═══════════════════════
  app.post('/cards/:id/proposals', async (c) => {
    const body = await c.req.json().catch(() => ({})) as any;
    const p = store.createProposal(tenantOf(c), { ...body, cardId: c.req.param('id') });
    return p ? ok(c, { proposal: p }, 201) : notFound(c, 'card');
  });
  app.get('/cards/:id/proposals', (c) => ok(c, { proposals: store.listProposals(tenantOf(c), c.req.param('id')) }));
  app.get('/tasks', (c) => {
    const tid = tenantOf(c);
    const view = c.req.query('view');
    if (view === 'overdue')  return ok(c, { tasks: tasksMod.overdueTasks(tid, parseTaskOpts(c)) });
    if (view === 'upcoming') return ok(c, { tasks: tasksMod.upcomingTasks(tid, { ...parseTaskOpts(c), days: Number(c.req.query('days')) || 7 }) });
    return ok(c, { tasks: tasksMod.listTasks(tid, parseTaskOpts(c)) });
  });
  app.post('/tasks', async (c) => {
    const tid = tenantOf(c);
    const body = await c.req.json().catch(() => ({})) as any;
    if (!body.title) return badRequest(c, 'title required');
    if (body.type && !['call','email','meeting','followup','other'].includes(body.type)) return badRequest(c, 'invalid type');
    if (body.priority && !['low','med','high','urgent'].includes(body.priority)) return badRequest(c, 'invalid priority');
    const t = tasksMod.createTask(tid, body);
    return ok(c, { task: t }, 201);
  });
  app.get('/tasks/stats', (c) => {
    const tid = tenantOf(c);
    return ok(c, { stats: tasksMod.tasksStats(tid, c.req.query('agentId') || undefined) });
  });
  app.get('/tasks/:id', (c) => {
    const t = tasksMod.getTask(tenantOf(c), c.req.param('id'));
    return t ? ok(c, { task: t }) : notFound(c, 'task');
  });
  app.patch('/tasks/:id', async (c) => {
    const tid = tenantOf(c);
    const body = await c.req.json().catch(() => ({})) as any;
    const t = tasksMod.updateTask(tid, c.req.param('id'), body);
    return t ? ok(c, { task: t }) : notFound(c, 'task');
  });
  app.delete('/tasks/:id', (c) => {
    return tasksMod.deleteTask(tenantOf(c), c.req.param('id')) ? c.body(null, 204) : notFound(c, 'task');
  });
  app.post('/tasks/:id/complete', async (c) => {
    const tid = tenantOf(c);
    const body = await c.req.json().catch(() => ({})) as any;
    const t = tasksMod.completeTask(tid, c.req.param('id'), body.agentId);
    return t ? ok(c, { task: t }) : notFound(c, 'task');
  });
  app.get('/cards/:id/tasks', (c) => {
    const tid = tenantOf(c);
    return ok(c, { tasks: tasksMod.listTasks(tid, { ...parseTaskOpts(c), cardId: c.req.param('id'), status: 'all' }) });
  });
  app.get('/appointments', (c) => {
    const tid = tenantOf(c);
    const opts: any = {};
    const from = c.req.query('from'); const to = c.req.query('to');
    if (from && /^\d+$/.test(from)) opts.from = Number(from);
    if (to && /^\d+$/.test(to)) opts.to = Number(to);
    if (c.req.query('agentId')) opts.agentId = c.req.query('agentId');
    if (c.req.query('contactId')) opts.contactId = c.req.query('contactId');
    if (c.req.query('cardId')) opts.cardId = c.req.query('cardId');
    if (c.req.query('status')) opts.status = c.req.query('status');
    return ok(c, { appointments: cal.listAppointments(tid, opts) });
  });
  app.post('/appointments', async (c) => {
    const tid = tenantOf(c);
    const body = await c.req.json().catch(() => ({})) as any;
    if (!body.title || !body.startsAt || !body.endsAt) return badRequest(c, 'title, startsAt, endsAt required');
    if (body.endsAt <= body.startsAt) return badRequest(c, 'endsAt must be after startsAt');
    return ok(c, { appointment: cal.createAppointment(tid, body) }, 201);
  });
  app.get('/appointments/:id', (c) => {
    const a = cal.getAppointment(tenantOf(c), c.req.param('id'));
    return a ? ok(c, { appointment: a }) : notFound(c, 'appointment');
  });
  app.patch('/appointments/:id', async (c) => {
    const tid = tenantOf(c);
    const body = await c.req.json().catch(() => ({})) as any;
    const a = cal.updateAppointment(tid, c.req.param('id'), body);
    return a ? ok(c, { appointment: a }) : notFound(c, 'appointment');
  });
  app.delete('/appointments/:id', (c) => {
    return cal.deleteAppointment(tenantOf(c), c.req.param('id')) ? c.body(null, 204) : notFound(c, 'appointment');
  });
  app.get('/calendar/ics-url', (c) => {
    const tid = tenantOf(c);
    const tok = cal.ensureIcsToken(tid);
    const proto = c.req.header('x-forwarded-proto') || 'https';
    const host = c.req.header('host') || 'localhost';
    return ok(c, { url: `${proto}://${host}/p/cal/${tok}.ics`, token: tok });
  });
  app.get('/cards/:id/comments', (c) => {
    return ok(c, { comments: collab.listCardComments(tenantOf(c), c.req.param('id')) });
  });
  app.post('/cards/:id/comments', async (c) => {
    const tid = tenantOf(c);
    const body = await c.req.json().catch(() => ({})) as any;
    if (!body.content) return badRequest(c, 'content required');
    return ok(c, { comment: collab.createCardComment(tid, { ...body, cardId: c.req.param('id') }) }, 201);
  });
  app.patch('/card-comments/:id', async (c) => {
    const tid = tenantOf(c);
    const body = await c.req.json().catch(() => ({})) as any;
    if (!body.content) return badRequest(c, 'content required');
    const cm = collab.updateCardComment(tid, c.req.param('id'), body);
    return cm ? ok(c, { comment: cm }) : notFound(c, 'comment');
  });
  app.delete('/card-comments/:id', (c) => {
    return collab.deleteCardComment(tenantOf(c), c.req.param('id')) ? c.body(null, 204) : notFound(c, 'comment');
  });
  app.get('/chat/rooms', (c) => {
    const tid = tenantOf(c);
    return ok(c, { rooms: collab.listChatRooms(tid, c.req.query('agentId') || undefined) });
  });
  app.post('/chat/rooms', async (c) => {
    const tid = tenantOf(c);
    const body = await c.req.json().catch(() => ({})) as any;
    if (!body.name || !Array.isArray(body.members)) return badRequest(c, 'name + members[] required');
    const type = body.type || 'group';
    if (!['dm', 'group', 'card', 'contact'].includes(type)) return badRequest(c, 'invalid type');
    return ok(c, { room: collab.createChatRoom(tid, { ...body, type }) }, 201);
  });
  app.get('/chat/rooms/:id', (c) => {
    const r = collab.getChatRoom(tenantOf(c), c.req.param('id'));
    return r ? ok(c, { room: r }) : notFound(c, 'room');
  });
  app.delete('/chat/rooms/:id', (c) => {
    return collab.deleteChatRoom(tenantOf(c), c.req.param('id')) ? c.body(null, 204) : notFound(c, 'room');
  });
  app.get('/chat/rooms/:id/messages', (c) => {
    const tid = tenantOf(c);
    const before = c.req.query('before');
    const limit = Number(c.req.query('limit')) || 100;
    const opts: any = { limit };
    if (before && /^\d+$/.test(before)) opts.before = Number(before);
    return ok(c, { messages: collab.listChatMessages(tid, c.req.param('id'), opts) });
  });
  app.post('/chat/rooms/:id/messages', async (c) => {
    const tid = tenantOf(c);
    const body = await c.req.json().catch(() => ({})) as any;
    if (!body.content) return badRequest(c, 'content required');
    const m = collab.postChatMessage(tid, { ...body, roomId: c.req.param('id') });
    return m ? ok(c, { message: m }, 201) : notFound(c, 'room');
  });
  app.post('/chat/rooms/:id/read', async (c) => {
    const tid = tenantOf(c);
    const body = await c.req.json().catch(() => ({})) as any;
    if (!body.agentId || !body.lastMessageId) return badRequest(c, 'agentId + lastMessageId required');
    collab.markRoomRead(tid, c.req.param('id'), body.agentId, body.lastMessageId);
    return ok(c, { ok: true });
  });
  app.get('/chat/unread', (c) => {
    const tid = tenantOf(c);
    const agentId = c.req.query('agentId');
    if (!agentId) return badRequest(c, 'agentId required');
    return ok(c, { unread: collab.unreadCounts(tid, agentId) });
  });
  app.get('/mentions', (c) => {
    const tid = tenantOf(c);
    const agentId = c.req.query('agentId');
    if (!agentId) return badRequest(c, 'agentId required');
    const unreadOnly = c.req.query('unreadOnly') === 'true';
    const limit = Number(c.req.query('limit')) || 50;
    return ok(c, {
      mentions: collab.agentMentions(tid, agentId, { unreadOnly, limit }),
      unreadCount: collab.unreadMentionsCount(tid, agentId),
    });
  });
  app.post('/mentions/:id/read', (c) => {
    const tid = tenantOf(c);
    const body = c.req.header('x-agent-id') || c.req.query('agentId') || '';
    if (!body) return badRequest(c, 'agentId required (query or x-agent-id header)');
    return collab.markMentionRead(tid, body as string, c.req.param('id')) ? ok(c, { ok: true }) : notFound(c, 'mention');
  });
  app.post('/mentions/read-all', async (c) => {
    const tid = tenantOf(c);
    const body = await c.req.json().catch(() => ({})) as any;
    if (!body.agentId) return badRequest(c, 'agentId required');
    const n = collab.markAllMentionsRead(tid, body.agentId);
    return ok(c, { markedRead: n });
  });
  app.get('/cards/:id/documents', (c) => {
    const tid = tenantOf(c);
    return ok(c, { documents: docs.listDocuments(tid, { cardId: c.req.param('id') }) });
  });
  app.post('/activities/:id/labels/:labelId', (c) =>
    store.addLabelToActivity(tenantOf(c), c.req.param('id'), c.req.param('labelId')) ? ok(c, { ok: true }) : notFound(c, 'activity'));
  app.delete('/activities/:id/labels/:labelId', (c) =>
    store.removeLabelFromActivity(tenantOf(c), c.req.param('id'), c.req.param('labelId')) ? c.body(null, 204) : notFound(c, 'activity'));
  app.post('/activities/:id/read', async (c) => {
    const body = await c.req.json().catch(() => ({})) as any;
    return store.markActivityRead(tenantOf(c), c.req.param('id'), body.agent_id || 'system') ? ok(c, { ok: true }) : notFound(c, 'activity');
  });
  app.post('/activities/:id/snooze', async (c) => {
    const body = await c.req.json().catch(() => ({})) as any;
    const until = typeof body.until_ts === 'number' ? body.until_ts : Date.parse(body.until || '');
    if (!Number.isFinite(until)) return badRequest(c, 'until_ts (ms) or until (iso) required');
    return store.snoozeActivity(tenantOf(c), c.req.param('id'), until) ? ok(c, { ok: true }) : notFound(c, 'activity');
  });
  app.post('/cards/:id/archive', (c) => {
    const r = store.archiveCard(tenantOf(c), c.req.param('id'));
    return r ? ok(c, { card: r }) : notFound(c, 'card');
  });
  app.post('/cards/:id/unarchive', (c) => {
    const r = store.unarchiveCard(tenantOf(c), c.req.param('id'));
    return r ? ok(c, { card: r }) : notFound(c, 'card');
  });
  app.post('/cards/:id/checklists', async (c) => {
    const body = await c.req.json().catch(() => ({})) as any;
    if (!body.title) return badRequest(c, 'title required');
    const cl = store.createChecklist(tenantOf(c), c.req.param('id'), body);
    return cl ? ok(c, { checklist: cl }, 201) : notFound(c, 'card');
  });
  app.get('/cards/:id/checklists', (c) => {
    return ok(c, { checklists: store.listChecklists(tenantOf(c), c.req.param('id')) });
  });
  app.get('/cards/:id/items', (c) => {
    return ok(c, { items: lineItems.listItemsByCard(tenantOf(c), c.req.param('id')) });
  });
  app.post('/cards/:id/items', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (!body.inventoryId || !body.qty) return badRequest(c, 'inventoryId and qty required');
    try {
      const item = lineItems.addItemToCard(tenantOf(c), c.req.param('id'), body);
      return item ? ok(c, { item }, 201) : notFound(c, 'card or product');
    } catch (e: any) {
      return badRequest(c, e.message);
    }
  });
  app.delete('/cards/:cardId/items/:itemId', (c) => {
    const ok2 = lineItems.removeItemFromCard(tenantOf(c), c.req.param('cardId'), c.req.param('itemId'));
    return ok2 ? c.body(null, 204) : notFound(c, 'item');
  });
}
