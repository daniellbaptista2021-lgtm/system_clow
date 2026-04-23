/**
 * CRM store — Data access layer.
 *
 * All functions require `tenantId`. Never expose raw db to routes.
 * Consistent ID format: `crm_${entity}_${uuid}` (debuggable).
 */

import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import { getCrmDb } from './schema.js';
import type {
  Board, BoardColumn, Contact, Card, Activity, Agent, Channel2,
  Subscription, Automation, InventoryItem, BoardType, ActivityType,
  Channel, MediaType, ChannelType, ChannelStatus, BillingCycle, SubscriptionStatus, AgentRole,
} from './types.js';

const now = () => Date.now();
// Lazy-loaded automation emitter (avoids circular import: automations -> store)
let _emit: ((ev: any) => Promise<void>) | null = null;

let _autoAssign: ((tid: string, cid: string) => boolean) | null = null;
async function getAutoAssign() {
  if (!_autoAssign) {
    try { _autoAssign = (await import('./assignment.js')).maybeAutoAssign; }
    catch { _autoAssign = () => false; }
  }
  return _autoAssign;
}
let _commitStock: ((tid: string, cid: string) => void) | null = null;
async function getCommitStock() {
  if (!_commitStock) {
    try { _commitStock = (await import('./lineItems.js')).commitStockForWonCard; }
    catch { _commitStock = () => {}; }
  }
  return _commitStock;
}
let _publishEvent: ((tid: string, ev: string, data: any) => void) | null = null;
async function getPublish() {
  if (!_publishEvent) {
    try { _publishEvent = (await import('./events.js')).publish; }
    catch { _publishEvent = () => {}; }
  }
  return _publishEvent;
}

async function getEmit() {
  if (!_emit) {
    try {
      const mod = await import('./automations.js');
      _emit = mod.emit;
    } catch { _emit = async () => {}; }
  }
  return _emit;
}

const nid = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

// ─── Serialization helpers ──────────────────────────────────────────────
const J = {
  parse: (s: string | null | undefined, def: any): any => {
    if (!s) return def;
    try { return JSON.parse(s); } catch { return def; }
  },
  stringify: (v: unknown): string => JSON.stringify(v ?? null),
};

