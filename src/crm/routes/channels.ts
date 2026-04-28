// CRM channels module — split out from the legacy monolithic file in a refactor.
// Edit this file directly; scripts/split-routes.cjs is retained only as a record
// of how the original was decomposed (it ran once against the .ts.bak snapshot).
import { Hono } from 'hono';
import * as store from '.././store.js';
import { encryptJson, decryptJson, maskSecret } from '.././crypto.js';
import { sendOutbound } from '.././inbox.js';
import * as automations from '.././automations.js';
import { markPaid } from '.././billing.js';
import * as assignment from '.././assignment.js';
import * as lineItems from '.././lineItems.js';
import * as analytics from '.././analytics.js';
import * as reports from '.././reports.js';
import { getCrmDb } from '.././schema.js';
import { toCSV, toPDF, type ReportKind } from '.././reportsExport.js';
import * as proposalsMod from '.././proposals.js';
import * as em from '.././emailMarketing.js';
import * as forms from '.././forms.js';
import * as tasksMod from '.././tasks.js';
import * as cal from '.././calendar.js';
import * as collab from '.././collaboration.js';
import * as search from '.././search.js';
import * as ohk from '.././outboundWebhooks.js';
import * as extint from '.././integrations.js';
import * as push from '.././push.js';
import * as ai from '.././ai.js';
import * as docs from '.././documents.js';
import * as gam from '.././gamification.js';
import * as lgpd from '.././lgpd.js';
import * as softDel from '.././softDelete.js';
import * as rl from '.././rateLimiter.js';
import * as sec from '.././security.js';
import { cache } from '.././queryCache.js';
import { contactLoader, agentLoader } from '.././dataLoader.js';
import { dbInfo, tableStats, explain, vacuum, applyPerformancePragmas } from '.././connectionInfo.js';
import * as bulkOps from '.././bulkOps.js';
import { fieldSelectionMiddleware } from '.././fieldSelector.js';
import { encodeCursor, decodeCursor } from '.././cursor.js';
import * as mobile from '.././mobile.js';
import { subscribe, formatSseFrame } from '.././events.js';
import { findTenantByApiKeyHash, hashApiKey } from '../../tenancy/tenantStore.js';
import { readMedia } from '.././media.js';
import type { BoardType, ChannelType, BillingCycle, AgentRole } from '.././types.js';
/**
 * CRM REST API routes — mounted at /v1/crm.
 *
 * All routes require tenant authentication (tenantId comes from context,
 * set by tenantAuth middleware). Every query is scoped automatically.
 *
 * Conventions:
 *   - 200 ok  | 201 created | 204 no content
 *   - 400 bad input | 401 unauth (handled by middleware) | 404 not found
 *   - JSON in/out, never form-encoded
 *   - IDs returned in responses; client never invents them
 */

// ─── Helpers ────────────────────────────────────────────────────────────
function tenantOf(c: any): string {
  const t = c.get?.('tenantId') || c.get?.('tenant_id');
  return t || 'default';
}

function badRequest(c: any, msg: string, details?: unknown) {
  return c.json({ error: 'bad_request', message: msg, details }, 400);
}
function notFound(c: any, what: string) {
  return c.json({ error: 'not_found', message: `${what} not found` }, 404);
}
function ok(c: any, data: unknown, status = 200) {
  return c.json(data, status);
}

/** Hydrated kanban view: board + columns + cards grouped by column. */

function parseWin(c: any): { from?: number; to?: number } {
  const from = c.req.query('from');
  const to   = c.req.query('to');
  const w: { from?: number; to?: number } = {};
  if (from && /^\d+$/.test(from)) w.from = Number(from);
  if (to   && /^\d+$/.test(to))   w.to   = Number(to);
  return w;
}

function parseWin2(c: any): { from?: number; to?: number } {
  const from = c.req.query('from');
  const to   = c.req.query('to');
  const w: { from?: number; to?: number } = {};
  if (from && /^\d+$/.test(from)) w.from = Number(from);
  if (to   && /^\d+$/.test(to))   w.to   = Number(to);
  return w;
}

