/**
 * Collaboration — Onda 21.
 *
 * Three collaboration surfaces + a unified timeline view:
 *   1. Card comments  — discussion threaded under a card, with @mentions
 *   2. Chat rooms     — DM or group chat between agents (room types: dm|group|card|contact)
 *   3. Contact notes  — pinned or timestamped notes on a contact
 *   4. Agent mentions — inbox aggregating @ references from anywhere
 *   5. Unified timeline — contact's full history (activities + comments + chat + notes + tasks + appointments)
 */

import { randomBytes } from 'crypto';
import { getCrmDb } from './schema.js';

function nid(prefix: string): string { return prefix + '_' + randomBytes(6).toString('hex'); }
const now = () => Date.now();

// ─── Mention extraction ─────────────────────────────────────────────────
/** Parse @mentions from content. Supports @agent_id or @agent:<id> or @<name>. */
export function extractMentions(content: string, knownAgents: Array<{ id: string; name: string; email: string }>): string[] {
  const mentions = new Set<string>();
  // 1) Explicit @agent:id syntax
  const explicit = content.matchAll(/@agent:([\w-]+)/g);
  for (const m of explicit) mentions.add(m[1]);
  // 2) @agent_id — matches agent id directly (typically starts with agt_)
  const byId = content.matchAll(/@(agt_[a-z0-9_-]+)/gi);
  for (const m of byId) mentions.add(m[1]);
  // 3) @name — best-effort match on first word of agent name
  const nameMatch = content.matchAll(/@([a-zA-ZÀ-ÿ][a-zA-ZÀ-ÿ0-9_-]+)/g);
  for (const m of nameMatch) {
    const token = m[1].toLowerCase();
    for (const a of knownAgents) {
      const firstName = a.name.split(/\s+/)[0].toLowerCase();
      const emailLocal = a.email.split('@')[0].toLowerCase();
      if (token === firstName || token === emailLocal) mentions.add(a.id);
    }
  }
  return Array.from(mentions);
}

function loadAgents(tenantId: string): Array<{ id: string; name: string; email: string }> {
  return getCrmDb().prepare('SELECT id, name, email FROM crm_agents WHERE tenant_id = ? AND active = 1').all(tenantId) as any[];
}

