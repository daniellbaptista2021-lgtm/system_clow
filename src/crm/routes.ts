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

import { Hono } from 'hono';
import * as store from './store.js';
import { encryptJson, decryptJson, maskSecret } from './crypto.js';
import { sendOutbound } from './inbox.js';
import * as automations from './automations.js';
import { markPaid } from './billing.js';
import * as assignment from './assignment.js';
import * as lineItems from './lineItems.js';
import * as analytics from './analytics.js';
import * as reports from './reports.js';
import { getCrmDb } from './schema.js';
import { toCSV, toPDF, type ReportKind } from './reportsExport.js';
import * as proposalsMod from './proposals.js';
import * as em from './emailMarketing.js';
import * as forms from './forms.js';
import * as tasksMod from './tasks.js';
import * as cal from './calendar.js';
import * as collab from './collaboration.js';
import * as search from './search.js';
import * as ohk from './outboundWebhooks.js';
import * as extint from './integrations.js';
import * as push from './push.js';
import * as ai from './ai.js';
import * as docs from './documents.js';
import * as gam from './gamification.js';
import * as lgpd from './lgpd.js';
import * as softDel from './softDelete.js';
import * as rl from './rateLimiter.js';
import * as sec from './security.js';
import { cache } from './queryCache.js';
import { contactLoader, agentLoader } from './dataLoader.js';
import { dbInfo, tableStats, explain, vacuum, applyPerformancePragmas } from './connectionInfo.js';
import * as bulkOps from './bulkOps.js';
import { fieldSelectionMiddleware } from './fieldSelector.js';
import { encodeCursor, decodeCursor } from './cursor.js';
import * as mobile from './mobile.js';
import { subscribe, formatSseFrame } from './events.js';
import { findTenantByApiKeyHash, hashApiKey } from '../tenancy/tenantStore.js';
import { readMedia } from './media.js';
import type { BoardType, ChannelType, BillingCycle, AgentRole } from './types.js';

const app = new Hono();

// ═══ ONDA 30: Rate limit + field selection middlewares ════════════════
app.use('*', rl.rateLimitMiddleware());
app.use('*', fieldSelectionMiddleware());


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

// ═══ INIT (idempotent — seeds defaults on first call) ═══════════════════
app.post('/init', (c) => {
  const tid = tenantOf(c);
  const board = store.seedDefaultBoards(tid);
  const boards = store.listBoards(tid);
  return ok(c, { ok: true, defaultBoardId: board.id, boards: boards.length }, 201);
});

// ═══ BOARDS ═════════════════════════════════════════════════════════════
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

/** Hydrated kanban view: board + columns + cards grouped by column. */
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

// ═══ COLUMNS ════════════════════════════════════════════════════════════
// ═══ ANALYTICS (Pipeline Analytics — Onda 13) ══════════════════════════
function parseWin(c: any): { from?: number; to?: number } {
  const from = c.req.query('from');
  const to   = c.req.query('to');
  const w: { from?: number; to?: number } = {};
  if (from && /^\d+$/.test(from)) w.from = Number(from);
  if (to   && /^\d+$/.test(to))   w.to   = Number(to);
  return w;
}

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

// ═══ REPORTS (Reports & Dashboards — Onda 14) ═════════════════════════
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

// ─── Scheduled reports CRUD ─────────────────────────────────────────────
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
  const { tick: runReports } = await import('./reportsScheduler.js');
  getCrmDb().prepare('UPDATE crm_scheduled_reports SET next_run_at = ? WHERE id = ?').run(Date.now() - 1, id);
  await runReports();
  return ok(c, { ok: true, triggered: id });
});

function computeFirstRunAt(interval: string): number {
  const d = new Date();
  // Schedule first run at 08:00 UTC next day/week/month
  d.setUTCHours(8, 0, 0, 0);
  if (interval === 'daily')   d.setUTCDate(d.getUTCDate() + 1);
  if (interval === 'weekly')  d.setUTCDate(d.getUTCDate() + 7);
  if (interval === 'monthly') d.setUTCMonth(d.getUTCMonth() + 1);
  return d.getTime();
}

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

// ═══ CARDS ══════════════════════════════════════════════════════════════
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
  const activities = store.listActivitiesByCard(tid, card.id, 200);
  return ok(c, { card, contact, activities });
});

app.patch('/cards/:id', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const upd = store.updateCard(tenantOf(c), c.req.param('id'), body);
  return upd ? ok(c, { card: upd }) : notFound(c, 'card');
});

app.post('/cards/:id/move', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!body.toColumnId) return badRequest(c, 'toColumnId required');
  // Onda 2: respeita WIP limit se configurado (settings.wipEnforce=true + col.wip_limit)
  const wip = store.checkWipLimit(tenantOf(c), body.toColumnId);
  if (!wip.allowed) return c.json({ error: 'wip_limit_reached', message: 'Coluna cheia (' + wip.current + '/' + wip.limit + '). Aumente o WIP ou mova outro card antes.', current: wip.current, limit: wip.limit }, 409);
  const moved = store.moveCard(tenantOf(c), c.req.param('id'), body.toColumnId, body.position);
  return moved ? ok(c, { card: moved }) : notFound(c, 'card');
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

// ═══ CONTACTS ═══════════════════════════════════════════════════════════
app.get('/contacts', (c) => {
  const limit = parseInt(c.req.query('limit') || '50', 10);
  const offset = parseInt(c.req.query('offset') || '0', 10);
  const tag = c.req.query('tag') || undefined;
  return ok(c, { contacts: store.listContacts(tenantOf(c), { limit, offset, tag }) });
});

app.get('/contacts/search', (c) => {
  const q = c.req.query('q') || '';
  if (!q) return ok(c, { contacts: [] });
  return ok(c, { contacts: store.searchContacts(tenantOf(c), q, 25) });
});

app.post('/contacts', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!body.name) return badRequest(c, 'name required');
  const contact = store.createContact(tenantOf(c), body);
  return ok(c, { contact }, 201);
});

// ═══ CONTACTS PRO ═══════════════════════════════════════════════════════
app.get('/contacts/duplicates', (c) => {
  const dups = store.findDuplicateContacts(tenantOf(c));
  return ok(c, { duplicates: dups });
});

app.post('/contacts/:id/merge', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const targetId = (body as any).target_id || (body as any).targetId;
  if (!targetId) return badRequest(c, 'target_id required');
  const r = store.mergeContacts(tenantOf(c), c.req.param('id'), targetId);
  return r.ok ? ok(c, { merged: true }) : c.json({ error: r.error }, 400);
});

app.post('/contacts/import', async (c) => {
  const tid = tenantOf(c);
  const ctype = c.req.header('content-type') || '';
  let csv = '';
  if (ctype.includes('multipart/form-data')) {
    const fd = await c.req.formData();
    const file = fd.get('file');
    if (!file || typeof file === 'string') return badRequest(c, 'file required');
    csv = Buffer.from(await (file as any).arrayBuffer()).toString('utf-8');
  } else {
    csv = await c.req.text();
  }
  const result = store.importContactsCsv(tid, csv);
  return ok(c, result);
});

app.get('/contacts/export', (c) => {
  const csv = store.exportContactsCsv(tenantOf(c));
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="contacts.csv"',
    },
  });
});

