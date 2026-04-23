/**
 * whatsappMeta.ts — Meta Official WhatsApp Cloud API Adapter
 *
 * Receives webhooks from Meta, routes to Clow QueryEngine, sends responses
 * back via WhatsApp Cloud API. Each phone number gets a persistent session.
 *
 * Flow: Meta webhook → verify/extract message → resolve session → process async → reply
 *
 * Meta API v22.0 — https://developers.facebook.com/docs/whatsapp/cloud-api
 */

import { Hono } from 'hono';
import type { SessionPool } from '../server/sessionPool.js';
import * as path from 'path';
import * as fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { isAdminPhone as isAdminPhoneFromConfig } from '../admin/adminConfig.js';


/**
 * Resolve tenantId for an inbound message:
 *   1. x-clow-tenant-id header (set by CRM webhook forward)
 *   2. Lookup CRM channel by phone_number_id from the payload
 *   3. Fallback: 'default' (legacy single-tenant mode)
 */

/**
 * Check if a phone is authorized to use the System Clow agent for a tenant.
 * Tenant.authorized_phones is the whitelist set on signup (= owner phone).
 * If empty / undefined: legacy mode, allow all (admin tenant).
 */
async function isPhoneAuthorized(tenantId: string, phone: string): Promise<boolean> {
  // Admin inbound (tenantId='default') — whitelist admin
  if (tenantId === 'default') return isAdminPhone(phone);
  try {
    const { getTenant } = await import('../tenancy/tenantStore.js');
    const t: any = getTenant(tenantId);
    if (!t) return false;
    const whitelist: string[] = t.authorized_phones || [];
    // SECURITY: fail-closed quando whitelist vazia (era fail-open/true antes).
    // Um tenant sem phones autorizados NAO pode receber comandos de ninguem
    // ate o owner cadastrar pelo menos 1 numero em Configuracoes.
    if (whitelist.length === 0) return false;
    const normalized = phone.replace(/\D/g, '');
    return whitelist.some((p) => p.replace(/\D/g, '') === normalized);
  } catch (err: any) {
    console.error('[isPhoneAuthorized]', err?.message);
    return false; // fail-closed em erro
  }
}


async function resolveTenantForMeta(req: { header: (k: string) => string | undefined }, phoneNumberId?: string): Promise<string> {
  const headerTid = req.header('x-clow-tenant-id');
  if (headerTid) return headerTid;
  if (phoneNumberId) {
    try {
      const { findChannelByPhoneId } = await import('../crm/store.js');
      const channel = findChannelByPhoneId(phoneNumberId);
      if (channel) return channel.tenantId;
    } catch { /* CRM module unavailable, fall through */ }
  }
  return 'default';
}


const execFileAsync = promisify(execFile);

// ─── Meta Config ───────────────────────────────────────────────────────────

interface MetaWhatsAppConfig {
  accessToken: string;
  phoneNumberId: string;
  wabaId: string;
  verifyToken: string;
  appId: string;
  apiVersion: string;
}

function getMetaConfig(): MetaWhatsAppConfig | null {
  const accessToken = process.env.META_WA_ACCESS_TOKEN;
  const phoneNumberId = process.env.META_WA_PHONE_NUMBER_ID;
  if (!accessToken || !phoneNumberId) return null;
  return {
    accessToken,
    phoneNumberId,
    wabaId: process.env.META_WA_BUSINESS_ACCOUNT_ID || '',
    verifyToken: process.env.META_WA_VERIFY_TOKEN || 'REDACTED_VERIFY_TOKEN',
    appId: process.env.META_WA_APP_ID || '',
    apiVersion: process.env.META_WA_API_VERSION || 'v22.0',
  };
}

// ─── Meta Cloud API Client ─────────────────────────────────────────────────

