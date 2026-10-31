/**
 * Durable, tenant-scoped conversation metadata for the web agent.
 *
 * The QueryEngine transcript is already the source of truth and survives
 * process restarts.  This module turns those JSONL transcripts into the
 * permanent conversation list used by the CRM sidebar.
 */
import {
  deleteSessionTranscript,
  listSessions,
  loadTranscriptFile,
  saveSessionMetadataForSession,
} from '../utils/session/sessionStorage.js';

export interface WebConversation {
  id: string;
  title: string;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  compactedCount: number;
}

export interface WebConversationMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: number;
}

type ConversationMeta = {
  title?: string;
  pinned?: boolean;
  updatedAt?: number;
};

function tenantIdFrom(entries: any[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.type === 'session_start' && entry.value && typeof entry.value === 'object') {
      const tenantId = entry.value.tenantId;
      if (typeof tenantId === 'string' && tenantId) return tenantId;
    }
  }
  return undefined;
}

function conversationMetaFrom(entries: any[]): ConversationMeta {
  const meta: ConversationMeta = {};
  for (const entry of entries) {
    if (entry?.type !== 'conversation_meta' || !entry.value || typeof entry.value !== 'object') continue;
    if (typeof entry.value.title === 'string') meta.title = entry.value.title;
    if (typeof entry.value.pinned === 'boolean') meta.pinned = entry.value.pinned;
    if (typeof entry.value.updatedAt === 'number') meta.updatedAt = entry.value.updatedAt;
  }
  return meta;
}

function messagesFrom(entries: any[]): WebConversationMessage[] {
  const messages: WebConversationMessage[] = [];
  for (const entry of entries) {
    if ((entry?.role !== 'user' && entry?.role !== 'assistant') || typeof entry.content !== 'string') continue;
    messages.push({
      id: typeof entry.uuid === 'string' ? entry.uuid : `${entry.role}-${entry.timestamp || Date.now()}-${messages.length}`,
      role: entry.role,
      text: entry.content,
      createdAt: typeof entry.timestamp === 'number' ? entry.timestamp : Date.now(),
    });
  }
  return messages;
}

function cleanTitle(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const title = value.trim().replace(/\s+/g, ' ').slice(0, 72);
  return title || undefined;
}

function buildConversation(sessionId: string, entries: any[], fallbackUpdatedAt: number): WebConversation {
  const messages = messagesFrom(entries);
  const meta = conversationMetaFrom(entries);
  const start = entries.find((entry) => entry?.type === 'session_start');
  const createdAt = typeof start?.value?.createdAt === 'number'
    ? start.value.createdAt
    : (typeof entries[0]?.timestamp === 'number' ? entries[0].timestamp : fallbackUpdatedAt);
  const lastMessageAt = messages.at(-1)?.createdAt || createdAt;
  const firstUser = messages.find((message) => message.role === 'user');
  return {
    id: sessionId,
    title: cleanTitle(meta.title) || cleanTitle(firstUser?.text) || 'Nova conversa',
    pinned: meta.pinned === true,
    createdAt,
    updatedAt: Math.max(lastMessageAt, meta.updatedAt || 0, fallbackUpdatedAt),
    messageCount: messages.length,
    compactedCount: entries.filter((entry) => entry?.type === 'conversation_compacted').length,
  };
}

export async function listTenantConversations(tenantId: string, limit = 100): Promise<WebConversation[]> {
  const sessions = await listSessions(500);
  const conversations: WebConversation[] = [];
  for (const session of sessions) {
    const entries = await loadTranscriptFile(session.sessionId).catch(() => []);
    if (tenantIdFrom(entries) !== tenantId) continue;
    conversations.push(buildConversation(session.sessionId, entries, session.mtime.getTime()));
  }
  return conversations
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)
    .slice(0, limit);
}

export async function getTenantConversation(
  tenantId: string,
  sessionId: string,
): Promise<{ conversation: WebConversation; messages: WebConversationMessage[] } | null> {
  const entries = await loadTranscriptFile(sessionId).catch(() => []);
  if (!entries.length || tenantIdFrom(entries) !== tenantId) return null;
  const lastTimestamp = typeof entries.at(-1)?.timestamp === 'number' ? entries.at(-1).timestamp : 0;
  return {
    conversation: buildConversation(sessionId, entries, lastTimestamp),
    messages: messagesFrom(entries),
  };
}

export async function updateTenantConversation(
  tenantId: string,
  sessionId: string,
  patch: { title?: unknown; pinned?: unknown },
): Promise<WebConversation | null> {
  const current = await getTenantConversation(tenantId, sessionId);
  if (!current) return null;
  const meta: ConversationMeta = { updatedAt: Date.now() };
  if (patch.title !== undefined) {
    const title = cleanTitle(patch.title);
    if (!title) throw new Error('O nome da conversa não pode ficar vazio.');
    meta.title = title;
  }
  if (patch.pinned !== undefined) meta.pinned = patch.pinned === true;
  await saveSessionMetadataForSession(sessionId, 'conversation_meta', meta);
  const updated = await getTenantConversation(tenantId, sessionId);
  return updated?.conversation || null;
}

export async function markConversationCompacted(tenantId: string, sessionId: string): Promise<void> {
  const current = await getTenantConversation(tenantId, sessionId);
  if (!current) return;
  await saveSessionMetadataForSession(sessionId, 'conversation_compacted', { at: Date.now() });
}

export async function deleteTenantConversation(tenantId: string, sessionId: string): Promise<boolean> {
  const current = await getTenantConversation(tenantId, sessionId);
  if (!current) return false;
  return deleteSessionTranscript(sessionId);
}