async function deliverReport(c: any, kind: ReportKind, rows: any[], title: string): Promise<Response> {
  const fmt = (c.req.query('format') || 'json').toLowerCase();
  if (fmt === 'csv') {
    const csv = toCSV(kind, rows);
    return new Response(csv, {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${kind}-${Date.now()}.csv"`,
      },
    });
  }
  if (fmt === 'pdf') {
    const pdf = await toPDF(kind, rows, { title });
    return new Response(new Uint8Array(pdf), {
      status: 200,
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': `attachment; filename="${kind}-${Date.now()}.pdf"`,
      },
    });
  }
  return ok(c, { kind, rows, count: rows.length });
}

// ─── Scheduled reports CRUD ─────────────────────────────────────────────

function computeFirstRunAt(interval: string): number {
  const d = new Date();
  // Schedule first run at 08:00 UTC next day/week/month
  d.setUTCHours(8, 0, 0, 0);
  if (interval === 'daily')   d.setUTCDate(d.getUTCDate() + 1);
  if (interval === 'weekly')  d.setUTCDate(d.getUTCDate() + 7);
  if (interval === 'monthly') d.setUTCMonth(d.getUTCMonth() + 1);
  return d.getTime();
}

// Onda 48: marcar card como lido (zera badge WhatsApp)

// Onda 59: reordenar card dentro/entre colunas — recalcula posicoes sequenciais
// body: { toColumnId, beforeCardId?: string (move pra antes desse card),
//         atIndex?: number (alternativa: posicao 0..N) }

// ─── Onda 55: refresh manual de fotos de perfil WhatsApp (Z-API) ──────
// POST /contacts/refresh-photos { force?: boolean }
//   force=false (default): só busca fotos de contatos sem avatar_url
//   force=true: busca de TODOS, sobrescreve URLs antigas (links Z-API expiram)
// Resposta: { ok, updated, skipped, noPhoto, errors, total }

/**
 * Channels store ENCRYPTED credentials. The API never returns raw credentials.
 * Instead, returns masked summaries so the UI shows what's configured.
 */

interface MetaCreds {
  accessToken: string;
  phoneNumberId: string;
  businessAccountId?: string;
  appId?: string;
  verifyToken?: string;
  apiVersion?: string;
}
interface ZapiCreds {
  instanceId: string;
  token: string;
  clientToken?: string;
  baseUrl?: string;
}

function maskedChannel(ch: any) {
  let creds: any = null;
  try { creds = decryptJson(ch.credentialsEncrypted); } catch { /* corrupted */ }
  const cred_summary = creds ? (
    ch.type === 'meta' ? {
      phoneNumberId: creds.phoneNumberId,
      accessToken: maskSecret(creds.accessToken || ''),
      businessAccountId: creds.businessAccountId,
      appId: creds.appId,
      apiVersion: creds.apiVersion || 'v22.0',
    } : {
      instanceId: creds.instanceId,
      token: maskSecret(creds.token || ''),
      clientToken: creds.clientToken ? maskSecret(creds.clientToken) : null,
      baseUrl: creds.baseUrl || 'https://api.z-api.io',
    }
  ) : null;
  return {
    id: ch.id, type: ch.type, name: ch.name, status: ch.status,
    phoneNumber: ch.phoneNumber, phoneNumberId: ch.phoneNumberId,
    webhookSecret: ch.webhookSecret, // needed by client for webhook URL
    lastInboundAt: ch.lastInboundAt, createdAt: ch.createdAt,
    credentials: cred_summary,
  };
}

// Onda 53: /me — info do tenant atual + limites WhatsApp

// POST /v1/crm/media/process — multipart file field
// Retorna: { kind: 'audio|image|pdf|text|unknown', content: '...' }

// Stripe Connect: tenant conecta SUA conta Stripe

// Invoices

// Coupons

// Dunning

// Subscriptions Pro ops

// MRR Dashboard

function baseUrlOf(c: any): string {
  const proto = c.req.header('x-forwarded-proto') || 'https';
  const host = c.req.header('host') || 'localhost';
  return `${proto}://${host}`;
}

// Keep onAccept hook in sync: when status is set to 'accepted' via admin
// endpoint (not just public sign), also trigger conversion.

// Sequences (drip)

// Unsubscribe management (admin-level)

// Inbound webhooks

// Public contact API — authenticated, simpler subset for integrations

