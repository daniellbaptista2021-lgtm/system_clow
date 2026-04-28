/**
 * Z-API adapter (Brazilian WhatsApp gateway).
 *
 * Send: POST {baseUrl}/instances/{instanceId}/token/{token}/send-text
 *       /send-image, /send-audio, /send-document, /send-link
 * Receive: webhook POST with {phone, fromMe, text:{message}, image, audio, ...}
 */

import { decryptJson } from '../crypto.js';
import type { Channel2, MediaType } from '../types.js';
import { logger } from '../../utils/logger.js';

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
      logger.warn('[zapi] resolveMediaForZapi read failed:', (err as any)?.message);
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
          logger.warn('[zapi] ffmpeg audio conversion failed; sending original');
        }
      } catch (err) {
        logger.warn('[zapi] ffmpeg spawn failed:', (err as any)?.message);
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
 *
 * @param connectedPhone Z-API tem um modo "receive-all-notifications"
 *   que ecoa as proprias mensagens enviadas pela API de volta no webhook
 *   recebido — geralmente com fromMe ausente/false e phone = numero
 *   conectado da instancia. Se passarmos o numero conectado aqui, a
 *   gente filtra esses ecos (caso contrario o bot vai responder a
 *   propria saudacao em looping).
 */
export function parseWebhook(payload: any, connectedPhone?: string): WebhookValue {
  const out: WebhookValue = { messages: [] };

  // Normalizacao do connected phone — só digitos, pra comparar igual.
  const connectedNorm = connectedPhone ? String(connectedPhone).replace(/\D/g, '') : '';

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
    // Onda 61: fromMe=true NAO pode ser descartado cegamente.
    // Existem duas origens de fromMe=true:
    //  (a) envio via API do proprio System Clow → ja logado em sendOutbound.
    //      A idempotencia em ingestInbound (providerMessageId) absorve esse
    //      caso: mesmo id ja gravado, "duplicate_skipped".
    //  (b) corretor digitou direto no app/WhatsApp Web do numero conectado
    //      → essa mensagem NUNCA passou pelo nosso send. Se descartarmos,
    //      o CRM fica cego pra conversas do dia-a-dia (bug grave: history
    //      so mostrava o lado do cliente). Precisa virar message_out.
    // Entao: deixa passar, marca fromMe=true, ingestInbound decide.
    const fromMe = item.fromMe === true;

    const phone = item.phone || item.from || '';
    if (!phone) continue;
    // Onda 47: ignorar mensagens com phone=@lid (internal Meta IDs).
    // Se item.chatLid existe e o phone real esta em outro campo, usariamos —
    // mas inbound de contato real sempre vem com phone=numero real.
    if (typeof phone === 'string' && phone.includes('@lid')) continue;

    // Onda 60: filtrar ECO da propria instancia. Z-API as vezes manda
    // o webhook recebido com fromMe=false mas phone=numero conectado
    // quando o "receive-all-notifications" esta ativo. Resultado: cada
    // outbound do bot virava um message_in fake do proprio numero,
    // criava contato "5521969927641" duplicado e bagunçava o history.
    if (connectedNorm) {
      const phoneNorm = String(phone).replace(/\D/g, '');
      if (phoneNorm === connectedNorm) continue;
    }

    // Onda 61: pra fromMe=true (corretor enviou), senderName eh o NOME DO
    // CORRETOR, nao do contato. O nome do contato eh chatName.
    // Pra fromMe=false (cliente enviou), senderName eh o NOME DO CLIENTE.
    const fromName = fromMe
      ? (item.chatName || item.notifyName || item.senderName)
      : (item.senderName || item.notifyName || item.chatName);

    const base: ParsedInbound = {
      fromPhone: phone,
      fromName,
      messageId: item.messageId || item.id || `zapi_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: (item.momment || item.timestamp || Date.now() / 1000) * (item.momment > 1e12 ? 1 : 1000),
      type: 'text',
      fromMe,
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


// ─── DEVICE INFO (Z-API) ────────────────────────────────────────────────
// GET /instances/{instance}/token/{token}/device → { phone, lid, imgUrl, ... }
// Retorna o numero conectado da instancia. Usamos pra filtrar ecos no
// parseWebhook (Z-API as vezes manda outbound de volta como inbound
// quando "receive-all-notifications" esta ativo).
//
// Cache em memoria (24h) pra evitar 1 GET por webhook recebido. O
// numero conectado raramente muda; se mudar, basta restart.
const _connectedPhoneCache = new Map<string, { phone: string; ts: number }>();
const CONNECTED_PHONE_TTL = 24 * 60 * 60 * 1000;

export async function fetchConnectedPhone(channel: Channel2): Promise<string | null> {
  const cached = _connectedPhoneCache.get(channel.id);
  if (cached && (Date.now() - cached.ts) < CONNECTED_PHONE_TTL) return cached.phone;
  try {
    const creds = decryptJson<ZapiCreds>(channel.credentialsEncrypted);
    if (!creds.instanceId || !creds.token) return null;
    const u = url(creds, '/device');
    const r = await fetch(u, { headers: headers(creds) });
    if (!r.ok) return null;
    const j: any = await r.json();
    const phone = String(j?.phone || '');
    if (!phone) return null;
    _connectedPhoneCache.set(channel.id, { phone, ts: Date.now() });
    return phone;
  } catch {
    return null;
  }
}

// ─── LID → PHONE RESOLVER (Z-API) ──────────────────────────────────────
// Onda 61: WhatsApp introduziu LIDs (Linked IDs) — IDs anonimos por chat
// que escondem o telefone real do destinatario em algumas situacoes.
// Quando o corretor responde direto pelo celular pra um contato cujo
// telefone esta protegido pelo LID, o webhook chega com:
//   { phone: "267628706820335@lid", fromMe: true, chatName: "Sara", ... }
// Sem resolver pra "556293323087", o parser descartava (filtro @lid) e
// a mensagem virava invisivel no CRM.
//
// Z-API expoe GET /chats/{lid}@lid → { name, phone, lid, ... }
// Cache 24h em memoria (LIDs sao estaveis por chat).
const _lidPhoneCache = new Map<string, { phone: string; ts: number }>();
const LID_PHONE_TTL = 24 * 60 * 60 * 1000;

export async function fetchPhoneFromLid(channel: Channel2, lid: string): Promise<string | null> {
  const cleanLid = String(lid).replace(/@lid$/, '').trim();
  if (!cleanLid) return null;
  const cacheKey = `${channel.id}:${cleanLid}`;
  const cached = _lidPhoneCache.get(cacheKey);
  if (cached && (Date.now() - cached.ts) < LID_PHONE_TTL) return cached.phone;
  try {
    const creds = decryptJson<ZapiCreds>(channel.credentialsEncrypted);
    if (!creds.instanceId || !creds.token) return null;
    const u = url(creds, `/chats/${encodeURIComponent(cleanLid + '@lid')}`);
    const r = await fetch(u, { headers: headers(creds), signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const j: any = await r.json().catch(() => ({}));
    const phone = String(j?.phone || '').replace(/\D/g, '');
    if (!phone) return null;
    _lidPhoneCache.set(cacheKey, { phone, ts: Date.now() });
    return phone;
  } catch (err: any) {
    logger.warn('[zapi.fetchPhoneFromLid] failed:', err?.message);
    return null;
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
    logger.warn('[zapi.fetchProfilePicture] failed:', err?.message);
    return null;
  }
}

// ─── AUTO-CONFIGURE WEBHOOKS ON Z-API ──────────────────────────────────
// Sem isso, o user tinha que ir no painel da Z-API e colar manualmente
// a URL do webhook. Resultado: clientes salvavam o canal achando que tava
// pronto, mandavam msg pro numero, NADA chegava no CRM (porque a Z-API
// nao sabia pra onde mandar). Bug silencioso.
//
// Z-API tem ~6 endpoints de webhook configuraveis. Setamos TODOS pra
// apontarem pro System Clow — assim qualquer evento que a Z-API
// gerar (recebido/entregue/status/desconexao/etc) chega aqui e e
// processado ou ignorado pelo parseWebhook (que so liberta
// ReceivedCallback). Por que setar todos:
//   1. evita que sobrem URLs antigas (n8n, etc) pegando eventos
//   2. centraliza o ponto unico de processamento
//   3. system clow ignora eventos que nao precisa
// Endpoints:
//   - update-webhook-received                     → msg recebida
//   - update-webhook-delivery                     → confirmacao entrega
//   - update-webhook-message-status               → lido/entregue/erro
//   - update-webhook-connection-status            → connected/disconnected
//   - update-webhook-presence-chat                → digitando/online
//   - update-webhook-receive-all-notifications    → eco de outbound (parser filtra)
async function setZapiWebhook(creds: ZapiCreds, endpoint: string, webhookUrl: string): Promise<{ ok: boolean; status?: number; error?: string }> {
  try {
    const u = url(creds, '/' + endpoint);
    const r = await fetch(u, {
      method: 'PUT',
      headers: headers(creds),
      body: JSON.stringify({ value: webhookUrl }),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      return { ok: false, status: r.status, error: txt.slice(0, 200) };
    }
    return { ok: true, status: r.status };
  } catch (err: any) {
    return { ok: false, error: err?.message || 'unknown' };
  }
}

export interface AutoConfigResult {
  ok: boolean;
  configured: string[]; // endpoints que setaram com sucesso
  failed: { endpoint: string; error: string }[];
}

/**
 * Configura todos os webhooks do Z-API pra apontar pra URL canonical
 * do canal (`/webhooks/crm/zapi/<webhookSecret>`). Idempotente.
 *
 * @param channel canal completo (com credentialsEncrypted)
 * @param baseUrl URL pública do System Clow (ex: https://system-clow.pvcorretor01.com.br)
 */
export async function autoConfigureWebhooks(
  channel: Channel2,
  baseUrl: string,
): Promise<AutoConfigResult> {
  const creds = decryptJson<ZapiCreds>(channel.credentialsEncrypted);
  const webhookUrl = baseUrl.replace(/\/$/, '') + '/webhooks/crm/zapi/' + channel.webhookSecret;
  const endpoints = [
    'update-webhook-received',
    'update-webhook-delivery',
    'update-webhook-message-status',
    'update-webhook-connection-status',
    'update-webhook-presence-chat',
    'update-webhook-receive-all-notifications',
  ];
  const result: AutoConfigResult = { ok: true, configured: [], failed: [] };
  for (const ep of endpoints) {
    const r = await setZapiWebhook(creds, ep, webhookUrl);
    if (r.ok) {
      result.configured.push(ep);
      logger.info(`[zapi.autoConfig] ✓ ${ep} → ${webhookUrl}`);
    } else {
      result.failed.push({ endpoint: ep, error: r.error || 'http_' + r.status });
      result.ok = false;
      logger.warn(`[zapi.autoConfig] ✗ ${ep}: ${r.error || 'http_' + r.status}`);
    }
  }

  // Onda 61: setar URLs nao basta. Z-API tem um TOGGLE separado que precisa
  // estar ligado pra disparar webhook quando o numero conectado envia
  // mensagem (seja via API ou via app/celular do corretor). Sem isso,
  // mensagens fromMe=true NUNCA chegam — o CRM fica cego pra qualquer
  // resposta que o usuario manda direto pelo celular.
  try {
    const u = url(creds, '/update-notify-sent-by-me');
    const r = await fetch(u, {
      method: 'PUT', headers: headers(creds),
      body: JSON.stringify({ value: true }),
    });
    const txt = await r.text().catch(() => '');
    if (r.ok && txt.includes('"value":true')) {
      result.configured.push('update-notify-sent-by-me');
      logger.info('[zapi.autoConfig] ✓ update-notify-sent-by-me=true');
    } else {
      result.failed.push({ endpoint: 'update-notify-sent-by-me', error: `http_${r.status}: ${txt.slice(0,100)}` });
      result.ok = false;
      logger.warn(`[zapi.autoConfig] ✗ update-notify-sent-by-me: ${txt.slice(0,100)}`);
    }
  } catch (err: any) {
    result.failed.push({ endpoint: 'update-notify-sent-by-me', error: err?.message || 'unknown' });
    result.ok = false;
  }

  return result;
}
