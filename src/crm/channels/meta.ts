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

// Upload media to Meta WhatsApp Cloud API → returns media_id
// Necessario quando mediaUrl e relativa (/v1/crm/media/...) ou nao HTTPS publica.
async function uploadMediaToMeta(
  creds: MetaCreds,
  mediaUrl: string,
  mediaType: 'image' | 'audio' | 'document' | 'video',
  filename?: string,
): Promise<{ ok: boolean; mediaId?: string; error?: string }> {
  try {
    // 1) Obter bytes do arquivo
    let bytes: Buffer;
    let mime: string = 'application/octet-stream';

    const isOurPath = /^\/v1\/crm\/media\/([^\/]+)\/([^\/]+)\/([^\/]+)$/.exec(mediaUrl);
    if (isOurPath) {
      // /v1/crm/media/{tenantId}/{date}/{filename} -> ler do disco
      const [, tenantId, date, fname] = isOurPath;
      const fsMod = await import('fs');
      const pathMod = await import('path');
      const osMod = await import('os');
      const home = process.env.CLOW_HOME || pathMod.join(osMod.homedir(), '.clow');
      const filePath = pathMod.join(home, 'crm-media', tenantId, date, fname);
      if (!fsMod.existsSync(filePath)) {
        return { ok: false, error: 'media_not_found_on_disk: ' + filePath };
      }
      bytes = fsMod.readFileSync(filePath);
      // adivinha mime do extension
      const ext = fname.split('.').pop()?.toLowerCase() || '';
      const mimeMap: Record<string, string> = {
        jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
        ogg: 'audio/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav',
        mp4: 'video/mp4', webm: 'video/webm',
        pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv',
        doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      };
      mime = mimeMap[ext] || 'application/octet-stream';

      // Meta rejeita audio/webm. Se for gravacao MediaRecorder do browser
      // (mediaType=audio + ext webm), transcoda pra audio/ogg via ffmpeg.
      if (mediaType === 'audio' && (ext === 'webm' || mime.startsWith('video/webm') || mime.startsWith('audio/webm'))) {
        try {
          const { execFile } = await import('child_process');
          const { promisify } = await import('util');
          const { randomUUID } = await import('crypto');
          const execFileP = promisify(execFile);
          const tmpDir = '/tmp';
          const inPath = pathMod.join(tmpDir, 'wa-in-' + randomUUID() + '.webm');
          const outPath = pathMod.join(tmpDir, 'wa-out-' + randomUUID() + '.ogg');
          fsMod.writeFileSync(inPath, bytes);
          // -c:a libopus 48kHz mono 64kbps — formato que Meta aceita
          await execFileP('ffmpeg', [
            '-y', '-i', inPath,
            '-vn', '-ac', '1', '-ar', '48000',
            '-c:a', 'libopus', '-b:a', '64k',
            '-f', 'ogg', outPath,
          ]);
          bytes = fsMod.readFileSync(outPath);
          mime = 'audio/ogg';
          try { fsMod.unlinkSync(inPath); } catch {}
          try { fsMod.unlinkSync(outPath); } catch {}
          console.log('[meta-upload] audio webm -> ogg opus (', bytes.length, 'bytes)');
        } catch (err: any) {
          console.error('[meta-upload] ffmpeg transcode failed:', err?.message);
          return { ok: false, error: 'audio_transcode_failed: ' + (err?.message || 'ffmpeg error') };
        }
      }
    } else if (/^https?:\/\//.test(mediaUrl)) {
      const r = await fetch(mediaUrl);
      if (!r.ok) return { ok: false, error: 'fetch_media_failed: HTTP ' + r.status };
      bytes = Buffer.from(new Uint8Array(await r.arrayBuffer()));
      mime = r.headers.get('content-type') || mime;
    } else {
      return { ok: false, error: 'unsupported_media_url_format' };
    }

    // 2) Upload pra Meta /{phone-id}/media
    const url = endpoint(creds, `/${creds.phoneNumberId}/media`);
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', mime);
    // Nome do arquivo no blob — Meta detecta formato pelo mime primarily
    const blobName = filename || `upload.${mime.split('/')[1]?.split(';')[0] || 'bin'}`;
    form.append('file', new Blob([new Uint8Array(bytes)], { type: mime }), blobName);

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${creds.accessToken}` },
      body: form,
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || !data?.id) {
      return {
        ok: false,
        error: `meta_upload_failed (${res.status}): ${data?.error?.message || JSON.stringify(data).slice(0, 200)}`,
      };
    }
    return { ok: true, mediaId: data.id };
  } catch (err: any) {
    return { ok: false, error: `upload_exception: ${err?.message || 'desconhecido'}` };
  }
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
    // Meta rejeita URLs relativas / auth-scoped. Se a URL for nossa
    // (/v1/crm/media/...) ou nao HTTPS acessivel, faz upload pra
    // /{phone-id}/media e usa media_id no lugar.
    const isOurLocalUrl = /^\/v1\/crm\/media\//.test(opts.mediaUrl);
    const isAbsoluteHttps = /^https:\/\//.test(opts.mediaUrl);
    if (isOurLocalUrl || !isAbsoluteHttps) {
      const uploaded = await uploadMediaToMeta(creds, opts.mediaUrl, opts.mediaType, opts.mediaFilename);
      if (!uploaded.ok) {
        return { ok: false, error: { message: uploaded.error || 'media_upload_failed' } };
      }
      body[opts.mediaType] = { id: uploaded.mediaId };
    } else {
      body[opts.mediaType] = { link: opts.mediaUrl };
    }
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
