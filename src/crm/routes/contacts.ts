// CRM contacts module — split out from the legacy monolithic file in a refactor.
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



export function registerContactsRoutes(app: Hono): void {
  app.get('/contacts', (c) => {
    const limit = parseInt(c.req.query('limit') || '50', 10);
    const offset = parseInt(c.req.query('offset') || '0', 10);
    const tag = c.req.query('tag') || undefined;
    const tid = tenantOf(c);
    const contacts = store.listContacts(tid, { limit, offset, tag });
    const total = store.countContacts(tid, { tag });
    return ok(c, { contacts, total, limit, offset, hasMore: offset + contacts.length < total });
  });
  app.post('/contacts/refresh-photos', async (c) => {
    const tid = tenantOf(c);
    const body = await c.req.json().catch(() => ({})) as any;
    const force = body.force === true;

    const zapiMod = await import('.././channels/zapi.js');
    const dbMod = await import('.././schema.js');
    const db = dbMod.getCrmDb();

    const channels = db.prepare("SELECT * FROM crm_channels WHERE tenant_id = ? AND type = 'zapi' AND status != 'disabled'").all(tid) as any[];
    if (!channels.length) {
      return c.json({ ok: false, error: 'no_zapi_channel', message: 'Conecte um canal Z-API primeiro' }, 400);
    }
    const channel = {
      id: channels[0].id, tenantId: channels[0].tenant_id, type: channels[0].type,
      name: channels[0].name, credentialsEncrypted: channels[0].credentials_encrypted,
      status: channels[0].status,
    };

    const where = force
      ? "tenant_id = ? AND phone IS NOT NULL AND phone != '' AND deleted_at IS NULL"
      : "tenant_id = ? AND phone IS NOT NULL AND phone != '' AND avatar_url IS NULL AND deleted_at IS NULL";
    const contacts = db.prepare(`SELECT id, phone, name FROM crm_contacts WHERE ${where} LIMIT 500`).all(tid) as any[];

    let updated = 0, noPhoto = 0, errors = 0;
    const upd = db.prepare('UPDATE crm_contacts SET avatar_url = ?, updated_at = ? WHERE id = ?');
    for (const ct of contacts) {
      try {
        const url = await zapiMod.fetchProfilePicture(channel as any, ct.phone);
        if (url) { upd.run(url, Date.now(), ct.id); updated++; }
        else { noPhoto++; }
      } catch { errors++; }
      await new Promise(r => setTimeout(r, 150));
    }
    return c.json({ ok: true, updated, noPhoto, errors, total: contacts.length, force });
  });
  app.get('/contacts/search', (c) => {
    const q = c.req.query('q') || '';
    if (!q) return ok(c, { contacts: [] });
    return ok(c, { contacts: store.searchContacts(tenantOf(c), q, 100) });
  });
  app.post('/contacts', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (!body.name) return badRequest(c, 'name required');
    const contact = store.createContact(tenantOf(c), body);
    return ok(c, { contact }, 201);
  });
  app.get('/contacts/duplicates', (c) => {
    const dups = store.findDuplicateContacts(tenantOf(c));
    return ok(c, { duplicates: dups });
  });
  app.post('/contacts/:id/merge', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const targetId = (body as any).target_id || (body as any).targetId;
    if (!targetId) return badRequest(c, 'target_id required');
    const r = store.mergeContacts(tenantOf(c), c.req.param('id'), targetId);
    return r.ok ? ok(c, { merged: true }) : c.json({ error: r.error }, 400);
  });
  app.post('/contacts/import', async (c) => {
    const tid = tenantOf(c);
    const ctype = c.req.header('content-type') || '';
    let csv = '';
    if (ctype.includes('multipart/form-data')) {
      const fd = await c.req.formData();
      const file = fd.get('file');
      if (!file || typeof file === 'string') return badRequest(c, 'file required');
      const filename = String((file as any).name || '').toLowerCase();
      const isXlsx = filename.endsWith('.xlsx') || filename.endsWith('.xls') ||
        ((file as any).type || '').includes('spreadsheet');
      const bytes = Buffer.from(await (file as any).arrayBuffer());
      if (isXlsx) {
        // Converte XLSX → CSV em memoria, reusa importContactsCsv
        try {
          const ExcelJS = (await import('exceljs')).default;
          const wb = new ExcelJS.Workbook();
          await wb.xlsx.load(bytes as any);
          const ws = wb.worksheets[0];
          if (!ws) return badRequest(c, 'planilha vazia');
          const csvLines: string[] = [];
          ws.eachRow((row) => {
            const cells: string[] = [];
            row.eachCell({ includeEmpty: true }, (cell) => {
              const v = cell.value;
              let s = '';
              if (v == null) s = '';
              else if (typeof v === 'object' && (v as any).text) s = String((v as any).text);
              else if (typeof v === 'object' && (v as any).richText) s = (v as any).richText.map((rt: any) => rt.text).join('');
              else if (v instanceof Date) s = v.toISOString();
              else s = String(v);
              // CSV escape: aspas duplas se contem virgula/aspas/quebra
              if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
              cells.push(s);
            });
            csvLines.push(cells.join(','));
          });
          csv = csvLines.join('\n');
        } catch (err: any) {
          return badRequest(c, 'erro lendo XLSX: ' + err.message);
        }
      } else {
        csv = bytes.toString('utf-8');
        // Remove BOM (Excel costuma exportar com)
        if (csv.charCodeAt(0) === 0xFEFF) csv = csv.slice(1);
      }
    } else {
      csv = await c.req.text();
    }
    const result = store.importContactsCsv(tid, csv);
    return ok(c, result);
  });
  app.get('/contacts/export', async (c) => {
    const tid = tenantOf(c);
    const format = (c.req.query('format') || 'csv').toLowerCase();
    if (format === 'xlsx') {
      try {
        const ExcelJS = (await import('exceljs')).default;
        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet('Contatos');
        const headers = ['name', 'phone', 'email', 'company', 'title', 'website', 'address', 'cpf_cnpj', 'lead_score', 'tags', 'source', 'notes', 'created_at'];
        ws.addRow(headers);
        ws.getRow(1).font = { bold: true };
        const dbMod = await import('.././schema.js');
        const db = dbMod.getCrmDb();
        const rows = db.prepare('SELECT * FROM crm_contacts WHERE tenant_id = ? AND deleted_at IS NULL ORDER BY created_at DESC').all(tid) as any[];
        for (const r of rows) {
          const tags = (() => { try { return JSON.parse(r.tags_json || '[]').join(';'); } catch { return ''; } })();
          ws.addRow([
            r.name || '', r.phone || '', r.email || '', r.company || '', r.title || '',
            r.website || '', r.address || '', r.cpf_cnpj || '', r.lead_score || 0,
            tags, r.source || '', r.notes || '',
            new Date(r.created_at).toISOString(),
          ]);
        }
        // Auto-width
        ws.columns.forEach((col, i) => {
          let max = headers[i].length;
          col.eachCell?.({ includeEmpty: false }, (cell) => {
            const len = String(cell.value || '').length;
            if (len > max) max = Math.min(len, 50);
          });
          col.width = max + 2;
        });
        const buf = await wb.xlsx.writeBuffer();
        return new Response(buf as any, {
          headers: {
            'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'Content-Disposition': 'attachment; filename="contatos.xlsx"',
          },
        });
      } catch (err: any) {
        return c.json({ error: 'export_failed', message: err.message }, 500);
      }
    }
    // default: CSV (com BOM pra Excel abrir UTF-8 corretamente)
    const csv = '\uFEFF' + store.exportContactsCsv(tenantOf(c));
    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="contatos.csv"',
      },
    });
  });
  app.post('/contacts/bulk', async (c) => {
    const body = await c.req.json().catch(() => ({})) as any;
    if (!body.action || !Array.isArray(body.ids)) return badRequest(c, 'action + ids[] required');
    const r = store.bulkContactOp(tenantOf(c), body);
    return ok(c, r);
  });
  app.get('/contacts/:id/history', (c) => {
    const limit = parseInt(c.req.query('limit') || '500', 10);
    const type = c.req.query('type') || undefined;
    const h = store.getContactHistory(tenantOf(c), c.req.param('id'), { limit, type });
    return ok(c, h);
  });
  app.get('/contacts/:id', (c) => {
    const tid = tenantOf(c);
    const contact = store.getContact(tid, c.req.param('id'));
    if (!contact) return notFound(c, 'contact');
    const cards = store.listCardsByContact(tid, contact.id);
    const activities = store.listActivitiesByContact(tid, contact.id, 1000);
    return ok(c, { contact, cards, activities });
  });
  app.patch('/contacts/:id', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const upd = store.updateContact(tenantOf(c), c.req.param('id'), body);
    return upd ? ok(c, { contact: upd }) : notFound(c, 'contact');
  });
  app.delete('/contacts/:id', (c) => {
    const ok2 = store.deleteContact(tenantOf(c), c.req.param('id'));
    return ok2 ? c.body(null, 204) : notFound(c, 'contact');
  });
  app.get('/email-templates', (c) => {
    const tid = tenantOf(c);
    const rows = getCrmDb().prepare('SELECT * FROM crm_email_templates WHERE tenant_id = ? ORDER BY updated_at DESC').all(tid);
    return ok(c, { templates: rows });
  });
  app.post('/email-templates', async (c) => {
    const tid = tenantOf(c);
    const body = await c.req.json().catch(() => ({})) as any;
    const name = String(body.name || '').trim();
    const subject = String(body.subject || '').trim();
    const html = String(body.bodyHtml || body.body_html || '');
    if (!name || !subject || !html) return badRequest(c, 'name, subject, bodyHtml required');
    const id = 'crm_emtpl_' + Math.random().toString(36).slice(2, 14);
    const now = Date.now();
    getCrmDb().prepare(
      'INSERT INTO crm_email_templates (id, tenant_id, name, subject, body_html, variables_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, tid, name, subject, html, JSON.stringify(body.variables || []), now, now);
    return ok(c, { id }, 201);
  });
  app.patch('/email-templates/:id', async (c) => {
    const tid = tenantOf(c);
    const body = await c.req.json().catch(() => ({})) as any;
    const sets: string[] = []; const params: any[] = [];
    for (const [k, col] of [['name','name'],['subject','subject'],['bodyHtml','body_html']]) {
      if (body[k] !== undefined) { sets.push(`${col} = ?`); params.push(body[k]); }
    }
    if (!sets.length) return badRequest(c, 'no fields to update');
    sets.push('updated_at = ?'); params.push(Date.now());
    params.push(c.req.param('id'), tid);
    const r = getCrmDb().prepare(`UPDATE crm_email_templates SET ${sets.join(', ')} WHERE id = ? AND tenant_id = ?`).run(...params);
    return r.changes > 0 ? ok(c, { ok: true }) : notFound(c, 'template');
  });
  app.delete('/email-templates/:id', (c) => {
    const tid = tenantOf(c);
    const r = getCrmDb().prepare('DELETE FROM crm_email_templates WHERE id = ? AND tenant_id = ?').run(c.req.param('id'), tid);
    return r.changes > 0 ? c.body(null, 204) : notFound(c, 'template');
  });
  app.get('/campaigns', (c) => {
    const tid = tenantOf(c);
    const rows = getCrmDb().prepare('SELECT * FROM crm_email_campaigns WHERE tenant_id = ? ORDER BY created_at DESC').all(tid);
    return ok(c, { campaigns: rows });
  });
  app.post('/campaigns', async (c) => {
    const tid = tenantOf(c);
    const body = await c.req.json().catch(() => ({})) as any;
    const name = String(body.name || '').trim();
    const segmentId = String(body.segmentId || '').trim();
    let subject = body.subject as string;
    let html = body.bodyHtml || body.body_html;
    if (body.templateId) {
      const tpl = getCrmDb().prepare('SELECT subject, body_html FROM crm_email_templates WHERE id = ? AND tenant_id = ?').get(body.templateId, tid) as any;
      if (tpl) { subject = subject || tpl.subject; html = html || tpl.body_html; }
    }
    if (!name || !segmentId || !subject || !html) return badRequest(c, 'name, segmentId, subject, bodyHtml required');
    const id = 'crm_camp_' + Math.random().toString(36).slice(2, 14);
    const scheduledAt = body.scheduledAt ? Number(body.scheduledAt) : null;
    const status = scheduledAt ? 'scheduled' : 'draft';
    getCrmDb().prepare(`
      INSERT INTO crm_email_campaigns (id, tenant_id, name, segment_id, template_id, subject, body_html, status, scheduled_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, tid, name, segmentId, body.templateId || null, subject, html, status, scheduledAt, Date.now());
    return ok(c, { id, status }, 201);
  });
  app.get('/campaigns/:id', (c) => {
    const tid = tenantOf(c);
    const row = getCrmDb().prepare('SELECT * FROM crm_email_campaigns WHERE id = ? AND tenant_id = ?').get(c.req.param('id'), tid);
    return row ? ok(c, { campaign: row }) : notFound(c, 'campaign');
  });
  app.post('/campaigns/:id/send', (c) => {
    const tid = tenantOf(c);
    try {
      const r = em.enqueueCampaign(tid, c.req.param('id'));
      return ok(c, r);
    } catch (err: any) { return notFound(c, err.message); }
  });
  app.post('/campaigns/:id/pause', (c) => {
    const tid = tenantOf(c);
    const r = getCrmDb().prepare("UPDATE crm_email_campaigns SET status = 'paused' WHERE id = ? AND tenant_id = ?").run(c.req.param('id'), tid);
    return r.changes > 0 ? ok(c, { ok: true }) : notFound(c, 'campaign');
  });
  app.post('/campaigns/:id/resume', (c) => {
    const tid = tenantOf(c);
    const r = getCrmDb().prepare("UPDATE crm_email_campaigns SET status = 'sending' WHERE id = ? AND tenant_id = ? AND status = 'paused'").run(c.req.param('id'), tid);
    return r.changes > 0 ? ok(c, { ok: true }) : notFound(c, 'campaign');
  });
  app.get('/campaigns/:id/stats', (c) => {
    const tid = tenantOf(c);
    const id = c.req.param('id');
    const camp = getCrmDb().prepare('SELECT * FROM crm_email_campaigns WHERE id = ? AND tenant_id = ?').get(id, tid) as any;
    if (!camp) return notFound(c, 'campaign');
    const sends = getCrmDb().prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN sent_at IS NOT NULL THEN 1 ELSE 0 END) AS sent,
        SUM(CASE WHEN opened_at IS NOT NULL THEN 1 ELSE 0 END) AS opened,
        SUM(CASE WHEN clicked_at IS NOT NULL THEN 1 ELSE 0 END) AS clicked,
        SUM(bounced) AS bounced
      FROM crm_campaign_sends WHERE campaign_id = ?
    `).get(id) as any;
    return ok(c, { campaign: camp, sends });
  });
  app.get('/sequences', (c) => {
    const tid = tenantOf(c);
    const rows = getCrmDb().prepare('SELECT * FROM crm_email_sequences WHERE tenant_id = ? ORDER BY updated_at DESC').all(tid);
    return ok(c, { sequences: rows });
  });
  app.post('/sequences', async (c) => {
    const tid = tenantOf(c);
    const body = await c.req.json().catch(() => ({})) as any;
    const name = String(body.name || '').trim();
    const steps = Array.isArray(body.steps) ? body.steps : [];
    if (!name || steps.length === 0) return badRequest(c, 'name + steps[] required');
    const id = 'crm_seq_' + Math.random().toString(36).slice(2, 14);
    const now = Date.now();
    getCrmDb().prepare(
      'INSERT INTO crm_email_sequences (id, tenant_id, name, segment_id, steps_json, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, tid, name, body.segmentId || null, JSON.stringify(steps), body.enabled === false ? 0 : 1, now, now);
    return ok(c, { id }, 201);
  });
  app.patch('/sequences/:id', async (c) => {
    const tid = tenantOf(c);
    const body = await c.req.json().catch(() => ({})) as any;
    const sets: string[] = []; const params: any[] = [];
    if (body.name !== undefined)     { sets.push('name = ?');        params.push(body.name); }
    if (body.segmentId !== undefined){ sets.push('segment_id = ?');  params.push(body.segmentId); }
    if (body.steps !== undefined)    { sets.push('steps_json = ?');  params.push(JSON.stringify(body.steps)); }
    if (body.enabled !== undefined)  { sets.push('enabled = ?');     params.push(body.enabled ? 1 : 0); }
    if (!sets.length) return badRequest(c, 'no fields');
    sets.push('updated_at = ?'); params.push(Date.now());
    params.push(c.req.param('id'), tid);
    const r = getCrmDb().prepare(`UPDATE crm_email_sequences SET ${sets.join(', ')} WHERE id = ? AND tenant_id = ?`).run(...params);
    return r.changes > 0 ? ok(c, { ok: true }) : notFound(c, 'sequence');
  });
  app.delete('/sequences/:id', (c) => {
    const tid = tenantOf(c);
    const r = getCrmDb().prepare('DELETE FROM crm_email_sequences WHERE id = ? AND tenant_id = ?').run(c.req.param('id'), tid);
    return r.changes > 0 ? c.body(null, 204) : notFound(c, 'sequence');
  });
  app.post('/sequences/:id/enroll', async (c) => {
    const tid = tenantOf(c);
    const body = await c.req.json().catch(() => ({})) as any;
    const cid = String(body.contactId || '').trim();
    if (!cid) return badRequest(c, 'contactId required');
    const enrId = em.enrollInSequence(tid, c.req.param('id'), cid);
    return enrId ? ok(c, { enrollmentId: enrId }, 201) : badRequest(c, 'enrollment failed (already enrolled or sequence disabled)');
  });
  app.get('/unsubscribes', (c) => {
    const tid = tenantOf(c);
    const rows = getCrmDb().prepare('SELECT email, reason, created_at FROM crm_unsubscribes WHERE tenant_id = ? ORDER BY created_at DESC').all(tid);
    return ok(c, { unsubscribes: rows });
  });
  app.post('/unsubscribes', async (c) => {
    const tid = tenantOf(c);
    const body = await c.req.json().catch(() => ({})) as any;
    const email = String(body.email || '').trim().toLowerCase();
    if (!email || !email.includes('@')) return badRequest(c, 'valid email required');
    try {
      getCrmDb().prepare('INSERT INTO crm_unsubscribes (tenant_id, email, reason, created_at) VALUES (?, ?, ?, ?)')
        .run(tid, email, body.reason || null, Date.now());
    } catch { /* already unsubbed */ }
    return ok(c, { ok: true });
  });
  app.delete('/unsubscribes/:email', (c) => {
    const tid = tenantOf(c);
    const r = getCrmDb().prepare('DELETE FROM crm_unsubscribes WHERE tenant_id = ? AND email = ?').run(tid, c.req.param('email').toLowerCase());
    return r.changes > 0 ? c.body(null, 204) : notFound(c, 'unsubscribe');
  });
  app.get('/forms', (c) => ok(c, { forms: forms.listForms(tenantOf(c)) }));
  app.post('/forms', async (c) => {
    const tid = tenantOf(c);
    const body = await c.req.json().catch(() => ({})) as any;
    if (!body.name || !Array.isArray(body.fields) || typeof body.mapping !== 'object') {
      return badRequest(c, 'name, fields[], mapping required');
    }
    const f = forms.createForm(tid, body);
    return ok(c, { form: f }, 201);
  });
  app.get('/forms/:id', (c) => {
    const f = forms.getFormById(tenantOf(c), c.req.param('id'));
    return f ? ok(c, { form: f }) : notFound(c, 'form');
  });
  app.patch('/forms/:id', async (c) => {
    const tid = tenantOf(c);
    const body = await c.req.json().catch(() => ({})) as any;
    const f = forms.updateForm(tid, c.req.param('id'), body);
    return f ? ok(c, { form: f }) : notFound(c, 'form');
  });
  app.delete('/forms/:id', (c) => {
    return forms.deleteForm(tenantOf(c), c.req.param('id')) ? c.body(null, 204) : notFound(c, 'form');
  });
  app.get('/forms/:id/submissions', (c) => {
    const tid = tenantOf(c);
    const limit = Math.min(1000, Number(c.req.query('limit')) || 100);
    return ok(c, { submissions: forms.listSubmissions(tid, c.req.param('id'), limit) });
  });
  app.get('/contacts/:id/tasks', (c) => {
    const tid = tenantOf(c);
    return ok(c, { tasks: tasksMod.listTasks(tid, { ...parseTaskOpts(c), contactId: c.req.param('id'), status: 'all' }) });
  });
  app.get('/contacts/:id/notes', (c) => {
    return ok(c, { notes: collab.listContactNotes(tenantOf(c), c.req.param('id')) });
  });
  app.post('/contacts/:id/notes', async (c) => {
    const tid = tenantOf(c);
    const body = await c.req.json().catch(() => ({})) as any;
    if (!body.content) return badRequest(c, 'content required');
    return ok(c, { note: collab.createContactNote(tid, { ...body, contactId: c.req.param('id') }) }, 201);
  });
  app.get('/contacts/:id/timeline', (c) => {
    const tid = tenantOf(c);
    const limit = Number(c.req.query('limit')) || 200;
    return ok(c, { timeline: collab.contactTimeline(tid, c.req.param('id'), { limit }) });
  });
  app.post('/bulk/cards', async (c) => {
    const tid = tenantOf(c);
    const body = await c.req.json().catch(() => ({})) as any;
    if (!Array.isArray(body.ids) || body.ids.length === 0) return badRequest(c, 'ids[] required');
    if (!body.action) return badRequest(c, 'action required');
    return ok(c, search.bulkCardAction(tid, body));
  });
  app.post('/bulk/contacts', async (c) => {
    const tid = tenantOf(c);
    const body = await c.req.json().catch(() => ({})) as any;
    if (!Array.isArray(body.ids) || body.ids.length === 0) return badRequest(c, 'ids[] required');
    if (!body.action) return badRequest(c, 'action required');
    return ok(c, search.bulkContactAction(tid, body));
  });
  app.get('/contacts/:id/documents', (c) => {
    const tid = tenantOf(c);
    return ok(c, { documents: docs.listDocuments(tid, { contactId: c.req.param('id') }) });
  });
  app.get('/contacts/:id/consents', (c) => {
    const tid = tenantOf(c);
    return ok(c, { consents: lgpd.listContactConsents(tid, c.req.param('id')) });
  });
  app.post('/contacts/:id/consents', async (c) => {
    const tid = tenantOf(c);
    const body = await c.req.json().catch(() => ({})) as any;
    if (!body.channel || !body.purpose || body.granted === undefined) return badRequest(c, 'channel + purpose + granted required');
    const consent = lgpd.recordConsent(tid, {
      contactId: c.req.param('id'),
      channel: body.channel, purpose: body.purpose,
      granted: !!body.granted, source: body.source, evidence: body.evidence,
    });
    return ok(c, { consent }, 201);
  });
  app.get('/contacts/:id/has-consent', (c) => {
    const tid = tenantOf(c);
    const channel = c.req.query('channel') as any;
    const purpose = c.req.query('purpose') as any;
    if (!channel || !purpose) return badRequest(c, 'channel + purpose required');
    return ok(c, { granted: lgpd.hasConsent(tid, c.req.param('id'), channel, purpose) });
  });
  app.get('/contacts/:id/portability', (c) => {
    const tid = tenantOf(c);
    const data = lgpd.exportContactData(tid, c.req.param('id'), c.req.header('x-actor-agent-id') || undefined);
    if (!data) return notFound(c, 'contact');
    const fmt = c.req.query('format');
    if (fmt === 'download') {
      return new Response(JSON.stringify(data, null, 2), {
        status: 200,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'content-disposition': `attachment; filename="portability-${c.req.param('id')}.json"`,
        },
      });
    }
    return ok(c, data);
  });
  app.post('/contacts/:id/forget', async (c) => {
    const tid = tenantOf(c);
    const body = await c.req.json().catch(() => ({})) as any;
    const mode = body.mode === 'delete' ? 'delete' : 'anonymize';
    const result = lgpd.forgetContact(tid, c.req.param('id'), {
      mode,
      actorAgentId: c.req.header('x-actor-agent-id') || body.actorAgentId,
      reason: body.reason,
    });
    return ok(c, result);
  });
  app.get('/contacts/:id/access-log', (c) => {
    const tid = tenantOf(c);
    return ok(c, { log: lgpd.queryAccessLog(tid, { contactId: c.req.param('id') }) });
  });
  app.post('/bulk/contacts/create', async (c) => {
    const tid = tenantOf(c);
    const body = await c.req.json().catch(() => ({})) as any;
    if (!Array.isArray(body.contacts)) return badRequest(c, 'contacts[] required');
    return ok(c, bulkOps.bulkCreateContacts(tid, body.contacts));
  });
  app.post('/bulk/contacts/update', async (c) => {
    const tid = tenantOf(c);
    const body = await c.req.json().catch(() => ({})) as any;
    if (!Array.isArray(body.updates)) return badRequest(c, 'updates[] required');
    return ok(c, bulkOps.bulkUpdateContacts(tid, body.updates));
  });
  app.post('/bulk/cards/create', async (c) => {
    const tid = tenantOf(c);
    const body = await c.req.json().catch(() => ({})) as any;
    if (!Array.isArray(body.cards)) return badRequest(c, 'cards[] required');
    return ok(c, bulkOps.bulkCreateCards(tid, body.cards));
  });
  app.post('/bulk/:entity/soft-delete', async (c) => {
    const tid = tenantOf(c);
    const body = await c.req.json().catch(() => ({})) as any;
    if (!Array.isArray(body.ids)) return badRequest(c, 'ids[] required');
    const entityMap: Record<string, string> = {
      cards: 'crm_cards', contacts: 'crm_contacts', activities: 'crm_activities',
      tasks: 'crm_tasks', appointments: 'crm_appointments',
    };
    const table = entityMap[c.req.param('entity')];
    if (!table) return badRequest(c, 'invalid entity');
    return ok(c, bulkOps.bulkSoftDelete(tid, table, body.ids));
  });
  app.post('/segments', async (c) => {
    const body = await c.req.json().catch(() => ({})) as any;
    if (!body.name || !body.filter) return badRequest(c, 'name + filter required');
    const seg = store.createSegment(tenantOf(c), body);
    return ok(c, { segment: seg }, 201);
  });
  app.get('/segments', (c) => ok(c, { segments: store.listSegments(tenantOf(c)) }));
  app.get('/segments/:id', (c) => {
    const seg = store.getSegment(tenantOf(c), c.req.param('id'));
    return seg ? ok(c, { segment: seg }) : notFound(c, 'segment');
  });
  app.patch('/segments/:id', async (c) => {
    const body = await c.req.json().catch(() => ({})) as any;
    const seg = store.updateSegment(tenantOf(c), c.req.param('id'), body);
    return seg ? ok(c, { segment: seg }) : notFound(c, 'segment');
  });
  app.delete('/segments/:id', (c) => {
    const ok2 = store.deleteSegment(tenantOf(c), c.req.param('id'));
    return ok2 ? c.body(null, 204) : notFound(c, 'segment');
  });
  app.post('/segments/:id/run', (c) => {
    const tid = tenantOf(c);
    const seg = store.getSegment(tid, c.req.param('id'));
    if (!seg) return notFound(c, 'segment');
    const limit = parseInt(c.req.query('limit') || '500', 10);
    const contacts = store.runSegment(tid, seg.filter, limit);
    return ok(c, { contacts, total: contacts.length });
  });
}