app.post('/contacts/bulk', async (c) => {
  const body = await c.req.json().catch(() => ({})) as any;
  if (!body.action || !Array.isArray(body.ids)) return badRequest(c, 'action + ids[] required');
  const r = store.bulkContactOp(tenantOf(c), body);
  return ok(c, r);
});

app.get('/contacts/:id/history', (c) => {
  const limit = parseInt(c.req.query('limit') || '500', 10);
  const type = c.req.query('type') || undefined;
  const h = store.getContactHistory(tenantOf(c), c.req.param('id'), { limit, type });
  return ok(c, h);
});


app.get('/contacts/:id', (c) => {
  const tid = tenantOf(c);
  const contact = store.getContact(tid, c.req.param('id'));
  if (!contact) return notFound(c, 'contact');
  const cards = store.listCardsByContact(tid, contact.id);
  const activities = store.listActivitiesByContact(tid, contact.id, 200);
  return ok(c, { contact, cards, activities });
});

app.patch('/contacts/:id', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const upd = store.updateContact(tenantOf(c), c.req.param('id'), body);
  return upd ? ok(c, { contact: upd }) : notFound(c, 'contact');
});

app.delete('/contacts/:id', (c) => {
  const ok2 = store.deleteContact(tenantOf(c), c.req.param('id'));
  return ok2 ? c.body(null, 204) : notFound(c, 'contact');
});

// ═══ ACTIVITIES (notes + manual logs) ═══════════════════════════════════
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

// ═══ AGENTS ═════════════════════════════════════════════════════════════
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

// ═══ CHANNELS (WhatsApp Meta + Z-API) ═══════════════════════════════════
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

app.get('/channels', (c) => {
  const channels = store.listChannels(tenantOf(c)).map(maskedChannel);
  return ok(c, { channels });
});

app.post('/channels', async (c) => {
  const tid = tenantOf(c);
  const body = await c.req.json().catch(() => ({}));
  if (!body.type || !['meta', 'zapi'].includes(body.type)) {
    return badRequest(c, 'type required (meta | zapi)');
  }
  if (!body.name || !body.credentials) return badRequest(c, 'name and credentials required');

  // Validate credentials shape per type
  if (body.type === 'meta') {
    const c2: MetaCreds = body.credentials;
    if (!c2.accessToken || !c2.phoneNumberId) {
      return badRequest(c, 'meta credentials need accessToken + phoneNumberId');
    }
  } else {
    const c2: ZapiCreds = body.credentials;
    if (!c2.instanceId || !c2.token) {
      return badRequest(c, 'zapi credentials need instanceId + token');
    }
  }

  let encrypted: string;
  try {
    encrypted = encryptJson(body.credentials);
  } catch (e: any) {
    return badRequest(c, `cannot encrypt credentials: ${e.message}`);
  }

  const ch = store.createChannel(tid, {
    type: body.type as ChannelType,
    name: body.name,
    credentialsEncrypted: encrypted,
    phoneNumber: body.phoneNumber,
    phoneNumberId: body.type === 'meta' ? body.credentials.phoneNumberId : undefined,
    status: 'pending', // until first webhook validates
  });
  return ok(c, { channel: maskedChannel(ch) }, 201);
});

app.get('/channels/:id', (c) => {
  const ch = store.getChannel(tenantOf(c), c.req.param('id'));
  return ch ? ok(c, { channel: maskedChannel(ch) }) : notFound(c, 'channel');
});

app.patch('/channels/:id', async (c) => {
  const tid = tenantOf(c);
  const id = c.req.param('id');
  const existing = store.getChannel(tid, id);
  if (!existing) return notFound(c, 'channel');
  const body = await c.req.json().catch(() => ({}));
  const patch: any = {};
  if (body.name !== undefined) patch.name = body.name;
  if (body.status !== undefined) patch.status = body.status;
  if (body.phoneNumber !== undefined) patch.phoneNumber = body.phoneNumber;
  if (body.credentials) {
    try { patch.credentialsEncrypted = encryptJson(body.credentials); }
    catch (e: any) { return badRequest(c, `cannot encrypt credentials: ${e.message}`); }
    if (body.credentials.phoneNumberId) patch.phoneNumberId = body.credentials.phoneNumberId;
  }
  const upd = store.updateChannel(tid, id, patch);
  return upd ? ok(c, { channel: maskedChannel(upd) }) : notFound(c, 'channel');
});

app.delete('/channels/:id', (c) => {
  const ok2 = store.deleteChannel(tenantOf(c), c.req.param('id'));
  return ok2 ? c.body(null, 204) : notFound(c, 'channel');
});

// ═══ SUBSCRIPTIONS (cobrança recorrente) ════════════════════════════════
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

// ═══ INVENTORY ══════════════════════════════════════════════════════════
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

// ═══ REMINDERS ══════════════════════════════════════════════════════════
app.post('/reminders', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!body.content || !body.dueAt) return badRequest(c, 'content and dueAt required');
  const r = store.createReminder(tenantOf(c), body);
  return ok(c, { reminder: r }, 201);
});

// ═══ STATS / DASHBOARD ══════════════════════════════════════════════════
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


// ═══ SEND MESSAGE via channel ═══════════════════════════════════════════
app.post('/channels/:id/send', async (c) => {
  const tid = tenantOf(c);
  const ch = store.getChannel(tid, c.req.param('id'));
  if (!ch) return notFound(c, 'channel');
  const body = await c.req.json().catch(() => ({}));
  if (!body.to) return badRequest(c, 'to required');
  if (!body.text && !body.mediaUrl) return badRequest(c, 'text or mediaUrl required');
  const r = await sendOutbound(ch, body);
  return r.ok ? ok(c, r) : c.json({ error: 'send_failed', message: r.error }, 502);
});

// ═══ MEDIA serving (auth-scoped) ═══════════════════════════════════════
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



// ═══ MEDIA upload (for UI composer) ═════════════════════════════════════
app.post('/media/upload', async (c) => {
  const tid = tenantOf(c);
  const formData = await c.req.formData();
  const file = formData.get('file');
  if (!file || typeof file === 'string') return badRequest(c, 'file required');
  const bytes = Buffer.from(await (file as any).arrayBuffer());
  const filename = (file as any).name || 'upload.bin';
  const mime = (file as any).type || 'application/octet-stream';
  const saved = (await import('./media.js')).saveMedia(tid, bytes, { mime, suggestedFilename: filename });
  // Return full URL with tenantId path
  return ok(c, { url: saved.publicUrl, bytes: saved.bytes, mime: saved.mime }, 201);
});

// ═══ MEDIA PROCESS (extrai texto de audio/imagem/pdf/arquivo) ═══════════
// POST /v1/crm/media/process — multipart file field
// Retorna: { kind: 'audio|image|pdf|text|unknown', content: '...' }
app.post('/media/process', async (c) => {
  const formData = await c.req.formData();
  const file = formData.get('file');
  if (!file || typeof file === 'string') return badRequest(c, 'file required');
  const bytes = Buffer.from(await (file as any).arrayBuffer());
  const filename = (file as any).name || 'upload.bin';
  const mime = (file as any).type || 'application/octet-stream';
  try {
    const { processMedia } = await import('../notifications/openaiMedia.js');
    const result = await processMedia(bytes, mime, filename);
    return ok(c, { kind: result.kind, content: result.content, filename, mime, bytes: bytes.length });
  } catch (err: any) {
    return c.json({ error: 'process_failed', message: err?.message }, 500);
  }
});


