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


export default app;
