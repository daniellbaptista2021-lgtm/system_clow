/**
 * Documents / Contracts — Onda 26.
 *
 * Generalizes the proposal pattern (Onda 16) to arbitrary documents:
 * contracts, NDAs, SOWs, custom HTML. Features:
 *   - Templates with {{placeholders}}
 *   - Generate from template with variable interpolation
 *   - Send via email (attach PDF) or WhatsApp (link + summary)
 *   - Public view at /p/docs/:token with tracking
 *   - Digital signature: draw signature pad → base64 image stored with IP/timestamp
 *   - Versioning: clone creates v2 linked via parent_document_id
 *   - Repository: list by contact_id / card_id
 */

import { randomBytes, randomUUID } from 'crypto';
import PDFDocument from 'pdfkit';
import { getCrmDb } from './schema.js';
import { sendEmail } from '../notifications/mailer.js';
import { sendOutbound } from './inbox.js';

function nid(prefix: string): string { return prefix + '_' + randomBytes(6).toString('hex'); }
function genToken(): string { return randomBytes(24).toString('base64url'); }
const now = () => Date.now();

export type DocumentKind = 'contract' | 'nda' | 'proposal' | 'sow' | 'custom';
export type DocumentStatus = 'draft' | 'sent' | 'viewed' | 'signed' | 'cancelled';

// ─── Templates ─────────────────────────────────────────────────────────
export interface DocumentTemplate {
  id: string;
  tenantId: string;
  name: string;
  kind: DocumentKind;
  bodyHtml: string;
  variables: Array<{ key: string; label: string; required?: boolean; defaultValue?: string }>;
  defaultTerms?: string;
  createdAt: number;
  updatedAt: number;
}

