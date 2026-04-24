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

// ═══════════════════════════════════════════════════════════════════════
// ONDA 1 — Contatos Pro: duplicates, merge, import/export, bulk, segments
// ═══════════════════════════════════════════════════════════════════════

import type { Segment, SegmentFilter, BulkContactOp } from './types.js';

function rowToContactPro(r: any): Contact {
  const base = rowToContact(r);
  return {
    ...base,
    company: r.company ?? undefined,
    title: r.title ?? undefined,
    website: r.website ?? undefined,
    address: r.address ?? undefined,
    birthdateTs: r.birthdate_ts ?? undefined,
    cpfCnpj: r.cpf_cnpj ?? undefined,
    leadScore: r.lead_score ?? 0,
  } as any;
}

// Re-list com os campos typed inclusos
export function listContactsPro(tenantId: string, opts: { limit?: number; offset?: number; tag?: string } = {}): Contact[] {
  const db = getCrmDb();
  const limit = Math.min(opts.limit ?? 100, 1000);
  const offset = opts.offset ?? 0;
  let sql = 'SELECT * FROM crm_contacts WHERE tenant_id = ?';
  const args: any[] = [tenantId];
  if (opts.tag) { sql += ' AND tags_json LIKE ?'; args.push('%"' + opts.tag + '"%'); }
  sql += ' ORDER BY updated_at DESC LIMIT ? OFFSET ?';
  args.push(limit, offset);
  const rows = db.prepare(sql).all(...args) as any[];
  return rows.map(rowToContactPro);
}

export function findDuplicateContacts(tenantId: string): Array<{ by: 'phone' | 'email' | 'name'; key: string; ids: string[] }> {
  const db = getCrmDb();
  const dups: Array<{ by: 'phone' | 'email' | 'name'; key: string; ids: string[] }> = [];

  // por phone
  const phoneDups = db.prepare(`
    SELECT phone, GROUP_CONCAT(id) as ids, COUNT(*) as cnt
    FROM crm_contacts WHERE tenant_id = ? AND phone IS NOT NULL AND phone != ''
    GROUP BY phone HAVING cnt > 1
  `).all(tenantId) as any[];
  for (const p of phoneDups) dups.push({ by: 'phone', key: p.phone, ids: String(p.ids).split(',') });

  // por email
  const emailDups = db.prepare(`
    SELECT email, GROUP_CONCAT(id) as ids, COUNT(*) as cnt
    FROM crm_contacts WHERE tenant_id = ? AND email IS NOT NULL AND email != ''
    GROUP BY LOWER(email) HAVING cnt > 1
  `).all(tenantId) as any[];
  for (const e of emailDups) dups.push({ by: 'email', key: e.email, ids: String(e.ids).split(',') });

  return dups;
}

export function mergeContacts(tenantId: string, keepId: string, mergeId: string): { ok: boolean; error?: string } {
  const db = getCrmDb();
  const keep = db.prepare('SELECT * FROM crm_contacts WHERE id = ? AND tenant_id = ?').get(keepId, tenantId) as any;
  const merge = db.prepare('SELECT * FROM crm_contacts WHERE id = ? AND tenant_id = ?').get(mergeId, tenantId) as any;
  if (!keep || !merge) return { ok: false, error: 'contact_not_found' };
  if (keepId === mergeId) return { ok: false, error: 'same_contact' };

  // Merge fields: keep tem prioridade, fill missing with merge's
  const mergedTags = Array.from(new Set([...JSON.parse(keep.tags_json || '[]'), ...JSON.parse(merge.tags_json || '[]')]));
  const mergedCustom = { ...JSON.parse(merge.custom_fields_json || '{}'), ...JSON.parse(keep.custom_fields_json || '{}') };

  const merged = {
    name: keep.name || merge.name,
    phone: keep.phone || merge.phone,
    email: keep.email || merge.email,
    avatar_url: keep.avatar_url || merge.avatar_url,
    tags_json: JSON.stringify(mergedTags),
    custom_fields_json: JSON.stringify(mergedCustom),
    notes: [keep.notes, merge.notes].filter(Boolean).join('\n\n---\n\n') || null,
    company: keep.company || merge.company,
    title: keep.title || merge.title,
    website: keep.website || merge.website,
    address: keep.address || merge.address,
    birthdate_ts: keep.birthdate_ts || merge.birthdate_ts,
    cpf_cnpj: keep.cpf_cnpj || merge.cpf_cnpj,
    lead_score: Math.max(keep.lead_score || 0, merge.lead_score || 0),
  };

  const tx = db.transaction(() => {
    // Atualiza keep com campos merged
    db.prepare(`
      UPDATE crm_contacts SET name=?, phone=?, email=?, avatar_url=?, tags_json=?, custom_fields_json=?,
        notes=?, company=?, title=?, website=?, address=?, birthdate_ts=?, cpf_cnpj=?, lead_score=?, updated_at=?
      WHERE id=? AND tenant_id=?
    `).run(merged.name, merged.phone, merged.email, merged.avatar_url, merged.tags_json, merged.custom_fields_json,
      merged.notes, merged.company, merged.title, merged.website, merged.address, merged.birthdate_ts,
      merged.cpf_cnpj, merged.lead_score, Date.now(), keepId, tenantId);

    // Transfere cards e activities
    db.prepare('UPDATE crm_cards SET contact_id = ? WHERE contact_id = ? AND tenant_id = ?').run(keepId, mergeId, tenantId);
    db.prepare('UPDATE crm_activities SET contact_id = ? WHERE contact_id = ? AND tenant_id = ?').run(keepId, mergeId, tenantId);
    db.prepare('UPDATE crm_subscriptions SET contact_id = ? WHERE contact_id = ? AND tenant_id = ?').run(keepId, mergeId, tenantId);

    // Deleta o merge
    db.prepare('DELETE FROM crm_contacts WHERE id = ? AND tenant_id = ?').run(mergeId, tenantId);
  });

  try { tx(); return { ok: true }; }
  catch (err: any) { return { ok: false, error: err.message }; }
}

// CSV utils — parser manual pra nao depender de lib externa
function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i+1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else cur += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { result.push(cur); cur = ''; }
      else cur += c;
    }
  }
  result.push(cur);
  return result;
}

