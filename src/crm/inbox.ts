/**
 * Inbox orchestrator — handles inbound messages from any channel.
 *
 * Responsibilities:
 *   1. Identify channel by webhook secret (validates ownership)
 *   2. Upsert contact based on phone (creates if new)
 *   3. Find or create an "open" card for the contact (in default board)
 *   4. Download media (if any) → save to disk → store URL in activity
 *   5. Log message_in activity to the timeline
 *   6. Mark as read (best-effort, non-blocking)
 *   7. Update channel.lastInboundAt
 */

import * as store from './store.js';
import { getCrmDb } from './schema.js';
import * as meta from './channels/meta.js';
import * as zapi from './channels/zapi.js';
import { saveMedia } from './media.js';
import * as automations from './automations.js';
import type { Channel2, Activity, MediaType } from './types.js';

export interface InboundResult {
  ok: boolean;
  contactId?: string;
  cardId?: string;
  activityId?: string;
  error?: string;
}

/**
 * Process a single inbound message from any channel.
 * Idempotent on providerMessageId — if same message arrives twice, we skip.
 */
export async function ingestInbound(channel: Channel2, msg: {
  fromPhone: string;
  fromName?: string;
  messageId: string;
  type: MediaType;
  text?: string;
  caption?: string;
  mediaId?: string; // Meta only (id, must download via API)
  mediaUrl?: string; // Z-API only (direct URL)
  mediaMime?: string;
  mediaFilename?: string;
  context?: { messageId?: string };
  timestamp: number;
}): Promise<InboundResult> {
  const tenantId = channel.tenantId;

  // 1. Idempotency: skip if we already logged this provider message id
  if (msg.messageId && wasAlreadyLogged(tenantId, msg.messageId)) {
    return { ok: true, error: 'duplicate_skipped' };
  }

  // 2. Upsert contact
  const contact = store.upsertContactByPhone(tenantId, msg.fromPhone, {
    name: msg.fromName,
    source: channel.type === 'meta' ? 'whatsapp_meta' : 'whatsapp_zapi',
  });

  // 3. Find or create card on the default sales board
  const card = await findOrCreateOpenCardForContact(tenantId, contact.id, msg.fromName || msg.fromPhone);

  // 4. Download/save media if applicable
  let mediaUrl: string | undefined;
  let savedFilename: string | undefined;
  if (msg.type !== 'text' && msg.type !== 'location' && msg.type !== 'interactive') {
    const result = await downloadAndSave(channel, msg, tenantId);
    if (result) {
      mediaUrl = result.publicUrl;
      savedFilename = result.filename;
    }
  }

  // 5. Build activity content (visible string for timeline preview)
  let content = '';
  if (msg.type === 'text' || msg.type === 'interactive') {
    content = msg.text || '';
  } else if (msg.type === 'location') {
    content = `[Localização compartilhada]`;
  } else {
    const labelMap: Record<string, string> = {
      image: 'Imagem', audio: 'Áudio', video: 'Vídeo', document: msg.mediaFilename || 'Documento',
    };
    content = `[${labelMap[msg.type] || msg.type}]${msg.caption ? ': ' + msg.caption : ''}`;
  }

  // 6. Log activity
  const activity = store.logActivity(tenantId, {
    cardId: card?.id, contactId: contact.id,
    type: 'message_in',
    channel: channel.type === 'meta' ? 'whatsapp_meta' : 'whatsapp_zapi',
    direction: 'in',
    content,
    mediaUrl,
    mediaType: msg.type,
    providerMessageId: msg.messageId,
    metadata: {
      channelId: channel.id,
      channelName: channel.name,
      fromPhone: msg.fromPhone,
      timestamp: msg.timestamp,
      ...(msg.context ? { replyToMessageId: msg.context.messageId } : {}),
      ...(savedFilename ? { savedFilename } : {}),
    },
  });

  // 7. Update channel last inbound (non-critical)
  try {
    store.updateChannel(tenantId, channel.id, { lastInboundAt: Date.now(), status: 'active' });
  } catch { /* noop */ }

  // 8. Mark as read (best-effort, async)
  if (channel.type === 'meta') {
    void meta.markAsRead(channel, msg.messageId);
  } else if (channel.type === 'zapi') {
    void zapi.markAsRead(channel, msg.messageId, msg.fromPhone);
  }

  void automations.emit({ trigger: 'inbound_message', tenantId, cardId: card?.id, contactId: contact.id, activityId: activity.id, text: msg.text || msg.caption || '' });
  return { ok: true, contactId: contact.id, cardId: card?.id, activityId: activity.id };
}

