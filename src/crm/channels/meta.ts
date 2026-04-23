/**
 * Meta WhatsApp Cloud API adapter.
 *
 * Send: POST graph.facebook.com/{ver}/{phone_id}/messages
 * Receive: webhook payload with messages[]
 * Media: GET graph.facebook.com/{ver}/{media_id} to get download URL
 */

import { decryptJson } from '../crypto.js';
import type { Channel2, MediaType } from '../types.js';

export interface MetaCreds {
  accessToken: string;
  phoneNumberId: string;
  businessAccountId?: string;
  appId?: string;
  verifyToken?: string;
  apiVersion?: string;
  appSecret?: string; // for signature verification (optional but recommended)
}

const DEFAULT_API_VERSION = 'v22.0';

function endpoint(creds: MetaCreds, path: string): string {
  const ver = creds.apiVersion || DEFAULT_API_VERSION;
  return `https://graph.facebook.com/${ver}${path}`;
}

// ─── SEND ───────────────────────────────────────────────────────────────
export interface SendOptions {
  to: string; // E.164 (digits only)
  text?: string;
  mediaUrl?: string;
  mediaType?: 'image' | 'audio' | 'document' | 'video';
  mediaFilename?: string;
  caption?: string;
  replyToMessageId?: string;
}

export interface SendResult {
  ok: boolean;
  messageId?: string;
  error?: { code?: number; message: string; raw?: unknown };
}

export async function sendMessage(channel: Channel2, opts: SendOptions): Promise<SendResult> {
  const creds = decryptJson<MetaCreds>(channel.credentialsEncrypted);
  const url = endpoint(creds, `/${creds.phoneNumberId}/messages`);

  let body: any = { messaging_product: 'whatsapp', to: opts.to.replace(/\D/g, '') };
  if (opts.replyToMessageId) {
    body.context = { message_id: opts.replyToMessageId };
  }

  if (opts.text && !opts.mediaUrl) {
    body.type = 'text';
    body.text = { body: opts.text, preview_url: true };
  } else if (opts.mediaUrl && opts.mediaType) {
    body.type = opts.mediaType;
    body[opts.mediaType] = { link: opts.mediaUrl };
    if (opts.caption && opts.mediaType !== 'audio') body[opts.mediaType].caption = opts.caption;
    if (opts.mediaFilename && opts.mediaType === 'document') body.document.filename = opts.mediaFilename;
  } else {
    return { ok: false, error: { message: 'must provide text or mediaUrl+mediaType' } };
  }

  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${creds.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const data: any = await r.json().catch(() => ({}));
    if (!r.ok) {
      return {
        ok: false,
        error: {
          code: data?.error?.code,
          message: data?.error?.message || `HTTP ${r.status}`,
          raw: data,
        },
      };
    }
    const messageId = data?.messages?.[0]?.id;
    return { ok: true, messageId };
  } catch (err: any) {
    return { ok: false, error: { message: err.message || 'fetch_failed' } };
  }
}

/** Mark a previously received message as read (blue checks). */
export async function markAsRead(channel: Channel2, messageId: string): Promise<void> {
  try {
    const creds = decryptJson<MetaCreds>(channel.credentialsEncrypted);
    const url = endpoint(creds, `/${creds.phoneNumberId}/messages`);
    await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${creds.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: messageId }),
    });
  } catch { /* non-critical */ }
}

/** Resolve media_id → downloadable URL + bytes. */
export async function fetchMedia(channel: Channel2, mediaId: string): Promise<{ ok: boolean; bytes?: Buffer; mime?: string; error?: string }> {
  const creds = decryptJson<MetaCreds>(channel.credentialsEncrypted);
  try {
    const metaResp = await fetch(endpoint(creds, `/${mediaId}`), {
      headers: { 'Authorization': `Bearer ${creds.accessToken}` },
    });
    if (!metaResp.ok) return { ok: false, error: `meta_lookup_failed_${metaResp.status}` };
    const meta: any = await metaResp.json();
    if (!meta?.url) return { ok: false, error: 'no_url_in_meta_response' };

    const dlResp = await fetch(meta.url, {
      headers: { 'Authorization': `Bearer ${creds.accessToken}` },
    });
    if (!dlResp.ok) return { ok: false, error: `download_failed_${dlResp.status}` };
    const ab = await dlResp.arrayBuffer();
    return { ok: true, bytes: Buffer.from(ab), mime: meta.mime_type };
  } catch (err: any) {
    return { ok: false, error: err.message || 'fetch_failed' };
  }
}