function parseTaskOpts(c: any): any {
  const opts: any = {};
  const status = c.req.query('status');
  const type = c.req.query('type');
  const priority = c.req.query('priority');
  const agentId = c.req.query('agentId');
  const cardId = c.req.query('cardId');
  const contactId = c.req.query('contactId');
  const dueBefore = c.req.query('dueBefore');
  const dueAfter = c.req.query('dueAfter');
  if (status)     opts.status = status;
  if (type)       opts.type = type;
  if (priority)   opts.priority = priority;
  if (agentId)    opts.agentId = agentId;
  if (cardId)     opts.cardId = cardId;
  if (contactId)  opts.contactId = contactId;
  if (dueBefore && /^\d+$/.test(dueBefore)) opts.dueBefore = Number(dueBefore);
  if (dueAfter && /^\d+$/.test(dueAfter))   opts.dueAfter = Number(dueAfter);
  return opts;
}

// "Minhas tarefas" views

// ICS feed URL (permission grant to sub to calendar app)

// Scheduling links (Calendly-style)

// Calendar integrations (Google/Outlook/CalDAV tokens)

// Card comments

// Chat rooms

// Contact notes

// Mentions inbox

// Unified timeline per contact

// Global full-text search

// Structured card/contact search

// Admin utility: rebuild FTS indices

// Saved views CRUD

// Bulk actions

// Outbound webhooks CRUD

// External integrations

// Trigger sync (batch import)

// Mobile compact endpoints

// Batch scoring (useful after migration or dashboard open)

// Templates

// Documents CRUD

// Repository by contact

// Goals CRUD

// Badges catalog

// Agent badges

// Consents

// Portability — export

// Right to erasure

// Access log

// Retention policies

// Deletion requests

// Cursor-paginated contact listing

// Migration history view

// Bulk operations

function actorOf(c: any): string | undefined {
  return c.req.header('x-actor-agent-id') || c.get?.('agentId') || undefined;
}
function ipOf(c: any): string {
  return c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.req.header('x-real-ip') || 'unknown';
}

// ─── RBAC ───────────────────────────────────────────────────────────────

// ─── 2FA ─────────────────────────────────────────────────────────────────

// ─── Sessions ───────────────────────────────────────────────────────────

// ─── IP whitelist ────────────────────────────────────────────────────────

// ─── Audit log ───────────────────────────────────────────────────────────

// Lazy-hydrated pipeline: uses DataLoader to batch contact fetch

// ─── Board settings ──────────────────────────────────────────

// ─── Swimlanes ───────────────────────────────────────────────

// ─── Checklists ─────────────────────────────────────────────

// Used by the System Clow shell to open CRM in-app without asking the user
// for an API key. When user logs into System Clow (workspace), this endpoint
// gives them the CRM key for their tenant.
//
// Today: admin session token → admin tenant key
// Tomorrow (multi-tenant SaaS): tenant session token → that tenant's key



