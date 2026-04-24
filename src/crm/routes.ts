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
import { subscribe, formatSseFrame } from './events.js';
import { findTenantByApiKeyHash, hashApiKey } from '../tenancy/tenantStore.js';
import { readMedia } from './media.js';
import type { BoardType, ChannelType, BillingCycle, AgentRole } from './types.js';

const app = new Hono();

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
  const cards = store.listCardsByBoard(tid, boardId);
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