// ═══ BOARDS ═════════════════════════════════════════════════════════════
export function createBoard(tenantId: string, input: {
  name: string; type?: BoardType; description?: string;
}): Board {
  const db = getCrmDb();
  const board: Board = {
    id: nid('crm_board'),
    tenantId,
    name: input.name,
    type: input.type ?? 'sales',
    description: input.description,
    position: getNextBoardPosition(db, tenantId),
    createdAt: now(),
    updatedAt: now(),
  };
  db.prepare(`
    INSERT INTO crm_boards (id, tenant_id, name, type, description, position, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(board.id, board.tenantId, board.name, board.type, board.description ?? null,
    board.position, board.createdAt, board.updatedAt);
  return board;
}

function getNextBoardPosition(db: Database.Database, tenantId: string): number {
  const r = db.prepare('SELECT COALESCE(MAX(position), -1) as m FROM crm_boards WHERE tenant_id = ?')
    .get(tenantId) as { m: number };
  return r.m + 1;
}

export function listBoards(tenantId: string): Board[] {
  const db = getCrmDb();
  const rows = db.prepare(`
    SELECT * FROM crm_boards WHERE tenant_id = ? ORDER BY position ASC, created_at ASC
  `).all(tenantId) as any[];
  return rows.map(rowToBoard);
}

export function getBoard(tenantId: string, boardId: string): Board | null {
  const db = getCrmDb();
  const r = db.prepare('SELECT * FROM crm_boards WHERE id = ? AND tenant_id = ?').get(boardId, tenantId) as any;
  return r ? rowToBoard(r) : null;
}

export function updateBoard(tenantId: string, boardId: string, patch: Partial<Pick<Board, 'name' | 'description' | 'type' | 'position'>>): Board | null {
  const db = getCrmDb();
  const existing = getBoard(tenantId, boardId);
  if (!existing) return null;
  const upd = { ...existing, ...patch, updatedAt: now() };
  db.prepare(`
    UPDATE crm_boards SET name = ?, description = ?, type = ?, position = ?, updated_at = ?
    WHERE id = ? AND tenant_id = ?
  `).run(upd.name, upd.description ?? null, upd.type, upd.position, upd.updatedAt, boardId, tenantId);
  return upd;
}

export function deleteBoard(tenantId: string, boardId: string): boolean {
  const db = getCrmDb();
  const r = db.prepare('DELETE FROM crm_boards WHERE id = ? AND tenant_id = ?').run(boardId, tenantId);
  return r.changes > 0;
}

function rowToBoard(r: any): Board {
  return {
    id: r.id, tenantId: r.tenant_id, name: r.name, type: r.type as BoardType,
    description: r.description ?? undefined, position: r.position,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

// ═══ COLUMNS ════════════════════════════════════════════════════════════
export function createColumn(tenantId: string, input: {
  boardId: string; name: string; color?: string; isTerminal?: boolean;
  autoRule?: { trigger: string; action: string; params?: Record<string, unknown> };
}): BoardColumn | null {
  const db = getCrmDb();
  if (!getBoard(tenantId, input.boardId)) return null;
  const col: BoardColumn = {
    id: nid('crm_col'),
    boardId: input.boardId,
    name: input.name,
    position: getNextColumnPosition(db, input.boardId),
    color: input.color ?? '#9B59FC',
    autoRule: input.autoRule ?? null,
    isTerminal: input.isTerminal ?? false,
    createdAt: now(),
  };
  db.prepare(`
    INSERT INTO crm_columns (id, board_id, name, position, color, auto_rule_json, is_terminal, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(col.id, col.boardId, col.name, col.position, col.color,
    col.autoRule ? J.stringify(col.autoRule) : null, col.isTerminal ? 1 : 0, col.createdAt);
  return col;
}

function getNextColumnPosition(db: Database.Database, boardId: string): number {
  const r = db.prepare('SELECT COALESCE(MAX(position), -1) as m FROM crm_columns WHERE board_id = ?')
    .get(boardId) as { m: number };
  return r.m + 1;
}

export function listColumns(tenantId: string, boardId: string): BoardColumn[] {
  const db = getCrmDb();
  if (!getBoard(tenantId, boardId)) return [];
  const rows = db.prepare(`
    SELECT * FROM crm_columns WHERE board_id = ? ORDER BY position ASC, created_at ASC
  `).all(boardId) as any[];
  return rows.map(rowToColumn);
}

export function updateColumn(tenantId: string, columnId: string, patch: Partial<Pick<BoardColumn, 'name' | 'color' | 'position' | 'isTerminal'>>): BoardColumn | null {
  const db = getCrmDb();
  const r = db.prepare(`
    SELECT c.* FROM crm_columns c
    JOIN crm_boards b ON b.id = c.board_id
    WHERE c.id = ? AND b.tenant_id = ?
  `).get(columnId, tenantId) as any;
  if (!r) return null;
  const upd: BoardColumn = { ...rowToColumn(r), ...patch };
  db.prepare(`UPDATE crm_columns SET name = ?, color = ?, position = ?, is_terminal = ? WHERE id = ?`)
    .run(upd.name, upd.color, upd.position, upd.isTerminal ? 1 : 0, columnId);
  return upd;
}

export function deleteColumn(tenantId: string, columnId: string): boolean {
  const db = getCrmDb();
  const r = db.prepare(`
    DELETE FROM crm_columns WHERE id = ? AND board_id IN (SELECT id FROM crm_boards WHERE tenant_id = ?)
  `).run(columnId, tenantId);
  return r.changes > 0;
}

function rowToColumn(r: any): BoardColumn {
  return {
    id: r.id, boardId: r.board_id, name: r.name, position: r.position, color: r.color,
    autoRule: J.parse(r.auto_rule_json, null),
    isTerminal: r.is_terminal === 1, createdAt: r.created_at,
  };
}

// ═══ CONTACTS ═══════════════════════════════════════════════════════════
export function createContact(tenantId: string, input: {
  name: string; phone?: string; email?: string; avatarUrl?: string;
  tags?: string[]; customFields?: Record<string, unknown>; notes?: string; source?: string;
}): Contact {
  const db = getCrmDb();
  const c: Contact = {
    id: nid('crm_contact'),
    tenantId,
    name: input.name,
    phone: input.phone,
    email: input.email,
    avatarUrl: input.avatarUrl,
    tags: input.tags ?? [],
    customFields: input.customFields ?? {},
    notes: input.notes,
    source: input.source,
    createdAt: now(),
    updatedAt: now(),
  };
  db.prepare(`
    INSERT INTO crm_contacts (id, tenant_id, name, phone, email, avatar_url, tags_json, custom_fields_json, notes, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(c.id, c.tenantId, c.name, c.phone ?? null, c.email ?? null, c.avatarUrl ?? null,
    J.stringify(c.tags), J.stringify(c.customFields), c.notes ?? null, c.source ?? null, c.createdAt, c.updatedAt);
  return c;
}

export function findContactByPhone(tenantId: string, phone: string): Contact | null {
  const db = getCrmDb();
  const cleaned = phone.replace(/\D/g, '');
  // Try exact + last 10 digits (Brazil phone variants w/ or w/o country code)
  const r = db.prepare(`
    SELECT * FROM crm_contacts WHERE tenant_id = ? AND (phone = ? OR phone = ? OR phone LIKE ?)
    LIMIT 1
  `).get(tenantId, phone, cleaned, `%${cleaned.slice(-10)}`) as any;
  return r ? rowToContact(r) : null;
}

export function findContactByEmail(tenantId: string, email: string): Contact | null {
  const db = getCrmDb();
  const r = db.prepare('SELECT * FROM crm_contacts WHERE tenant_id = ? AND LOWER(email) = LOWER(?)')
    .get(tenantId, email) as any;
  return r ? rowToContact(r) : null;
}

export function getContact(tenantId: string, contactId: string): Contact | null {
  const db = getCrmDb();
  const r = db.prepare('SELECT * FROM crm_contacts WHERE id = ? AND tenant_id = ?').get(contactId, tenantId) as any;
  return r ? rowToContact(r) : null;
}

export function searchContacts(tenantId: string, query: string, limit = 25): Contact[] {
  const db = getCrmDb();
  const q = `%${query.toLowerCase()}%`;
  const rows = db.prepare(`
    SELECT * FROM crm_contacts
    WHERE tenant_id = ? AND (LOWER(name) LIKE ? OR LOWER(email) LIKE ? OR phone LIKE ?)
    ORDER BY updated_at DESC LIMIT ?
  `).all(tenantId, q, q, `%${query.replace(/\D/g, '')}%`, limit) as any[];
  return rows.map(rowToContact);
}

export function listContacts(tenantId: string, opts: { limit?: number; offset?: number; tag?: string } = {}): Contact[] {
  const db = getCrmDb();
  const limit = Math.min(opts.limit ?? 50, 500);
  const offset = opts.offset ?? 0;
  const rows = opts.tag
    ? db.prepare(`
        SELECT * FROM crm_contacts WHERE tenant_id = ? AND tags_json LIKE ?
        ORDER BY updated_at DESC LIMIT ? OFFSET ?
      `).all(tenantId, `%"${opts.tag}"%`, limit, offset) as any[]
    : db.prepare(`
        SELECT * FROM crm_contacts WHERE tenant_id = ?
        ORDER BY updated_at DESC LIMIT ? OFFSET ?
      `).all(tenantId, limit, offset) as any[];
  return rows.map(rowToContact);
}

export function updateContact(tenantId: string, contactId: string, patch: Partial<Omit<Contact, 'id' | 'tenantId' | 'createdAt'>>): Contact | null {
  const db = getCrmDb();
  const existing = getContact(tenantId, contactId);
  if (!existing) return null;
  const upd: Contact = { ...existing, ...patch, updatedAt: now() };
  db.prepare(`
    UPDATE crm_contacts SET name = ?, phone = ?, email = ?, avatar_url = ?,
      tags_json = ?, custom_fields_json = ?, notes = ?, source = ?,
      updated_at = ?, last_interaction_at = ?
    WHERE id = ? AND tenant_id = ?
  `).run(upd.name, upd.phone ?? null, upd.email ?? null, upd.avatarUrl ?? null,
    J.stringify(upd.tags), J.stringify(upd.customFields), upd.notes ?? null, upd.source ?? null,
    upd.updatedAt, upd.lastInteractionAt ?? null, contactId, tenantId);
  return upd;
}

export function deleteContact(tenantId: string, contactId: string): boolean {
  const db = getCrmDb();
  const r = db.prepare('DELETE FROM crm_contacts WHERE id = ? AND tenant_id = ?').run(contactId, tenantId);
  return r.changes > 0;
}

/** Get-or-create — used by WhatsApp webhooks to upsert incoming contacts. */
export function upsertContactByPhone(tenantId: string, phone: string, input: {
  name?: string; avatarUrl?: string; source?: string;
}): Contact {
  const existing = findContactByPhone(tenantId, phone);
  if (existing) {
    if ((input.name && input.name !== existing.name) || input.avatarUrl) {
      return updateContact(tenantId, existing.id, {
        name: input.name ?? existing.name,
        avatarUrl: input.avatarUrl ?? existing.avatarUrl,
        lastInteractionAt: now(),
      }) ?? existing;
    }
    updateContact(tenantId, existing.id, { lastInteractionAt: now() });
    return existing;
  }
  return createContact(tenantId, {
    name: input.name ?? phone,
    phone,
    avatarUrl: input.avatarUrl,
    source: input.source ?? 'whatsapp',
  });
}

function rowToContact(r: any): Contact {
  return {
    id: r.id, tenantId: r.tenant_id, name: r.name,
    phone: r.phone ?? undefined, email: r.email ?? undefined, avatarUrl: r.avatar_url ?? undefined,
    tags: J.parse(r.tags_json, []),
    customFields: J.parse(r.custom_fields_json, {}),
    notes: r.notes ?? undefined, source: r.source ?? undefined,
    createdAt: r.created_at, updatedAt: r.updated_at,
    lastInteractionAt: r.last_interaction_at ?? undefined,
  };
}

// ═══ CARDS ══════════════════════════════════════════════════════════════
export function createCard(tenantId: string, input: {
  boardId: string; columnId: string; title: string; description?: string;
  contactId?: string; ownerAgentId?: string; valueCents?: number; probability?: number;
  labels?: string[]; dueDate?: number; customFields?: Record<string, unknown>;
}): Card | null {
  const db = getCrmDb();
  if (!getBoard(tenantId, input.boardId)) return null;
  const card: Card = {
    id: nid('crm_card'),
    tenantId,
    boardId: input.boardId,
    columnId: input.columnId,
    title: input.title,
    description: input.description,
    contactId: input.contactId,
    ownerAgentId: input.ownerAgentId,
    valueCents: input.valueCents ?? 0,
    probability: input.probability ?? 0,
    labels: input.labels ?? [],
    dueDate: input.dueDate,
    position: getNextCardPosition(db, input.columnId),
    customFields: input.customFields ?? {},
    createdAt: now(),
    updatedAt: now(),
  };
  db.prepare(`
    INSERT INTO crm_cards (id, tenant_id, board_id, column_id, title, description, contact_id, owner_agent_id,
      value_cents, probability, labels_json, due_date, position, custom_fields_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(card.id, card.tenantId, card.boardId, card.columnId, card.title, card.description ?? null,
    card.contactId ?? null, card.ownerAgentId ?? null, card.valueCents, card.probability,
    J.stringify(card.labels), card.dueDate ?? null, card.position, J.stringify(card.customFields),
    card.createdAt, card.updatedAt);
  logActivity(tenantId, { cardId: card.id, contactId: card.contactId, type: 'system', channel: 'manual',
    content: `Card criado na coluna ${card.columnId}` });
  void (async () => { (await getEmit())({ trigger: 'card_created', tenantId, cardId: card.id, contactId: card.contactId }); (await getAutoAssign())(tenantId, card.id); (await getPublish())(tenantId, 'card', { action: 'created', cardId: card.id }); })();
  return card;
}

function getNextCardPosition(db: Database.Database, columnId: string): number {
  const r = db.prepare('SELECT COALESCE(MAX(position), -1) as m FROM crm_cards WHERE column_id = ?')
    .get(columnId) as { m: number };
  return r.m + 1;
}

export function getCard(tenantId: string, cardId: string): Card | null {
  const db = getCrmDb();
  const r = db.prepare('SELECT * FROM crm_cards WHERE id = ? AND tenant_id = ?').get(cardId, tenantId) as any;
  return r ? rowToCard(r) : null;
}

export function listCardsByColumn(tenantId: string, columnId: string): Card[] {
  const db = getCrmDb();
  const rows = db.prepare(`
    SELECT * FROM crm_cards WHERE tenant_id = ? AND column_id = ? ORDER BY position ASC, created_at ASC
  `).all(tenantId, columnId) as any[];
  return rows.map(rowToCard);
}

export function listCardsByBoard(tenantId: string, boardId: string): Card[] {
  const db = getCrmDb();
  const rows = db.prepare(`
    SELECT * FROM crm_cards WHERE tenant_id = ? AND board_id = ? ORDER BY column_id, position ASC
  `).all(tenantId, boardId) as any[];
  return rows.map(rowToCard);
}

export function listCardsByContact(tenantId: string, contactId: string): Card[] {
  const db = getCrmDb();
  const rows = db.prepare(`
    SELECT * FROM crm_cards WHERE tenant_id = ? AND contact_id = ? ORDER BY updated_at DESC
  `).all(tenantId, contactId) as any[];
  return rows.map(rowToCard);
}

export function updateCard(tenantId: string, cardId: string, patch: Partial<Omit<Card, 'id' | 'tenantId' | 'createdAt'>>): Card | null {
  const db = getCrmDb();
  const existing = getCard(tenantId, cardId);
  if (!existing) return null;
  const upd: Card = { ...existing, ...patch, updatedAt: now() };
  db.prepare(`
    UPDATE crm_cards SET board_id = ?, column_id = ?, title = ?, description = ?, contact_id = ?,
      owner_agent_id = ?, value_cents = ?, probability = ?, labels_json = ?, due_date = ?,
      position = ?, custom_fields_json = ?, updated_at = ?, last_activity_at = ?
    WHERE id = ? AND tenant_id = ?
  `).run(upd.boardId, upd.columnId, upd.title, upd.description ?? null, upd.contactId ?? null,
    upd.ownerAgentId ?? null, upd.valueCents, upd.probability, J.stringify(upd.labels), upd.dueDate ?? null,
    upd.position, J.stringify(upd.customFields), upd.updatedAt, upd.lastActivityAt ?? null, cardId, tenantId);
  return upd;
}

/** Move a card to a different column (optionally re-position). Logs a stage_change activity. */
export function moveCard(tenantId: string, cardId: string, toColumnId: string, position?: number): Card | null {
  const db = getCrmDb();
  const existing = getCard(tenantId, cardId);
  if (!existing) return null;
  const pos = position ?? getNextCardPosition(db, toColumnId);
  const moved = updateCard(tenantId, cardId, { columnId: toColumnId, position: pos });
  if (moved && moved.columnId !== existing.columnId) {
    logActivity(tenantId, {
      cardId, contactId: existing.contactId, type: 'stage_change', channel: 'manual',
      content: `Movido de ${existing.columnId} para ${toColumnId}`,
    });
    void (async () => { (await getEmit())({ trigger: 'card_moved', tenantId, cardId, contactId: existing.contactId, fromColumnId: existing.columnId, toColumnId }); const cols2 = listColumns(tenantId, existing.boardId); const tgt = cols2.find(c => c.id === toColumnId); if (tgt?.isTerminal && /ganho|won/i.test(tgt.name)) { (await getCommitStock())(tenantId, cardId); } (await getPublish())(tenantId, 'card', { action: 'moved', cardId, toColumnId }); })();
  }
  return moved;
}

export function deleteCard(tenantId: string, cardId: string): boolean {
  const db = getCrmDb();
  const r = db.prepare('DELETE FROM crm_cards WHERE id = ? AND tenant_id = ?').run(cardId, tenantId);
  return r.changes > 0;
}

function rowToCard(r: any): Card {
  return {
    id: r.id, tenantId: r.tenant_id, boardId: r.board_id, columnId: r.column_id,
    title: r.title, description: r.description ?? undefined,
    contactId: r.contact_id ?? undefined, ownerAgentId: r.owner_agent_id ?? undefined,
    valueCents: r.value_cents, probability: r.probability,
    labels: J.parse(r.labels_json, []),
    dueDate: r.due_date ?? undefined, position: r.position,
    customFields: J.parse(r.custom_fields_json, {}),
    createdAt: r.created_at, updatedAt: r.updated_at,
    lastActivityAt: r.last_activity_at ?? undefined,
  };
}

// ═══ ACTIVITIES (timeline) ══════════════════════════════════════════════
export function logActivity(tenantId: string, input: {
  cardId?: string; contactId?: string; type: ActivityType; channel: Channel;
  direction?: 'in' | 'out'; content: string; mediaUrl?: string; mediaType?: MediaType;
  providerMessageId?: string; createdByAgentId?: string; metadata?: Record<string, unknown>;
}): Activity {
  const db = getCrmDb();
  const a: Activity = {
    id: nid('crm_act'),
    tenantId,
    cardId: input.cardId,
    contactId: input.contactId,
    type: input.type,
    channel: input.channel,
    direction: input.direction,
    content: input.content,
    mediaUrl: input.mediaUrl,
    mediaType: input.mediaType,
    providerMessageId: input.providerMessageId,
    createdByAgentId: input.createdByAgentId,
    metadata: input.metadata,
    createdAt: now(),
  };
  db.prepare(`
    INSERT INTO crm_activities (id, tenant_id, card_id, contact_id, type, channel, direction,
      content, media_url, media_type, provider_message_id, created_by_agent_id, metadata_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(a.id, a.tenantId, a.cardId ?? null, a.contactId ?? null, a.type, a.channel, a.direction ?? null,
    a.content, a.mediaUrl ?? null, a.mediaType ?? null, a.providerMessageId ?? null,
    a.createdByAgentId ?? null, a.metadata ? J.stringify(a.metadata) : null, a.createdAt);

  // Touch parent entities for sort-by-recent
  if (a.cardId) {
    db.prepare('UPDATE crm_cards SET last_activity_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ?')
      .run(a.createdAt, a.createdAt, a.cardId, tenantId);
  }
  if (a.contactId) {
    db.prepare('UPDATE crm_contacts SET last_interaction_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ?')
      .run(a.createdAt, a.createdAt, a.contactId, tenantId);
  }
  void (async () => { (await getPublish())(tenantId, 'activity', { activityId: a.id, cardId: a.cardId, contactId: a.contactId, type: a.type }); })();
  return a;
}

export function listActivitiesByCard(tenantId: string, cardId: string, limit = 100): Activity[] {
  const db = getCrmDb();
  const rows = db.prepare(`
    SELECT * FROM crm_activities WHERE tenant_id = ? AND card_id = ?
    ORDER BY created_at ASC LIMIT ?
  `).all(tenantId, cardId, limit) as any[];
  return rows.map(rowToActivity);
}

export function listActivitiesByContact(tenantId: string, contactId: string, limit = 100): Activity[] {
  const db = getCrmDb();
  const rows = db.prepare(`
    SELECT * FROM crm_activities WHERE tenant_id = ? AND contact_id = ?
    ORDER BY created_at ASC LIMIT ?
  `).all(tenantId, contactId, limit) as any[];
  return rows.map(rowToActivity);
}

function rowToActivity(r: any): Activity {
  return {
    id: r.id, tenantId: r.tenant_id, cardId: r.card_id ?? undefined, contactId: r.contact_id ?? undefined,
    type: r.type as ActivityType, channel: r.channel as Channel,
    direction: r.direction ?? undefined, content: r.content,
    mediaUrl: r.media_url ?? undefined, mediaType: r.media_type as MediaType ?? undefined,
    providerMessageId: r.provider_message_id ?? undefined,
    createdByAgentId: r.created_by_agent_id ?? undefined,
    metadata: J.parse(r.metadata_json, undefined),
    createdAt: r.created_at,
  };
}

// ═══ AGENTS ═════════════════════════════════════════════════════════════
export function createAgent(tenantId: string, input: {
  name: string; email: string; phone?: string; role?: AgentRole; apiKeyHash?: string;
}): Agent {
  const db = getCrmDb();
  const a: Agent = {
    id: nid('crm_agent'),
    tenantId, name: input.name, email: input.email.toLowerCase(),
    phone: input.phone, role: input.role ?? 'agent', active: true,
    apiKeyHash: input.apiKeyHash, createdAt: now(),
  };
  db.prepare(`
    INSERT INTO crm_agents (id, tenant_id, name, email, phone, role, active, api_key_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(a.id, a.tenantId, a.name, a.email, a.phone ?? null, a.role, a.apiKeyHash ?? null, a.createdAt);
  return a;
}

export function listAgents(tenantId: string): Agent[] {
  const db = getCrmDb();
  const rows = db.prepare('SELECT * FROM crm_agents WHERE tenant_id = ? ORDER BY created_at ASC').all(tenantId) as any[];
  return rows.map(rowToAgent);
}

export function getAgent(tenantId: string, agentId: string): Agent | null {
  const db = getCrmDb();
  const r = db.prepare('SELECT * FROM crm_agents WHERE id = ? AND tenant_id = ?').get(agentId, tenantId) as any;
  return r ? rowToAgent(r) : null;
}

export function updateAgent(tenantId: string, agentId: string, patch: Partial<Omit<Agent, 'id' | 'tenantId' | 'createdAt'>>): Agent | null {
  const db = getCrmDb();
  const existing = getAgent(tenantId, agentId);
  if (!existing) return null;
  const upd = { ...existing, ...patch };
  db.prepare(`
    UPDATE crm_agents SET name = ?, email = ?, phone = ?, role = ?, active = ?, api_key_hash = ?
    WHERE id = ? AND tenant_id = ?
  `).run(upd.name, upd.email.toLowerCase(), upd.phone ?? null, upd.role, upd.active ? 1 : 0,
    upd.apiKeyHash ?? null, agentId, tenantId);
  return upd;
}

export function deleteAgent(tenantId: string, agentId: string): boolean {
  const db = getCrmDb();
  const r = db.prepare('DELETE FROM crm_agents WHERE id = ? AND tenant_id = ?').run(agentId, tenantId);
  return r.changes > 0;
}

function rowToAgent(r: any): Agent {
  return {
    id: r.id, tenantId: r.tenant_id, name: r.name, email: r.email,
    phone: r.phone ?? undefined, role: r.role as AgentRole, active: r.active === 1,
    apiKeyHash: r.api_key_hash ?? undefined, createdAt: r.created_at,
  };
}

// ═══ CHANNELS (Meta / Z-API) ════════════════════════════════════════════
export function createChannel(tenantId: string, input: {
  type: ChannelType; name: string; credentialsEncrypted: string;
  phoneNumber?: string; phoneNumberId?: string; webhookSecret?: string;
  status?: ChannelStatus;
}): Channel2 {
  const db = getCrmDb();
  const ch: Channel2 = {
    id: nid('crm_ch'), tenantId, type: input.type, name: input.name,
    status: input.status ?? 'pending', credentialsEncrypted: input.credentialsEncrypted,
    phoneNumber: input.phoneNumber, phoneNumberId: input.phoneNumberId,
    webhookSecret: input.webhookSecret ?? randomUUID().replace(/-/g, ''),
    createdAt: now(),
  };
  db.prepare(`
    INSERT INTO crm_channels (id, tenant_id, type, name, status, credentials_encrypted,
      phone_number, phone_number_id, webhook_secret, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(ch.id, ch.tenantId, ch.type, ch.name, ch.status, ch.credentialsEncrypted,
    ch.phoneNumber ?? null, ch.phoneNumberId ?? null, ch.webhookSecret, ch.createdAt);
  return ch;
}

export function listChannels(tenantId: string): Channel2[] {
  const db = getCrmDb();
  const rows = db.prepare('SELECT * FROM crm_channels WHERE tenant_id = ? ORDER BY created_at ASC').all(tenantId) as any[];
  return rows.map(rowToChannel);
}

export function getChannel(tenantId: string, channelId: string): Channel2 | null {
  const db = getCrmDb();
  const r = db.prepare('SELECT * FROM crm_channels WHERE id = ? AND tenant_id = ?').get(channelId, tenantId) as any;
  return r ? rowToChannel(r) : null;
}

export function findChannelByWebhookSecret(secret: string): Channel2 | null {
  const db = getCrmDb();
  const r = db.prepare('SELECT * FROM crm_channels WHERE webhook_secret = ?').get(secret) as any;
  return r ? rowToChannel(r) : null;
}

export function findChannelByPhoneId(phoneNumberId: string): Channel2 | null {
  const db = getCrmDb();
  const r = db.prepare('SELECT * FROM crm_channels WHERE phone_number_id = ?').get(phoneNumberId) as any;
  return r ? rowToChannel(r) : null;
}

export function updateChannel(tenantId: string, channelId: string, patch: Partial<Omit<Channel2, 'id' | 'tenantId' | 'createdAt'>>): Channel2 | null {
  const db = getCrmDb();
  const existing = getChannel(tenantId, channelId);
  if (!existing) return null;
  const upd = { ...existing, ...patch };
  db.prepare(`
    UPDATE crm_channels SET name = ?, status = ?, credentials_encrypted = ?,
      phone_number = ?, phone_number_id = ?, webhook_secret = ?, last_inbound_at = ?
    WHERE id = ? AND tenant_id = ?
  `).run(upd.name, upd.status, upd.credentialsEncrypted, upd.phoneNumber ?? null,
    upd.phoneNumberId ?? null, upd.webhookSecret ?? null, upd.lastInboundAt ?? null, channelId, tenantId);
  return upd;
}

export function deleteChannel(tenantId: string, channelId: string): boolean {
  const db = getCrmDb();
  const r = db.prepare('DELETE FROM crm_channels WHERE id = ? AND tenant_id = ?').run(channelId, tenantId);
  return r.changes > 0;
}

function rowToChannel(r: any): Channel2 {
  return {
    id: r.id, tenantId: r.tenant_id, type: r.type as ChannelType, name: r.name,
    status: r.status as ChannelStatus, credentialsEncrypted: r.credentials_encrypted,
    phoneNumber: r.phone_number ?? undefined, phoneNumberId: r.phone_number_id ?? undefined,
    webhookSecret: r.webhook_secret ?? undefined, lastInboundAt: r.last_inbound_at ?? undefined,
    createdAt: r.created_at,
  };
}

// ═══ SUBSCRIPTIONS (cobrança recorrente) ════════════════════════════════
export function createSubscription(tenantId: string, input: {
  contactId: string; cardId?: string; planName: string; amountCents: number;
  cycle: BillingCycle; nextChargeAt: number;
}): Subscription {
  const db = getCrmDb();
  const s: Subscription = {
    id: nid('crm_sub'), tenantId, contactId: input.contactId, cardId: input.cardId,
    planName: input.planName, amountCents: input.amountCents, cycle: input.cycle,
    nextChargeAt: input.nextChargeAt, status: 'active', remindersSent: 0, createdAt: now(),
  };
  db.prepare(`
    INSERT INTO crm_subscriptions (id, tenant_id, contact_id, card_id, plan_name, amount_cents,
      cycle, next_charge_at, status, reminders_sent, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, ?)
  `).run(s.id, s.tenantId, s.contactId, s.cardId ?? null, s.planName, s.amountCents,
    s.cycle, s.nextChargeAt, s.createdAt);
  return s;
}

export function listSubscriptions(tenantId: string, status?: SubscriptionStatus): Subscription[] {
  const db = getCrmDb();
  const rows = status
    ? db.prepare('SELECT * FROM crm_subscriptions WHERE tenant_id = ? AND status = ? ORDER BY next_charge_at ASC').all(tenantId, status) as any[]
    : db.prepare('SELECT * FROM crm_subscriptions WHERE tenant_id = ? ORDER BY next_charge_at ASC').all(tenantId) as any[];
  return rows.map(rowToSubscription);
}

export function listSubscriptionsDue(beforeTs: number = now()): Subscription[] {
  const db = getCrmDb();
  const rows = db.prepare(`
    SELECT * FROM crm_subscriptions WHERE status = 'active' AND next_charge_at <= ?
    ORDER BY next_charge_at ASC
  `).all(beforeTs) as any[];
  return rows.map(rowToSubscription);
}

export function updateSubscription(tenantId: string, subId: string, patch: Partial<Omit<Subscription, 'id' | 'tenantId' | 'createdAt'>>): Subscription | null {
  const db = getCrmDb();
  const r = db.prepare('SELECT * FROM crm_subscriptions WHERE id = ? AND tenant_id = ?').get(subId, tenantId) as any;
  if (!r) return null;
  const existing = rowToSubscription(r);
  const upd = { ...existing, ...patch };
  db.prepare(`
    UPDATE crm_subscriptions SET plan_name = ?, amount_cents = ?, cycle = ?, next_charge_at = ?,
      status = ?, reminders_sent = ?, cancelled_at = ?
    WHERE id = ? AND tenant_id = ?
  `).run(upd.planName, upd.amountCents, upd.cycle, upd.nextChargeAt, upd.status,
    upd.remindersSent, upd.cancelledAt ?? null, subId, tenantId);
  return upd;
}

function rowToSubscription(r: any): Subscription {
  return {
    id: r.id, tenantId: r.tenant_id, contactId: r.contact_id, cardId: r.card_id ?? undefined,
    planName: r.plan_name, amountCents: r.amount_cents, cycle: r.cycle as BillingCycle,
    nextChargeAt: r.next_charge_at, status: r.status as SubscriptionStatus,
    remindersSent: r.reminders_sent, createdAt: r.created_at, cancelledAt: r.cancelled_at ?? undefined,
  };
}

// ═══ REMINDERS ══════════════════════════════════════════════════════════
export function createReminder(tenantId: string, input: {
  cardId?: string; contactId?: string; content: string; dueAt: number; createdByAgentId?: string;
}): { id: string; tenantId: string; cardId?: string; contactId?: string; content: string; dueAt: number; createdAt: number } {
  const db = getCrmDb();
  const r = {
    id: nid('crm_rem'), tenantId, cardId: input.cardId, contactId: input.contactId,
    content: input.content, dueAt: input.dueAt, createdAt: now(),
  };
  db.prepare(`
    INSERT INTO crm_reminders (id, tenant_id, card_id, contact_id, content, due_at, created_by_agent_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(r.id, tenantId, r.cardId ?? null, r.contactId ?? null, r.content, r.dueAt,
    input.createdByAgentId ?? null, r.createdAt);
  return r;
}

export function listDueReminders(): Array<{ id: string; tenantId: string; cardId?: string; contactId?: string; content: string; dueAt: number }> {
  const db = getCrmDb();
  const rows = db.prepare(`
    SELECT * FROM crm_reminders WHERE completed_at IS NULL AND due_at <= ? ORDER BY due_at ASC LIMIT 500
  `).all(now()) as any[];
  return rows.map((r: any) => ({
    id: r.id, tenantId: r.tenant_id, cardId: r.card_id ?? undefined,
    contactId: r.contact_id ?? undefined, content: r.content, dueAt: r.due_at,
  }));
}

export function completeReminder(tenantId: string, reminderId: string): boolean {
  const db = getCrmDb();
  const r = db.prepare('UPDATE crm_reminders SET completed_at = ? WHERE id = ? AND tenant_id = ?')
    .run(now(), reminderId, tenantId);
  return r.changes > 0;
}

// ═══ INVENTORY ══════════════════════════════════════════════════════════
export function createInventoryItem(tenantId: string, input: {
  sku: string; name: string; description?: string; priceCents?: number; stock?: number;
  category?: string; customFields?: Record<string, unknown>;
}): InventoryItem {
  const db = getCrmDb();
  const it: InventoryItem = {
    id: nid('crm_inv'), tenantId, sku: input.sku, name: input.name,
    description: input.description, priceCents: input.priceCents ?? 0,
    stock: input.stock ?? 0, category: input.category,
    customFields: input.customFields ?? {}, createdAt: now(), updatedAt: now(),
  };
  db.prepare(`
    INSERT INTO crm_inventory (id, tenant_id, sku, name, description, price_cents, stock, category, custom_fields_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(it.id, it.tenantId, it.sku, it.name, it.description ?? null, it.priceCents, it.stock,
    it.category ?? null, J.stringify(it.customFields), it.createdAt, it.updatedAt);
  return it;
}

export function listInventory(tenantId: string): InventoryItem[] {
  const db = getCrmDb();
  const rows = db.prepare('SELECT * FROM crm_inventory WHERE tenant_id = ? ORDER BY name ASC').all(tenantId) as any[];
  return rows.map((r: any) => ({
    id: r.id, tenantId: r.tenant_id, sku: r.sku, name: r.name,
    description: r.description ?? undefined, priceCents: r.price_cents, stock: r.stock,
    category: r.category ?? undefined, customFields: J.parse(r.custom_fields_json, {}),
    createdAt: r.created_at, updatedAt: r.updated_at,
  }));
}

export function updateInventoryStock(tenantId: string, itemId: string, delta: number): InventoryItem | null {
  const db = getCrmDb();
  const r = db.prepare(`
    UPDATE crm_inventory SET stock = stock + ?, updated_at = ? WHERE id = ? AND tenant_id = ?
  `).run(delta, now(), itemId, tenantId);
  if (r.changes === 0) return null;
  const row = db.prepare('SELECT * FROM crm_inventory WHERE id = ?').get(itemId) as any;
  return row ? {
    id: row.id, tenantId: row.tenant_id, sku: row.sku, name: row.name,
    description: row.description ?? undefined, priceCents: row.price_cents, stock: row.stock,
    category: row.category ?? undefined, customFields: J.parse(row.custom_fields_json, {}),
    createdAt: row.created_at, updatedAt: row.updated_at,
  } : null;
}

// ═══ SEED DEFAULTS (first-time tenant) ══════════════════════════════════
/**
 * Create a sensible default board ("Pipeline de Vendas") with 6 columns
 * when a tenant accesses the CRM for the first time.
 */
export function seedDefaultBoards(tenantId: string): Board {
  const existing = listBoards(tenantId);
  if (existing.length > 0) return existing[0];

  const salesBoard = createBoard(tenantId, { name: 'Pipeline de Vendas', type: 'sales',
    description: 'Leads do primeiro contato até o fechamento' });

  const salesCols = [
    { name: 'Lead novo', color: '#94A3B8' },
    { name: 'Qualificado', color: '#4A9EFF' },
    { name: 'Proposta enviada', color: '#9B59FC' },
    { name: 'Negociação', color: '#F59E0B' },
    { name: 'Ganho', color: '#22C55E', isTerminal: true },
    { name: 'Perdido', color: '#EF4444', isTerminal: true },
  ];
  for (const c of salesCols) {
    createColumn(tenantId, { boardId: salesBoard.id, name: c.name, color: c.color, isTerminal: c.isTerminal });
  }

  const supportBoard = createBoard(tenantId, {
    name: 'Atendimento', type: 'support',
    description: 'Tickets de suporte e pós-venda',
  });
  for (const c of [
    { name: 'Aberto', color: '#EF4444' },
    { name: 'Em andamento', color: '#F59E0B' },
    { name: 'Aguardando cliente', color: '#94A3B8' },
    { name: 'Resolvido', color: '#22C55E', isTerminal: true },
  ]) {
    createColumn(tenantId, { boardId: supportBoard.id, name: c.name, color: c.color, isTerminal: c.isTerminal });
  }

  return salesBoard;
}