function csvEscape(v: unknown): string {
  if (v == null) return '';
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export interface ImportResult {
  total: number;
  created: number;
  updated: number;
  errors: Array<{ line: number; error: string }>;
}

export function importContactsCsv(tenantId: string, csvText: string): ImportResult {
  const lines = csvText.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return { total: 0, created: 0, updated: 0, errors: [{ line: 0, error: 'csv vazio ou sem header' }] };

  const header = parseCsvLine(lines[0]).map(h => h.trim().toLowerCase());
  const result: ImportResult = { total: 0, created: 0, updated: 0, errors: [] };

  for (let i = 1; i < lines.length; i++) {
    try {
      const row = parseCsvLine(lines[i]);
      const obj: Record<string, string> = {};
      for (let j = 0; j < header.length && j < row.length; j++) obj[header[j]] = row[j];
      result.total++;

      const name = obj['name'] || obj['nome'] || obj['full_name'];
      if (!name) { result.errors.push({ line: i + 1, error: 'name obrigatorio' }); continue; }

      const phone = obj['phone'] || obj['telefone'] || obj['whatsapp'] || undefined;
      const email = obj['email'] || undefined;

      // Upsert por phone ou email
      const existing = phone
        ? findContactByPhone(tenantId, phone)
        : email
          ? (getCrmDb().prepare('SELECT * FROM crm_contacts WHERE tenant_id=? AND LOWER(email)=LOWER(?)').get(tenantId, email) as any)
          : null;

      const tags = obj['tags'] ? obj['tags'].split(/[;|]/).map(t => t.trim()).filter(Boolean) : [];
      const fields = {
        name, phone, email,
        company: obj['company'] || obj['empresa'] || undefined,
        title: obj['title'] || obj['cargo'] || undefined,
        website: obj['website'] || obj['site'] || undefined,
        address: obj['address'] || obj['endereco'] || undefined,
        cpfCnpj: obj['cpf'] || obj['cnpj'] || obj['cpf_cnpj'] || undefined,
        notes: obj['notes'] || obj['observacoes'] || undefined,
        source: obj['source'] || 'import',
        tags,
      };

      if (existing) {
        updateContact(tenantId, existing.id, fields as any);
        result.updated++;
      } else {
        createContact(tenantId, fields as any);
        result.created++;
      }
    } catch (err: any) {
      result.errors.push({ line: i + 1, error: err.message });
    }
  }
  return result;
}

export function exportContactsCsv(tenantId: string): string {
  const db = getCrmDb();
  const rows = db.prepare('SELECT * FROM crm_contacts WHERE tenant_id = ? ORDER BY created_at DESC').all(tenantId) as any[];
  const header = ['name', 'phone', 'email', 'company', 'title', 'website', 'address', 'cpf_cnpj', 'lead_score', 'tags', 'source', 'notes', 'created_at'];
  const lines: string[] = [header.join(',')];
  for (const r of rows) {
    const tags = JSON.parse(r.tags_json || '[]').join(';');
    lines.push([
      csvEscape(r.name),
      csvEscape(r.phone),
      csvEscape(r.email),
      csvEscape(r.company),
      csvEscape(r.title),
      csvEscape(r.website),
      csvEscape(r.address),
      csvEscape(r.cpf_cnpj),
      csvEscape(r.lead_score),
      csvEscape(tags),
      csvEscape(r.source),
      csvEscape(r.notes),
      csvEscape(new Date(r.created_at).toISOString()),
    ].join(','));
  }
  return lines.join('\n');
}

export function bulkContactOp(tenantId: string, op: BulkContactOp): { affected: number; errors: string[] } {
  const db = getCrmDb();
  const errors: string[] = [];
  let affected = 0;

  const tx = db.transaction(() => {
    for (const id of op.ids) {
      try {
        if (op.action === 'delete') {
          const r = db.prepare('DELETE FROM crm_contacts WHERE id = ? AND tenant_id = ?').run(id, tenantId);
          if (r.changes > 0) affected++;
          continue;
        }
        const c = db.prepare('SELECT * FROM crm_contacts WHERE id = ? AND tenant_id = ?').get(id, tenantId) as any;
        if (!c) { errors.push(`${id}: not_found`); continue; }

        if (op.action === 'addTag' && op.payload?.tag) {
          const tags: string[] = JSON.parse(c.tags_json || '[]');
          if (!tags.includes(op.payload.tag)) {
            tags.push(op.payload.tag);
            db.prepare('UPDATE crm_contacts SET tags_json=?, updated_at=? WHERE id=? AND tenant_id=?')
              .run(JSON.stringify(tags), Date.now(), id, tenantId);
            affected++;
          }
        } else if (op.action === 'removeTag' && op.payload?.tag) {
          const tags: string[] = JSON.parse(c.tags_json || '[]');
          const filtered = tags.filter(t => t !== op.payload!.tag);
          if (filtered.length !== tags.length) {
            db.prepare('UPDATE crm_contacts SET tags_json=?, updated_at=? WHERE id=? AND tenant_id=?')
              .run(JSON.stringify(filtered), Date.now(), id, tenantId);
            affected++;
          }
        } else if (op.action === 'updateField' && op.payload?.field) {
          const field = op.payload.field;
          const value = op.payload.value;
          const allowed = new Set(['name','phone','email','company','title','website','address','cpf_cnpj','lead_score','notes','source']);
          if (!allowed.has(field)) { errors.push(`${id}: field ${field} not allowed`); continue; }
          db.prepare(`UPDATE crm_contacts SET ${field}=?, updated_at=? WHERE id=? AND tenant_id=?`)
            .run(value as any, Date.now(), id, tenantId);
          affected++;
        }
      } catch (err: any) { errors.push(`${id}: ${err.message}`); }
    }
  });
  tx();
  return { affected, errors };
}

export function getContactHistory(tenantId: string, contactId: string, opts: { limit?: number; type?: string } = {}): { activities: any[]; cards: any[]; subscriptions: any[] } {
  const db = getCrmDb();
  const limit = opts.limit ?? 500;
  let sql = 'SELECT * FROM crm_activities WHERE tenant_id = ? AND contact_id = ?';
  const args: any[] = [tenantId, contactId];
  if (opts.type) { sql += ' AND type = ?'; args.push(opts.type); }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  args.push(limit);
  const activities = db.prepare(sql).all(...args) as any[];
  const cards = db.prepare('SELECT * FROM crm_cards WHERE tenant_id = ? AND contact_id = ?').all(tenantId, contactId) as any[];
  const subs = db.prepare('SELECT * FROM crm_subscriptions WHERE tenant_id = ? AND contact_id = ?').all(tenantId, contactId) as any[];
  return { activities, cards, subscriptions: subs };
}

// ─── Segments ──────────────────────────────────────────────
export function createSegment(tenantId: string, input: { name: string; description?: string; filter: SegmentFilter }): Segment {
  const db = getCrmDb();
  const s: Segment = {
    id: nid('crm_seg'), tenantId, name: input.name, description: input.description,
    filter: input.filter, createdAt: now(), updatedAt: now(),
  };
  db.prepare(`INSERT INTO crm_segments (id,tenant_id,name,description,filter_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
    .run(s.id, s.tenantId, s.name, s.description ?? null, JSON.stringify(s.filter), s.createdAt, s.updatedAt);
  return s;
}

export function listSegments(tenantId: string): Segment[] {
  const db = getCrmDb();
  const rows = db.prepare('SELECT * FROM crm_segments WHERE tenant_id = ? ORDER BY updated_at DESC').all(tenantId) as any[];
  return rows.map(rowToSegment);
}

export function getSegment(tenantId: string, id: string): Segment | null {
  const db = getCrmDb();
  const r = db.prepare('SELECT * FROM crm_segments WHERE id = ? AND tenant_id = ?').get(id, tenantId) as any;
  return r ? rowToSegment(r) : null;
}

export function updateSegment(tenantId: string, id: string, patch: Partial<Omit<Segment,'id'|'tenantId'|'createdAt'>>): Segment | null {
  const existing = getSegment(tenantId, id);
  if (!existing) return null;
  const upd = { ...existing, ...patch, updatedAt: now() };
  const db = getCrmDb();
  db.prepare('UPDATE crm_segments SET name=?, description=?, filter_json=?, updated_at=? WHERE id=? AND tenant_id=?')
    .run(upd.name, upd.description ?? null, JSON.stringify(upd.filter), upd.updatedAt, id, tenantId);
  return upd;
}

export function deleteSegment(tenantId: string, id: string): boolean {
  const db = getCrmDb();
  const r = db.prepare('DELETE FROM crm_segments WHERE id=? AND tenant_id=?').run(id, tenantId);
  return r.changes > 0;
}

function rowToSegment(r: any): Segment {
  return {
    id: r.id, tenantId: r.tenant_id, name: r.name,
    description: r.description ?? undefined,
    filter: JSON.parse(r.filter_json || '{}') as SegmentFilter,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export function runSegment(tenantId: string, filter: SegmentFilter, limit: number = 500): Contact[] {
  const db = getCrmDb();
  const conds: string[] = ['tenant_id = ?'];
  const args: any[] = [tenantId];

  if (filter.hasPhone) conds.push('phone IS NOT NULL AND phone != ""');
  if (filter.hasEmail) conds.push('email IS NOT NULL AND email != ""');
  if (filter.company) { conds.push('company LIKE ?'); args.push('%' + filter.company + '%'); }
  if (filter.source) { conds.push('source = ?'); args.push(filter.source); }
  if (filter.minLeadScore != null) { conds.push('COALESCE(lead_score,0) >= ?'); args.push(filter.minLeadScore); }
  if (filter.maxLeadScore != null) { conds.push('COALESCE(lead_score,0) <= ?'); args.push(filter.maxLeadScore); }
  if (filter.createdAfter) { conds.push('created_at >= ?'); args.push(filter.createdAfter); }
  if (filter.createdBefore) { conds.push('created_at <= ?'); args.push(filter.createdBefore); }
  if (filter.lastInteractionAfter) { conds.push('last_interaction_at >= ?'); args.push(filter.lastInteractionAfter); }
  if (filter.lastInteractionBefore) { conds.push('last_interaction_at <= ?'); args.push(filter.lastInteractionBefore); }
  if (filter.nameContains) { conds.push('name LIKE ?'); args.push('%' + filter.nameContains + '%'); }

  // Tags via LIKE (aproximacao)
  if (filter.tags && filter.tags.length) {
    const mode = filter.tagsMode || 'any';
    const tagConds = filter.tags.map(() => 'tags_json LIKE ?').join(mode === 'all' ? ' AND ' : ' OR ');
    conds.push('(' + tagConds + ')');
    for (const t of filter.tags) args.push('%"' + t + '"%');
  }

  const sql = `SELECT * FROM crm_contacts WHERE ${conds.join(' AND ')} ORDER BY updated_at DESC LIMIT ?`;
  args.push(Math.min(limit, 2000));
  const rows = db.prepare(sql).all(...args) as any[];

  // customFieldEquals filter na memoria (JSON match)
  let results = rows;
  if (filter.customFieldEquals) {
    results = results.filter(r => {
      const cf = JSON.parse(r.custom_fields_json || '{}');
      for (const [k, v] of Object.entries(filter.customFieldEquals!)) {
        if (cf[k] !== v) return false;
      }
      return true;
    });
  }
  return results.map(rowToContactPro);
}

// ═══════════════════════════════════════════════════════════════════════
// ONDA 2 — Kanban Pro: WIP limits, archive, checklists, swimlanes
// ═══════════════════════════════════════════════════════════════════════

import type { Swimlane, Checklist, ChecklistItem, BoardSettings, ColumnStageType } from './types.js';

// ─── WIP limits & column settings ─────────────────────────────────
export function setColumnWipLimit(tenantId: string, columnId: string, wipLimit: number | null): boolean {
  const db = getCrmDb();
  // Ensure column belongs to a board of this tenant
  const col = db.prepare(`
    SELECT c.* FROM crm_columns c JOIN crm_boards b ON b.id = c.board_id
    WHERE c.id = ? AND b.tenant_id = ?
  `).get(columnId, tenantId) as any;
  if (!col) return false;
  db.prepare('UPDATE crm_columns SET wip_limit = ? WHERE id = ?').run(wipLimit, columnId);
  return true;
}

export function setColumnStageType(tenantId: string, columnId: string, stageType: ColumnStageType): boolean {
  const db = getCrmDb();
  const col = db.prepare(`
    SELECT c.* FROM crm_columns c JOIN crm_boards b ON b.id = c.board_id
    WHERE c.id = ? AND b.tenant_id = ?
  `).get(columnId, tenantId) as any;
  if (!col) return false;
  const isTerminal = stageType === 'won' || stageType === 'lost' ? 1 : 0;
  db.prepare('UPDATE crm_columns SET stage_type = ?, is_terminal = ? WHERE id = ?')
    .run(stageType, isTerminal, columnId);
  return true;
}

export function checkWipLimit(tenantId: string, columnId: string): { allowed: boolean; current: number; limit?: number } {
  const db = getCrmDb();
  const col = db.prepare(`
    SELECT c.wip_limit, b.settings_json FROM crm_columns c JOIN crm_boards b ON b.id = c.board_id
    WHERE c.id = ? AND b.tenant_id = ?
  `).get(columnId, tenantId) as any;
  if (!col) return { allowed: true, current: 0 };
  const settings: BoardSettings = JSON.parse(col.settings_json || '{}');
  if (!settings.wipEnforce || col.wip_limit == null) return { allowed: true, current: 0, limit: col.wip_limit ?? undefined };

  const count = (db.prepare("SELECT COUNT(*) as n FROM crm_cards WHERE column_id = ? AND COALESCE(status,'active') = 'active'").get(columnId) as any).n;
  return { allowed: count < col.wip_limit, current: count, limit: col.wip_limit };
}

// ─── Archive ───────────────────────────────────────────────────────
export function archiveCard(tenantId: string, cardId: string): Card | null {
  const db = getCrmDb();
  const existing = db.prepare('SELECT * FROM crm_cards WHERE id=? AND tenant_id=?').get(cardId, tenantId) as any;
  if (!existing) return null;
  db.prepare("UPDATE crm_cards SET status='archived', archived_at=?, updated_at=? WHERE id=? AND tenant_id=?")
    .run(Date.now(), Date.now(), cardId, tenantId);
  return rowToCard({ ...existing, status: 'archived', archived_at: Date.now() });
}

export function unarchiveCard(tenantId: string, cardId: string): Card | null {
  const db = getCrmDb();
  const existing = db.prepare('SELECT * FROM crm_cards WHERE id=? AND tenant_id=?').get(cardId, tenantId) as any;
  if (!existing) return null;
  db.prepare("UPDATE crm_cards SET status='active', archived_at=NULL, updated_at=? WHERE id=? AND tenant_id=?")
    .run(Date.now(), cardId, tenantId);
  return rowToCard({ ...existing, status: 'active', archived_at: null });
}

// ─── Board settings ────────────────────────────────────────────────
export function updateBoardSettings(tenantId: string, boardId: string, settings: Partial<BoardSettings>): Board | null {
  const db = getCrmDb();
  const b = db.prepare('SELECT * FROM crm_boards WHERE id=? AND tenant_id=?').get(boardId, tenantId) as any;
  if (!b) return null;
  const current: BoardSettings = JSON.parse(b.settings_json || '{}');
  const merged = { ...current, ...settings };
  db.prepare('UPDATE crm_boards SET settings_json=?, updated_at=? WHERE id=? AND tenant_id=?')
    .run(JSON.stringify(merged), Date.now(), boardId, tenantId);
  return { ...rowToBoard(b), settings: merged } as any;
}

// ─── Swimlanes ─────────────────────────────────────────────────────
export function createSwimlane(tenantId: string, boardId: string, input: { name: string; color?: string; position?: number }): Swimlane | null {
  const db = getCrmDb();
  const b = db.prepare('SELECT id FROM crm_boards WHERE id=? AND tenant_id=?').get(boardId, tenantId);
  if (!b) return null;
  const pos = input.position ?? (((db.prepare('SELECT MAX(position) as m FROM crm_swimlanes WHERE board_id=?').get(boardId) as any).m ?? -1) + 1);
  const s: Swimlane = {
    id: nid('crm_sl'), tenantId, boardId, name: input.name,
    color: input.color || '#9B59FC', position: pos, createdAt: now(),
  };
  db.prepare('INSERT INTO crm_swimlanes (id, tenant_id, board_id, name, color, position, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(s.id, tenantId, boardId, s.name, s.color, s.position, s.createdAt);
  return s;
}

export function listSwimlanes(tenantId: string, boardId: string): Swimlane[] {
  const db = getCrmDb();
  const rows = db.prepare('SELECT * FROM crm_swimlanes WHERE tenant_id=? AND board_id=? ORDER BY position ASC').all(tenantId, boardId) as any[];
  return rows.map((r: any) => ({
    id: r.id, tenantId: r.tenant_id, boardId: r.board_id,
    name: r.name, color: r.color, position: r.position, createdAt: r.created_at,
  }));
}

export function updateSwimlane(tenantId: string, id: string, patch: Partial<Omit<Swimlane,'id'|'tenantId'|'boardId'|'createdAt'>>): Swimlane | null {
  const db = getCrmDb();
  const r = db.prepare('SELECT * FROM crm_swimlanes WHERE id=? AND tenant_id=?').get(id, tenantId) as any;
  if (!r) return null;
  const upd = { name: patch.name ?? r.name, color: patch.color ?? r.color, position: patch.position ?? r.position };
  db.prepare('UPDATE crm_swimlanes SET name=?, color=?, position=? WHERE id=? AND tenant_id=?')
    .run(upd.name, upd.color, upd.position, id, tenantId);
  return { id, tenantId, boardId: r.board_id, ...upd, createdAt: r.created_at } as Swimlane;
}

export function deleteSwimlane(tenantId: string, id: string): boolean {
  const db = getCrmDb();
  // Clear swimlane_id em cards
  db.prepare('UPDATE crm_cards SET swimlane_id=NULL WHERE swimlane_id=? AND tenant_id=?').run(id, tenantId);
  const r = db.prepare('DELETE FROM crm_swimlanes WHERE id=? AND tenant_id=?').run(id, tenantId);
  return r.changes > 0;
}

// ─── Checklists ────────────────────────────────────────────────────
export function createChecklist(tenantId: string, cardId: string, input: { title: string; items?: string[] }): Checklist | null {
  const db = getCrmDb();
  const card = db.prepare('SELECT id FROM crm_cards WHERE id=? AND tenant_id=?').get(cardId, tenantId);
  if (!card) return null;
  const items: ChecklistItem[] = (input.items || []).map((t, i) => ({ id: nid('ci'), text: t, done: false }));
  const cl: Checklist = {
    id: nid('crm_cl'), tenantId, cardId, title: input.title,
    items, createdAt: now(), updatedAt: now(),
  };
  db.prepare('INSERT INTO crm_checklists (id, tenant_id, card_id, title, items_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(cl.id, tenantId, cardId, cl.title, JSON.stringify(cl.items), cl.createdAt, cl.updatedAt);
  return cl;
}

export function listChecklists(tenantId: string, cardId: string): Checklist[] {
  const db = getCrmDb();
  const rows = db.prepare('SELECT * FROM crm_checklists WHERE tenant_id=? AND card_id=? ORDER BY created_at ASC').all(tenantId, cardId) as any[];
  return rows.map((r: any) => ({
    id: r.id, tenantId: r.tenant_id, cardId: r.card_id,
    title: r.title, items: JSON.parse(r.items_json || '[]') as ChecklistItem[],
    createdAt: r.created_at, updatedAt: r.updated_at,
  }));
}

export function updateChecklist(tenantId: string, id: string, patch: { title?: string; items?: ChecklistItem[] }): Checklist | null {
  const db = getCrmDb();
  const r = db.prepare('SELECT * FROM crm_checklists WHERE id=? AND tenant_id=?').get(id, tenantId) as any;
  if (!r) return null;
  const title = patch.title ?? r.title;
  const items = patch.items ?? JSON.parse(r.items_json || '[]');
  db.prepare('UPDATE crm_checklists SET title=?, items_json=?, updated_at=? WHERE id=? AND tenant_id=?')
    .run(title, JSON.stringify(items), Date.now(), id, tenantId);
  return { id, tenantId, cardId: r.card_id, title, items, createdAt: r.created_at, updatedAt: Date.now() };
}

export function toggleChecklistItem(tenantId: string, checklistId: string, itemId: string): Checklist | null {
  const db = getCrmDb();
  const r = db.prepare('SELECT * FROM crm_checklists WHERE id=? AND tenant_id=?').get(checklistId, tenantId) as any;
  if (!r) return null;
  const items: ChecklistItem[] = JSON.parse(r.items_json || '[]');
  const it = items.find(i => i.id === itemId);
  if (!it) return null;
  it.done = !it.done;
  db.prepare('UPDATE crm_checklists SET items_json=?, updated_at=? WHERE id=? AND tenant_id=?')
    .run(JSON.stringify(items), Date.now(), checklistId, tenantId);
  return { id: checklistId, tenantId, cardId: r.card_id, title: r.title, items, createdAt: r.created_at, updatedAt: Date.now() };
}

export function deleteChecklist(tenantId: string, id: string): boolean {
  const db = getCrmDb();
  const r = db.prepare('DELETE FROM crm_checklists WHERE id=? AND tenant_id=?').run(id, tenantId);
  return r.changes > 0;
}

// ═══════════════════════════════════════════════════════════════════════
// ONDA 3 — Agentes Pro: teams, perms, status, SLA, metrics
// ═══════════════════════════════════════════════════════════════════════
import type { Team, AgentPermissions, AgentMetricsPro, SlaRule,
              Label, QuickReply, InboxRule } from './types.js';

function rowToTeam(r: any): Team {
  return { id: r.id, tenantId: r.tenant_id, name: r.name, color: r.color || '#9B59FC',
    description: r.description ?? undefined, managerAgentId: r.manager_agent_id ?? undefined,
    createdAt: r.created_at, updatedAt: r.updated_at };
}
export function createTeam(tenantId: string, input: { name: string; color?: string; description?: string; managerAgentId?: string }): Team {
  const db = getCrmDb();
  const t: Team = { id: nid('crm_team'), tenantId, name: input.name,
    color: input.color || '#9B59FC', description: input.description,
    managerAgentId: input.managerAgentId, createdAt: now(), updatedAt: now() };
  db.prepare('INSERT INTO crm_teams (id,tenant_id,name,color,description,manager_agent_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(t.id, tenantId, t.name, t.color, t.description ?? null, t.managerAgentId ?? null, t.createdAt, t.updatedAt);
  return t;
}
export function listTeams(tenantId: string): Team[] {
  const db = getCrmDb();
  return (db.prepare('SELECT * FROM crm_teams WHERE tenant_id=? ORDER BY name').all(tenantId) as any[]).map(rowToTeam);
}
export function getTeam(tenantId: string, id: string): Team | null {
  const db = getCrmDb();
  const r = db.prepare('SELECT * FROM crm_teams WHERE id=? AND tenant_id=?').get(id, tenantId) as any;
  return r ? rowToTeam(r) : null;
}
export function updateTeam(tenantId: string, id: string, patch: Partial<Omit<Team,'id'|'tenantId'|'createdAt'>>): Team | null {
  const existing = getTeam(tenantId, id);
  if (!existing) return null;
  const upd = { ...existing, ...patch, updatedAt: now() };
  getCrmDb().prepare('UPDATE crm_teams SET name=?, color=?, description=?, manager_agent_id=?, updated_at=? WHERE id=? AND tenant_id=?')
    .run(upd.name, upd.color, upd.description ?? null, upd.managerAgentId ?? null, upd.updatedAt, id, tenantId);
  return upd;
}
export function deleteTeam(tenantId: string, id: string): boolean {
  const db = getCrmDb();
  db.prepare('UPDATE crm_agents SET team_id=NULL WHERE team_id=? AND tenant_id=?').run(id, tenantId);
  return db.prepare('DELETE FROM crm_teams WHERE id=? AND tenant_id=?').run(id, tenantId).changes > 0;
}

export function setAgentPermissions(tenantId: string, agentId: string, perms: AgentPermissions): boolean {
  const db = getCrmDb();
  return db.prepare('UPDATE crm_agents SET permissions_json=?, updated_at=? WHERE id=? AND tenant_id=?')
    .run(JSON.stringify(perms), Date.now(), agentId, tenantId).changes > 0;
}
export function setAgentTeam(tenantId: string, agentId: string, teamId: string | null): boolean {
  return getCrmDb().prepare('UPDATE crm_agents SET team_id=?, updated_at=? WHERE id=? AND tenant_id=?')
    .run(teamId, Date.now(), agentId, tenantId).changes > 0;
}
export function setAgentStatus(tenantId: string, agentId: string, status: 'online' | 'away' | 'offline'): boolean {
  return getCrmDb().prepare('UPDATE crm_agents SET status=?, last_seen_at=?, updated_at=? WHERE id=? AND tenant_id=?')
    .run(status, Date.now(), Date.now(), agentId, tenantId).changes > 0;
}

export function getAgentMetricsPro(tenantId: string, agentId?: string): AgentMetricsPro[] {
  const db = getCrmDb();
  const agents = agentId
    ? (db.prepare('SELECT * FROM crm_agents WHERE tenant_id=? AND id=?').all(tenantId, agentId) as any[])
    : (db.prepare('SELECT * FROM crm_agents WHERE tenant_id=?').all(tenantId) as any[]);
  const now24h = Date.now() - 24*60*60*1000;
  return agents.map((a: any) => {
    const opened = (db.prepare("SELECT COUNT(*) n FROM crm_cards WHERE tenant_id=? AND owner_agent_id=? AND COALESCE(status,'active')='active'").get(tenantId, a.id) as any).n;
    // won/lost precisam de stage_type
    const won = (db.prepare("SELECT COUNT(*) n FROM crm_cards c JOIN crm_columns col ON col.id=c.column_id WHERE c.tenant_id=? AND c.owner_agent_id=? AND col.stage_type='won'").get(tenantId, a.id) as any).n;
    const lost = (db.prepare("SELECT COUNT(*) n FROM crm_cards c JOIN crm_columns col ON col.id=c.column_id WHERE c.tenant_id=? AND c.owner_agent_id=? AND col.stage_type='lost'").get(tenantId, a.id) as any).n;
    const totalValue = (db.prepare("SELECT COALESCE(SUM(c.value_cents),0) v FROM crm_cards c JOIN crm_columns col ON col.id=c.column_id WHERE c.tenant_id=? AND c.owner_agent_id=? AND col.stage_type='won'").get(tenantId, a.id) as any).v;
    const msgsToday = (db.prepare("SELECT COUNT(*) n FROM crm_activities WHERE tenant_id=? AND created_by_agent_id=? AND created_at>=?").get(tenantId, a.id, now24h) as any).n;
    const total = won + lost;
    return {
      agentId: a.id, agentName: a.name,
      cardsOpen: opened, cardsWon: won, cardsLost: lost,
      conversionRate: total > 0 ? won / total : 0,
      totalValueCents: totalValue,
      avgResponseMins: 0, // heuristica futura
      messagesToday: msgsToday,
      lastSeenAt: a.last_seen_at ?? undefined,
      status: (a.status || 'offline') as any,
    };
  });
}

// SLA
function rowToSla(r: any): SlaRule {
  return { id: r.id, tenantId: r.tenant_id, teamId: r.team_id ?? undefined,
    agentId: r.agent_id ?? undefined, name: r.name, maxResponseMins: r.max_response_mins,
    escalateToAgentId: r.escalate_to_agent_id ?? undefined,
    enabled: !!r.enabled, createdAt: r.created_at };
}
export function createSlaRule(tenantId: string, input: Omit<SlaRule,'id'|'tenantId'|'createdAt'>): SlaRule {
  const rule: SlaRule = { id: nid('crm_sla'), tenantId, ...input, createdAt: now() };
  getCrmDb().prepare('INSERT INTO crm_sla_rules (id,tenant_id,team_id,agent_id,name,max_response_mins,escalate_to_agent_id,enabled,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(rule.id, tenantId, rule.teamId ?? null, rule.agentId ?? null, rule.name, rule.maxResponseMins,
         rule.escalateToAgentId ?? null, rule.enabled ? 1 : 0, rule.createdAt);
  return rule;
}
export function listSlaRules(tenantId: string): SlaRule[] {
  return (getCrmDb().prepare('SELECT * FROM crm_sla_rules WHERE tenant_id=? ORDER BY created_at DESC').all(tenantId) as any[]).map(rowToSla);
}
export function deleteSlaRule(tenantId: string, id: string): boolean {
  return getCrmDb().prepare('DELETE FROM crm_sla_rules WHERE id=? AND tenant_id=?').run(id, tenantId).changes > 0;
}

// ═══════════════════════════════════════════════════════════════════════
// ONDA 4 — Inbox Pro
// ═══════════════════════════════════════════════════════════════════════
function rowToLabel(r: any): Label {
  return { id: r.id, tenantId: r.tenant_id, name: r.name, color: r.color || '#9B59FC', scope: (r.scope || 'inbox') as any, createdAt: r.created_at };
}
export function createLabel(tenantId: string, input: { name: string; color?: string; scope?: 'inbox'|'contact'|'both' }): Label {
  const l: Label = { id: nid('crm_lbl'), tenantId, name: input.name,
    color: input.color || '#9B59FC', scope: input.scope || 'inbox', createdAt: now() };
  getCrmDb().prepare('INSERT INTO crm_labels (id,tenant_id,name,color,scope,created_at) VALUES (?,?,?,?,?,?)')
    .run(l.id, tenantId, l.name, l.color, l.scope, l.createdAt);
  return l;
}
export function listLabels(tenantId: string, scope?: 'inbox'|'contact'|'both'): Label[] {
  const db = getCrmDb();
  let sql = 'SELECT * FROM crm_labels WHERE tenant_id=?';
  const args: any[] = [tenantId];
  if (scope) { sql += " AND (scope=? OR scope='both')"; args.push(scope); }
  return (db.prepare(sql + ' ORDER BY name').all(...args) as any[]).map(rowToLabel);
}
export function updateLabel(tenantId: string, id: string, patch: Partial<Omit<Label,'id'|'tenantId'|'createdAt'>>): Label | null {
  const db = getCrmDb();
  const r = db.prepare('SELECT * FROM crm_labels WHERE id=? AND tenant_id=?').get(id, tenantId) as any;
  if (!r) return null;
  const upd = { name: patch.name ?? r.name, color: patch.color ?? r.color, scope: patch.scope ?? r.scope };
  db.prepare('UPDATE crm_labels SET name=?, color=?, scope=? WHERE id=? AND tenant_id=?')
    .run(upd.name, upd.color, upd.scope, id, tenantId);
  return { id, tenantId, ...upd, createdAt: r.created_at } as Label;
}
export function deleteLabel(tenantId: string, id: string): boolean {
  return getCrmDb().prepare('DELETE FROM crm_labels WHERE id=? AND tenant_id=?').run(id, tenantId).changes > 0;
}

// Attach label to activity
export function addLabelToActivity(tenantId: string, activityId: string, labelId: string): boolean {
  const db = getCrmDb();
  const a = db.prepare('SELECT labels_json FROM crm_activities WHERE id=? AND tenant_id=?').get(activityId, tenantId) as any;
  if (!a) return false;
  const labels: string[] = JSON.parse(a.labels_json || '[]');
  if (!labels.includes(labelId)) {
    labels.push(labelId);
    db.prepare('UPDATE crm_activities SET labels_json=? WHERE id=? AND tenant_id=?').run(JSON.stringify(labels), activityId, tenantId);
  }
  return true;
}
export function removeLabelFromActivity(tenantId: string, activityId: string, labelId: string): boolean {
  const db = getCrmDb();
  const a = db.prepare('SELECT labels_json FROM crm_activities WHERE id=? AND tenant_id=?').get(activityId, tenantId) as any;
  if (!a) return false;
  const labels: string[] = JSON.parse(a.labels_json || '[]').filter((x: string) => x !== labelId);
  db.prepare('UPDATE crm_activities SET labels_json=? WHERE id=? AND tenant_id=?').run(JSON.stringify(labels), activityId, tenantId);
  return true;
}

// Quick replies
function rowToQr(r: any): QuickReply {
  return { id: r.id, tenantId: r.tenant_id, title: r.title, body: r.body,
    shortcut: r.shortcut ?? undefined, category: r.category ?? undefined,
    useCount: r.use_count, createdAt: r.created_at, updatedAt: r.updated_at };
}
export function createQuickReply(tenantId: string, input: { title: string; body: string; shortcut?: string; category?: string }): QuickReply {
  const q: QuickReply = { id: nid('crm_qr'), tenantId, ...input, useCount: 0, createdAt: now(), updatedAt: now() };
  getCrmDb().prepare('INSERT INTO crm_quick_replies (id,tenant_id,title,body,shortcut,category,use_count,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(q.id, tenantId, q.title, q.body, q.shortcut ?? null, q.category ?? null, 0, q.createdAt, q.updatedAt);
  return q;
}
export function listQuickReplies(tenantId: string, category?: string): QuickReply[] {
  const db = getCrmDb();
  let sql = 'SELECT * FROM crm_quick_replies WHERE tenant_id=?';
  const args: any[] = [tenantId];
  if (category) { sql += ' AND category=?'; args.push(category); }
  return (db.prepare(sql + ' ORDER BY use_count DESC, title ASC').all(...args) as any[]).map(rowToQr);
}
export function updateQuickReply(tenantId: string, id: string, patch: Partial<Omit<QuickReply,'id'|'tenantId'|'createdAt'|'useCount'>>): QuickReply | null {
  const db = getCrmDb();
  const r = db.prepare('SELECT * FROM crm_quick_replies WHERE id=? AND tenant_id=?').get(id, tenantId) as any;
  if (!r) return null;
  const upd = { title: patch.title ?? r.title, body: patch.body ?? r.body,
    shortcut: patch.shortcut ?? r.shortcut, category: patch.category ?? r.category,
    updatedAt: now() };
  db.prepare('UPDATE crm_quick_replies SET title=?, body=?, shortcut=?, category=?, updated_at=? WHERE id=? AND tenant_id=?')
    .run(upd.title, upd.body, upd.shortcut ?? null, upd.category ?? null, upd.updatedAt, id, tenantId);
  return { id, tenantId, title: upd.title, body: upd.body, shortcut: upd.shortcut, category: upd.category, useCount: r.use_count, createdAt: r.created_at, updatedAt: upd.updatedAt };
}
export function deleteQuickReply(tenantId: string, id: string): boolean {
  return getCrmDb().prepare('DELETE FROM crm_quick_replies WHERE id=? AND tenant_id=?').run(id, tenantId).changes > 0;
}
export function bumpQuickReplyUse(tenantId: string, id: string): void {
  getCrmDb().prepare('UPDATE crm_quick_replies SET use_count=use_count+1 WHERE id=? AND tenant_id=?').run(id, tenantId);
}

// Inbox rules + engine
function rowToInboxRule(r: any): InboxRule {
  return { id: r.id, tenantId: r.tenant_id, name: r.name,
    keyword: r.keyword ?? undefined, assignToAgentId: r.assign_to_agent_id ?? undefined,
    assignToTeamId: r.assign_to_team_id ?? undefined, labelId: r.label_id ?? undefined,
    priority: r.priority ?? 0, enabled: !!r.enabled, createdAt: r.created_at };
}
export function createInboxRule(tenantId: string, input: Omit<InboxRule,'id'|'tenantId'|'createdAt'>): InboxRule {
  const rule: InboxRule = { id: nid('crm_irule'), tenantId, ...input, createdAt: now() };
  getCrmDb().prepare('INSERT INTO crm_inbox_rules (id,tenant_id,name,keyword,assign_to_agent_id,assign_to_team_id,label_id,priority,enabled,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(rule.id, tenantId, rule.name, rule.keyword ?? null, rule.assignToAgentId ?? null, rule.assignToTeamId ?? null, rule.labelId ?? null, rule.priority, rule.enabled ? 1 : 0, rule.createdAt);
  return rule;
}
export function listInboxRules(tenantId: string): InboxRule[] {
  return (getCrmDb().prepare('SELECT * FROM crm_inbox_rules WHERE tenant_id=? ORDER BY priority DESC').all(tenantId) as any[]).map(rowToInboxRule);
}
export function deleteInboxRule(tenantId: string, id: string): boolean {
  return getCrmDb().prepare('DELETE FROM crm_inbox_rules WHERE id=? AND tenant_id=?').run(id, tenantId).changes > 0;
}

// Auto-assign: passa texto + cardId, aplica rules em ordem de priority
export function applyInboxRules(tenantId: string, text: string, cardId: string): { applied: string[]; assignedAgent?: string; appliedLabel?: string } {
  const rules = listInboxRules(tenantId).filter(r => r.enabled);
  const applied: string[] = [];
  let assignedAgent: string | undefined;
  let appliedLabel: string | undefined;
  const lc = (text || '').toLowerCase();
  for (const r of rules) {
    const matches = !r.keyword || lc.includes(r.keyword.toLowerCase());
    if (!matches) continue;
    applied.push(r.id);
    if (r.assignToAgentId && !assignedAgent) {
      getCrmDb().prepare('UPDATE crm_cards SET owner_agent_id=?, updated_at=? WHERE id=? AND tenant_id=?')
        .run(r.assignToAgentId, Date.now(), cardId, tenantId);
      assignedAgent = r.assignToAgentId;
    }
    if (r.labelId && !appliedLabel) appliedLabel = r.labelId;
  }
  return { applied, assignedAgent, appliedLabel };
}

// Mark read/unread
export function markActivityRead(tenantId: string, activityId: string, agentId: string): boolean {
  const db = getCrmDb();
  const a = db.prepare('SELECT read_by_json FROM crm_activities WHERE id=? AND tenant_id=?').get(activityId, tenantId) as any;
  if (!a) return false;
  const readBy: string[] = JSON.parse(a.read_by_json || '[]');
  if (!readBy.includes(agentId)) {
    readBy.push(agentId);
    db.prepare('UPDATE crm_activities SET read_by_json=? WHERE id=? AND tenant_id=?').run(JSON.stringify(readBy), activityId, tenantId);
  }
  return true;
}
export function snoozeActivity(tenantId: string, activityId: string, untilTs: number): boolean {
  return getCrmDb().prepare('UPDATE crm_activities SET snoozed_until=? WHERE id=? AND tenant_id=?')
    .run(untilTs, activityId, tenantId).changes > 0;
}

// ═══════════════════════════════════════════════════════════════════════
// ONDA 5 — Timeline Pro
// ═══════════════════════════════════════════════════════════════════════
import type { ActivityFilter, ReminderChannel, ReminderStatus, ReminderPro } from './types.js';

export function listActivitiesFiltered(tenantId: string, filter: ActivityFilter, limit: number = 200, offset: number = 0): any[] {
  const db = getCrmDb();
  const conds: string[] = ['tenant_id = ?'];
  const args: any[] = [tenantId];
  if (filter.types?.length) {
    conds.push('type IN (' + filter.types.map(() => '?').join(',') + ')');
    args.push(...filter.types);
  }
  if (filter.agentId) { conds.push('created_by_agent_id = ?'); args.push(filter.agentId); }
  if (filter.contactId) { conds.push('contact_id = ?'); args.push(filter.contactId); }
  if (filter.cardId) { conds.push('card_id = ?'); args.push(filter.cardId); }
  if (filter.dateFrom) { conds.push('created_at >= ?'); args.push(filter.dateFrom); }
  if (filter.dateTo) { conds.push('created_at <= ?'); args.push(filter.dateTo); }
  if (filter.isPrivate != null) { conds.push('COALESCE(is_private,0) = ?'); args.push(filter.isPrivate ? 1 : 0); }
  if (filter.mentionedAgent) { conds.push('mentions_json LIKE ?'); args.push('%"' + filter.mentionedAgent + '"%'); }
  if (filter.hasAttachment) conds.push("COALESCE(attachments_json, '[]') != '[]'");

  const sql = `SELECT * FROM crm_activities WHERE ${conds.join(' AND ')} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
  args.push(Math.min(limit, 1000), offset);
  return db.prepare(sql).all(...args) as any[];
}

export function addMentionsToActivity(tenantId: string, activityId: string, agentIds: string[]): boolean {
  const db = getCrmDb();
  const a = db.prepare('SELECT mentions_json FROM crm_activities WHERE id=? AND tenant_id=?').get(activityId, tenantId) as any;
  if (!a) return false;
  const existing: string[] = JSON.parse(a.mentions_json || '[]');
  for (const id of agentIds) if (!existing.includes(id)) existing.push(id);
  db.prepare('UPDATE crm_activities SET mentions_json=? WHERE id=? AND tenant_id=?').run(JSON.stringify(existing), activityId, tenantId);
  return true;
}

export function createActivityPro(tenantId: string, input: {
  type: string; content: string; cardId?: string; contactId?: string;
  channel?: string; direction?: string; createdByAgentId?: string;
  durationSeconds?: number; callOutcome?: string; emailSubject?: string;
  attachments?: string[]; mentions?: string[]; isPrivate?: boolean;
  metadata?: Record<string, unknown>; mediaUrl?: string; mediaType?: string;
  providerMessageId?: string;
}): any {
  const db = getCrmDb();
  const id = nid('crm_act');
  const t = now();
  db.prepare(`INSERT INTO crm_activities
    (id, tenant_id, card_id, contact_id, type, channel, direction, content,
     media_url, media_type, provider_message_id, metadata_json, created_by_agent_id,
     created_at, duration_seconds, call_outcome, email_subject, attachments_json,
     mentions_json, is_private)
    VALUES (?,?,?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?, ?,?)`)
    .run(id, tenantId, input.cardId ?? null, input.contactId ?? null, input.type,
         input.channel ?? null, input.direction ?? null, input.content,
         input.mediaUrl ?? null, input.mediaType ?? null, input.providerMessageId ?? null,
         JSON.stringify(input.metadata || {}), input.createdByAgentId ?? null, t,
         input.durationSeconds ?? null, input.callOutcome ?? null, input.emailSubject ?? null,
         JSON.stringify(input.attachments || []),
         JSON.stringify(input.mentions || []), input.isPrivate ? 1 : 0);
  return { id, tenantId, ...input, createdAt: t };
}

// ═══════════════════════════════════════════════════════════════════════
// ONDA 6 — Lembretes Pro
// ═══════════════════════════════════════════════════════════════════════

function rowToReminderPro(r: any): ReminderPro {
  return {
    id: r.id, tenantId: r.tenant_id, title: r.title,
    description: r.description ?? undefined, dueAt: r.due_at,
    agentId: r.agent_id ?? undefined, contactId: r.contact_id ?? undefined,
    cardId: r.card_id ?? undefined,
    recurrenceRule: r.recurrence_rule ?? undefined,
    recurrenceEndTs: r.recurrence_end_ts ?? undefined,
    snoozeUntil: r.snooze_until ?? undefined,
    channels: JSON.parse(r.channels_json || '["in_app"]'),
    preNotifyMins: r.pre_notify_mins ?? undefined,
    status: (r.status || 'active') as ReminderStatus,
    createdAt: r.created_at,
    completedAt: r.completed_at ?? undefined,
  };
}

export function createReminderPro(tenantId: string, input: {
  title: string; description?: string; dueAt: number;
  agentId?: string; contactId?: string; cardId?: string;
  recurrenceRule?: string; recurrenceEndTs?: number;
  channels?: ReminderChannel[]; preNotifyMins?: number;
}): ReminderPro {
  const db = getCrmDb();
  const id = nid('crm_rem');
  const t = now();
  const channels = input.channels || ['in_app'];
  db.prepare(`INSERT INTO crm_reminders
    (id, tenant_id, card_id, contact_id, agent_id, title, description, due_at,
     status, created_at, completed_at, recurrence_rule, recurrence_end_ts,
     snooze_until, channels_json, pre_notify_mins)
    VALUES (?,?,?,?,?,?,?,?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, tenantId, input.cardId ?? null, input.contactId ?? null, input.agentId ?? null,
         input.title, input.description ?? null, input.dueAt, 'active', t, null,
         input.recurrenceRule ?? null, input.recurrenceEndTs ?? null,
         null, JSON.stringify(channels), input.preNotifyMins ?? null);
  return { id, tenantId, title: input.title, description: input.description, dueAt: input.dueAt,
    agentId: input.agentId, contactId: input.contactId, cardId: input.cardId,
    recurrenceRule: input.recurrenceRule, recurrenceEndTs: input.recurrenceEndTs,
    channels, preNotifyMins: input.preNotifyMins, status: 'active', createdAt: t };
}

export function listRemindersPro(tenantId: string, opts: { agentId?: string; status?: ReminderStatus; dueBefore?: number; limit?: number } = {}): ReminderPro[] {
  const db = getCrmDb();
  const conds: string[] = ['tenant_id = ?'];
  const args: any[] = [tenantId];
  if (opts.agentId) { conds.push('agent_id = ?'); args.push(opts.agentId); }
  if (opts.status) { conds.push('status = ?'); args.push(opts.status); }
  if (opts.dueBefore) { conds.push('due_at <= ?'); args.push(opts.dueBefore); }
  const sql = `SELECT * FROM crm_reminders WHERE ${conds.join(' AND ')} ORDER BY due_at ASC LIMIT ?`;
  args.push(Math.min(opts.limit || 200, 1000));
  return (db.prepare(sql).all(...args) as any[]).map(rowToReminderPro);
}

export function snoozeReminder(tenantId: string, id: string, untilTs: number): ReminderPro | null {
  const db = getCrmDb();
  const r = db.prepare('SELECT * FROM crm_reminders WHERE id=? AND tenant_id=?').get(id, tenantId) as any;
  if (!r) return null;
  db.prepare('UPDATE crm_reminders SET snooze_until=?, due_at=? WHERE id=? AND tenant_id=?')
    .run(untilTs, untilTs, id, tenantId);
  return rowToReminderPro({ ...r, snooze_until: untilTs, due_at: untilTs });
}

// Very lightweight RRULE-ish advancer:
// Suporta FREQ=DAILY|WEEKLY|MONTHLY|YEARLY; INTERVAL=N
function advanceRecurrence(rule: string, from: number): number | null {
  try {
    const parts: Record<string, string> = {};
    rule.split(';').forEach(kv => {
      const [k, v] = kv.split('=');
      if (k) parts[k.trim().toUpperCase()] = (v || '').trim().toUpperCase();
    });
    const freq = parts['FREQ'];
    const interval = parseInt(parts['INTERVAL'] || '1', 10) || 1;
    const d = new Date(from);
    if (freq === 'DAILY') d.setDate(d.getDate() + interval);
    else if (freq === 'WEEKLY') d.setDate(d.getDate() + 7 * interval);
    else if (freq === 'MONTHLY') d.setMonth(d.getMonth() + interval);
    else if (freq === 'YEARLY') d.setFullYear(d.getFullYear() + interval);
    else return null;
    return d.getTime();
  } catch { return null; }
}

export function completeReminderPro(tenantId: string, id: string): ReminderPro | null {
  const db = getCrmDb();
  const r = db.prepare('SELECT * FROM crm_reminders WHERE id=? AND tenant_id=?').get(id, tenantId) as any;
  if (!r) return null;
  if (r.recurrence_rule) {
    const nextAt = advanceRecurrence(r.recurrence_rule, r.due_at);
    if (nextAt && (!r.recurrence_end_ts || nextAt <= r.recurrence_end_ts)) {
      db.prepare('UPDATE crm_reminders SET due_at=?, snooze_until=NULL, status=?, completed_at=? WHERE id=? AND tenant_id=?')
        .run(nextAt, 'active', null, id, tenantId);
      return rowToReminderPro({ ...r, due_at: nextAt, snooze_until: null, status: 'active', completed_at: null });
    }
  }
  db.prepare('UPDATE crm_reminders SET status=?, completed_at=? WHERE id=? AND tenant_id=?')
    .run('done', Date.now(), id, tenantId);
  return rowToReminderPro({ ...r, status: 'done', completed_at: Date.now() });
}

export function logReminderFired(tenantId: string, reminderId: string, channel: string, delivered: boolean, error?: string): void {
  getCrmDb().prepare('INSERT INTO crm_reminder_history (id, tenant_id, reminder_id, fired_at, channel, delivered, error) VALUES (?,?,?,?,?,?,?)')
    .run(nid('crm_remh'), tenantId, reminderId, Date.now(), channel, delivered ? 1 : 0, error ?? null);
}

export function getReminderHistory(tenantId: string, reminderId: string, limit: number = 100): any[] {
  return getCrmDb().prepare('SELECT * FROM crm_reminder_history WHERE tenant_id=? AND reminder_id=? ORDER BY fired_at DESC LIMIT ?')
    .all(tenantId, reminderId, Math.min(limit, 500)) as any[];
}

// ═══════════════════════════════════════════════════════════════════════
// ONDA 7 — Inventario Pro
// ═══════════════════════════════════════════════════════════════════════
import type { InventoryCategory, InventoryVariant, InventoryMovement,
              Proposal, ProposalStatus, ProposalTemplate } from './types.js';

export function createInvCategory(tenantId: string, input: { name: string; parentId?: string }): InventoryCategory {
  const c: InventoryCategory = { id: nid('crm_ivcat'), tenantId, name: input.name, parentId: input.parentId, createdAt: now() };
  getCrmDb().prepare('INSERT INTO crm_inv_categories (id, tenant_id, name, parent_id, created_at) VALUES (?,?,?,?,?)')
    .run(c.id, tenantId, c.name, c.parentId ?? null, c.createdAt);
  return c;
}
export function listInvCategories(tenantId: string): InventoryCategory[] {
  return (getCrmDb().prepare('SELECT * FROM crm_inv_categories WHERE tenant_id=? ORDER BY name').all(tenantId) as any[])
    .map((r: any) => ({ id: r.id, tenantId: r.tenant_id, name: r.name, parentId: r.parent_id ?? undefined, createdAt: r.created_at }));
}
export function deleteInvCategory(tenantId: string, id: string): boolean {
  return getCrmDb().prepare('DELETE FROM crm_inv_categories WHERE id=? AND tenant_id=?').run(id, tenantId).changes > 0;
}

export function createVariant(tenantId: string, input: { inventoryId: string; sku: string; name: string; attrs?: Record<string,string>; stock?: number; priceCents?: number; barcode?: string }): InventoryVariant {
  const v: InventoryVariant = { id: nid('crm_ivvar'), tenantId, inventoryId: input.inventoryId,
    sku: input.sku, name: input.name, attrs: input.attrs || {}, stock: input.stock ?? 0,
    priceCents: input.priceCents, barcode: input.barcode, createdAt: now() };
  getCrmDb().prepare('INSERT INTO crm_inv_variants (id,tenant_id,inventory_id,sku,name,attrs_json,stock,price_cents,barcode,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(v.id, tenantId, v.inventoryId, v.sku, v.name, JSON.stringify(v.attrs), v.stock, v.priceCents ?? null, v.barcode ?? null, v.createdAt);
  return v;
}
export function listVariants(tenantId: string, inventoryId: string): InventoryVariant[] {
  return (getCrmDb().prepare('SELECT * FROM crm_inv_variants WHERE tenant_id=? AND inventory_id=? ORDER BY name').all(tenantId, inventoryId) as any[])
    .map((r: any) => ({ id: r.id, tenantId: r.tenant_id, inventoryId: r.inventory_id,
      sku: r.sku, name: r.name, attrs: JSON.parse(r.attrs_json || '{}'),
      stock: r.stock, priceCents: r.price_cents ?? undefined, barcode: r.barcode ?? undefined, createdAt: r.created_at }));
}
export function deleteVariant(tenantId: string, id: string): boolean {
  return getCrmDb().prepare('DELETE FROM crm_inv_variants WHERE id=? AND tenant_id=?').run(id, tenantId).changes > 0;
}

export function recordMovement(tenantId: string, input: { inventoryId: string; variantId?: string; delta: number; reason?: string; reference?: string; createdByAgentId?: string }): InventoryMovement {
  const db = getCrmDb();
  const m: InventoryMovement = { id: nid('crm_ivmov'), tenantId, inventoryId: input.inventoryId,
    variantId: input.variantId, delta: input.delta, reason: input.reason,
    reference: input.reference, createdByAgentId: input.createdByAgentId, createdAt: now() };
  db.prepare('INSERT INTO crm_inv_movements (id,tenant_id,inventory_id,variant_id,delta,reason,reference,created_by_agent_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(m.id, tenantId, m.inventoryId, m.variantId ?? null, m.delta, m.reason ?? null, m.reference ?? null, m.createdByAgentId ?? null, m.createdAt);
  // Atualiza stock agregado no item OU variante
  if (m.variantId) {
    db.prepare('UPDATE crm_inv_variants SET stock = MAX(0, stock + ?) WHERE id=? AND tenant_id=?').run(m.delta, m.variantId, tenantId);
  }
  db.prepare('UPDATE crm_inventory SET stock = MAX(0, stock + ?), updated_at=? WHERE id=? AND tenant_id=?').run(m.delta, Date.now(), m.inventoryId, tenantId);
  return m;
}

export function listMovements(tenantId: string, inventoryId: string, limit: number = 100): InventoryMovement[] {
  return (getCrmDb().prepare('SELECT * FROM crm_inv_movements WHERE tenant_id=? AND inventory_id=? ORDER BY created_at DESC LIMIT ?')
    .all(tenantId, inventoryId, Math.min(limit, 500)) as any[])
    .map((r: any) => ({ id: r.id, tenantId: r.tenant_id, inventoryId: r.inventory_id,
      variantId: r.variant_id ?? undefined, delta: r.delta, reason: r.reason ?? undefined,
      reference: r.reference ?? undefined, createdByAgentId: r.created_by_agent_id ?? undefined, createdAt: r.created_at }));
}

export function lowStockAlerts(tenantId: string): any[] {
  return getCrmDb().prepare(`
    SELECT id, sku, name, stock, min_stock FROM crm_inventory
    WHERE tenant_id = ? AND min_stock > 0 AND stock <= min_stock
    ORDER BY stock ASC
  `).all(tenantId) as any[];
}

// ═══════════════════════════════════════════════════════════════════════
// ONDA 8 — Proposals (Line Items Pro)
// ═══════════════════════════════════════════════════════════════════════

function rowToProposal(r: any): Proposal {
  return {
    id: r.id, tenantId: r.tenant_id, cardId: r.card_id, version: r.version,
    subtotalCents: r.subtotal_cents, discountCents: r.discount_cents,
    taxCents: r.tax_cents, totalCents: r.total_cents,
    validUntilTs: r.valid_until_ts ?? undefined,
    status: (r.status || 'draft') as ProposalStatus,
    terms: r.terms ?? undefined,
    signedAt: r.signed_at ?? undefined, signedBy: r.signed_by ?? undefined, signedIp: r.signed_ip ?? undefined,
    pdfUrl: r.pdf_url ?? undefined,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export function calcProposalTotals(lineItems: Array<{ unitPriceCents: number; quantity: number; discountCents?: number; discountPercent?: number; taxCents?: number; taxPercent?: number }>): { subtotal: number; discount: number; tax: number; total: number } {
  let subtotal = 0, discount = 0, tax = 0;
  for (const li of lineItems) {
    const base = li.unitPriceCents * li.quantity;
    subtotal += base;
    const disc = (li.discountCents || 0) + (li.discountPercent ? Math.round(base * (li.discountPercent / 100)) : 0);
    discount += disc;
    const netAfterDisc = base - disc;
    const tx = (li.taxCents || 0) + (li.taxPercent ? Math.round(netAfterDisc * (li.taxPercent / 100)) : 0);
    tax += tx;
  }
  const total = Math.max(0, subtotal - discount + tax);
  return { subtotal, discount, tax, total };
}

export function createProposal(tenantId: string, input: { cardId: string; validUntilTs?: number; terms?: string }): Proposal | null {
  const db = getCrmDb();
  const card = db.prepare('SELECT id FROM crm_cards WHERE id=? AND tenant_id=?').get(input.cardId, tenantId);
  if (!card) return null;
  const prevVersion = (db.prepare('SELECT COALESCE(MAX(version),0) m FROM crm_proposals WHERE tenant_id=? AND card_id=?').get(tenantId, input.cardId) as any).m;
  const items = db.prepare('SELECT unit_price_cents, quantity, discount_cents, discount_percent, tax_cents, tax_percent FROM crm_line_items WHERE tenant_id=? AND card_id=?').all(tenantId, input.cardId) as any[];
  const totals = calcProposalTotals(items.map(i => ({
    unitPriceCents: i.unit_price_cents, quantity: i.quantity,
    discountCents: i.discount_cents ?? 0, discountPercent: i.discount_percent ?? 0,
    taxCents: i.tax_cents ?? 0, taxPercent: i.tax_percent ?? 0,
  })));
  const p: Proposal = {
    id: nid('crm_prop'), tenantId, cardId: input.cardId, version: prevVersion + 1,
    subtotalCents: totals.subtotal, discountCents: totals.discount, taxCents: totals.tax, totalCents: totals.total,
    validUntilTs: input.validUntilTs, status: 'draft', terms: input.terms,
    createdAt: now(), updatedAt: now(),
  };
  db.prepare('INSERT INTO crm_proposals (id,tenant_id,card_id,version,subtotal_cents,discount_cents,tax_cents,total_cents,valid_until_ts,status,terms,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(p.id, tenantId, p.cardId, p.version, p.subtotalCents, p.discountCents, p.taxCents, p.totalCents,
         p.validUntilTs ?? null, p.status, p.terms ?? null, p.createdAt, p.updatedAt);
  return p;
}

export function listProposals(tenantId: string, cardId: string): Proposal[] {
  return (getCrmDb().prepare('SELECT * FROM crm_proposals WHERE tenant_id=? AND card_id=? ORDER BY version DESC').all(tenantId, cardId) as any[]).map(rowToProposal);
}

export function getProposal(tenantId: string, id: string): Proposal | null {
  const r = getCrmDb().prepare('SELECT * FROM crm_proposals WHERE id=? AND tenant_id=?').get(id, tenantId) as any;
  return r ? rowToProposal(r) : null;
}

export function updateProposalStatus(tenantId: string, id: string, status: ProposalStatus, meta?: { signedBy?: string; signedIp?: string }): Proposal | null {
  const db = getCrmDb();
  const r = db.prepare('SELECT * FROM crm_proposals WHERE id=? AND tenant_id=?').get(id, tenantId) as any;
  if (!r) return null;
  if (status === 'accepted' && meta?.signedBy) {
    db.prepare('UPDATE crm_proposals SET status=?, signed_at=?, signed_by=?, signed_ip=?, updated_at=? WHERE id=? AND tenant_id=?')
      .run(status, Date.now(), meta.signedBy, meta.signedIp ?? null, Date.now(), id, tenantId);
  } else {
    db.prepare('UPDATE crm_proposals SET status=?, updated_at=? WHERE id=? AND tenant_id=?').run(status, Date.now(), id, tenantId);
  }
  return getProposal(tenantId, id);
}

export function createProposalTemplate(tenantId: string, input: { name: string; items: any[]; defaultTerms?: string; taxPercent?: number; discountPercent?: number; validForDays?: number }): ProposalTemplate {
  const t: ProposalTemplate = { id: nid('crm_ptpl'), tenantId, ...input, createdAt: now() };
  getCrmDb().prepare('INSERT INTO crm_proposal_templates (id,tenant_id,name,items_json,default_terms,tax_percent,discount_percent,valid_for_days,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(t.id, tenantId, t.name, JSON.stringify(t.items), t.defaultTerms ?? null, t.taxPercent ?? null, t.discountPercent ?? null, t.validForDays ?? null, t.createdAt);
  return t;
}
export function listProposalTemplates(tenantId: string): ProposalTemplate[] {
  return (getCrmDb().prepare('SELECT * FROM crm_proposal_templates WHERE tenant_id=? ORDER BY name').all(tenantId) as any[])
    .map((r: any) => ({ id: r.id, tenantId: r.tenant_id, name: r.name,
      items: JSON.parse(r.items_json || '[]'),
      defaultTerms: r.default_terms ?? undefined,
      taxPercent: r.tax_percent ?? undefined,
      discountPercent: r.discount_percent ?? undefined,
      validForDays: r.valid_for_days ?? undefined,
      createdAt: r.created_at }));
}
export function deleteProposalTemplate(tenantId: string, id: string): boolean {
  return getCrmDb().prepare('DELETE FROM crm_proposal_templates WHERE id=? AND tenant_id=?').run(id, tenantId).changes > 0;
}
