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
import * as evolution from './channels/evolution.js';
import { ingestInbound } from './inbox.js';
import { logger } from '../utils/logger.js';


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
    logger.warn('[crm-webhook forward] agent unreachable:', err?.message || err);
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
  const { incWebhookReceived } = await import('../server/metrics.js');
  incWebhookReceived('meta');

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
    logger.info('[crm-webhook] senders=' + senderPhones.join(',') + ' adminMatch=' + hasAdminSender);
    if (hasAdminSender) {
      forwardTenantId = undefined; // admin path
      logger.info('[crm-webhook] admin sender detected -> routing to admin context (not tenant ' + channel.tenantId.slice(0,8) + ')');
    }
  } catch (err: any) {
    logger.warn('[crm-webhook] adminConfig check failed:', err?.message);
  }

  // ALSO forward the original payload to the System Clow AI agent so it can reply
  // (the agent handler dedupes by messageId so no double-processing risk)
  void forwardToAgent('/webhooks/meta', payload, c.req.header('x-hub-signature-256'), forwardTenantId);
  return c.json({ ok: true, processed: parsed.messages.length });
});



// ─── EVOLUTION: POST ──────────────────────────────────────────────────────
//
// A Evolution manda TODOS os eventos configurados para o MESMO endereço:
// mensagem recebida, mudança de conexão, confirmação de entrega, presença.
// `parseWebhook` devolve lista vazia para o que não é mensagem — e responder
// 200 mesmo assim importa: erro faz a Evolution reentregar, e reentrega de um
// evento que ignoramos de propósito vira laço.
app.post('/evolution/:secret', async (c) => {
  const { incWebhookReceived } = await import('../server/metrics.js');
  incWebhookReceived('evolution');
  const secret = c.req.param('secret');
  const channel = findChannelByWebhookSecret(secret);
  if (!channel || channel.type !== 'evolution') return c.text('not_found', 404);
  let payload: any;
  try {
    payload = await c.req.json();
  } catch {
    return c.text('bad_json', 400);
  }
  // Conexão caiu ou voltou: mantém o status do canal honesto na tela, em vez
  // de o corretor descobrir que o WhatsApp desconectou quando um lead reclama
  // que ninguém respondeu.
  const evento = String(payload?.event || '').toLowerCase();
  if (evento.startsWith('connection.update')) {
    const estado = payload?.data?.state || payload?.data?.connection;
    try {
      const { updateChannel } = await import('./store.js');
      updateChannel(channel.tenantId, channel.id, {
        status: estado === 'open' ? 'active' : 'disconnected',
      });
      logger.info(`[evolution-webhook] canal ${channel.id} -> ${estado}`);
    } catch (err: any) {
      logger.warn('[evolution-webhook] falha ao atualizar status:', err?.message);
    }
    return c.json({ ok: true, processed: 0 });
  }
  // Conversa lida no aparelho: apaga o alerta do card. Sem isto o corretor
  // que atende pelo celular via o alerta de mensagem nova continuar aceso em
  // conversa que ele já tinha aberto, lido e às vezes até respondido.
  const recibos = evolution.parseReadReceipt(payload);
  if (recibos.messageIds.length) {
    try {
      const { aplicarRecibosDeLeitura } = await import('./channels/evolutionSync.js');
      const limpos = aplicarRecibosDeLeitura(channel, recibos.messageIds);
      // Uma linha por conversa aberta no celular, não por mensagem: é o
      // rastro que permite dizer se o caminho rápido está de pé sem ligar o
      // log verboso. Recibo de mensagem que o CRM não ingeriu dá zero, e é
      // silencioso de propósito.
      if (limpos) {
        logger.info(`[evolution-read] canal ${channel.id}: ${limpos} alerta(s) apagado(s) pelo recibo do aparelho`);
      }
    } catch (err: any) {
      logger.warn('[evolution-webhook] recibo de leitura falhou:', err?.message);
    }
    return c.json({ ok: true, processed: 0, lidos: recibos.messageIds.length });
  }

  const parsed = evolution.parseWebhook(payload);
  // Encadeadas, não disparadas em paralelo.
  //
  // Um mesmo lote pode trazer a mensagem do cliente E a resposta que o
  // corretor mandou do celular. Em paralelo, a resposta às vezes era gravada
  // primeiro: o `unread_count = 0` do `message_out` acontecia ANTES do `+1`
  // do `message_in`, e o alerta nascia aceso numa conversa já respondida.
  // O encadeamento preserva a ordem sem segurar a resposta do webhook — o que
  // faria a Evolution reentregar o lote inteiro.
  let fila: Promise<unknown> = Promise.resolve();
  for (const msg of parsed.messages) {
    fila = fila.then(() => ingestInbound(channel, msg)).catch((err: any) => {
      logger.warn('[evolution-webhook] ingest falhou:', err?.message);
    });
  }
  void fila;
  // Dispara o agente de IA. Só para mensagem do CLIENTE: `fromMe` é o próprio
  // corretor escrevendo pelo celular dele, e responder a isso faria o agente
  // conversar sozinho.
  try {
    for (const msg of parsed.messages) {
      if (msg.fromMe) continue;
      const aiAgent = await import('./ai/agent.js');
      aiAgent.handleInboundForAI({
        channel,
        customerPhone: msg.fromPhone,
        text: msg.text || msg.caption,
        audioUrl: msg.type === 'audio' ? msg.mediaUrl : undefined,
        imageUrl: msg.type === 'image' ? msg.mediaUrl : undefined,
        senderName: msg.fromName,
        messageId: msg.messageId,
      });
    }
  } catch (err: any) {
    logger.warn('[evolution-webhook] disparo do agente falhou:', err?.message);
  }
  return c.json({ ok: true, processed: parsed.messages.length });
});

export default app;
