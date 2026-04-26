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
  mediaMime?: string;
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

  // Onda 45: helper pra converter /v1/crm/media/... em data:base64
  // Z-API nao consegue baixar URLs internas (auth-protected), entao
  // enviamos o conteudo inline como base64 quando o mediaUrl aponta pro
  // nosso endpoint interno.
  async function resolveMediaForZapi(mediaUrl: string, mediaMime?: string, mediaType?: string): Promise<string> {
    let bytes: Buffer | null = null;
    let mime = mediaMime || 'application/octet-stream';
    // Se for URL externa (https://...), passar direto — Z-API faz fetch
    if (/^https?:\/\//i.test(mediaUrl)) return mediaUrl;
    // URL interna: extrair tenantId/date/filename e ler do disk
    const m = mediaUrl.match(/\/v1\/crm\/media\/([^/]+)\/([^/]+)\/([^/?]+)/);
    if (!m) return mediaUrl;
    const [, tid, date, filename] = m;
    try {
      const { readMedia } = await import('../media.js');
      const file = readMedia(tid, date, filename);
      if (!file) return mediaUrl;
      bytes = file.bytes;
      mime = mediaMime || file.mime || 'application/octet-stream';
    } catch (err) {
      console.warn('[zapi] resolveMediaForZapi read failed:', (err as any)?.message);
      return mediaUrl;
    }
    // Onda 47: audio webm precisa virar ogg/opus pro WhatsApp tocar.
    // Browser MediaRecorder produz webm/opus. Z-API repassa, mas WA mobile
    // mostra audio "vazio". Converter via ffmpeg.
    if (mediaType === 'audio' && /webm|ogg/i.test(mime)) {
      try {
        const { spawn } = await import('node:child_process');
        const converted = await new Promise<Buffer | null>((resolve) => {
          const ff = spawn('ffmpeg', [
            '-i', 'pipe:0',
            '-c:a', 'libopus',
            '-b:a', '32k',
            '-ar', '16000',
            '-ac', '1',
            '-f', 'ogg',
            'pipe:1',
          ], { stdio: ['pipe', 'pipe', 'pipe'] });
          const chunks: Buffer[] = [];
          ff.stdout.on('data', (d: Buffer) => chunks.push(d));
          ff.on('error', () => resolve(null));
          ff.on('close', (code: number) => {
            if (code === 0 && chunks.length > 0) resolve(Buffer.concat(chunks));
            else resolve(null);
          });
          ff.stdin.write(bytes);
          ff.stdin.end();
        });
        if (converted) {
          bytes = converted;
          mime = 'audio/ogg; codecs=opus';
        } else {
          console.warn('[zapi] ffmpeg audio conversion failed; sending original');
        }
      } catch (err) {
        console.warn('[zapi] ffmpeg spawn failed:', (err as any)?.message);
      }
    }
    return `data:${mime};base64,${bytes!.toString('base64')}`;
  }

  if (opts.text && !opts.mediaUrl) {
    path = '/send-text';
    body.message = opts.text;
  } else if (opts.mediaUrl && opts.mediaType === 'image') {
    path = '/send-image';
    body.image = await resolveMediaForZapi(opts.mediaUrl, opts.mediaMime, 'image');
    if (opts.caption) body.caption = opts.caption;
  } else if (opts.mediaUrl && opts.mediaType === 'audio') {
    path = '/send-audio';
    body.audio = await resolveMediaForZapi(opts.mediaUrl, opts.mediaMime, 'audio');
    body.viewOnce = false;
  } else if (opts.mediaUrl && opts.mediaType === 'video') {
    path = '/send-video';
    body.video = await resolveMediaForZapi(opts.mediaUrl, opts.mediaMime, 'video');
    if (opts.caption) body.caption = opts.caption;
  } else if (opts.mediaUrl && opts.mediaType === 'document') {
    const ext = (opts.mediaFilename?.split('.').pop() || 'pdf').toLowerCase();
    path = `/send-document/${ext}`;
    body.document = await resolveMediaForZapi(opts.mediaUrl, opts.mediaMime, 'document');
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
    // Onda 47: Z-API tem 4+ tipos de webhook. Apenas ReceivedCallback
    // contem mensagens reais. Tudo o resto (PresenceChatCallback,
    // MessageStatusCallback, DeliveryCallback) sao eventos auxiliares
    // que NAO devem virar message_in/activity.
    if (item.type && item.type !== 'ReceivedCallback') continue;
    // Sanity: se nem text nem image/audio/video/document/location/contact
    // existem, e nao tem 'message' fallback, nao processar.
    const hasContent = !!(item.text?.message || item.image || item.audio ||
      item.video || item.document || item.location || item.contact || item.message);
    if (!hasContent) continue;
    if (item.fromMe === true) continue; // ja logamos outbound no send

    const phone = item.phone || item.from || '';
    if (!phone) continue;
    // Onda 47: ignorar mensagens com phone=@lid (internal Meta IDs).
    // Se item.chatLid existe e o phone real esta em outro campo, usariamos —
    // mas inbound de contato real sempre vem com phone=numero real.
    if (typeof phone === 'string' && phone.includes('@lid')) continue;

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

    // Onda 51: aceitar todas as formas que Z-API manda texto
    const textCandidate = item.text?.message
      || item.text?.body
      || item.text?.text
      || item.message?.body
      || item.body
      || (typeof item.text === 'string' ? item.text : null)
      || item.buttonsResponseMessage?.message
      || item.listResponseMessage?.title
      || item.templateMessage?.message
      || item.extendedTextMessage?.text;
    if (textCandidate) {
      base.type = 'text';
      base.text = String(textCandidate);
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
    } else if (item.reaction) {
      // Onda 51: reacao em mensagem
      base.type = 'text';
      base.text = `${item.reaction.value || '👍'} (reagiu)`;
    } else if (item.sticker) {
      // Onda 51: sticker
      base.type = 'image';
      base.mediaUrl = item.sticker.stickerUrl || item.sticker.url;
      base.mediaMime = item.sticker.mimeType || 'image/webp';
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


// ─── PROFILE PICTURE (Z-API) ────────────────────────────────────────────
// GET /instances/{instance}/token/{token}/profile-picture/{phone}
// Retorna { link: string } ou {} se a pessoa nao tem foto/foto privada.
export async function fetchProfilePicture(channel: Channel2, phone: string): Promise<string | null> {
  try {
    const creds = decryptJson<ZapiCreds>(channel.credentialsEncrypted);
    if (!creds.instanceId || !creds.token) return null;
    const cleanPhone = String(phone).replace(/\D/g, '');
    if (!cleanPhone) return null;
    const u = url(creds, `/profile-picture?phone=${encodeURIComponent(cleanPhone)}`);
    const r = await fetch(u, { method: 'GET', headers: headers(creds), signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const j: any = await r.json().catch(() => ({}));
    return (typeof j?.link === 'string' && j.link.startsWith('http')) ? j.link : null;
  } catch (err: any) {
    console.warn('[zapi.fetchProfilePicture] failed:', err?.message);
    return null;
  }
}