function rowToTpl(r: any): DocumentTemplate {
  return {
    id: r.id, tenantId: r.tenant_id, name: r.name, kind: r.kind || 'custom',
    bodyHtml: r.body_html, variables: JSON.parse(r.variables_json || '[]'),
    defaultTerms: r.default_terms ?? undefined,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export function createTemplate(tenantId: string, input: {
  name: string; kind?: DocumentKind; bodyHtml: string;
  variables?: any[]; defaultTerms?: string;
}): DocumentTemplate {
  const id = nid('crm_doctpl');
  const t = now();
  getCrmDb().prepare(`
    INSERT INTO crm_document_templates (id, tenant_id, name, kind, body_html, variables_json, default_terms, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, tenantId, input.name, input.kind || 'custom', input.bodyHtml,
    JSON.stringify(input.variables || []), input.defaultTerms ?? null, t, t);
  return getTemplate(tenantId, id)!;
}

export function getTemplate(tenantId: string, id: string): DocumentTemplate | null {
  const r = getCrmDb().prepare('SELECT * FROM crm_document_templates WHERE id = ? AND tenant_id = ?').get(id, tenantId) as any;
  return r ? rowToTpl(r) : null;
}

export function listTemplates(tenantId: string, kind?: DocumentKind): DocumentTemplate[] {
  const wh = ['tenant_id = ?'];
  const params: any[] = [tenantId];
  if (kind) { wh.push('kind = ?'); params.push(kind); }
  return (getCrmDb().prepare(`SELECT * FROM crm_document_templates WHERE ${wh.join(' AND ')} ORDER BY updated_at DESC`).all(...params) as any[])
    .map(rowToTpl);
}

export function updateTemplate(tenantId: string, id: string, patch: Partial<DocumentTemplate>): DocumentTemplate | null {
  const ex = getTemplate(tenantId, id);
  if (!ex) return null;
  const m = { ...ex, ...patch };
  getCrmDb().prepare(`
    UPDATE crm_document_templates SET name=?, kind=?, body_html=?, variables_json=?, default_terms=?, updated_at=?
    WHERE id = ? AND tenant_id = ?
  `).run(m.name, m.kind, m.bodyHtml, JSON.stringify(m.variables || []), m.defaultTerms ?? null, now(), id, tenantId);
  return getTemplate(tenantId, id);
}

export function deleteTemplate(tenantId: string, id: string): boolean {
  return getCrmDb().prepare('DELETE FROM crm_document_templates WHERE id = ? AND tenant_id = ?').run(id, tenantId).changes > 0;
}

// ─── Interpolation ─────────────────────────────────────────────────────
export function interpolate(html: string, vars: Record<string, any>): string {
  return html.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_m, key) => {
    const parts = String(key).split('.');
    let v: any = vars;
    for (const p of parts) v = v?.[p];
    return v == null ? '' : String(v);
  });
}

// ─── Documents ─────────────────────────────────────────────────────────
export interface DocumentRecord {
  id: string;
  tenantId: string;
  contactId?: string;
  cardId?: string;
  templateId?: string;
  title: string;
  bodyHtml: string;
  variables: Record<string, any>;
  status: DocumentStatus;
  publicToken: string;
  version: number;
  parentDocumentId?: string;
  signedAt?: number;
  signedBy?: string;
  signedIp?: string;
  signatureImage?: string;
  fileUrl?: string;
  sentVia?: string;
  sentTo?: string;
  sentAt?: number;
  viewedAt?: number;
  viewedCount: number;
  createdByAgentId?: string;
  icsUid: string;
  createdAt: number;
  updatedAt: number;
}

function rowToDoc(r: any): DocumentRecord {
  return {
    id: r.id, tenantId: r.tenant_id,
    contactId: r.contact_id ?? undefined,
    cardId: r.card_id ?? undefined,
    templateId: r.template_id ?? undefined,
    title: r.title,
    bodyHtml: r.body_html,
    variables: JSON.parse(r.variables_json || '{}'),
    status: r.status as DocumentStatus,
    publicToken: r.public_token,
    version: r.version, parentDocumentId: r.parent_document_id ?? undefined,
    signedAt: r.signed_at ?? undefined, signedBy: r.signed_by ?? undefined,
    signedIp: r.signed_ip ?? undefined,
    signatureImage: r.signature_image_b64 ?? undefined,
    fileUrl: r.file_url ?? undefined,
    sentVia: r.sent_via ?? undefined, sentTo: r.sent_to ?? undefined,
    sentAt: r.sent_at ?? undefined,
    viewedAt: r.viewed_at ?? undefined, viewedCount: r.viewed_count || 0,
    createdByAgentId: r.created_by_agent_id ?? undefined,
    icsUid: r.ics_uid,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export function createDocument(tenantId: string, input: {
  title: string; templateId?: string; bodyHtml?: string; variables?: Record<string, any>;
  contactId?: string; cardId?: string; createdByAgentId?: string;
}): DocumentRecord {
  const db = getCrmDb();
  let bodyHtml = input.bodyHtml || '';
  if (input.templateId) {
    const tpl = getTemplate(tenantId, input.templateId);
    if (!tpl) throw new Error('template not found');
    bodyHtml = tpl.bodyHtml;
  }
  const vars = input.variables || {};
  const rendered = interpolate(bodyHtml, vars);

  // Compute version: if there's an existing doc for same card/contact with same title → increment
  let version = 1;
  if (input.cardId) {
    const prev = db.prepare('SELECT MAX(version) m FROM crm_documents WHERE tenant_id = ? AND card_id = ? AND title = ?')
      .get(tenantId, input.cardId, input.title) as any;
    version = (prev?.m || 0) + 1;
  }

  const id = nid('crm_doc');
  const token = genToken();
  const uid = randomUUID() + '@clow';
  const t = now();
  db.prepare(`
    INSERT INTO crm_documents
      (id, tenant_id, contact_id, card_id, template_id, title, body_html, variables_json,
       status, public_token, version, created_by_agent_id, ics_uid, created_at, updated_at, viewed_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, 0)
  `).run(id, tenantId, input.contactId ?? null, input.cardId ?? null, input.templateId ?? null,
    input.title, rendered, JSON.stringify(vars), token, version,
    input.createdByAgentId ?? null, uid, t, t);
  return getDocument(tenantId, id)!;
}

export function getDocument(tenantId: string, id: string): DocumentRecord | null {
  const r = getCrmDb().prepare('SELECT * FROM crm_documents WHERE id = ? AND tenant_id = ?').get(id, tenantId) as any;
  return r ? rowToDoc(r) : null;
}

export function getDocumentByToken(token: string): { tenantId: string; doc: DocumentRecord } | null {
  const r = getCrmDb().prepare('SELECT * FROM crm_documents WHERE public_token = ?').get(token) as any;
  if (!r) return null;
  return { tenantId: r.tenant_id, doc: rowToDoc(r) };
}

export interface ListDocOpts {
  contactId?: string;
  cardId?: string;
  status?: DocumentStatus | 'all';
  templateId?: string;
  limit?: number;
}

export function listDocuments(tenantId: string, opts: ListDocOpts = {}): DocumentRecord[] {
  const wh = ['tenant_id = ?'];
  const params: any[] = [tenantId];
  if (opts.contactId)  { wh.push('contact_id = ?'); params.push(opts.contactId); }
  if (opts.cardId)     { wh.push('card_id = ?'); params.push(opts.cardId); }
  if (opts.templateId) { wh.push('template_id = ?'); params.push(opts.templateId); }
  if (opts.status && opts.status !== 'all') { wh.push('status = ?'); params.push(opts.status); }
  const limit = Math.min(500, opts.limit || 100);
  return (getCrmDb().prepare(
    `SELECT * FROM crm_documents WHERE ${wh.join(' AND ')} ORDER BY created_at DESC LIMIT ?`
  ).all(...params, limit) as any[]).map(rowToDoc);
}

export function updateDocument(tenantId: string, id: string, patch: Partial<DocumentRecord>): DocumentRecord | null {
  const ex = getDocument(tenantId, id);
  if (!ex) return null;
  const m = { ...ex, ...patch };
  getCrmDb().prepare(`
    UPDATE crm_documents SET title=?, body_html=?, variables_json=?, status=?, contact_id=?, card_id=?, updated_at=?
    WHERE id = ? AND tenant_id = ?
  `).run(m.title, m.bodyHtml, JSON.stringify(m.variables || {}), m.status,
    m.contactId ?? null, m.cardId ?? null, now(), id, tenantId);
  return getDocument(tenantId, id);
}

export function deleteDocument(tenantId: string, id: string): boolean {
  return getCrmDb().prepare('DELETE FROM crm_documents WHERE id = ? AND tenant_id = ?').run(id, tenantId).changes > 0;
}

export function cloneAsNewVersion(tenantId: string, id: string): DocumentRecord | null {
  const ex = getDocument(tenantId, id);
  if (!ex) return null;
  const next = createDocument(tenantId, {
    title: ex.title,
    bodyHtml: ex.bodyHtml,
    variables: ex.variables,
    contactId: ex.contactId,
    cardId: ex.cardId,
    templateId: ex.templateId,
  });
  // Link parent and bump version
  getCrmDb().prepare('UPDATE crm_documents SET parent_document_id = ?, version = ? WHERE id = ?')
    .run(id, ex.version + 1, next.id);
  return getDocument(tenantId, next.id);
}

// ─── Events ────────────────────────────────────────────────────────────
export function recordEvent(documentId: string, event: 'sent' | 'viewed' | 'signed' | 'cancelled', meta: { ip?: string; ua?: string } = {}): void {
  const db = getCrmDb();
  db.prepare(
    'INSERT INTO crm_document_events (id, document_id, event, ts, ip, ua) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(nid('crm_docevt'), documentId, event, now(), meta.ip ?? null, meta.ua ?? null);
  if (event === 'viewed') {
    db.prepare(
      'UPDATE crm_documents SET viewed_at = COALESCE(viewed_at, ?), viewed_count = COALESCE(viewed_count, 0) + 1, status = CASE WHEN status = \'sent\' THEN \'viewed\' ELSE status END WHERE id = ?'
    ).run(now(), documentId);
  }
}

export function listEvents(tenantId: string, documentId: string): any[] {
  const db = getCrmDb();
  const own = db.prepare('SELECT id FROM crm_documents WHERE id = ? AND tenant_id = ?').get(documentId, tenantId);
  if (!own) return [];
  return db.prepare('SELECT * FROM crm_document_events WHERE document_id = ? ORDER BY ts ASC').all(documentId) as any[];
}

// ─── PDF render ────────────────────────────────────────────────────────
export async function renderPDF(doc: DocumentRecord): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    try {
      const pdf = new PDFDocument({ margin: 50, size: 'A4' });
      const bufs: Buffer[] = [];
      pdf.on('data', (b: Buffer) => bufs.push(b));
      pdf.on('end', () => resolve(Buffer.concat(bufs)));
      pdf.on('error', reject);

      pdf.fontSize(20).fillColor('#9B59FC').text(doc.title);
      pdf.fontSize(10).fillColor('#64748b').text(`Versão ${doc.version} · ${new Date(doc.createdAt).toLocaleDateString('pt-BR')}`);
      pdf.moveDown(1.5);

      // Strip HTML tags for plain-text PDF body (keeps simple for first cut)
      const plain = doc.bodyHtml
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
      pdf.fontSize(11).fillColor('#1e293b').text(plain.trim(), { align: 'justify' });

      if (doc.status === 'signed' && doc.signedBy) {
        pdf.moveDown(2);
        pdf.strokeColor('#e2e8f0').lineWidth(1).moveTo(50, pdf.y).lineTo(545, pdf.y).stroke();
        pdf.moveDown(0.5);
        pdf.fontSize(11).fillColor('#1e293b').text('Assinado por: ' + doc.signedBy);
        pdf.fontSize(9).fillColor('#64748b').text(
          `IP: ${doc.signedIp || '—'} · Data: ${doc.signedAt ? new Date(doc.signedAt).toISOString() : '—'}`
        );
        if (doc.signatureImage && doc.signatureImage.startsWith('data:image/')) {
          try {
            const b64 = doc.signatureImage.split(',')[1];
            pdf.image(Buffer.from(b64, 'base64'), { width: 200 });
          } catch { /* skip */ }
        }
      }

      pdf.end();
    } catch (err) { reject(err); }
  });
}

// ─── Send via email / WhatsApp ────────────────────────────────────────
export async function sendByEmail(tenantId: string, id: string, opts: { to: string; baseUrl: string; attachPdf?: boolean }): Promise<{ ok: boolean; error?: string }> {
  const doc = getDocument(tenantId, id);
  if (!doc) return { ok: false, error: 'not_found' };

  const publicUrl = `${opts.baseUrl.replace(/\/$/, '')}/p/docs/${doc.publicToken}`;
  const html = `<div style="font-family:sans-serif;max-width:600px;margin:0 auto">
<h2 style="color:#9B59FC">${escapeHtml(doc.title)}</h2>
<p>Olá, segue documento para sua análise e assinatura.</p>
<p style="text-align:center;margin:32px 0"><a href="${publicUrl}" style="background:#9B59FC;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:600">Visualizar e assinar</a></p>
<p style="color:#64748b;font-size:13px">Versão ${doc.version} · Se o botão não funcionar, acesse: ${publicUrl}</p>
</div>`;

  const attachments: Array<{ filename: string; content: Buffer }> = [];
  if (opts.attachPdf !== false) {
    const pdf = await renderPDF(doc);
    attachments.push({ filename: `${sanitize(doc.title)}-v${doc.version}.pdf`, content: pdf });
  }

  const r = await sendEmail({
    to: opts.to,
    subject: doc.title,
    html,
    attachments: attachments.length ? attachments : undefined,
  });

  if (r.ok) {
    getCrmDb().prepare(
      'UPDATE crm_documents SET sent_via = ?, sent_to = ?, sent_at = ?, status = CASE WHEN status = \'draft\' THEN \'sent\' ELSE status END WHERE id = ?'
    ).run('email', opts.to, now(), id);
    recordEvent(id, 'sent');
  }
  return { ok: r.ok, error: r.error };
}

export async function sendByWhatsApp(tenantId: string, id: string, opts: { channelId: string; toPhone?: string; baseUrl: string }): Promise<{ ok: boolean; error?: string }> {
  const db = getCrmDb();
  const doc = getDocument(tenantId, id);
  if (!doc) return { ok: false, error: 'not_found' };

  const channel = db.prepare('SELECT * FROM crm_channels WHERE id = ? AND tenant_id = ?').get(opts.channelId, tenantId) as any;
  if (!channel) return { ok: false, error: 'channel_not_found' };

  const contact = doc.contactId ? (db.prepare('SELECT phone FROM crm_contacts WHERE id = ? AND tenant_id = ?').get(doc.contactId, tenantId) as any) : null;
  const to = opts.toPhone || contact?.phone;
  if (!to) return { ok: false, error: 'no_phone' };

  const publicUrl = `${opts.baseUrl.replace(/\/$/, '')}/p/docs/${doc.publicToken}`;
  const text = `*${doc.title}*\nVersão ${doc.version}\n\nDocumento pra sua análise e assinatura:\n${publicUrl}`;

  const mapped: any = { ...channel, tenantId: channel.tenant_id, credentialsEncrypted: channel.credentials_encrypted };
  const r = await sendOutbound(mapped, { to, text, contactId: doc.contactId, cardId: doc.cardId });

  if (r.ok) {
    db.prepare(
      'UPDATE crm_documents SET sent_via = ?, sent_to = ?, sent_at = ?, status = CASE WHEN status = \'draft\' THEN \'sent\' ELSE status END WHERE id = ?'
    ).run('whatsapp', to, now(), id);
    recordEvent(id, 'sent');
  }
  return { ok: r.ok, error: r.error };
}

// ─── Sign ──────────────────────────────────────────────────────────────
export function signDocument(tenantId: string, id: string, input: {
  signedBy: string; signedIp?: string; signatureImage?: string;
}): DocumentRecord | null {
  const db = getCrmDb();
  const doc = getDocument(tenantId, id);
  if (!doc) return null;
  if (doc.status === 'signed') return doc;

  db.prepare(`
    UPDATE crm_documents SET status = 'signed', signed_at = ?, signed_by = ?, signed_ip = ?, signature_image_b64 = ?, updated_at = ?
    WHERE id = ? AND tenant_id = ?
  `).run(now(), input.signedBy, input.signedIp ?? null,
    input.signatureImage ?? null, now(), id, tenantId);
  recordEvent(id, 'signed', { ip: input.signedIp });
  return getDocument(tenantId, id);
}

function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 50);
}