async function sendMetaMessage(phone: string, message: string): Promise<void> {
  const config = getMetaConfig();
  if (!config) {
    console.error('[meta-wa] No Meta config — cannot send message');
    return;
  }

  const chunks = splitForWhatsApp(message);

  for (const chunk of chunks) {
    try {
      const url = `https://graph.facebook.com/${config.apiVersion}/${config.phoneNumberId}/messages`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.accessToken}`,
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: phone,
          type: 'text',
          text: { preview_url: true, body: chunk },
        }),
      });

      if (!res.ok) {
        const err = await res.text();
        console.error(`[meta-wa] Send failed to ${phone}: ${res.status} ${err}`);
      }
    } catch (err: any) {
      console.error(`[meta-wa] Send failed to ${phone}: ${err.message}`);
    }

    // Small delay between chunks to preserve order
    if (chunks.length > 1) {
      await sleep(600);
    }
  }
}

async function markAsRead(messageId: string): Promise<void> {
  const config = getMetaConfig();
  if (!config) return;

  try {
    const url = `https://graph.facebook.com/${config.apiVersion}/${config.phoneNumberId}/messages`;
    await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.accessToken}`,
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
      }),
    });
  } catch {
    // Non-critical
  }
}

async function sendReaction(messageId: string, emoji: string): Promise<void> {
  const config = getMetaConfig();
  if (!config) return;

  try {
    const url = `https://graph.facebook.com/${config.apiVersion}/${config.phoneNumberId}/messages`;
    // We need the recipient phone for reactions — skip if we don't have context
    // This is a fire-and-forget UX enhancement
  } catch {
    // Non-critical
  }
}

// ─── Audio Transcription (Google Speech-to-Text) ───────────────────────────