// ─── WEBHOOK PARSING ────────────────────────────────────────────────────
export interface ParsedInbound {
  fromPhone: string;
  fromName?: string;
  messageId: string;
  timestamp: number;
  type: MediaType;
  text?: string;
  caption?: string;
  mediaId?: string;
  mediaMime?: string;
  mediaFilename?: string;
  location?: { lat: number; lng: number; name?: string; address?: string };
  context?: { messageId?: string }; // reply-to
  raw: unknown;
}

export interface WebhookValue {
  messages: ParsedInbound[];
  statuses: Array<{ messageId: string; status: string; timestamp: number; recipientPhone: string }>;
  phoneNumberId?: string;
}

/**
 * Parse a Meta webhook POST payload (from `messages` field) into a normalized shape.
 * Returns null if it's not a message webhook (could be status update, etc).
 */
export function parseWebhook(payload: any): WebhookValue {
  const out: WebhookValue = { messages: [], statuses: [] };
  if (!payload?.entry) return out;

  for (const entry of payload.entry) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      out.phoneNumberId = value?.metadata?.phone_number_id || out.phoneNumberId;

      // Status updates (delivered/read/failed)
      for (const st of value.statuses || []) {
        out.statuses.push({
          messageId: st.id,
          status: st.status,
          timestamp: parseInt(st.timestamp, 10) * 1000 || Date.now(),
          recipientPhone: st.recipient_id || '',
        });
      }

      // Inbound messages
      const contacts: any[] = value.contacts || [];
      const contactByWa: Record<string, any> = {};
      for (const c of contacts) contactByWa[c.wa_id] = c;

      for (const msg of value.messages || []) {
        const fromPhone = msg.from;
        const contact = contactByWa[fromPhone];
        const baseTs = parseInt(msg.timestamp, 10) * 1000 || Date.now();
        const base: ParsedInbound = {
          fromPhone,
          fromName: contact?.profile?.name,
          messageId: msg.id,
          timestamp: baseTs,
          type: 'text',
          context: msg.context ? { messageId: msg.context.id } : undefined,
          raw: msg,
        };

        if (msg.type === 'text') {
          base.type = 'text';
          base.text = msg.text?.body || '';
        } else if (msg.type === 'image') {
          base.type = 'image';
          base.mediaId = msg.image?.id;
          base.mediaMime = msg.image?.mime_type;
          base.caption = msg.image?.caption;
        } else if (msg.type === 'audio') {
          base.type = 'audio';
          base.mediaId = msg.audio?.id;
          base.mediaMime = msg.audio?.mime_type;
        } else if (msg.type === 'video') {
          base.type = 'video';
          base.mediaId = msg.video?.id;
          base.mediaMime = msg.video?.mime_type;
          base.caption = msg.video?.caption;
        } else if (msg.type === 'document') {
          base.type = 'document';
          base.mediaId = msg.document?.id;
          base.mediaMime = msg.document?.mime_type;
          base.mediaFilename = msg.document?.filename;
          base.caption = msg.document?.caption;
        } else if (msg.type === 'location') {
          base.type = 'location';
          base.location = {
            lat: msg.location?.latitude, lng: msg.location?.longitude,
            name: msg.location?.name, address: msg.location?.address,
          };
        } else if (msg.type === 'interactive') {
          base.type = 'interactive';
          const reply = msg.interactive?.button_reply || msg.interactive?.list_reply;
          base.text = reply?.title || reply?.id || JSON.stringify(msg.interactive);
        } else {
          base.type = 'text';
          base.text = `[${msg.type} unsupported]`;
        }

        out.messages.push(base);
      }
    }
  }
  return out;
}

/** Verify Meta webhook signature (X-Hub-Signature-256: sha256=...). */
export async function verifySignature(rawBody: string, header: string | undefined, appSecret: string): Promise<boolean> {
  if (!header || !appSecret) return false;
  const expected = header.startsWith('sha256=') ? header.slice(7) : header;
  const { createHmac, timingSafeEqual } = await import('crypto');
  const computed = createHmac('sha256', appSecret).update(rawBody, 'utf-8').digest('hex');
  if (computed.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(computed, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}