function fanOutMentions(
  tenantId: string,
  mentionedAgentIds: string[],
  source: { type: 'comment' | 'chat' | 'note' | 'activity'; id: string; cardId?: string; contactId?: string; snippet: string },
): void {
  if (mentionedAgentIds.length === 0) return;
  const db = getCrmDb();
  const stmt = db.prepare(`
    INSERT INTO crm_agent_mentions
      (id, tenant_id, mentioned_agent_id, source_type, source_id, card_id, contact_id, snippet, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const snippet = source.snippet.slice(0, 200);
  const t = now();
  const tx = db.transaction(() => {
    for (const agentId of mentionedAgentIds) {
      stmt.run(nid('crm_mnt'), tenantId, agentId, source.type, source.id, source.cardId ?? null, source.contactId ?? null, snippet, t);
    }
  });
  tx();
}

// ─── Card comments ──────────────────────────────────────────────────────
export interface CardComment {
  id: string; cardId: string; authorAgentId?: string;
  content: string; mentions: string[];
  parentCommentId?: string; editedAt?: number; deletedAt?: number;
  createdAt: number;
}

function rowToComment(r: any): CardComment {
  return {
    id: r.id, cardId: r.card_id, authorAgentId: r.author_agent_id ?? undefined,
    content: r.content, mentions: JSON.parse(r.mentions_json || '[]'),
    parentCommentId: r.parent_comment_id ?? undefined,
    editedAt: r.edited_at ?? undefined, deletedAt: r.deleted_at ?? undefined,
    createdAt: r.created_at,
  };
}

export function listCardComments(tenantId: string, cardId: string): CardComment[] {
  const rows = getCrmDb().prepare(
    'SELECT * FROM crm_card_comments WHERE tenant_id = ? AND card_id = ? AND deleted_at IS NULL ORDER BY created_at ASC'
  ).all(tenantId, cardId) as any[];
  return rows.map(rowToComment);
}

export function createCardComment(tenantId: string, input: {
  cardId: string; content: string; authorAgentId?: string; parentCommentId?: string;
}): CardComment {
  const id = nid('crm_cmt');
  const t = now();
  const mentions = extractMentions(input.content, loadAgents(tenantId));
  getCrmDb().prepare(`
    INSERT INTO crm_card_comments
      (id, tenant_id, card_id, author_agent_id, content, mentions_json, parent_comment_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, tenantId, input.cardId, input.authorAgentId ?? null, input.content,
    JSON.stringify(mentions), input.parentCommentId ?? null, t);

  // Load card for contactId fan-out
  const card = getCrmDb().prepare('SELECT contact_id FROM crm_cards WHERE id = ?').get(input.cardId) as any;
  fanOutMentions(tenantId, mentions, {
    type: 'comment', id, cardId: input.cardId, contactId: card?.contact_id,
    snippet: input.content,
  });
  return rowToComment(getCrmDb().prepare('SELECT * FROM crm_card_comments WHERE id = ?').get(id));
}

export function updateCardComment(tenantId: string, id: string, input: { content: string }): CardComment | null {
  const ex = getCrmDb().prepare('SELECT * FROM crm_card_comments WHERE id = ? AND tenant_id = ?').get(id, tenantId) as any;
  if (!ex) return null;
  const mentions = extractMentions(input.content, loadAgents(tenantId));
  getCrmDb().prepare(
    'UPDATE crm_card_comments SET content = ?, mentions_json = ?, edited_at = ? WHERE id = ? AND tenant_id = ?'
  ).run(input.content, JSON.stringify(mentions), now(), id, tenantId);
  return rowToComment(getCrmDb().prepare('SELECT * FROM crm_card_comments WHERE id = ?').get(id));
}

export function deleteCardComment(tenantId: string, id: string): boolean {
  const r = getCrmDb().prepare('UPDATE crm_card_comments SET deleted_at = ? WHERE id = ? AND tenant_id = ?')
    .run(now(), id, tenantId);
  return r.changes > 0;
}

// ─── Chat rooms & messages ─────────────────────────────────────────────
export type RoomType = 'dm' | 'group' | 'card' | 'contact';

export interface ChatRoom {
  id: string; name: string; type: RoomType; cardId?: string; contactId?: string;
  members: string[]; createdByAgentId?: string; createdAt: number;
}

function rowToRoom(r: any): ChatRoom {
  return {
    id: r.id, name: r.name, type: r.type, cardId: r.card_id ?? undefined,
    contactId: r.contact_id ?? undefined, members: JSON.parse(r.members_json || '[]'),
    createdByAgentId: r.created_by_agent_id ?? undefined, createdAt: r.created_at,
  };
}

export function createChatRoom(tenantId: string, input: {
  name: string; type: RoomType; members: string[]; cardId?: string; contactId?: string; createdByAgentId?: string;
}): ChatRoom {
  const id = nid('crm_room');
  getCrmDb().prepare(`
    INSERT INTO crm_chat_rooms
      (id, tenant_id, name, type, card_id, contact_id, members_json, created_by_agent_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, tenantId, input.name, input.type,
    input.cardId ?? null, input.contactId ?? null,
    JSON.stringify(input.members), input.createdByAgentId ?? null, now());
  return rowToRoom(getCrmDb().prepare('SELECT * FROM crm_chat_rooms WHERE id = ?').get(id));
}

export function listChatRooms(tenantId: string, agentId?: string): ChatRoom[] {
  const rows = getCrmDb().prepare(
    'SELECT * FROM crm_chat_rooms WHERE tenant_id = ? ORDER BY created_at DESC'
  ).all(tenantId) as any[];
  const all = rows.map(rowToRoom);
  if (agentId) return all.filter(r => r.members.includes(agentId));
  return all;
}

export function getChatRoom(tenantId: string, id: string): ChatRoom | null {
  const r = getCrmDb().prepare('SELECT * FROM crm_chat_rooms WHERE id = ? AND tenant_id = ?').get(id, tenantId) as any;
  return r ? rowToRoom(r) : null;
}

export function deleteChatRoom(tenantId: string, id: string): boolean {
  return getCrmDb().prepare('DELETE FROM crm_chat_rooms WHERE id = ? AND tenant_id = ?').run(id, tenantId).changes > 0;
}

export interface ChatMessage {
  id: string; roomId: string; authorAgentId?: string;
  content: string; mentions: string[]; replyToId?: string;
  editedAt?: number; deletedAt?: number; createdAt: number;
}

function rowToMessage(r: any): ChatMessage {
  return {
    id: r.id, roomId: r.room_id, authorAgentId: r.author_agent_id ?? undefined,
    content: r.content, mentions: JSON.parse(r.mentions_json || '[]'),
    replyToId: r.reply_to_id ?? undefined,
    editedAt: r.edited_at ?? undefined, deletedAt: r.deleted_at ?? undefined,
    createdAt: r.created_at,
  };
}

export function postChatMessage(tenantId: string, input: {
  roomId: string; content: string; authorAgentId?: string; replyToId?: string;
}): ChatMessage | null {
  const room = getChatRoom(tenantId, input.roomId);
  if (!room) return null;
  const id = nid('crm_msg');
  const t = now();
  const mentions = extractMentions(input.content, loadAgents(tenantId));
  getCrmDb().prepare(`
    INSERT INTO crm_chat_messages
      (id, room_id, author_agent_id, content, mentions_json, reply_to_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, input.roomId, input.authorAgentId ?? null, input.content,
    JSON.stringify(mentions), input.replyToId ?? null, t);
  fanOutMentions(tenantId, mentions, {
    type: 'chat', id, cardId: room.cardId, contactId: room.contactId,
    snippet: input.content,
  });
  return rowToMessage(getCrmDb().prepare('SELECT * FROM crm_chat_messages WHERE id = ?').get(id));
}

export function listChatMessages(tenantId: string, roomId: string, opts: { before?: number; limit?: number } = {}): ChatMessage[] {
  const room = getChatRoom(tenantId, roomId);
  if (!room) return [];
  const limit = Math.min(500, opts.limit || 100);
  const wh: string[] = ['room_id = ?', 'deleted_at IS NULL'];
  const params: any[] = [roomId];
  if (opts.before) { wh.push('created_at < ?'); params.push(opts.before); }
  const rows = getCrmDb().prepare(
    `SELECT * FROM crm_chat_messages WHERE ${wh.join(' AND ')} ORDER BY created_at DESC LIMIT ?`
  ).all(...params, limit) as any[];
  return rows.map(rowToMessage).reverse(); // return ascending
}

export function markRoomRead(tenantId: string, roomId: string, agentId: string, lastMessageId: string): void {
  const room = getChatRoom(tenantId, roomId);
  if (!room) return;
  getCrmDb().prepare(`
    INSERT INTO crm_chat_reads (room_id, agent_id, last_read_message_id, last_read_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(room_id, agent_id) DO UPDATE SET last_read_message_id = excluded.last_read_message_id, last_read_at = excluded.last_read_at
  `).run(roomId, agentId, lastMessageId, now());
}

export function unreadCounts(tenantId: string, agentId: string): Record<string, number> {
  // For every room the agent is a member of, count messages after last_read_at
  const rooms = listChatRooms(tenantId, agentId);
  const result: Record<string, number> = {};
  const db = getCrmDb();
  for (const room of rooms) {
    const read = db.prepare('SELECT last_read_at FROM crm_chat_reads WHERE room_id = ? AND agent_id = ?').get(room.id, agentId) as any;
    const since = read?.last_read_at || 0;
    const n = (db.prepare(
      'SELECT COUNT(*) n FROM crm_chat_messages WHERE room_id = ? AND created_at > ? AND (author_agent_id IS NULL OR author_agent_id != ?) AND deleted_at IS NULL'
    ).get(room.id, since, agentId) as any).n;
    result[room.id] = n;
  }
  return result;
}

// ─── Contact notes ──────────────────────────────────────────────────────
export interface ContactNote {
  id: string; contactId: string; authorAgentId?: string; content: string;
  pinned: boolean; mentions: string[]; createdAt: number; updatedAt: number;
}

function rowToNote(r: any): ContactNote {
  return {
    id: r.id, contactId: r.contact_id, authorAgentId: r.author_agent_id ?? undefined,
    content: r.content, pinned: r.pinned === 1,
    mentions: JSON.parse(r.mentions_json || '[]'),
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export function listContactNotes(tenantId: string, contactId: string): ContactNote[] {
  const rows = getCrmDb().prepare(
    'SELECT * FROM crm_contact_notes WHERE tenant_id = ? AND contact_id = ? ORDER BY pinned DESC, created_at DESC'
  ).all(tenantId, contactId) as any[];
  return rows.map(rowToNote);
}

export function createContactNote(tenantId: string, input: {
  contactId: string; content: string; authorAgentId?: string; pinned?: boolean;
}): ContactNote {
  const id = nid('crm_note');
  const t = now();
  const mentions = extractMentions(input.content, loadAgents(tenantId));
  getCrmDb().prepare(`
    INSERT INTO crm_contact_notes
      (id, tenant_id, contact_id, author_agent_id, content, pinned, mentions_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, tenantId, input.contactId, input.authorAgentId ?? null, input.content,
    input.pinned ? 1 : 0, JSON.stringify(mentions), t, t);
  fanOutMentions(tenantId, mentions, {
    type: 'note', id, contactId: input.contactId, snippet: input.content,
  });
  return rowToNote(getCrmDb().prepare('SELECT * FROM crm_contact_notes WHERE id = ?').get(id));
}

export function updateContactNote(tenantId: string, id: string, input: { content?: string; pinned?: boolean }): ContactNote | null {
  const ex = getCrmDb().prepare('SELECT * FROM crm_contact_notes WHERE id = ? AND tenant_id = ?').get(id, tenantId) as any;
  if (!ex) return null;
  const content = input.content ?? ex.content;
  const pinned = input.pinned !== undefined ? (input.pinned ? 1 : 0) : ex.pinned;
  const mentions = input.content !== undefined
    ? extractMentions(content, loadAgents(tenantId))
    : JSON.parse(ex.mentions_json || '[]');
  getCrmDb().prepare(
    'UPDATE crm_contact_notes SET content = ?, pinned = ?, mentions_json = ?, updated_at = ? WHERE id = ? AND tenant_id = ?'
  ).run(content, pinned, JSON.stringify(mentions), now(), id, tenantId);
  return rowToNote(getCrmDb().prepare('SELECT * FROM crm_contact_notes WHERE id = ?').get(id));
}

export function deleteContactNote(tenantId: string, id: string): boolean {
  return getCrmDb().prepare('DELETE FROM crm_contact_notes WHERE id = ? AND tenant_id = ?').run(id, tenantId).changes > 0;
}

// ─── Mentions inbox ────────────────────────────────────────────────────
export function agentMentions(tenantId: string, agentId: string, opts: { unreadOnly?: boolean; limit?: number } = {}): any[] {
  const limit = Math.min(500, opts.limit || 50);
  const wh = ['tenant_id = ?', 'mentioned_agent_id = ?'];
  const params: any[] = [tenantId, agentId];
  if (opts.unreadOnly) wh.push('read_at IS NULL');
  return getCrmDb().prepare(
    `SELECT * FROM crm_agent_mentions WHERE ${wh.join(' AND ')} ORDER BY created_at DESC LIMIT ?`
  ).all(...params, limit) as any[];
}

export function unreadMentionsCount(tenantId: string, agentId: string): number {
  const r = getCrmDb().prepare(
    'SELECT COUNT(*) n FROM crm_agent_mentions WHERE tenant_id = ? AND mentioned_agent_id = ? AND read_at IS NULL'
  ).get(tenantId, agentId) as any;
  return r.n;
}

export function markMentionRead(tenantId: string, agentId: string, mentionId: string): boolean {
  return getCrmDb().prepare(
    'UPDATE crm_agent_mentions SET read_at = ? WHERE id = ? AND tenant_id = ? AND mentioned_agent_id = ?'
  ).run(now(), mentionId, tenantId, agentId).changes > 0;
}

export function markAllMentionsRead(tenantId: string, agentId: string): number {
  return getCrmDb().prepare(
    'UPDATE crm_agent_mentions SET read_at = ? WHERE tenant_id = ? AND mentioned_agent_id = ? AND read_at IS NULL'
  ).run(now(), tenantId, agentId).changes;
}

// ─── Unified timeline ──────────────────────────────────────────────────
export interface TimelineEntry {
  kind: 'activity' | 'comment' | 'note' | 'task' | 'appointment';
  id: string;
  ts: number;
  authorAgentId?: string;
  title?: string;
  content?: string;
  metadata?: Record<string, any>;
}

/** Merge all collaboration surfaces for a given contact, newest first. */
export function contactTimeline(tenantId: string, contactId: string, opts: { limit?: number } = {}): TimelineEntry[] {
  const db = getCrmDb();
  const limit = Math.min(1000, opts.limit || 200);
  const entries: TimelineEntry[] = [];

  // Activities
  const acts = db.prepare(
    'SELECT id, created_at, created_by_agent_id, type, channel, content, direction FROM crm_activities WHERE tenant_id = ? AND contact_id = ? ORDER BY created_at DESC LIMIT ?'
  ).all(tenantId, contactId, limit) as any[];
  for (const a of acts) entries.push({
    kind: 'activity', id: a.id, ts: a.created_at, authorAgentId: a.created_by_agent_id ?? undefined,
    content: a.content, metadata: { type: a.type, channel: a.channel, direction: a.direction },
  });

  // Notes
  const notes = db.prepare(
    'SELECT id, created_at, author_agent_id, content, pinned FROM crm_contact_notes WHERE tenant_id = ? AND contact_id = ? ORDER BY created_at DESC LIMIT ?'
  ).all(tenantId, contactId, limit) as any[];
  for (const n of notes) entries.push({
    kind: 'note', id: n.id, ts: n.created_at, authorAgentId: n.author_agent_id ?? undefined,
    content: n.content, metadata: { pinned: n.pinned === 1 },
  });

  // Card comments on cards linked to this contact
  const comments = db.prepare(`
    SELECT cmt.id, cmt.created_at, cmt.author_agent_id, cmt.content, cmt.card_id, cd.title AS card_title
    FROM crm_card_comments cmt
    JOIN crm_cards cd ON cd.id = cmt.card_id
    WHERE cmt.tenant_id = ? AND cd.contact_id = ? AND cmt.deleted_at IS NULL
    ORDER BY cmt.created_at DESC LIMIT ?
  `).all(tenantId, contactId, limit) as any[];
  for (const c of comments) entries.push({
    kind: 'comment', id: c.id, ts: c.created_at, authorAgentId: c.author_agent_id ?? undefined,
    content: c.content, metadata: { cardId: c.card_id, cardTitle: c.card_title },
  });

  // Tasks (open + completed)
  const tasks = db.prepare(
    'SELECT id, created_at, title, description, type, priority, status, due_at, assigned_to_agent_id FROM crm_tasks WHERE tenant_id = ? AND contact_id = ? ORDER BY created_at DESC LIMIT ?'
  ).all(tenantId, contactId, limit) as any[];
  for (const t of tasks) entries.push({
    kind: 'task', id: t.id, ts: t.created_at, authorAgentId: t.assigned_to_agent_id ?? undefined,
    title: t.title, content: t.description,
    metadata: { type: t.type, priority: t.priority, status: t.status, dueAt: t.due_at },
  });

  // Appointments
  const appts = db.prepare(
    'SELECT id, created_at, title, description, starts_at, ends_at, agent_id, status, meeting_url FROM crm_appointments WHERE tenant_id = ? AND contact_id = ? ORDER BY starts_at DESC LIMIT ?'
  ).all(tenantId, contactId, limit) as any[];
  for (const a of appts) entries.push({
    kind: 'appointment', id: a.id, ts: a.created_at, authorAgentId: a.agent_id ?? undefined,
    title: a.title, content: a.description,
    metadata: { startsAt: a.starts_at, endsAt: a.ends_at, status: a.status, meetingUrl: a.meeting_url },
  });

  return entries.sort((a, b) => b.ts - a.ts).slice(0, limit);
}