async function transcribeAudio(audioId: string): Promise<string> {
  const googleApiKey = process.env.GOOGLE_API_KEY;

  if (!googleApiKey) {
    return '[Audio recebido — transcrição indisponível. Configure GOOGLE_API_KEY.]';
  }

  const config = getMetaConfig();
  if (!config) {
    return '[Audio recebido — sem configuração Meta para baixar o áudio.]';
  }

  const tmpDir = '/tmp/clow-audio';
  try { fs.mkdirSync(tmpDir, { recursive: true }); } catch {}

  const oggPath = `${tmpDir}/${audioId}.ogg`;
  const wavPath = `${tmpDir}/${audioId}.wav`;

  try {
    // Step 1: Download audio from Meta Cloud API
    const downloadUrl = `https://graph.facebook.com/${config.apiVersion}/${audioId}`;
    const audioRes = await fetch(downloadUrl, {
      headers: { 'Authorization': `Bearer ${config.accessToken}` },
    });

    if (!audioRes.ok) {
      console.error(`[meta-wa/stt] Failed to download audio: ${audioRes.status}`);
      return '[Audio recebido — erro ao baixar o arquivo de áudio.]';
    }

    const audioBuffer = Buffer.from(await audioRes.arrayBuffer());
    fs.writeFileSync(oggPath, audioBuffer);

    // Step 2: Convert OGG/Opus to WAV (LINEAR16, 16kHz, mono) — Google requirement
    try {
      await execFileAsync('ffmpeg', [
        '-y', '-i', oggPath,
        '-ar', '16000',        // 16kHz sample rate
        '-ac', '1',            // mono
        '-sample_fmt', 's16',  // LINEAR16
        wavPath,
      ]);
    } catch (ffmpegErr: any) {
      console.error(`[meta-wa/stt] FFmpeg conversion failed: ${ffmpegErr.message}`);
      return '[Audio recebido — erro ao converter o formato do áudio.]';
    }

    // Step 3: Read WAV and send to Google Speech-to-Text API
    const wavBuffer = fs.readFileSync(wavPath);
    const audioBase64 = wavBuffer.toString('base64');

    const sttRes = await fetch(
      `https://speech.googleapis.com/v1/speech:recognize?key=${googleApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config: {
            encoding: 'LINEAR16',
            sampleRateHertz: 16000,
            languageCode: 'pt-BR',
            enableAutomaticPunctuation: true,
            model: 'latest_long',
          },
          audio: {
            content: audioBase64,
          },
        }),
      }
    );

    if (!sttRes.ok) {
      const errBody = await sttRes.text();
      console.error(`[meta-wa/stt] Google STT API error: ${sttRes.status} ${errBody}`);
      return '[Audio recebido — erro na transcrição via Google.]';
    }

    const sttResult = await sttRes.json() as any;
    const transcript = sttResult.results?.[0]?.alternatives?.[0]?.transcript;

    if (transcript) {
      console.log(`[meta-wa/stt] Transcribed: "${transcript.slice(0, 100)}"`);
      return transcript;
    }

    return '[Audio recebido — não foi possível transcrever o conteúdo.]';
  } catch (err: any) {
    console.error(`[meta-wa/stt] Transcription failed: ${err.message}`);
    return '[Audio recebido — falha na transcrição.]';
  } finally {
    // Cleanup temp files
    try { fs.unlinkSync(oggPath); } catch {}
    try { fs.unlinkSync(wavPath); } catch {}
  }
}


// ─── Audio Transcription (Google Speech-to-Text) ───────────────────────────

async function transcribeAudioGoogle(audioMediaId: string): Promise<string> {
  const config = getMetaConfig();
  if (!config) {
    return '[Audio recebido — sem configuracao Meta para baixar]';
  }

  const googleApiKey = process.env.GOOGLE_API_KEY;
  if (!googleApiKey) {
    console.warn('[meta-wa] GOOGLE_API_KEY not set — audio transcription unavailable');
    return '[Audio recebido — transcrição indisponivel. Configure GOOGLE_API_KEY.]';
  }

  try {
    // Step 1: Download audio from Meta Cloud API
    const downloadUrl = `https://graph.facebook.com/${config.apiVersion}/${audioMediaId}`;
    const downloadRes = await fetch(downloadUrl, {
      headers: { 'Authorization': `Bearer ${config.accessToken}` },
    });

    if (!downloadRes.ok) {
      console.error(`[meta-wa] Failed to download audio: ${downloadRes.status}`);
      return '[Audio recebido — erro ao baixar arquivo]';
    }

    // Meta returns a URL redirect or direct binary
    let audioBuffer: Buffer;
    const contentType = downloadRes.headers.get('content-type') || '';

    if (contentType.includes('json')) {
      // Meta returns JSON with url field
      const json = await downloadRes.json() as any;
      if (!json.url) {
        console.error('[meta-wa] No audio URL in Meta response');
        return '[Audio recebido — erro ao obter URL do audio]';
      }
      const audioRes = await fetch(json.url, {
        headers: { 'Authorization': `Bearer ${config.accessToken}` },
      });
      if (!audioRes.ok) {
        console.error(`[meta-wa] Failed to download audio from URL: ${audioRes.status}`);
        return '[Audio recebido — erro ao baixar audio]';
      }
      const ab = await audioRes.arrayBuffer();
      audioBuffer = Buffer.from(ab);
    } else {
      // Direct binary
      const ab = await downloadRes.arrayBuffer();
      audioBuffer = Buffer.from(ab);
    }

    // Step 2: Convert OGG to WAV (LINEAR16) using ffmpeg
    const tmpDir = '/tmp/clow-audio';
    try { fs.mkdirSync(tmpDir, { recursive: true }); } catch {}

    const oggPath = path.join(tmpDir, `${audioMediaId}.ogg`);
    const wavPath = path.join(tmpDir, `${audioMediaId}.wav`);

    fs.writeFileSync(oggPath, audioBuffer);

    try {
      await execFileAsync('ffmpeg', ['-y', '-i', oggPath, '-ar', '16000', '-ac', '1', '-f', 'wav', wavPath], {
        timeout: 30000,
      });
    } catch (ffmpegErr: any) {
      console.error(`[meta-wa] ffmpeg conversion failed: ${ffmpegErr.message}`);
      return '[Audio recebido — erro ao converter audio]';
    }

    // Step 3: Read WAV and send to Google Speech-to-Text API
    const wavBuffer = fs.readFileSync(wavPath);
    const audioBase64 = wavBuffer.toString('base64');

    // Cleanup temp files
    try { fs.unlinkSync(oggPath); } catch {}
    try { fs.unlinkSync(wavPath); } catch {}

    const googleRes = await fetch(
      `https://speech.googleapis.com/v1/speech:recognize?key=${googleApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config: {
            encoding: 'LINEAR16',
            sampleRateHertz: 16000,
            languageCode: 'pt-BR',
            enableAutomaticPunctuation: true,
            model: 'latest_long',
          },
          audio: {
            content: audioBase64,
          },
        }),
      },
    );

    if (!googleRes.ok) {
      const errText = await googleRes.text();
      console.error(`[meta-wa] Google Speech API error: ${googleRes.status} ${errText}`);
      return '[Audio recebido — erro na transcrição]';
    }

    const result = await googleRes.json() as any;
    const transcript = result?.results?.[0]?.alternatives?.[0]?.transcript;

    if (transcript) {
      console.log(`[meta-wa] Audio transcribed: "${transcript.slice(0, 100)}"`);
      return transcript;
    }

    return '[Audio recebido — não foi possivel transcrever. Tente novamente.]';

  } catch (err: any) {
    console.error(`[meta-wa] Audio transcription failed: ${err.message}`);
    return '[Audio recebido — falha na transcrição. Envie como texto por favor.]';
  }
}

// ─── Message Extraction ────────────────────────────────────────────────────

interface ExtractedMessage {
  phone: string;
  messageId: string;
  text: string;
  name?: string;
  type: string;
}

async function extractMessage(payload: any): Promise<ExtractedMessage | null> {
  try {
    const entry = payload?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    if (!value || value.messaging_product !== 'whatsapp') return null;

    const messages = value.messages;
    if (!messages || messages.length === 0) return null;

    const msg = messages[0];
    const phone = msg.from;
    const messageId = msg.id;
    const contact = value.contacts?.[0];
    const name = contact?.profile?.name;

    // Text message
    if (msg.type === 'text' && msg.text?.body) {
      return { phone, messageId, text: msg.text.body, name, type: 'text' };
    }

    // Image message
    if (msg.type === 'image') {
      const caption = msg.image?.caption || '';
      return {
        phone, messageId, name, type: 'image',
        text: caption
          ? `[Imagem recebida com legenda: "${caption}"]`
          : '[Imagem recebida — envie como texto para eu processar]',
      };
    }

    // Audio message — transcribe with Google Speech-to-Text
    if (msg.type === 'audio') {
      const audioId = msg.audio?.id;
      const transcription = audioId
        ? await transcribeAudio(audioId)
        : '[Audio recebido — sem ID do áudio.]';
      return {
        phone, messageId, name, type: 'audio',
        text: transcription,
      };
    }

    // Document
    if (msg.type === 'document') {
      const fileName = msg.document?.filename || 'arquivo';
      return {
        phone, messageId, name, type: 'document',
        text: `[Documento recebido: ${fileName}]`,
      };
    }

    // Sticker — ignore
    if (msg.type === 'sticker') return null;

    // Location
    if (msg.type === 'location') {
      const lat = msg.location?.latitude;
      const lng = msg.location?.longitude;
      return {
        phone, messageId, name, type: 'location',
        text: `[Localizacao: ${lat}, ${lng}]`,
      };
    }

    // Interactive (button reply, list reply)
    if (msg.type === 'interactive') {
      const reply = msg.interactive?.button_reply?.title
        || msg.interactive?.list_reply?.title
        || msg.interactive?.list_reply?.description
        || '';
      if (reply) return { phone, messageId, text: reply, name, type: 'interactive' };
    }

    // Reaction — ignore
    if (msg.type === 'reaction') return null;

    // Fallback
    return null;
  } catch {
    return null;
  }
}

// ─── Tool Description for UX ───────────────────────────────────────────────

function describeTool(toolName: string): string {
  const descriptions: Record<string, string> = {
    Bash: 'Executando comando...',
    Read: 'Lendo arquivo...',
    Edit: 'Editando arquivo...',
    Write: 'Escrevendo arquivo...',
    Glob: 'Buscando arquivos...',
    Grep: 'Pesquisando no codigo...',
    WebFetch: 'Acessando URL...',
    WebSearch: 'Pesquisando na web...',
    Agent: 'Delegando para sub-agente...',
    Download: 'Preparando download...',
  };
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.split('__');
    return `Usando ${parts[1]}/${parts[2]}...`;
  }
  return descriptions[toolName] || `Usando ${toolName}...`;
}

// ─── Message Splitting ─────────────────────────────────────────────────────

function splitForWhatsApp(text: string, maxLen = 3500): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  const paragraphs = text.split('\n\n');
  let current = '';

  for (const p of paragraphs) {
    if ((current + '\n\n' + p).length > maxLen) {
      if (current) chunks.push(current.trim());
      if (p.length > maxLen) {
        for (let i = 0; i < p.length; i += maxLen) {
          chunks.push(p.slice(i, i + maxLen));
        }
        current = '';
      } else {
        current = p;
      }
    } else {
      current = current ? `${current}\n\n${p}` : p;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

// ─── Admin Phone Check ─────────────────────────────────────────────────────

function isAdminPhone(phone: string): boolean {
  // Delega pra adminConfig (seed do env + persiste adicoes via UI admin)
  return isAdminPhoneFromConfig(phone);
}

// ─── Background Processing ────────────────────────────────────────────────

async function processInBackground(
  pool: SessionPool,
  sessionId: string,
  phone: string,
  userMessage: string,
  messageId: string,
  userName?: string,
  tenantId: string = 'default',
): Promise<void> {
  try {
    // Mark as read immediately
    void markAsRead(messageId);

    const wsDir = path.join(process.env.CLOW_WORKSPACES || '/tmp/clow-workspaces', `meta_${phone}`);
    try { fs.mkdirSync(wsDir, { recursive: true }); } catch {}

    const engine = await pool.getOrCreate(sessionId, {
      cwd: wsDir,
      workspaceRoot: wsDir,
      isAdmin: isAdminPhone(phone),
      tenantId,
    });

    let buffer = '';
    let lastSentTime = Date.now();
    let lastToolNotified = '';
    let toolCount = 0;

    // Admin password unlock: se a msg for apenas a senha admin, destravar sessao
    // e substituir pelo marcador antes do LLM ver.
    let effectiveUserMessage = userMessage;
    try {
      if (isAdminPhone(phone)) {
        const { tryUnlockFromMessage } = await import('../auth/adminUnlock.js');
        const res = tryUnlockFromMessage(sessionId, userMessage, true);
        if (res.matched) effectiveUserMessage = res.stripped;
      }
    } catch (err: any) { console.error('[adminUnlock wa]', err?.message); }

    // Prepend user name context on first message
    const contextMessage = userName
      ? `[Usuario: ${userName} | WhatsApp: ${phone}]\n\n${effectiveUserMessage}`
      : effectiveUserMessage;

    for await (const event of engine.submitMessage(contextMessage)) {
      if (event.type === 'assistant' && event.content) {
        buffer += event.content;

        // Send in chunks: every 300 chars OR 4s
        if (buffer.length > 300 || Date.now() - lastSentTime > 4000) {
          await sendMetaMessage(phone, buffer);
          buffer = '';
          lastSentTime = Date.now();
        }
      }

      if (event.type === 'progress' && event.toolName) {
        const toolKey = event.toolName;
        if (toolKey !== lastToolNotified && toolCount < 3) {
          lastToolNotified = toolKey;
          toolCount++;
          await sendMetaMessage(phone, `_⚙️ ${describeTool(event.toolName)}_`);
        }
      }

      if (event.type === 'result') {
        if (event.subtype?.startsWith('error')) {
          if (buffer) {
            await sendMetaMessage(phone, buffer);
            buffer = '';
          }
          const errorMsg = event.content || 'Ocorreu um erro ao processar sua solicitacao.';
          await sendMetaMessage(phone, `⚠️ ${errorMsg.slice(0, 500)}`);
        }
      }
    }

    // Flush remaining buffer
    if (buffer.trim()) {
      await sendMetaMessage(phone, buffer);
    }

    pool.trackMessage(sessionId);

  } catch (err: any) {
    console.error(`[meta-wa] Error processing message for ${phone}: ${err.message}`);
    await sendMetaMessage(phone, `⚠️ Erro ao processar: ${err.message.slice(0, 200)}`);
  }
}

// ─── Build Routes ──────────────────────────────────────────────────────────

export function buildMetaWhatsAppRoutes(pool: SessionPool): Hono {
  const app = new Hono();

  // ── Webhook Verification (GET) — Meta sends this on setup ──────────────
  app.get('/webhooks/meta', (c) => {
    const config = getMetaConfig();
    if (!config) {
      return c.text('Meta WhatsApp not configured', 503);
    }

    const mode = c.req.query('hub.mode');
    const token = c.req.query('hub.verify_token');
    const challenge = c.req.query('hub.challenge');

    if (mode === 'subscribe' && token === config.verifyToken) {
      console.log('[meta-wa] Webhook verified successfully');
      return c.text(challenge || '', 200);
    }

    console.error(`[meta-wa] Webhook verification failed: mode=${mode} token=${token}`);
    return c.text('Forbidden', 403);
  });

  // ── Webhook Receiver (POST) — Incoming messages ────────────────────────
  app.post('/webhooks/meta', async (c) => {
    // Resolve tenant: header from CRM forward, OR lookup by phone_number_id
    let tenantId = 'default';

    const config = getMetaConfig();
    if (!config) {
      console.error('[meta-wa] Webhook hit but no Meta config — ignoring');
      return c.json({ ok: true });
    }

    let payload: any;
    try {
      payload = await c.req.json();
    } catch {
      return c.json({ ok: true });
    }

    // Extract message
    const extracted = await extractMessage(payload);
    if (!extracted) {
      // Might be a status update (delivered, read, etc) — ignore
      return c.json({ ok: true });
    }

    const { phone, messageId, text, name, type } = extracted;

    // Resolve tenant from header (set by CRM forward) or by phone_number_id lookup
    const phoneNumberId = payload?.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id;
    tenantId = await resolveTenantForMeta(c.req, phoneNumberId);

    // Quota gate: check monthly message limit per plan
    try {
      const { checkAndIncrementMessageQuota } = await import('../billing/quotaGuard.js');
      const q = checkAndIncrementMessageQuota(tenantId);
      if (!q.allowed) {
        const reason = q.reason === 'over_hard_limit' ? 'Limite mensal atingido (2× plano). Upgrade em /signup ou aguarde virar do mês.' : 'Conta suspensa. Contate suporte.';
        console.log(`[meta-wa] [tenant=${tenantId.slice(0,8)}] QUOTA BLOCK: ${q.reason} (${q.current}/${q.limit})`);
        // Notify user once via WA so they know
        try {
          const config2 = getMetaConfig();
          if (config2) {
            await fetch(`https://graph.facebook.com/${config2.apiVersion}/${config2.phoneNumberId}/messages`, {
              method: 'POST',
              headers: { 'Authorization': 'Bearer ' + config2.accessToken, 'Content-Type': 'application/json' },
              body: JSON.stringify({ messaging_product: 'whatsapp', to: phone.replace(/\D/g,''), type: 'text', text: { body: '⚠️ ' + reason } }),
            });
          }
        } catch {}
        return c.json({ ok: true, blocked: 'quota' });
      }
      if (q.overage_msgs > 0 && q.overage_msgs === 1) {
        console.log(`[meta-wa] [tenant=${tenantId.slice(0,8)}] entered OVERAGE zone (custo extra R$ ${(q.overage_cost_cents/100).toFixed(2)}/msg)`);
      }
    } catch (err: any) {
      console.warn('[quota check] failed, allowing msg:', err.message);
    }

    // Gate: only owner-authorized phones may invoke the agent (prevents random
    // people from triggering the AI on someone else's account).
    if (!(await isPhoneAuthorized(tenantId, phone))) {
      console.log(`[meta-wa] [tenant=${tenantId.slice(0,8)}] BLOCKED unauthorized phone ${phone}: ${text.slice(0,40)}`);
      return c.json({ ok: true, ignored: 'phone_not_authorized' });
    }

    console.log(`[meta-wa] [tenant=${tenantId.slice(0,8)}] ${phone}${name ? ` (${name})` : ''}: ${text.slice(0, 80)}${text.length > 80 ? '...' : ''}`);

    // Session ID: 1 phone = 1 persistent session
    const sessionId = `meta_${phone.replace(/\D/g, '')}`;

    // Process in background (don't block webhook — Meta has 20s timeout)
    void processInBackground(pool, sessionId, phone, text, messageId, name, tenantId);

    // Respond 200 immediately
    return c.json({ ok: true });
  });

  // ── Health check for Meta adapter ──────────────────────────────────────
  app.get('/webhooks/meta/status', (c) => {
    const config = getMetaConfig();
    return c.json({
      configured: !!config,
      phoneNumberId: config?.phoneNumberId || null,
      wabaId: config?.wabaId || null,
      apiVersion: config?.apiVersion || null,
    });
  });

  return app;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Export for direct use ─────────────────────────────────────────────────

export { sendMetaMessage, getMetaConfig };