/** Check if a provider message id was already logged in the last 7 days. */
function wasAlreadyLogged(tenantId: string, providerMessageId: string): boolean {
  const acts = store.listActivitiesByContact(tenantId, '__never__', 0); // tiny query, just for db ref
  // Direct check via DB — store doesn't expose raw query, do via list scan as fallback
  // Cleaner: dedicated lookup
  return checkProviderId(tenantId, providerMessageId);
}

function checkProviderId(tenantId: string, pid: string): boolean {
  const db = getCrmDb();
  const r = db.prepare(`
    SELECT 1 FROM crm_activities WHERE tenant_id = ? AND provider_message_id = ? LIMIT 1
  `).get(tenantId, pid);
  return !!r;
}

/**
 * Find an "open" card for the contact (one that's not in a terminal column).
 * If none exists, create a fresh one on the first non-terminal column of the
 * default sales board.
 */
async function findOrCreateOpenCardForContact(tenantId: string, contactId: string, displayTitle: string) {
  const cards = store.listCardsByContact(tenantId, contactId);
  // Try to find a card whose column isn't terminal
  for (const card of cards) {
    const cols = store.listColumns(tenantId, card.boardId);
    const col = cols.find(c => c.id === card.columnId);
    if (col && !col.isTerminal) return card;
  }
  // Create new card on default board (Sales)
  const boards = store.listBoards(tenantId);
  let board = boards.find(b => b.type === 'sales') || boards[0];
  if (!board) {
    board = store.seedDefaultBoards(tenantId);
  }
  const cols = store.listColumns(tenantId, board.id);
  const firstCol = cols.find(c => !c.isTerminal) || cols[0];
  if (!firstCol) return null;
  return store.createCard(tenantId, {
    boardId: board.id,
    columnId: firstCol.id,
    title: displayTitle,
    contactId,
  });
}

async function downloadAndSave(channel: Channel2, msg: any, tenantId: string) {
  let bytes: Buffer | undefined;
  let mime = msg.mediaMime;
  try {
    if (channel.type === 'meta' && msg.mediaId) {
      const res = await meta.fetchMedia(channel, msg.mediaId);
      if (!res.ok) return null;
      bytes = res.bytes;
      mime = res.mime || mime;
    } else if (channel.type === 'zapi' && msg.mediaUrl) {
      const res = await zapi.fetchMedia(channel, msg.mediaUrl);
      if (!res.ok) return null;
      bytes = res.bytes;
      mime = res.mime || mime;
    }
  } catch { return null; }
  if (!bytes) return null;
  return saveMedia(tenantId, bytes, {
    mime, mediaType: msg.type as MediaType, suggestedFilename: msg.mediaFilename,
  });
}

// ─── OUTBOUND: send + log ───────────────────────────────────────────────
export interface SendInbox {
  to: string;
  text?: string;
  mediaUrl?: string;
  mediaType?: 'image' | 'audio' | 'document' | 'video';
  mediaFilename?: string;
  caption?: string;
  cardId?: string;
  contactId?: string;
  agentId?: string;
  replyToMessageId?: string;
}

export interface SendInboxResult {
  ok: boolean;
  messageId?: string;
  activityId?: string;
  error?: string;
}

export async function sendOutbound(channel: Channel2, opts: SendInbox): Promise<SendInboxResult> {
  const tenantId = channel.tenantId;
  let result: { ok: boolean; messageId?: string; error?: any };
  if (channel.type === 'meta') {
    result = await meta.sendMessage(channel, opts);
  } else {
    result = await zapi.sendMessage(channel, opts);
  }
  if (!result.ok) {
    return { ok: false, error: result.error?.message || 'send_failed' };
  }

  // Resolve contact (by phone if not provided)
  let contactId = opts.contactId;
  if (!contactId) {
    const c = store.findContactByPhone(tenantId, opts.to);
    if (c) contactId = c.id;
    else {
      const created = store.createContact(tenantId, { name: opts.to, phone: opts.to, source: 'outbound' });
      contactId = created.id;
    }
  }

  // Build content preview
  let content = opts.text || '';
  if (!content && opts.mediaType) {
    content = `[${opts.mediaType}]${opts.caption ? ': ' + opts.caption : ''}`;
  }

  const activity = store.logActivity(tenantId, {
    cardId: opts.cardId, contactId,
    type: 'message_out',
    channel: channel.type === 'meta' ? 'whatsapp_meta' : 'whatsapp_zapi',
    direction: 'out',
    content,
    mediaUrl: opts.mediaUrl,
    mediaType: opts.mediaType as MediaType,
    providerMessageId: result.messageId,
    createdByAgentId: opts.agentId,
    metadata: { channelId: channel.id, channelName: channel.name, toPhone: opts.to },
  });
  void automations.emit({ trigger: 'outbound_message', tenantId, cardId: opts.cardId, contactId, activityId: activity.id, text: opts.text || '' });
  return { ok: true, messageId: result.messageId, activityId: activity.id };
}
