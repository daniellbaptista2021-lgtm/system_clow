/**
 * Z-API adapter (Brazilian WhatsApp gateway).
 *
 * Send: POST {baseUrl}/instances/{instanceId}/token/{token}/send-text
 *       /send-image, /send-audio, /send-document, /send-link
 * Receive: webhook POST with {phone, fromMe, text:{message}, image, audio, ...}
 */

import { decryptJson } from '../crypto.js';
import type { Channel2, MediaType } from '../types.js';

export interface ZapiCreds {
  instanceId: string;
  token: string;
  clientToken?: string; // optional account-level token (sent as Client-Token header)
  baseUrl?: string;
}

const DEFAULT_BASE = 'https://api.z-api.io';

function url(creds: ZapiCreds, path: string): string {
  const base = creds.baseUrl || DEFAULT_BASE;
  return `${base.replace(/\/$/, '')}/instances/${creds.instanceId}/token/${creds.token}${path}`;
}

function headers(creds: ZapiCreds): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (creds.clientToken) h['Client-Token'] = creds.clientToken;
  return h;
}

// ─── SEND ───────────────────────────────────────────────────────────────
export interface SendOptions {
  to: string;
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
  const creds = decryptJson<ZapiCreds>(channel.credentialsEncrypted);
  const phone = opts.to.replace(/\D/g, '');

  let path = '/send-text';
  let body: any = { phone };
  if (opts.replyToMessageId) body.messageId = opts.replyToMessageId;

  if (opts.text && !opts.mediaUrl) {
    path = '/send-text';
    body.message = opts.text;
  } else if (opts.mediaUrl && opts.mediaType === 'image') {
    path = '/send-image';
    body.image = opts.mediaUrl;
    if (opts.caption) body.caption = opts.caption;
  } else if (opts.mediaUrl && opts.mediaType === 'audio') {
    path = '/send-audio';
    body.audio = opts.mediaUrl;
    body.viewOnce = false;
  } else if (opts.mediaUrl && opts.mediaType === 'video') {
    path = '/send-video';
    body.video = opts.mediaUrl;
    if (opts.caption) body.caption = opts.caption;
  } else if (opts.mediaUrl && opts.mediaType === 'document') {
    // Z-API uses /send-document/{extension}
    const ext = (opts.mediaFilename?.split('.').pop() || 'pdf').toLowerCase();
    path = `/send-document/${ext}`;
    body.document = opts.mediaUrl;
    body.fileName = opts.mediaFilename || `documento.${ext}`;
  } else {
    return { ok: false, error: { message: 'must provide text or mediaUrl+mediaType' } };
  }

  try {
    const r = await fetch(url(creds, path), {
      method: 'POST',
      headers: headers(creds),
      body: JSON.stringify(body),
    });
    const data: any = await r.json().catch(() => ({}));
    if (!r.ok) {
      return {
        ok: false,
        error: {
          code: r.status,
          message: data?.error || data?.message || `HTTP ${r.status}`,
          raw: data,
        },
      };
    }
    // Z-API returns { id: "...", messageId: "..." }
    return { ok: true, messageId: data?.messageId || data?.id };
  } catch (err: any) {
    return { ok: false, error: { message: err.message || 'fetch_failed' } };
  }
}

/** Mark a previously received message as read. */
export async function markAsRead(channel: Channel2, messageId: string, phone: string): Promise<void> {
  try {
    const creds = decryptJson<ZapiCreds>(channel.credentialsEncrypted);
    await fetch(url(creds, `/read-message`), {
      method: 'POST',
      headers: headers(creds),
      body: JSON.stringify({ phone, messageId }),
    });
  } catch { /* non-critical */ }
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
  mediaUrl?: string; // Z-API gives direct URL, not media_id
  mediaMime?: string;
  mediaFilename?: string;
  fromMe: boolean;
  raw: unknown;
}

export interface WebhookValue {
  messages: ParsedInbound[];
}

/**
 * Parse Z-API webhook payload.
 * Z-API has multiple webhook formats: messageReceived, statusReceived, etc.
 * We focus on incoming messages (`fromMe: false`).
 */
export function parseWebhook(payload: any): WebhookValue {
  const out: WebhookValue = { messages: [] };

  // Z-API "DeliveryCallback" / "ReceivedCallback" / "MessageStatusCallback"
  // Single-message payloads: { phone, fromMe, isStatusReply, text:{message}, ... }
  // Detect array vs single
  const items: any[] = Array.isArray(payload) ? payload : [payload];

  for (const item of items) {
    if (!item) continue;
    // Skip status callbacks
    if (item.type === 'MessageStatusCallback' || item.status) continue;
    if (item.fromMe === true) continue; // ignore our own outbound (we already log it on send)

    const phone = item.phone || item.from || '';
    if (!phone) continue;

    const base: ParsedInbound = {
      fromPhone: phone,
      fromName: item.senderName || item.notifyName || item.chatName,
      messageId: item.messageId || item.id || `zapi_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: (item.momment || item.timestamp || Date.now() / 1000) * (item.momment > 1e12 ? 1 : 1000),
      type: 'text',
      fromMe: false,
      raw: item,
    };
    // Normalize timestamp (Z-API returns seconds OR ms)
    if (base.timestamp < 1e12) base.timestamp *= 1000;

    if (item.text?.message) {
      base.type = 'text';
      base.text = item.text.message;
    } else if (item.image) {
      base.type = 'image';
      base.mediaUrl = item.image.imageUrl || item.image.url;
      base.mediaMime = item.image.mimeType || 'image/jpeg';
      base.caption = item.image.caption;
    } else if (item.audio) {
      base.type = 'audio';
      base.mediaUrl = item.audio.audioUrl || item.audio.url;
      base.mediaMime = item.audio.mimeType || 'audio/ogg';
    } else if (item.video) {
      base.type = 'video';
      base.mediaUrl = item.video.videoUrl || item.video.url;
      base.mediaMime = item.video.mimeType || 'video/mp4';
      base.caption = item.video.caption;
    } else if (item.document) {
      base.type = 'document';
      base.mediaUrl = item.document.documentUrl || item.document.url;
      base.mediaMime = item.document.mimeType || 'application/pdf';
      base.mediaFilename = item.document.fileName || 'documento.pdf';
      base.caption = item.document.caption;
    } else if (item.location) {
      base.type = 'location';
      base.text = `[Localização: ${item.location.latitude},${item.location.longitude}]`;
    } else if (item.contact) {
      base.type = 'text';
      base.text = `[Contato: ${item.contact.displayName || item.contact.vcard?.slice(0, 100)}]`;
    } else {
      // Unknown type — log as text
      base.type = 'text';
      base.text = item.message || `[mensagem ${Object.keys(item).filter(k => !['phone','fromMe','messageId','momment','timestamp'].includes(k))[0] || 'desconhecida'}]`;
    }

    out.messages.push(base);
  }

  return out;
}

/** Download media bytes from a Z-API URL. */
export async function fetchMedia(channel: Channel2, mediaUrl: string): Promise<{ ok: boolean; bytes?: Buffer; mime?: string; error?: string }> {
  try {
    const r = await fetch(mediaUrl);
    if (!r.ok) return { ok: false, error: `download_failed_${r.status}` };
    const ab = await r.arrayBuffer();
    return { ok: true, bytes: Buffer.from(ab), mime: r.headers.get('content-type') || undefined };
  } catch (err: any) {
    return { ok: false, error: err.message || 'fetch_failed' };
  }
}
