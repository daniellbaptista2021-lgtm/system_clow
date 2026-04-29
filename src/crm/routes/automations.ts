// CRM automations module — split out from the legacy monolithic file in a refactor.
// Edit this file directly; scripts/split-routes.cjs is retained only as a record
// of how the original was decomposed (it ran once against the .ts.bak snapshot).
import { Hono } from 'hono';
import { tenantOf } from './_helpers.js';
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



export function registerAutomationsRoutes(app: Hono): void {
  app.patch('/automations/:id/schedule', async (c) => {
    const body = await c.req.json().catch(() => ({})) as any;
    const cron = body.schedule_cron ?? null;
    const nextRunAt = body.next_run_at ?? (cron ? Date.now() + 60000 : null);
    return store.setAutomationSchedule(tenantOf(c), c.req.param('id'), cron, nextRunAt) ? ok(c, { ok: true }) : notFound(c, 'automation');
  });
  app.post('/automations/:id/webhook', (c) => {
    const secret = store.setAutomationWebhook(tenantOf(c), c.req.param('id'));
    const url = `/v1/crm/automations/webhook/${secret}`;
    return ok(c, { url, secret });
  });
  app.post('/automations/webhook/:secret', async (c) => {
    const auto = store.findAutomationByWebhook(c.req.param('secret'));
    if (!auto) return notFound(c, 'automation');
    const payload = await c.req.json().catch(() => ({}));
    const start = Date.now();
    try {
      // dispara automation via seu engine existente (emit)
      const automations = await import('.././automations.js');
      await automations.emit({ trigger: 'webhook', tenantId: auto.tenant_id, text: JSON.stringify(payload) });
      store.logAutomationRun(auto.tenant_id, auto.id, { triggerPayload: payload, actionsExecuted: 1, success: true, durationMs: Date.now() - start });
      return ok(c, { fired: true });
    } catch (err: any) {
      store.logAutomationRun(auto.tenant_id, auto.id, { triggerPayload: payload, actionsExecuted: 0, success: false, error: err.message, durationMs: Date.now() - start });
      return c.json({ error: err.message }, 500);
    }
  });
  app.get('/automations/:id/logs', (c) => {
    const limit = parseInt(c.req.query('limit') || '50', 10);
    return ok(c, { logs: store.listAutomationLogs(tenantOf(c), c.req.param('id'), limit) });
  });
  app.post('/assignment-rules', async (c) => {
    const body = await c.req.json().catch(() => ({})) as any;
    if (!body.name) return badRequest(c, 'name required');
    return ok(c, { rule: store.createAssignmentRule(tenantOf(c), {
      name: body.name, conditions: body.conditions || {},
      assignToAgentId: body.assign_to_agent_id,
      assignToTeamId: body.assign_to_team_id,
      skillRequired: body.skill_required,
      slaMinutes: body.sla_minutes,
      escalateToAgentId: body.escalate_to_agent_id,
      priority: body.priority || 0,
      enabled: body.enabled !== false,
    }) }, 201);
  });
  app.get('/assignment-rules', (c) => ok(c, { rules: store.listAssignmentRules(tenantOf(c)) }));
  app.delete('/assignment-rules/:id', (c) => store.deleteAssignmentRule(tenantOf(c), c.req.param('id')) ? c.body(null, 204) : notFound(c, 'rule'));
  app.get('/outbound-webhooks', (c) => ok(c, { webhooks: ohk.listOutboundWebhooks(tenantOf(c)) }));
  app.post('/outbound-webhooks', async (c) => {
    const tid = tenantOf(c);
    const body = await c.req.json().catch(() => ({})) as any;
    if (!body.name || !body.url || !Array.isArray(body.events)) return badRequest(c, 'name, url, events[] required');
    return ok(c, { webhook: ohk.createOutboundWebhook(tid, body) }, 201);
  });
  app.get('/outbound-webhooks/:id', (c) => {
    const w = ohk.getOutboundWebhook(tenantOf(c), c.req.param('id'));
    return w ? ok(c, { webhook: w }) : notFound(c, 'webhook');
  });
  app.patch('/outbound-webhooks/:id', async (c) => {
    const tid = tenantOf(c);
    const body = await c.req.json().catch(() => ({})) as any;
    const w = ohk.updateOutboundWebhook(tid, c.req.param('id'), body);
    return w ? ok(c, { webhook: w }) : notFound(c, 'webhook');
  });
  app.delete('/outbound-webhooks/:id', (c) => {
    return ohk.deleteOutboundWebhook(tenantOf(c), c.req.param('id')) ? c.body(null, 204) : notFound(c, 'webhook');
  });
  app.get('/outbound-webhooks/:id/deliveries', (c) => {
    const tid = tenantOf(c);
    const limit = Number(c.req.query('limit')) || 50;
    return ok(c, { deliveries: ohk.listDeliveries(tid, c.req.param('id'), limit) });
  });
  app.post('/outbound-webhooks/:id/test', async (c) => {
    const tid = tenantOf(c);
    await ohk.emit(tid, 'contact.created', { test: true, contact: { id: 'test', name: 'Test' } });
    return ok(c, { ok: true, event: 'contact.created' });
  });
  app.get('/automations', (c) => {
    return ok(c, { automations: automations.listAutomations(tenantOf(c)) });
  });
  app.get('/automations/templates', (c) => {
    return ok(c, { templates: automations.AUTOMATION_TEMPLATES });
  });
  app.post('/automations', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (!body.name || !body.trigger || !Array.isArray(body.actions)) {
      return badRequest(c, 'name, trigger, actions[] required');
    }
    const a = automations.createAutomation(tenantOf(c), body);
    return ok(c, { automation: a }, 201);
  });
  app.post('/automations/install-template', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const tpl = automations.AUTOMATION_TEMPLATES.find(t => t.key === body.key);
    if (!tpl) return badRequest(c, 'unknown template key');
    const a = automations.createAutomation(tenantOf(c), {
      name: tpl.name, trigger: tpl.trigger,
      conditions: tpl.conditions, actions: tpl.actions, enabled: true,
    });
    return ok(c, { automation: a }, 201);
  });
  app.patch('/automations/:id', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const upd = automations.updateAutomation(tenantOf(c), c.req.param('id'), body);
    return upd ? ok(c, { automation: upd }) : notFound(c, 'automation');
  });
  app.delete('/automations/:id', (c) => {
    const ok2 = automations.deleteAutomation(tenantOf(c), c.req.param('id'));
    return ok2 ? c.body(null, 204) : notFound(c, 'automation');
  });
}
