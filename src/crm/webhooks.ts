/**
 * Public webhook endpoints for CRM channels.
 *
 * Mounted at /webhooks/crm/* (no tenant auth — secret in URL is the auth).
 * Each channel gets a unique webhook_secret on creation; URL pattern:
 *   POST /webhooks/crm/meta/:secret
 *   GET  /webhooks/crm/meta/:secret    (Meta verification handshake)
 *   POST /webhooks/crm/zapi/:secret
 */

import { Hono } from 'hono';
import { findChannelByWebhookSecret } from './store.js';
import { decryptJson } from './crypto.js';
import * as meta from './channels/meta.js';
import * as zapi from './channels/zapi.js';
import { ingestInbound } from './inbox.js';


// Internal forward: also deliver the raw webhook to the System Clow agent
// adapter so the AI can respond. Fire-and-forget; never blocks ACK to Meta.
async function forwardToAgent(path: string, payload: unknown, sigHeader?: string, tenantId?: string) {
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'x-clow-internal-forward': '1' };
    if (sigHeader) headers['x-hub-signature-256'] = sigHeader;
    if (tenantId) headers['x-clow-tenant-id'] = tenantId;
    await fetch('http://127.0.0.1:3001' + path, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
  } catch (err: any) {
    console.warn('[crm-webhook forward] agent unreachable:', err?.message || err);
  }
}

const app = new Hono();

// ─── META: GET (verification handshake) ─────────────────────────────────
// Meta sends: ?hub.mode=subscribe&hub.challenge=XXX&hub.verify_token=YYY
// We must respond with the challenge if verify_token matches.
app.get('/meta/:secret', async (c) => {
  const secret = c.req.param('secret');
  const channel = findChannelByWebhookSecret(secret);
  if (!channel || channel.type !== 'meta') return c.text('not_found', 404);

  const mode = c.req.query('hub.mode');
  const challenge = c.req.query('hub.challenge');
  const verifyToken = c.req.query('hub.verify_token');
  if (mode !== 'subscribe' || !challenge) return c.text('bad_request', 400);

  try {
    const creds = decryptJson<meta.MetaCreds>(channel.credentialsEncrypted);
    if (!creds.verifyToken || verifyToken !== creds.verifyToken) {
      return c.text('verify_token_mismatch', 403);
    }
    return c.text(challenge, 200);
  } catch {
    return c.text('credentials_unreadable', 500);
  }
});

// ─── META: POST (incoming messages) ─────────────────────────────────────
app.post('/meta/:secret', async (c) => {
  const secret = c.req.param('secret');
  const channel = findChannelByWebhookSecret(secret);
  if (!channel || channel.type !== 'meta') return c.text('not_found', 404);

  // Optional signature verification (X-Hub-Signature-256)
  const sigHeader = c.req.header('x-hub-signature-256');
  let payload: any;
  try {
    const raw = await c.req.text();
    if (sigHeader) {
      try {
        const creds = decryptJson<meta.MetaCreds>(channel.credentialsEncrypted);
        if (creds.appSecret) {
          const ok = await meta.verifySignature(raw, sigHeader, creds.appSecret);
          if (!ok) return c.text('invalid_signature', 401);
        }
      } catch { /* signature verification optional */ }
    }
    payload = JSON.parse(raw || '{}');
  } catch {
    return c.text('bad_json', 400);
  }

  const parsed = meta.parseWebhook(payload);
  // Process messages async-fire-and-forget so we ACK Meta in <2s
  for (const msg of parsed.messages) {
    void ingestInbound(channel, msg);
  }

  // Detecta se algum sender eh ADMIN (seu WA pessoal autorizado em admin-config.json).
  // Se for, encaminha para o agente SEM tenantId -> resolveTenantForMeta cai pra 'default'
  // -> admin handler processa com isAdmin=true (acesso pleno, sem quotas de tenant).
  let forwardTenantId: string | undefined = channel.tenantId;
  try {
    const { isAdminPhone } = await import('../admin/adminConfig.js');
    const senderPhones = parsed.messages.map((m: any) => String(m.fromPhone || m.phone || '')).filter(Boolean);
    const hasAdminSender = senderPhones.some((p) => isAdminPhone(p));
    console.log('[crm-webhook] senders=' + senderPhones.join(',') + ' adminMatch=' + hasAdminSender);
    if (hasAdminSender) {
      forwardTenantId = undefined; // admin path
      console.log('[crm-webhook] admin sender detected -> routing to admin context (not tenant ' + channel.tenantId.slice(0,8) + ')');
    }
  } catch (err: any) {
    console.warn('[crm-webhook] adminConfig check failed:', err?.message);
  }

  // ALSO forward the original payload to the System Clow AI agent so it can reply
  // (the agent handler dedupes by messageId so no double-processing risk)
  void forwardToAgent('/webhooks/meta', payload, c.req.header('x-hub-signature-256'), forwardTenantId);
  return c.json({ ok: true, processed: parsed.messages.length });
});

// ─── Z-API: POST (incoming messages) ────────────────────────────────────
app.post('/zapi/:secret', async (c) => {
  const secret = c.req.param('secret');
  const channel = findChannelByWebhookSecret(secret);
  if (!channel || channel.type !== 'zapi') return c.text('not_found', 404);

  let payload: any;
  try { payload = await c.req.json(); }
  catch { return c.text('bad_json', 400); }

  const parsed = zapi.parseWebhook(payload);
  for (const msg of parsed.messages) {
    void ingestInbound(channel, msg);
  }
  // Forward to agent (Z-API webhook endpoint exists in whatsappAgent adapter)
  void forwardToAgent('/webhooks/zapi', payload, undefined, channel.tenantId);
  return c.json({ ok: true, processed: parsed.messages.length });
});

export default app;