// ═══ TIMELINE PRO ════════════════════════════════════════════════════════
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

// ═══ REMINDERS PRO ═══════════════════════════════════════════════════════
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
app.get('/channels/:id/health', async (c) => {
  return ok(c, { health: await store.channelHealthCheck(tenantOf(c), c.req.param('id')) });
});

app.get('/channels/:id/metrics', (c) => {
  const m = store.getChannelMetrics(tenantOf(c), c.req.param('id'));
  return m ? ok(c, { metrics: m }) : notFound(c, 'channel');
});

app.post('/channels/:id/templates/sync', async (c) => {
  return ok(c, await store.syncMetaTemplates(tenantOf(c), c.req.param('id')));
});

app.get('/channels/:id/templates', (c) => {
  return ok(c, { templates: store.listChannelTemplates(tenantOf(c), c.req.param('id')) });
});

// ═══ MIDIA UPGRADE: bulk process ═══════════════════════════════════════
app.post('/media/bulk-process', async (c) => {
  const fd = await c.req.formData();
  const files = fd.getAll('files');
  if (!files.length) return badRequest(c, 'files[] required');
  const { processMedia } = await import('../notifications/openaiMedia.js');
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

// ═══ AUTOMATIONS PRO ════════════════════════════════════════════════════
app.patch('/automations/:id/schedule', async (c) => {
  const body = await c.req.json().catch(() => ({})) as any;
  const cron = body.schedule_cron ?? null;
  const nextRunAt = body.next_run_at ?? (cron ? Date.now() + 60000 : null);
  return store.setAutomationSchedule(tenantOf(c), c.req.param('id'), cron, nextRunAt) ? ok(c, { ok: true }) : notFound(c, 'automation');
});

app.post('/automations/:id/webhook', (c) => {
  const secret = store.setAutomationWebhook(tenantOf(c), c.req.param('id'));
  const url = `/v1/crm/automations/webhook/${secret}`;
  return ok(c, { url, secret });
});

app.post('/automations/webhook/:secret', async (c) => {
  const auto = store.findAutomationByWebhook(c.req.param('secret'));
  if (!auto) return notFound(c, 'automation');
  const payload = await c.req.json().catch(() => ({}));
  const start = Date.now();
  try {
    // dispara automation via seu engine existente (emit)
    const automations = await import('./automations.js');
    await automations.emit({ trigger: 'webhook', tenantId: auto.tenant_id, text: JSON.stringify(payload) });
    store.logAutomationRun(auto.tenant_id, auto.id, { triggerPayload: payload, actionsExecuted: 1, success: true, durationMs: Date.now() - start });
    return ok(c, { fired: true });
  } catch (err: any) {
    store.logAutomationRun(auto.tenant_id, auto.id, { triggerPayload: payload, actionsExecuted: 0, success: false, error: err.message, durationMs: Date.now() - start });
    return c.json({ error: err.message }, 500);
  }
});

app.get('/automations/:id/logs', (c) => {
  const limit = parseInt(c.req.query('limit') || '50', 10);
  return ok(c, { logs: store.listAutomationLogs(tenantOf(c), c.req.param('id'), limit) });
});

// ═══ ASSIGNMENT PRO (rules + SLA) ═══════════════════════════════════════
app.post('/assignment-rules', async (c) => {
  const body = await c.req.json().catch(() => ({})) as any;
  if (!body.name) return badRequest(c, 'name required');
  return ok(c, { rule: store.createAssignmentRule(tenantOf(c), {
    name: body.name, conditions: body.conditions || {},
    assignToAgentId: body.assign_to_agent_id,
    assignToTeamId: body.assign_to_team_id,
    skillRequired: body.skill_required,
    slaMinutes: body.sla_minutes,
    escalateToAgentId: body.escalate_to_agent_id,
    priority: body.priority || 0,
    enabled: body.enabled !== false,
  }) }, 201);
});
app.get('/assignment-rules', (c) => ok(c, { rules: store.listAssignmentRules(tenantOf(c)) }));
app.delete('/assignment-rules/:id', (c) => store.deleteAssignmentRule(tenantOf(c), c.req.param('id')) ? c.body(null, 204) : notFound(c, 'rule'));

app.post('/assignment/evaluate', async (c) => {
  const body = await c.req.json().catch(() => ({})) as any;
  if (!body.card) return badRequest(c, 'card required');
  return ok(c, store.evaluateAssignment(tenantOf(c), { card: body.card, contact: body.contact, channel: body.channel, keyword: body.keyword }));
});

app.get('/assignment/sla-violations', (c) => ok(c, { violations: store.slaViolations(tenantOf(c)) }));

// ═══ SUBSCRIPTIONS PRO + STRIPE CONNECT + INVOICES + COUPONS + MRR ══════════

// Stripe Connect: tenant conecta SUA conta Stripe
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

// Invoices
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

// Coupons
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

// Dunning
app.get('/subscriptions/:id/dunning', (c) => ok(c, { log: store.listDunning(tenantOf(c), c.req.param('id')) }));

// Subscriptions Pro ops
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

// MRR Dashboard
app.get('/mrr', (c) => ok(c, store.computeMrr(tenantOf(c))));

// ═══ INVENTORY PRO ═══════════════════════════════════════════════════════
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

// ═══ PROPOSALS (Line Items Pro) ══════════════════════════════════════════
app.post('/cards/:id/proposals', async (c) => {
  const body = await c.req.json().catch(() => ({})) as any;
  const p = store.createProposal(tenantOf(c), { ...body, cardId: c.req.param('id') });
  return p ? ok(c, { proposal: p }, 201) : notFound(c, 'card');
});
app.get('/cards/:id/proposals', (c) => ok(c, { proposals: store.listProposals(tenantOf(c), c.req.param('id')) }));
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

// ═══ PROPOSALS PRO (Onda 16) ══════════════════════════════════════════
function baseUrlOf(c: any): string {
  const proto = c.req.header('x-forwarded-proto') || 'https';
  const host = c.req.header('host') || 'localhost';
  return `${proto}://${host}`;
}

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

// Keep onAccept hook in sync: when status is set to 'accepted' via admin
// endpoint (not just public sign), also trigger conversion.
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

// ═══ EMAIL MARKETING (Onda 17) ════════════════════════════════════════
app.get('/email-templates', (c) => {
  const tid = tenantOf(c);
  const rows = getCrmDb().prepare('SELECT * FROM crm_email_templates WHERE tenant_id = ? ORDER BY updated_at DESC').all(tid);
  return ok(c, { templates: rows });
});

app.post('/email-templates', async (c) => {
  const tid = tenantOf(c);
  const body = await c.req.json().catch(() => ({})) as any;
  const name = String(body.name || '').trim();
  const subject = String(body.subject || '').trim();
  const html = String(body.bodyHtml || body.body_html || '');
  if (!name || !subject || !html) return badRequest(c, 'name, subject, bodyHtml required');
  const id = 'crm_emtpl_' + Math.random().toString(36).slice(2, 14);
  const now = Date.now();
  getCrmDb().prepare(
    'INSERT INTO crm_email_templates (id, tenant_id, name, subject, body_html, variables_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, tid, name, subject, html, JSON.stringify(body.variables || []), now, now);
  return ok(c, { id }, 201);
});

app.patch('/email-templates/:id', async (c) => {
  const tid = tenantOf(c);
  const body = await c.req.json().catch(() => ({})) as any;
  const sets: string[] = []; const params: any[] = [];
  for (const [k, col] of [['name','name'],['subject','subject'],['bodyHtml','body_html']]) {
    if (body[k] !== undefined) { sets.push(`${col} = ?`); params.push(body[k]); }
  }
  if (!sets.length) return badRequest(c, 'no fields to update');
  sets.push('updated_at = ?'); params.push(Date.now());
  params.push(c.req.param('id'), tid);
  const r = getCrmDb().prepare(`UPDATE crm_email_templates SET ${sets.join(', ')} WHERE id = ? AND tenant_id = ?`).run(...params);
  return r.changes > 0 ? ok(c, { ok: true }) : notFound(c, 'template');
});

app.delete('/email-templates/:id', (c) => {
  const tid = tenantOf(c);
  const r = getCrmDb().prepare('DELETE FROM crm_email_templates WHERE id = ? AND tenant_id = ?').run(c.req.param('id'), tid);
  return r.changes > 0 ? c.body(null, 204) : notFound(c, 'template');
});

app.get('/campaigns', (c) => {
  const tid = tenantOf(c);
  const rows = getCrmDb().prepare('SELECT * FROM crm_email_campaigns WHERE tenant_id = ? ORDER BY created_at DESC').all(tid);
  return ok(c, { campaigns: rows });
});

app.post('/campaigns', async (c) => {
  const tid = tenantOf(c);
  const body = await c.req.json().catch(() => ({})) as any;
  const name = String(body.name || '').trim();
  const segmentId = String(body.segmentId || '').trim();
  let subject = body.subject as string;
  let html = body.bodyHtml || body.body_html;
  if (body.templateId) {
    const tpl = getCrmDb().prepare('SELECT subject, body_html FROM crm_email_templates WHERE id = ? AND tenant_id = ?').get(body.templateId, tid) as any;
    if (tpl) { subject = subject || tpl.subject; html = html || tpl.body_html; }
  }
  if (!name || !segmentId || !subject || !html) return badRequest(c, 'name, segmentId, subject, bodyHtml required');
  const id = 'crm_camp_' + Math.random().toString(36).slice(2, 14);
  const scheduledAt = body.scheduledAt ? Number(body.scheduledAt) : null;
  const status = scheduledAt ? 'scheduled' : 'draft';
  getCrmDb().prepare(`
    INSERT INTO crm_email_campaigns (id, tenant_id, name, segment_id, template_id, subject, body_html, status, scheduled_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, tid, name, segmentId, body.templateId || null, subject, html, status, scheduledAt, Date.now());
  return ok(c, { id, status }, 201);
});

app.get('/campaigns/:id', (c) => {
  const tid = tenantOf(c);
  const row = getCrmDb().prepare('SELECT * FROM crm_email_campaigns WHERE id = ? AND tenant_id = ?').get(c.req.param('id'), tid);
  return row ? ok(c, { campaign: row }) : notFound(c, 'campaign');
});

app.post('/campaigns/:id/send', (c) => {
  const tid = tenantOf(c);
  try {
    const r = em.enqueueCampaign(tid, c.req.param('id'));
    return ok(c, r);
  } catch (err: any) { return notFound(c, err.message); }
});

app.post('/campaigns/:id/pause', (c) => {
  const tid = tenantOf(c);
  const r = getCrmDb().prepare("UPDATE crm_email_campaigns SET status = 'paused' WHERE id = ? AND tenant_id = ?").run(c.req.param('id'), tid);
  return r.changes > 0 ? ok(c, { ok: true }) : notFound(c, 'campaign');
});

app.post('/campaigns/:id/resume', (c) => {
  const tid = tenantOf(c);
  const r = getCrmDb().prepare("UPDATE crm_email_campaigns SET status = 'sending' WHERE id = ? AND tenant_id = ? AND status = 'paused'").run(c.req.param('id'), tid);
  return r.changes > 0 ? ok(c, { ok: true }) : notFound(c, 'campaign');
});

app.get('/campaigns/:id/stats', (c) => {
  const tid = tenantOf(c);
  const id = c.req.param('id');
  const camp = getCrmDb().prepare('SELECT * FROM crm_email_campaigns WHERE id = ? AND tenant_id = ?').get(id, tid) as any;
  if (!camp) return notFound(c, 'campaign');
  const sends = getCrmDb().prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN sent_at IS NOT NULL THEN 1 ELSE 0 END) AS sent,
      SUM(CASE WHEN opened_at IS NOT NULL THEN 1 ELSE 0 END) AS opened,
      SUM(CASE WHEN clicked_at IS NOT NULL THEN 1 ELSE 0 END) AS clicked,
      SUM(bounced) AS bounced
    FROM crm_campaign_sends WHERE campaign_id = ?
  `).get(id) as any;
  return ok(c, { campaign: camp, sends });
});

// Sequences (drip)
app.get('/sequences', (c) => {
  const tid = tenantOf(c);
  const rows = getCrmDb().prepare('SELECT * FROM crm_email_sequences WHERE tenant_id = ? ORDER BY updated_at DESC').all(tid);
  return ok(c, { sequences: rows });
});

app.post('/sequences', async (c) => {
  const tid = tenantOf(c);
  const body = await c.req.json().catch(() => ({})) as any;
  const name = String(body.name || '').trim();
  const steps = Array.isArray(body.steps) ? body.steps : [];
  if (!name || steps.length === 0) return badRequest(c, 'name + steps[] required');
  const id = 'crm_seq_' + Math.random().toString(36).slice(2, 14);
  const now = Date.now();
  getCrmDb().prepare(
    'INSERT INTO crm_email_sequences (id, tenant_id, name, segment_id, steps_json, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, tid, name, body.segmentId || null, JSON.stringify(steps), body.enabled === false ? 0 : 1, now, now);
  return ok(c, { id }, 201);
});

app.patch('/sequences/:id', async (c) => {
  const tid = tenantOf(c);
  const body = await c.req.json().catch(() => ({})) as any;
  const sets: string[] = []; const params: any[] = [];
  if (body.name !== undefined)     { sets.push('name = ?');        params.push(body.name); }
  if (body.segmentId !== undefined){ sets.push('segment_id = ?');  params.push(body.segmentId); }
  if (body.steps !== undefined)    { sets.push('steps_json = ?');  params.push(JSON.stringify(body.steps)); }
  if (body.enabled !== undefined)  { sets.push('enabled = ?');     params.push(body.enabled ? 1 : 0); }
  if (!sets.length) return badRequest(c, 'no fields');
  sets.push('updated_at = ?'); params.push(Date.now());
  params.push(c.req.param('id'), tid);
  const r = getCrmDb().prepare(`UPDATE crm_email_sequences SET ${sets.join(', ')} WHERE id = ? AND tenant_id = ?`).run(...params);
  return r.changes > 0 ? ok(c, { ok: true }) : notFound(c, 'sequence');
});

app.delete('/sequences/:id', (c) => {
  const tid = tenantOf(c);
  const r = getCrmDb().prepare('DELETE FROM crm_email_sequences WHERE id = ? AND tenant_id = ?').run(c.req.param('id'), tid);
  return r.changes > 0 ? c.body(null, 204) : notFound(c, 'sequence');
});

app.post('/sequences/:id/enroll', async (c) => {
  const tid = tenantOf(c);
  const body = await c.req.json().catch(() => ({})) as any;
  const cid = String(body.contactId || '').trim();
  if (!cid) return badRequest(c, 'contactId required');
  const enrId = em.enrollInSequence(tid, c.req.param('id'), cid);
  return enrId ? ok(c, { enrollmentId: enrId }, 201) : badRequest(c, 'enrollment failed (already enrolled or sequence disabled)');
});

// Unsubscribe management (admin-level)
app.get('/unsubscribes', (c) => {
  const tid = tenantOf(c);
  const rows = getCrmDb().prepare('SELECT email, reason, created_at FROM crm_unsubscribes WHERE tenant_id = ? ORDER BY created_at DESC').all(tid);
  return ok(c, { unsubscribes: rows });
});

app.post('/unsubscribes', async (c) => {
  const tid = tenantOf(c);
  const body = await c.req.json().catch(() => ({})) as any;
  const email = String(body.email || '').trim().toLowerCase();
  if (!email || !email.includes('@')) return badRequest(c, 'valid email required');
  try {
    getCrmDb().prepare('INSERT INTO crm_unsubscribes (tenant_id, email, reason, created_at) VALUES (?, ?, ?, ?)')
      .run(tid, email, body.reason || null, Date.now());
  } catch { /* already unsubbed */ }
  return ok(c, { ok: true });
});

app.delete('/unsubscribes/:email', (c) => {
  const tid = tenantOf(c);
  const r = getCrmDb().prepare('DELETE FROM crm_unsubscribes WHERE tenant_id = ? AND email = ?').run(tid, c.req.param('email').toLowerCase());
  return r.changes > 0 ? c.body(null, 204) : notFound(c, 'unsubscribe');
});

// ═══ FORMS / LANDING PAGES / INBOUND WEBHOOKS (Onda 18) ═══════════════
app.get('/forms', (c) => ok(c, { forms: forms.listForms(tenantOf(c)) }));

app.post('/forms', async (c) => {
  const tid = tenantOf(c);
  const body = await c.req.json().catch(() => ({})) as any;
  if (!body.name || !Array.isArray(body.fields) || typeof body.mapping !== 'object') {
    return badRequest(c, 'name, fields[], mapping required');
  }
  const f = forms.createForm(tid, body);
  return ok(c, { form: f }, 201);
});

app.get('/forms/:id', (c) => {
  const f = forms.getFormById(tenantOf(c), c.req.param('id'));
  return f ? ok(c, { form: f }) : notFound(c, 'form');
});

app.patch('/forms/:id', async (c) => {
  const tid = tenantOf(c);
  const body = await c.req.json().catch(() => ({})) as any;
  const f = forms.updateForm(tid, c.req.param('id'), body);
  return f ? ok(c, { form: f }) : notFound(c, 'form');
});

app.delete('/forms/:id', (c) => {
  return forms.deleteForm(tenantOf(c), c.req.param('id')) ? c.body(null, 204) : notFound(c, 'form');
});

app.get('/forms/:id/submissions', (c) => {
  const tid = tenantOf(c);
  const limit = Math.min(1000, Number(c.req.query('limit')) || 100);
  return ok(c, { submissions: forms.listSubmissions(tid, c.req.param('id'), limit) });
});

// Inbound webhooks
app.get('/webhooks', (c) => ok(c, { webhooks: forms.listHooks(tenantOf(c)) }));

app.post('/webhooks', async (c) => {
  const tid = tenantOf(c);
  const body = await c.req.json().catch(() => ({})) as any;
  if (!body.name || typeof body.mapping !== 'object') return badRequest(c, 'name + mapping required');
  const hook = forms.createHook(tid, body);
  return ok(c, { webhook: hook }, 201);
});

app.delete('/webhooks/:id', (c) => {
  return forms.deleteHook(tenantOf(c), c.req.param('id')) ? c.body(null, 204) : notFound(c, 'webhook');
});

app.post('/webhooks/:id/toggle', async (c) => {
  const tid = tenantOf(c);
  const body = await c.req.json().catch(() => ({})) as any;
  const ok2 = forms.toggleHook(tid, c.req.param('id'), body.enabled !== false);
  return ok2 ? ok(c, { ok: true }) : notFound(c, 'webhook');
});

// Public contact API — authenticated, simpler subset for integrations
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

// ═══ TASKS PRO (Onda 19) ═══════════════════════════════════════════════
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

// "Minhas tarefas" views
app.get('/agents/:id/tasks', (c) => {
  const tid = tenantOf(c);
  return ok(c, { tasks: tasksMod.listTasks(tid, { ...parseTaskOpts(c), agentId: c.req.param('id') }) });
});

app.get('/agents/:id/tasks/stats', (c) => {
  const tid = tenantOf(c);
  return ok(c, { stats: tasksMod.tasksStats(tid, c.req.param('id')) });
});

app.get('/cards/:id/tasks', (c) => {
  const tid = tenantOf(c);
  return ok(c, { tasks: tasksMod.listTasks(tid, { ...parseTaskOpts(c), cardId: c.req.param('id'), status: 'all' }) });
});

app.get('/contacts/:id/tasks', (c) => {
  const tid = tenantOf(c);
  return ok(c, { tasks: tasksMod.listTasks(tid, { ...parseTaskOpts(c), contactId: c.req.param('id'), status: 'all' }) });
});

// ═══ CALENDAR (Onda 20) ════════════════════════════════════════════════
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

// ICS feed URL (permission grant to sub to calendar app)
app.get('/calendar/ics-url', (c) => {
  const tid = tenantOf(c);
  const tok = cal.ensureIcsToken(tid);
  const proto = c.req.header('x-forwarded-proto') || 'https';
  const host = c.req.header('host') || 'localhost';
  return ok(c, { url: `${proto}://${host}/p/cal/${tok}.ics`, token: tok });
});

// Scheduling links (Calendly-style)
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

// Calendar integrations (Google/Outlook/CalDAV tokens)
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

// ═══ COLLABORATION (Onda 21) ══════════════════════════════════════════
// Card comments
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

// Chat rooms
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

// Contact notes
app.get('/contacts/:id/notes', (c) => {
  return ok(c, { notes: collab.listContactNotes(tenantOf(c), c.req.param('id')) });
});

app.post('/contacts/:id/notes', async (c) => {
  const tid = tenantOf(c);
  const body = await c.req.json().catch(() => ({})) as any;
  if (!body.content) return badRequest(c, 'content required');
  return ok(c, { note: collab.createContactNote(tid, { ...body, contactId: c.req.param('id') }) }, 201);
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

// Mentions inbox
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

// Unified timeline per contact
app.get('/contacts/:id/timeline', (c) => {
  const tid = tenantOf(c);
  const limit = Number(c.req.query('limit')) || 200;
  return ok(c, { timeline: collab.contactTimeline(tid, c.req.param('id'), { limit }) });
});

// ═══ SEARCH / VIEWS / BULK (Onda 22) ══════════════════════════════════
// Global full-text search
app.get('/search', (c) => {
  const tid = tenantOf(c);
  const q = c.req.query('q') || '';
  const entities = (c.req.query('entities') || 'cards,contacts,activities,notes').split(',') as any[];
  const limit = Number(c.req.query('limit')) || 25;
  return ok(c, { hits: search.globalSearch(tid, q, { entities, limit }) });
});

// Structured card/contact search
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

// Admin utility: rebuild FTS indices
app.post('/search/rebuild-fts', (c) => {
  return ok(c, { rebuilt: search.backfillFTS() });
});

// Saved views CRUD
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

// Bulk actions
app.post('/bulk/cards', async (c) => {
  const tid = tenantOf(c);
  const body = await c.req.json().catch(() => ({})) as any;
  if (!Array.isArray(body.ids) || body.ids.length === 0) return badRequest(c, 'ids[] required');
  if (!body.action) return badRequest(c, 'action required');
  return ok(c, search.bulkCardAction(tid, body));
});

app.post('/bulk/contacts', async (c) => {
  const tid = tenantOf(c);
  const body = await c.req.json().catch(() => ({})) as any;
  if (!Array.isArray(body.ids) || body.ids.length === 0) return badRequest(c, 'ids[] required');
  if (!body.action) return badRequest(c, 'action required');
  return ok(c, search.bulkContactAction(tid, body));
});

// ═══ OUTBOUND WEBHOOKS + EXTERNAL INTEGRATIONS (Onda 23) ═══════════════
// Outbound webhooks CRUD
app.get('/outbound-webhooks', (c) => ok(c, { webhooks: ohk.listOutboundWebhooks(tenantOf(c)) }));

app.post('/outbound-webhooks', async (c) => {
  const tid = tenantOf(c);
  const body = await c.req.json().catch(() => ({})) as any;
  if (!body.name || !body.url || !Array.isArray(body.events)) return badRequest(c, 'name, url, events[] required');
  return ok(c, { webhook: ohk.createOutboundWebhook(tid, body) }, 201);
});

app.get('/outbound-webhooks/:id', (c) => {
  const w = ohk.getOutboundWebhook(tenantOf(c), c.req.param('id'));
  return w ? ok(c, { webhook: w }) : notFound(c, 'webhook');
});

app.patch('/outbound-webhooks/:id', async (c) => {
  const tid = tenantOf(c);
  const body = await c.req.json().catch(() => ({})) as any;
  const w = ohk.updateOutboundWebhook(tid, c.req.param('id'), body);
  return w ? ok(c, { webhook: w }) : notFound(c, 'webhook');
});

app.delete('/outbound-webhooks/:id', (c) => {
  return ohk.deleteOutboundWebhook(tenantOf(c), c.req.param('id')) ? c.body(null, 204) : notFound(c, 'webhook');
});

app.get('/outbound-webhooks/:id/deliveries', (c) => {
  const tid = tenantOf(c);
  const limit = Number(c.req.query('limit')) || 50;
  return ok(c, { deliveries: ohk.listDeliveries(tid, c.req.param('id'), limit) });
});

app.post('/outbound-webhooks/:id/test', async (c) => {
  const tid = tenantOf(c);
  await ohk.emit(tid, 'contact.created', { test: true, contact: { id: 'test', name: 'Test' } });
  return ok(c, { ok: true, event: 'contact.created' });
});

app.get('/outbound-webhooks-stats', (c) => {
  return ok(c, ohk.deliveryStats(tenantOf(c)));
});

// External integrations
app.get('/external-integrations', (c) => ok(c, { integrations: extint.listIntegrations(tenantOf(c)) }));

app.post('/external-integrations', async (c) => {
  const tid = tenantOf(c);
  const body = await c.req.json().catch(() => ({})) as any;
  if (!body.provider || !['gmail', 'outlook', 'hubspot', 'rdstation'].includes(body.provider)) {
    return badRequest(c, 'invalid provider');
  }
  return ok(c, { integration: extint.createIntegration(tid, body) }, 201);
});

app.get('/external-integrations/:id', (c) => {
  const i = extint.getIntegration(tenantOf(c), c.req.param('id'));
  return i ? ok(c, { integration: i }) : notFound(c, 'integration');
});

app.patch('/external-integrations/:id', async (c) => {
  const tid = tenantOf(c);
  const body = await c.req.json().catch(() => ({})) as any;
  const i = extint.updateIntegration(tid, c.req.param('id'), body);
  return i ? ok(c, { integration: i }) : notFound(c, 'integration');
});

app.delete('/external-integrations/:id', (c) => {
  return extint.deleteIntegration(tenantOf(c), c.req.param('id')) ? c.body(null, 204) : notFound(c, 'integration');
});

// Trigger sync (batch import)
app.post('/external-integrations/:id/sync', async (c) => {
  const tid = tenantOf(c);
  const id = c.req.param('id');
  const integ = extint.getIntegration(tid, id);
  if (!integ) return notFound(c, 'integration');
  try {
    if (integ.provider === 'hubspot')   return ok(c, await extint.importFromHubSpot(tid, id));
    if (integ.provider === 'rdstation') return ok(c, await extint.importFromRDStation(tid, id));
    return badRequest(c, 'provider ' + integ.provider + ' sync not implemented yet');
  } catch (err: any) { return c.json({ error: 'sync_failed', message: err.message }, 502); }
});

// ═══ PWA PUSH + MOBILE COMPACT (Onda 24) ═══════════════════════════════
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

// Mobile compact endpoints
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

// ═══ AI INSIGHTS (Onda 25) ════════════════════════════════════════════
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

// Batch scoring (useful after migration or dashboard open)
app.post('/ai/batch-score', async (c) => {
  const body = await c.req.json().catch(() => ({})) as any;
  const limit = Math.min(50, Number(body.limit) || 10);
  const r = await ai.tickAutoScore(limit);
  return ok(c, r);
});

// ═══ DOCUMENTS / CONTRACTS (Onda 26) ══════════════════════════════════
// Templates
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

// Documents CRUD
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

// Repository by contact
app.get('/contacts/:id/documents', (c) => {
  const tid = tenantOf(c);
  return ok(c, { documents: docs.listDocuments(tid, { contactId: c.req.param('id') }) });
});

app.get('/cards/:id/documents', (c) => {
  const tid = tenantOf(c);
  return ok(c, { documents: docs.listDocuments(tid, { cardId: c.req.param('id') }) });
});

// ═══ GAMIFICATION (Onda 27) ═══════════════════════════════════════════
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

// Goals CRUD
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

// Badges catalog
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

// Agent badges
app.get('/agents/:id/badges', (c) => {
  return ok(c, { badges: gam.agentBadges(tenantOf(c), c.req.param('id')) });
});

app.post('/agents/:id/badges/:badgeId', async (c) => {
  const tid = tenantOf(c);
  const body = await c.req.json().catch(() => ({})) as any;
  const awarded = gam.awardBadge(tid, c.req.param('id'), c.req.param('badgeId'), body.evidence);
  return ok(c, { awarded });
});

// ═══ LGPD / COMPLIANCE (Onda 28) ══════════════════════════════════════
// Consents
app.get('/contacts/:id/consents', (c) => {
  const tid = tenantOf(c);
  return ok(c, { consents: lgpd.listContactConsents(tid, c.req.param('id')) });
});

app.post('/contacts/:id/consents', async (c) => {
  const tid = tenantOf(c);
  const body = await c.req.json().catch(() => ({})) as any;
  if (!body.channel || !body.purpose || body.granted === undefined) return badRequest(c, 'channel + purpose + granted required');
  const consent = lgpd.recordConsent(tid, {
    contactId: c.req.param('id'),
    channel: body.channel, purpose: body.purpose,
    granted: !!body.granted, source: body.source, evidence: body.evidence,
  });
  return ok(c, { consent }, 201);
});

app.get('/contacts/:id/has-consent', (c) => {
  const tid = tenantOf(c);
  const channel = c.req.query('channel') as any;
  const purpose = c.req.query('purpose') as any;
  if (!channel || !purpose) return badRequest(c, 'channel + purpose required');
  return ok(c, { granted: lgpd.hasConsent(tid, c.req.param('id'), channel, purpose) });
});

// Portability — export
app.get('/contacts/:id/portability', (c) => {
  const tid = tenantOf(c);
  const data = lgpd.exportContactData(tid, c.req.param('id'), c.req.header('x-actor-agent-id') || undefined);
  if (!data) return notFound(c, 'contact');
  const fmt = c.req.query('format');
  if (fmt === 'download') {
    return new Response(JSON.stringify(data, null, 2), {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="portability-${c.req.param('id')}.json"`,
      },
    });
  }
  return ok(c, data);
});

// Right to erasure
app.post('/contacts/:id/forget', async (c) => {
  const tid = tenantOf(c);
  const body = await c.req.json().catch(() => ({})) as any;
  const mode = body.mode === 'delete' ? 'delete' : 'anonymize';
  const result = lgpd.forgetContact(tid, c.req.param('id'), {
    mode,
    actorAgentId: c.req.header('x-actor-agent-id') || body.actorAgentId,
    reason: body.reason,
  });
  return ok(c, result);
});

// Access log
app.get('/contacts/:id/access-log', (c) => {
  const tid = tenantOf(c);
  return ok(c, { log: lgpd.queryAccessLog(tid, { contactId: c.req.param('id') }) });
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

// Retention policies
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

// Deletion requests
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

// ═══ DB ENHANCEMENTS (Onda 29) — soft delete + trash + cursor ═════════
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

// Cursor-paginated contact listing
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

// Migration history view
app.get('/system/migrations', (c) => {
  const rows = getCrmDb().prepare('SELECT * FROM crm_migration_history').all() as any[];
  return ok(c, { migrations: rows });
});

// ═══ API TIERS + BULK OPS (Onda 30) ════════════════════════════════════
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

// Bulk operations
app.post('/bulk/contacts/create', async (c) => {
  const tid = tenantOf(c);
  const body = await c.req.json().catch(() => ({})) as any;
  if (!Array.isArray(body.contacts)) return badRequest(c, 'contacts[] required');
  return ok(c, bulkOps.bulkCreateContacts(tid, body.contacts));
});

app.post('/bulk/contacts/update', async (c) => {
  const tid = tenantOf(c);
  const body = await c.req.json().catch(() => ({})) as any;
  if (!Array.isArray(body.updates)) return badRequest(c, 'updates[] required');
  return ok(c, bulkOps.bulkUpdateContacts(tid, body.updates));
});

app.post('/bulk/cards/create', async (c) => {
  const tid = tenantOf(c);
  const body = await c.req.json().catch(() => ({})) as any;
  if (!Array.isArray(body.cards)) return badRequest(c, 'cards[] required');
  return ok(c, bulkOps.bulkCreateCards(tid, body.cards));
});

app.post('/bulk/:entity/soft-delete', async (c) => {
  const tid = tenantOf(c);
  const body = await c.req.json().catch(() => ({})) as any;
  if (!Array.isArray(body.ids)) return badRequest(c, 'ids[] required');
  const entityMap: Record<string, string> = {
    cards: 'crm_cards', contacts: 'crm_contacts', activities: 'crm_activities',
    tasks: 'crm_tasks', appointments: 'crm_appointments',
  };
  const table = entityMap[c.req.param('entity')];
  if (!table) return badRequest(c, 'invalid entity');
  return ok(c, bulkOps.bulkSoftDelete(tid, table, body.ids));
});

// ═══ SECURITY (Onda 31) — RBAC + 2FA + Sessions + IP whitelist + Audit ═══
function actorOf(c: any): string | undefined {
  return c.req.header('x-actor-agent-id') || c.get?.('agentId') || undefined;
}
function ipOf(c: any): string {
  return c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.req.header('x-real-ip') || 'unknown';
}

// ─── RBAC ───────────────────────────────────────────────────────────────
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

// ─── 2FA ─────────────────────────────────────────────────────────────────
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

// ─── Sessions ───────────────────────────────────────────────────────────
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

// ─── IP whitelist ────────────────────────────────────────────────────────
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

// ─── Audit log ───────────────────────────────────────────────────────────
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

// ═══ PERFORMANCE (Onda 32) ═════════════════════════════════════════════
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

// Lazy-hydrated pipeline: uses DataLoader to batch contact fetch
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

app.post('/proposal-templates', async (c) => {
  const body = await c.req.json().catch(() => ({})) as any;
  if (!body.name || !Array.isArray(body.items)) return badRequest(c, 'name + items[] required');
  return ok(c, { template: store.createProposalTemplate(tenantOf(c), body) }, 201);
});
app.get('/proposal-templates', (c) => ok(c, { templates: store.listProposalTemplates(tenantOf(c)) }));
app.delete('/proposal-templates/:id', (c) => store.deleteProposalTemplate(tenantOf(c), c.req.param('id')) ? c.body(null, 204) : notFound(c, 'template'));

// ═══ TEAMS + AGENTS PRO + SLA ═══════════════════════════════════════════
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

// ═══ INBOX PRO: labels, quick-replies, inbox-rules ══════════════════════
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

// ═══ KANBAN PRO ═════════════════════════════════════════════════════════

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

app.post('/cards/:id/archive', (c) => {
  const r = store.archiveCard(tenantOf(c), c.req.param('id'));
  return r ? ok(c, { card: r }) : notFound(c, 'card');
});

app.post('/cards/:id/unarchive', (c) => {
  const r = store.unarchiveCard(tenantOf(c), c.req.param('id'));
  return r ? ok(c, { card: r }) : notFound(c, 'card');
});

// ─── Board settings ──────────────────────────────────────────
app.patch('/boards/:id/settings', async (c) => {
  const body = await c.req.json().catch(() => ({})) as any;
  const r = store.updateBoardSettings(tenantOf(c), c.req.param('id'), body);
  return r ? ok(c, { board: r }) : notFound(c, 'board');
});

// ─── Swimlanes ───────────────────────────────────────────────
app.post('/boards/:id/swimlanes', async (c) => {
  const body = await c.req.json().catch(() => ({})) as any;
  if (!body.name) return badRequest(c, 'name required');
  const sl = store.createSwimlane(tenantOf(c), c.req.param('id'), body);
  return sl ? ok(c, { swimlane: sl }, 201) : notFound(c, 'board');
});

app.get('/boards/:id/swimlanes', (c) => {
  return ok(c, { swimlanes: store.listSwimlanes(tenantOf(c), c.req.param('id')) });
});

app.patch('/swimlanes/:id', async (c) => {
  const body = await c.req.json().catch(() => ({})) as any;
  const sl = store.updateSwimlane(tenantOf(c), c.req.param('id'), body);
  return sl ? ok(c, { swimlane: sl }) : notFound(c, 'swimlane');
});

app.delete('/swimlanes/:id', (c) => {
  const ok2 = store.deleteSwimlane(tenantOf(c), c.req.param('id'));
  return ok2 ? c.body(null, 204) : notFound(c, 'swimlane');
});

// ─── Checklists ─────────────────────────────────────────────
app.post('/cards/:id/checklists', async (c) => {
  const body = await c.req.json().catch(() => ({})) as any;
  if (!body.title) return badRequest(c, 'title required');
  const cl = store.createChecklist(tenantOf(c), c.req.param('id'), body);
  return cl ? ok(c, { checklist: cl }, 201) : notFound(c, 'card');
});

app.get('/cards/:id/checklists', (c) => {
  return ok(c, { checklists: store.listChecklists(tenantOf(c), c.req.param('id')) });
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

// ═══ SEGMENTS ═══════════════════════════════════════════════════════════
app.post('/segments', async (c) => {
  const body = await c.req.json().catch(() => ({})) as any;
  if (!body.name || !body.filter) return badRequest(c, 'name + filter required');
  const seg = store.createSegment(tenantOf(c), body);
  return ok(c, { segment: seg }, 201);
});

app.get('/segments', (c) => ok(c, { segments: store.listSegments(tenantOf(c)) }));

app.get('/segments/:id', (c) => {
  const seg = store.getSegment(tenantOf(c), c.req.param('id'));
  return seg ? ok(c, { segment: seg }) : notFound(c, 'segment');
});

app.patch('/segments/:id', async (c) => {
  const body = await c.req.json().catch(() => ({})) as any;
  const seg = store.updateSegment(tenantOf(c), c.req.param('id'), body);
  return seg ? ok(c, { segment: seg }) : notFound(c, 'segment');
});

app.delete('/segments/:id', (c) => {
  const ok2 = store.deleteSegment(tenantOf(c), c.req.param('id'));
  return ok2 ? c.body(null, 204) : notFound(c, 'segment');
});

app.post('/segments/:id/run', (c) => {
  const tid = tenantOf(c);
  const seg = store.getSegment(tid, c.req.param('id'));
  if (!seg) return notFound(c, 'segment');
  const limit = parseInt(c.req.query('limit') || '500', 10);
  const contacts = store.runSegment(tid, seg.filter, limit);
  return ok(c, { contacts, total: contacts.length });
});

// ═══ AUTOMATIONS ═══════════════════════════════════════════════════════
app.get('/automations', (c) => {
  return ok(c, { automations: automations.listAutomations(tenantOf(c)) });
});

app.get('/automations/templates', (c) => {
  return ok(c, { templates: automations.AUTOMATION_TEMPLATES });
});

app.post('/automations', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!body.name || !body.trigger || !Array.isArray(body.actions)) {
    return badRequest(c, 'name, trigger, actions[] required');
  }
  const a = automations.createAutomation(tenantOf(c), body);
  return ok(c, { automation: a }, 201);
});

app.post('/automations/install-template', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const tpl = automations.AUTOMATION_TEMPLATES.find(t => t.key === body.key);
  if (!tpl) return badRequest(c, 'unknown template key');
  const a = automations.createAutomation(tenantOf(c), {
    name: tpl.name, trigger: tpl.trigger,
    conditions: tpl.conditions, actions: tpl.actions, enabled: true,
  });
  return ok(c, { automation: a }, 201);
});

app.patch('/automations/:id', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const upd = automations.updateAutomation(tenantOf(c), c.req.param('id'), body);
  return upd ? ok(c, { automation: upd }) : notFound(c, 'automation');
});

app.delete('/automations/:id', (c) => {
  const ok2 = automations.deleteAutomation(tenantOf(c), c.req.param('id'));
  return ok2 ? c.body(null, 204) : notFound(c, 'automation');
});


// ═══ Billing extras ════════════════════════════════════════════════════
app.post('/subscriptions/:id/mark-paid', (c) => {
  const r = markPaid(tenantOf(c), c.req.param('id'));
  return r ? ok(c, { subscription: r }) : notFound(c, 'subscription');
});

// ═══ Assignment / Agent metrics ════════════════════════════════════════
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

// ═══ Card line items (inventory ↔ deals) ═══════════════════════════════
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

// ═══ SSE real-time stream ══════════════════════════════════════════════
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


// ═══ AUTH EXCHANGE: trade System Clow session token for CRM api_key ════
// Used by the System Clow shell to open CRM in-app without asking the user
// for an API key. When user logs into System Clow (workspace), this endpoint
// gives them the CRM key for their tenant.
//
// Today: admin session token → admin tenant key
// Tomorrow (multi-tenant SaaS): tenant session token → that tenant's key
app.post('/auth/exchange', async (c) => {
  const authHeader = c.req.header('Authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return c.json({ error: 'missing_token' }, 401);

  // Try user session token first (multi-tenant SaaS)
  const userTok = (await import('../auth/authRoutes.js')).verifyUserToken(token);
  if (userTok) {
    const t = (await import('../tenancy/tenantStore.js')).getTenant(userTok.tid);
    if (!t) return c.json({ error: 'tenant_not_found' }, 404);
    const apiKey = (await import('../tenancy/tenantStore.js')).createApiKeyForTenant(t.id, 'crm-shell-' + Date.now());
    return c.json({
      api_key: apiKey,
      tenant_id: t.id,
      tenant_name: t.name,
      tenant_email: t.email,
      tier: t.tier,
    });
  }

  // Try admin session (legacy single-admin mode)
  const adm = (await import('../server/middleware/tenantAuth.js')).verifyAdminSessionToken(token);
  if (adm.ok) {
    // Map admin to admin@clow.dev tenant (the one with assets + active subs)
    const tenants = (await import('../tenancy/tenantStore.js')).listTenants();
    const tenant = tenants.find(t => t.email === 'admin@clow.dev') || tenants[0];
    if (!tenant) return c.json({ error: 'no_tenant' }, 404);
    // Find or create a CRM key for this tenant
    const keys = (await import('../tenancy/tenantStore.js')).listApiKeysForTenant(tenant.id);
    let apiKey: string;
    const existing = keys.find(k => k.name && k.name.startsWith('crm-shell-'));
    if (existing) {
      // We dont store raw keys, so always create a fresh shell key per session
      // (cheap; old ones stay valid until rotated)
      apiKey = (await import('../tenancy/tenantStore.js')).createApiKeyForTenant(tenant.id, 'crm-shell-' + Date.now());
    } else {
      apiKey = (await import('../tenancy/tenantStore.js')).createApiKeyForTenant(tenant.id, 'crm-shell-' + Date.now());
    }
    return c.json({
      api_key: apiKey,
      tenant_id: tenant.id,
      tenant_name: tenant.name,
      tenant_email: tenant.email,
      tier: tenant.tier,
    });
  }

  // Try tenant API key (if user logs in with their key directly)
  const hash = (await import('../tenancy/tenantStore.js')).hashApiKey(token);
  const tenant = (await import('../tenancy/tenantStore.js')).findTenantByApiKeyHash(hash);
  if (tenant) {
    return c.json({
      api_key: token,
      tenant_id: tenant.id,
      tenant_name: tenant.name,
      tenant_email: tenant.email,
      tier: tenant.tier,
    });
  }

  return c.json({ error: 'invalid_token' }, 401);
});

export default app;