export function registerChannelsRoutes(app: Hono): void {
  app.get('/channels', (c) => {
    const channels = store.listChannels(tenantOf(c)).map(maskedChannel);
    return ok(c, { channels });
  });
  app.post('/channels', async (c) => {
    const tid = tenantOf(c);
    const body = await c.req.json().catch(() => ({}));
    if (!body.type || !['meta', 'zapi'].includes(body.type)) {
      return badRequest(c, 'type required (meta | zapi)');
    }
    if (!body.name || !body.credentials) return badRequest(c, 'name and credentials required');

    // Validate credentials shape per type
    if (body.type === 'meta') {
      const c2: MetaCreds = body.credentials;
      if (!c2.accessToken || !c2.phoneNumberId) {
        return badRequest(c, 'meta credentials need accessToken + phoneNumberId');
      }
    } else {
      const c2: ZapiCreds = body.credentials;
      if (!c2.instanceId || !c2.token) {
        return badRequest(c, 'zapi credentials need instanceId + token');
      }
    }

    let encrypted: string;
    try {
      encrypted = encryptJson(body.credentials);
    } catch (e: any) {
      return badRequest(c, `cannot encrypt credentials: ${e.message}`);
    }

    const ch = store.createChannel(tid, {
      type: body.type as ChannelType,
      name: body.name,
      credentialsEncrypted: encrypted,
      phoneNumber: body.phoneNumber,
      phoneNumberId: body.type === 'meta' ? body.credentials.phoneNumberId : undefined,
      status: 'pending', // until first webhook validates
    });
    // Auto-configura webhooks na Z-API pra eliminar o passo manual de
    // colar URL no painel deles. Sem isso, cliente salvava canal e msgs
    // recebidas SUMIAM (Z-API nao sabia pra onde mandar).
    if (body.type === 'zapi') {
      try {
        const baseUrl = process.env.CLOW_PUBLIC_BASE_URL || 'https://system-clow.pvcorretor01.com.br';
        const zapi = await import('../channels/zapi.js');
        const r = await zapi.autoConfigureWebhooks(ch, baseUrl);
        if (!r.ok) {
          (c as any).set('zapiAutoConfig', { ok: false, configured: r.configured, failed: r.failed });
        }
      } catch (err: any) {
        (c as any).set('zapiAutoConfig', { ok: false, error: err?.message });
      }
    }
    return ok(c, { channel: maskedChannel(ch), zapiAutoConfig: (c as any).get('zapiAutoConfig') }, 201);
  });
  app.get('/channels/:id', (c) => {
    const ch = store.getChannel(tenantOf(c), c.req.param('id'));
    return ch ? ok(c, { channel: maskedChannel(ch) }) : notFound(c, 'channel');
  });
  app.patch('/channels/:id', async (c) => {
    const tid = tenantOf(c);
    const id = c.req.param('id');
    const existing = store.getChannel(tid, id);
    if (!existing) return notFound(c, 'channel');
    const body = await c.req.json().catch(() => ({}));
    const patch: any = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.status !== undefined) patch.status = body.status;
    if (body.phoneNumber !== undefined) patch.phoneNumber = body.phoneNumber;
    if (body.credentials) {
      try { patch.credentialsEncrypted = encryptJson(body.credentials); }
      catch (e: any) { return badRequest(c, `cannot encrypt credentials: ${e.message}`); }
      if (body.credentials.phoneNumberId) patch.phoneNumberId = body.credentials.phoneNumberId;
    }
    const upd = store.updateChannel(tid, id, patch);
    if (!upd) return notFound(c, 'channel');
    // Re-configura webhooks na Z-API se as credenciais mudaram (instanceId/token
    // novos exigem nova chamada de update-webhook-*). Idempotente.
    let zapiAutoConfig: any = null;
    if (upd.type === 'zapi' && body.credentials) {
      try {
        const baseUrl = process.env.CLOW_PUBLIC_BASE_URL || 'https://system-clow.pvcorretor01.com.br';
        const zapi = await import('../channels/zapi.js');
        zapiAutoConfig = await zapi.autoConfigureWebhooks(upd, baseUrl);
      } catch (err: any) {
        zapiAutoConfig = { ok: false, error: err?.message };
      }
    }
    return ok(c, { channel: maskedChannel(upd), zapiAutoConfig });
  });
  // Endpoint pra forcar reconfigure dos webhooks de um canal Z-API
  // existente. Util pra canais antigos criados antes da auto-config OU
  // se o user mudar a URL publica do System Clow.
  app.post('/channels/:id/zapi-reconfigure-webhooks', async (c) => {
    const tid = tenantOf(c);
    const ch = store.getChannel(tid, c.req.param('id'));
    if (!ch) return notFound(c, 'channel');
    if (ch.type !== 'zapi') return badRequest(c, 'channel is not zapi');
    const baseUrl = process.env.CLOW_PUBLIC_BASE_URL || 'https://system-clow.pvcorretor01.com.br';
    const zapi = await import('../channels/zapi.js');
    const r = await zapi.autoConfigureWebhooks(ch, baseUrl);
    return ok(c, r);
  });
  // ── AI Agent config (per channel) ────────────────────────────────────
  app.get('/channels/:id/ai-config', (c) => {
    const tid = tenantOf(c);
    const id = c.req.param('id');
    const ch = store.getChannel(tid, id);
    if (!ch) return notFound(c, 'channel');
    const db = getCrmDb();
    const r = db.prepare(`
      SELECT ai_enabled, ai_system_prompt, ai_model, ai_audio_enabled,
             ai_max_history, ai_debounce_seconds
      FROM crm_channels WHERE id = ? AND tenant_id = ?
    `).get(id, tid) as any;
    return ok(c, {
      enabled: !!r?.ai_enabled,
      systemPrompt: r?.ai_system_prompt || '',
      model: r?.ai_model || 'deepseek-chat',
      audioEnabled: r ? r.ai_audio_enabled !== 0 : true,
      maxHistory: Number(r?.ai_max_history || 20),
      debounceSeconds: Number(r?.ai_debounce_seconds || 8),
    });
  });
  app.patch('/channels/:id/ai-config', async (c) => {
    const tid = tenantOf(c);
    const id = c.req.param('id');
    const ch = store.getChannel(tid, id);
    if (!ch) return notFound(c, 'channel');
    const body = await c.req.json().catch(() => ({})) as any;
    const db = getCrmDb();
    const sets: string[] = []; const params: any[] = [];
    if (body.enabled !== undefined)         { sets.push('ai_enabled = ?');         params.push(body.enabled ? 1 : 0); }
    if (body.systemPrompt !== undefined)    { sets.push('ai_system_prompt = ?');   params.push(String(body.systemPrompt || '')); }
    if (body.model !== undefined)           { sets.push('ai_model = ?');           params.push(String(body.model || 'deepseek-chat')); }
    if (body.audioEnabled !== undefined)    { sets.push('ai_audio_enabled = ?');   params.push(body.audioEnabled ? 1 : 0); }
    if (body.maxHistory !== undefined)      { sets.push('ai_max_history = ?');     params.push(Math.max(1, Math.min(100, Number(body.maxHistory) || 20))); }
    if (body.debounceSeconds !== undefined) { sets.push('ai_debounce_seconds = ?'); params.push(Math.max(0, Math.min(60, Number(body.debounceSeconds) || 8))); }
    if (!sets.length) return badRequest(c, 'no fields to update');
    params.push(id, tid);
    db.prepare(`UPDATE crm_channels SET ${sets.join(', ')} WHERE id = ? AND tenant_id = ?`).run(...params);
    return ok(c, { ok: true });
  });

  app.get('/channels/:id/webhook-info', (c) => {
    const tid = tenantOf(c);
    const ch = store.getChannel(tid, c.req.param('id'));
    if (!ch) return notFound(c, 'channel');
    const baseUrl = process.env.CLOW_PUBLIC_BASE_URL || 'https://localhost:3001';
    const path = ch.type === 'meta' ? `/webhooks/crm/meta/${ch.webhookSecret}` : `/webhooks/crm/zapi/${ch.webhookSecret}`;
    return ok(c, {
      url: baseUrl.replace(/\/$/, '') + path,
      secret: ch.webhookSecret,
      lastInboundAt: (ch as any).lastInboundAt || null,
      autoCreateCards: (ch as any).auto_create_cards !== 0,
      inboxBoardId: (ch as any).inbox_board_id || null,
      inboxColumnId: (ch as any).inbox_column_id || null,
    });
  });
  app.patch('/channels/:id/inbox-config', async (c) => {
    const tid = tenantOf(c);
    const id = c.req.param('id');
    const ch = store.getChannel(tid, id);
    if (!ch) return notFound(c, 'channel');
    const body = await c.req.json().catch(() => ({})) as any;
    const db = getCrmDb();
    const sets: string[] = []; const params: any[] = [];
    if (body.autoCreateCards !== undefined) { sets.push('auto_create_cards = ?'); params.push(body.autoCreateCards ? 1 : 0); }
    if (body.inboxBoardId !== undefined)    { sets.push('inbox_board_id = ?');    params.push(body.inboxBoardId || null); }
    if (body.inboxColumnId !== undefined)   { sets.push('inbox_column_id = ?');   params.push(body.inboxColumnId || null); }
    if (!sets.length) return badRequest(c, 'no fields');
    params.push(id, tid);
    db.prepare(`UPDATE crm_channels SET ${sets.join(', ')} WHERE id = ? AND tenant_id = ?`).run(...params);
    return ok(c, { ok: true });
  });
  app.post('/channels/:id/test-inbound', async (c) => {
    const tid = tenantOf(c);
    const id = c.req.param('id');
    const ch = store.getChannel(tid, id);
    if (!ch) return notFound(c, 'channel');
    const body = await c.req.json().catch(() => ({})) as any;
    const fromPhone = String(body.fromPhone || '5511900000000');
    const fromName = String(body.fromName || 'Teste Lead');
    const text = String(body.text || 'Mensagem de teste — gerada via UI');
    const { ingestInbound } = await import('.././inbox.js');
    try {
      const r = await ingestInbound(ch, {
        fromPhone, fromName, messageId: 'test_' + Date.now(),
        type: 'text' as any, text, timestamp: Date.now(),
      });
      return ok(c, { ok: true, result: r });
    } catch (err: any) {
      return c.json({ error: 'test_failed', message: err.message }, 500);
    }
  });
  app.delete('/channels/:id', (c) => {
    const ok2 = store.deleteChannel(tenantOf(c), c.req.param('id'));
    return ok2 ? c.body(null, 204) : notFound(c, 'channel');
  });
  app.post('/channels/:id/send', async (c) => {
    const tid = tenantOf(c);
    const ch = store.getChannel(tid, c.req.param('id'));
    if (!ch) return notFound(c, 'channel');
    const body = await c.req.json().catch(() => ({}));
    if (!body.to) return badRequest(c, 'to required');
    if (!body.text && !body.mediaUrl) return badRequest(c, 'text or mediaUrl required');
    const r = await sendOutbound(ch, body);
    return r.ok ? ok(c, r) : c.json({ error: 'send_failed', message: r.error }, 502);
  });
  app.get('/channels/:id/health', async (c) => {
    return ok(c, { health: await store.channelHealthCheck(tenantOf(c), c.req.param('id')) });
  });
  app.get('/channels/:id/metrics', (c) => {
    const m = store.getChannelMetrics(tenantOf(c), c.req.param('id'));
    return m ? ok(c, { metrics: m }) : notFound(c, 'channel');
  });
  app.post('/channels/:id/templates/sync', async (c) => {
    return ok(c, await store.syncMetaTemplates(tenantOf(c), c.req.param('id')));
  });
  app.get('/channels/:id/templates', (c) => {
    return ok(c, { templates: store.listChannelTemplates(tenantOf(c), c.req.param('id')) });
  });
  app.get('/webhooks', (c) => ok(c, { webhooks: forms.listHooks(tenantOf(c)) }));
  app.post('/webhooks', async (c) => {
    const tid = tenantOf(c);
    const body = await c.req.json().catch(() => ({})) as any;
    if (!body.name || typeof body.mapping !== 'object') return badRequest(c, 'name + mapping required');
    const hook = forms.createHook(tid, body);
    return ok(c, { webhook: hook }, 201);
  });
  app.delete('/webhooks/:id', (c) => {
    return forms.deleteHook(tenantOf(c), c.req.param('id')) ? c.body(null, 204) : notFound(c, 'webhook');
  });
  app.post('/webhooks/:id/toggle', async (c) => {
    const tid = tenantOf(c);
    const body = await c.req.json().catch(() => ({})) as any;
    const ok2 = forms.toggleHook(tid, c.req.param('id'), body.enabled !== false);
    return ok2 ? ok(c, { ok: true }) : notFound(c, 'webhook');
  });
  app.get('/external-integrations', (c) => ok(c, { integrations: extint.listIntegrations(tenantOf(c)) }));
  app.post('/external-integrations', async (c) => {
    const tid = tenantOf(c);
    const body = await c.req.json().catch(() => ({})) as any;
    if (!body.provider || !['gmail', 'outlook', 'hubspot', 'rdstation'].includes(body.provider)) {
      return badRequest(c, 'invalid provider');
    }
    return ok(c, { integration: extint.createIntegration(tid, body) }, 201);
  });
  app.get('/external-integrations/:id', (c) => {
    const i = extint.getIntegration(tenantOf(c), c.req.param('id'));
    return i ? ok(c, { integration: i }) : notFound(c, 'integration');
  });
  app.patch('/external-integrations/:id', async (c) => {
    const tid = tenantOf(c);
    const body = await c.req.json().catch(() => ({})) as any;
    const i = extint.updateIntegration(tid, c.req.param('id'), body);
    return i ? ok(c, { integration: i }) : notFound(c, 'integration');
  });
  app.delete('/external-integrations/:id', (c) => {
    return extint.deleteIntegration(tenantOf(c), c.req.param('id')) ? c.body(null, 204) : notFound(c, 'integration');
  });
  app.post('/external-integrations/:id/sync', async (c) => {
    const tid = tenantOf(c);
    const id = c.req.param('id');
    const integ = extint.getIntegration(tid, id);
    if (!integ) return notFound(c, 'integration');
    try {
      if (integ.provider === 'hubspot')   return ok(c, await extint.importFromHubSpot(tid, id));
      if (integ.provider === 'rdstation') return ok(c, await extint.importFromRDStation(tid, id));
      return badRequest(c, 'provider ' + integ.provider + ' sync not implemented yet');
    } catch (err: any) { return c.json({ error: 'sync_failed', message: err.message }, 502); }
  });
}
