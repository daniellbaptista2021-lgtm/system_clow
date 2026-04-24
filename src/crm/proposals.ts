/**
 * Proposals Pro — Onda 16.
 *
 * Extended proposal operations beyond what store.ts exposes:
 *   - sendByEmail  : render HTML + attach PDF, email to contact
 *   - sendByWhatsApp: send text with public link to contact's channel
 *   - renderHTML   : deterministic HTML for email body + public view
 *   - renderPDF    : pdfkit-based PDF of proposal
 *   - cloneVersion : duplicate a proposal as new version (prev accepted etc.)
 *   - recordEvent  : append to crm_proposal_events (sent|viewed|signed|converted)
 *   - onAccept     : when accepted, auto-move card to won column (if enabled)
 *
 * Public view/sign flows live in publicRoutes.ts (no tenant auth, token-based).
 */

import { randomBytes } from 'crypto';
import PDFDocument from 'pdfkit';
import { getCrmDb } from './schema.js';
import * as store from './store.js';
import { sendEmail } from '../notifications/mailer.js';
import { sendOutbound } from './inbox.js';

export type ProposalEventKind = 'sent' | 'viewed' | 'signed' | 'converted' | 'rejected';

function nid(prefix: string): string {
  return prefix + '_' + randomBytes(6).toString('hex');
}

function genToken(): string {
  return randomBytes(24).toString('base64url');
}

export function ensurePublicToken(tenantId: string, proposalId: string): string {
  const db = getCrmDb();
  const row = db.prepare('SELECT public_token FROM crm_proposals WHERE id = ? AND tenant_id = ?').get(proposalId, tenantId) as any;
  if (!row) throw new Error('proposal not found');
  if (row.public_token) return row.public_token;
  const tok = genToken();
  db.prepare('UPDATE crm_proposals SET public_token = ?, updated_at = ? WHERE id = ?').run(tok, Date.now(), proposalId);
  return tok;
}

export function recordEvent(proposalId: string, event: ProposalEventKind, meta: { ip?: string; ua?: string } = {}): void {
  const db = getCrmDb();
  db.prepare(
    'INSERT INTO crm_proposal_events (id, proposal_id, event, ts, ip, ua) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(nid('crm_prop_evt'), proposalId, event, Date.now(), meta.ip ?? null, meta.ua ?? null);
  if (event === 'viewed') {
    db.prepare(
      'UPDATE crm_proposals SET viewed_at = COALESCE(viewed_at, ?), viewed_count = COALESCE(viewed_count, 0) + 1, first_viewed_ip = COALESCE(first_viewed_ip, ?) WHERE id = ?'
    ).run(Date.now(), meta.ip ?? null, proposalId);
  }
}

export interface ProposalRenderContext {
  proposal: any;
  card: any;
  contact: any;
  items: Array<{ name: string; qty: number; unitPriceCents: number; lineTotalCents: number }>;
  publicUrl: string;
  brandName: string;
}

export function buildContext(tenantId: string, proposalId: string, baseUrl: string): ProposalRenderContext {
  const db = getCrmDb();
  const proposal = store.getProposal(tenantId, proposalId);
  if (!proposal) throw new Error('proposal not found');
  const card = db.prepare('SELECT * FROM crm_cards WHERE id = ? AND tenant_id = ?').get(proposal.cardId, tenantId) as any;
  const contact = card?.contact_id ? (db.prepare('SELECT * FROM crm_contacts WHERE id = ? AND tenant_id = ?').get(card.contact_id, tenantId) as any) : null;
  const rawItems = db.prepare(
    'SELECT id, qty, unit_price_cents, inventory_id FROM crm_card_items WHERE tenant_id = ? AND card_id = ?'
  ).all(tenantId, proposal.cardId) as any[];
  const items = rawItems.map(it => {
    const inv = it.inventory_id ? (db.prepare('SELECT name FROM crm_inventory WHERE id = ?').get(it.inventory_id) as any) : null;
    return {
      name: inv?.name || 'Item',
      qty: it.qty,
      unitPriceCents: it.unit_price_cents,
      lineTotalCents: it.qty * it.unit_price_cents,
    };
  });

  const token = ensurePublicToken(tenantId, proposalId);
  return {
    proposal,
    card,
    contact,
    items,
    publicUrl: `${baseUrl.replace(/\/$/, '')}/p/proposals/${token}`,
    brandName: 'System Clow',
  };
}

export function renderHTML(ctx: ProposalRenderContext): string {
  const brl = (c: number) => (c / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const itemsRows = ctx.items.map(i => `
    <tr>
      <td>${escapeHtml(i.name)}</td>
      <td style="text-align:center">${i.qty}</td>
      <td style="text-align:right">R$ ${brl(i.unitPriceCents)}</td>
      <td style="text-align:right"><b>R$ ${brl(i.lineTotalCents)}</b></td>
    </tr>`).join('');

  const validUntil = ctx.proposal.validUntilTs
    ? new Date(ctx.proposal.validUntilTs).toLocaleDateString('pt-BR')
    : '—';

  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>Proposta ${escapeHtml(ctx.proposal.id)}</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 760px; margin: 20px auto; color: #1e293b; padding: 20px; }
  .hdr { border-bottom: 3px solid #9B59FC; padding-bottom: 12px; margin-bottom: 20px; }
  .hdr h1 { color: #9B59FC; margin: 0; }
  .meta { color: #64748b; font-size: 13px; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; margin: 14px 0; }
  th { text-align: left; background: #f1f5f9; padding: 10px; font-size: 13px; }
  td { padding: 10px; border-bottom: 1px solid #e2e8f0; font-size: 14px; }
  .totals { margin-top: 16px; text-align: right; font-size: 15px; }
  .totals .row { padding: 4px 0; }
  .totals .total { border-top: 2px solid #9B59FC; padding-top: 8px; font-size: 18px; font-weight: 700; color: #9B59FC; }
  .actions { margin-top: 24px; text-align: center; }
  .btn { display: inline-block; background: #9B59FC; color: #fff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600; }
  .terms { margin-top: 18px; padding: 12px; background: #f8fafc; border-radius: 8px; font-size: 12px; color: #475569; }
</style></head><body>
  <div class="hdr">
    <h1>Proposta Comercial</h1>
    <div class="meta">
      Versão ${ctx.proposal.version} · ${ctx.card ? escapeHtml(ctx.card.title) : '—'}
      ${ctx.contact ? ' · Cliente: ' + escapeHtml(ctx.contact.name) : ''}
    </div>
    <div class="meta">Válida até ${validUntil} · Status: ${escapeHtml(ctx.proposal.status)}</div>
  </div>

  <table>
    <thead><tr><th>Item</th><th style="text-align:center">Qtd</th><th style="text-align:right">Unitário</th><th style="text-align:right">Total</th></tr></thead>
    <tbody>${itemsRows || '<tr><td colspan="4" style="text-align:center;color:#94a3b8">Sem itens</td></tr>'}</tbody>
  </table>

  <div class="totals">
    <div class="row">Subtotal: <b>R$ ${brl(ctx.proposal.subtotalCents)}</b></div>
    ${ctx.proposal.discountCents ? `<div class="row">Desconto: <b>- R$ ${brl(ctx.proposal.discountCents)}</b></div>` : ''}
    ${ctx.proposal.taxCents ? `<div class="row">Impostos: <b>R$ ${brl(ctx.proposal.taxCents)}</b></div>` : ''}
    <div class="row total">Total: R$ ${brl(ctx.proposal.totalCents)}</div>
  </div>

  ${ctx.proposal.terms ? `<div class="terms"><b>Termos:</b><br>${escapeHtml(ctx.proposal.terms).replace(/\n/g, '<br>')}</div>` : ''}

  <div class="actions">
    ${ctx.proposal.status === 'sent' || ctx.proposal.status === 'draft'
      ? `<a class="btn" href="${ctx.publicUrl}">Aceitar Proposta</a>`
      : `<div style="color:#64748b">Proposta ${ctx.proposal.status}</div>`}
  </div>
</body></html>`;
}

function escapeHtml(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export async function renderPDF(ctx: ProposalRenderContext): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 50, size: 'A4' });
      const bufs: Buffer[] = [];
      doc.on('data', (b: Buffer) => bufs.push(b));
      doc.on('end', () => resolve(Buffer.concat(bufs)));
      doc.on('error', reject);

      const brl = (c: number) => (c / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 });

      // Header
      doc.fontSize(24).fillColor('#9B59FC').text('Proposta Comercial');
      doc.fontSize(11).fillColor('#64748b').text(
        `Versão ${ctx.proposal.version} · ${ctx.card?.title || '—'}${ctx.contact ? ' · ' + ctx.contact.name : ''}`
      );
      if (ctx.proposal.validUntilTs) {
        doc.text(`Válida até ${new Date(ctx.proposal.validUntilTs).toLocaleDateString('pt-BR')}`);
      }
      doc.moveDown(1.5);

      // Items table
      const startY = doc.y;
      const colsX = [50, 300, 370, 470];
      doc.fontSize(11).fillColor('#000').font('Helvetica-Bold');
      doc.text('Item', colsX[0], startY);
      doc.text('Qtd', colsX[1], startY, { width: 60, align: 'center' });
      doc.text('Unit.', colsX[2], startY, { width: 90, align: 'right' });
      doc.text('Total', colsX[3], startY, { width: 90, align: 'right' });
      doc.moveTo(50, startY + 14).lineTo(560, startY + 14).strokeColor('#9B59FC').stroke();
      let y = startY + 22;
      doc.font('Helvetica').fontSize(10).fillColor('#333');
      for (const it of ctx.items) {
        if (y > 700) { doc.addPage(); y = 50; }
        doc.text(it.name, colsX[0], y, { width: 240 });
        doc.text(String(it.qty), colsX[1], y, { width: 60, align: 'center' });
        doc.text('R$ ' + brl(it.unitPriceCents), colsX[2], y, { width: 90, align: 'right' });
        doc.text('R$ ' + brl(it.lineTotalCents), colsX[3], y, { width: 90, align: 'right' });
        y += 18;
      }

      // Totals
      y += 10;
      doc.moveTo(350, y).lineTo(560, y).strokeColor('#9B59FC').stroke();
      y += 6;
      doc.fontSize(10).fillColor('#64748b');
      doc.text('Subtotal: R$ ' + brl(ctx.proposal.subtotalCents), 350, y, { width: 210, align: 'right' });
      if (ctx.proposal.discountCents) { y += 14; doc.text('Desconto: - R$ ' + brl(ctx.proposal.discountCents), 350, y, { width: 210, align: 'right' }); }
      if (ctx.proposal.taxCents)      { y += 14; doc.text('Impostos: R$ ' + brl(ctx.proposal.taxCents), 350, y, { width: 210, align: 'right' }); }
      y += 22;
      doc.fontSize(16).fillColor('#9B59FC').font('Helvetica-Bold')
        .text('Total: R$ ' + brl(ctx.proposal.totalCents), 350, y, { width: 210, align: 'right' });

      if (ctx.proposal.terms) {
        y += 40;
        if (y > 680) { doc.addPage(); y = 50; }
        doc.fontSize(11).fillColor('#000').font('Helvetica-Bold').text('Termos', 50, y);
        doc.fontSize(9).fillColor('#475569').font('Helvetica').text(ctx.proposal.terms, 50, y + 16, { width: 510 });
      }

      doc.end();
    } catch (e) { reject(e); }
  });
}

export async function sendByEmail(
  tenantId: string,
  proposalId: string,
  opts: { to: string; baseUrl: string; attachPdf?: boolean },
): Promise<{ ok: boolean; error?: string }> {
  const ctx = buildContext(tenantId, proposalId, opts.baseUrl);
  const html = renderHTML(ctx);
  const attachments: Array<{ filename: string; content: Buffer }> = [];
  if (opts.attachPdf !== false) {
    const pdf = await renderPDF(ctx);
    attachments.push({ filename: `proposta-v${ctx.proposal.version}.pdf`, content: pdf });
  }

  const r = await sendEmail({
    to: opts.to,
    subject: `Proposta comercial — ${ctx.card?.title || ctx.brandName}`,
    html,
    attachments: attachments.length ? attachments : undefined,
  });

  if (r.ok) {
    const db = getCrmDb();
    db.prepare('UPDATE crm_proposals SET sent_via = ?, sent_to = ?, sent_at = ?, status = CASE WHEN status = \'draft\' THEN \'sent\' ELSE status END WHERE id = ?')
      .run('email', opts.to, Date.now(), proposalId);
    recordEvent(proposalId, 'sent');
  }

  return { ok: r.ok, error: r.error };
}

export async function sendByWhatsApp(
  tenantId: string,
  proposalId: string,
  opts: { channelId: string; toPhone?: string; baseUrl: string },
): Promise<{ ok: boolean; error?: string }> {
  const ctx = buildContext(tenantId, proposalId, opts.baseUrl);
  const db = getCrmDb();
  const channel = db.prepare('SELECT * FROM crm_channels WHERE id = ? AND tenant_id = ?').get(opts.channelId, tenantId) as any;
  if (!channel) return { ok: false, error: 'channel not found' };

  const to = opts.toPhone || ctx.contact?.phone;
  if (!to) return { ok: false, error: 'no phone' };

  const brl = (c: number) => (c / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
  const text = [
    `*Proposta Comercial v${ctx.proposal.version}*`,
    ctx.card?.title ? `Projeto: ${ctx.card.title}` : '',
    ctx.contact?.name ? `Cliente: ${ctx.contact.name}` : '',
    '',
    `Total: *R$ ${brl(ctx.proposal.totalCents)}*`,
    ctx.proposal.validUntilTs ? `Válida até ${new Date(ctx.proposal.validUntilTs).toLocaleDateString('pt-BR')}` : '',
    '',
    `Ver e aceitar: ${ctx.publicUrl}`,
  ].filter(Boolean).join('\n');

  const mapped: any = {
    ...channel,
    tenantId: channel.tenant_id,
    credentialsEncrypted: channel.credentials_encrypted,
  };
  const r = await sendOutbound(mapped, { to, text, contactId: ctx.contact?.id, cardId: ctx.card?.id });

  if (r.ok) {
    db.prepare('UPDATE crm_proposals SET sent_via = ?, sent_to = ?, sent_at = ?, status = CASE WHEN status = \'draft\' THEN \'sent\' ELSE status END WHERE id = ?')
      .run('whatsapp', to, Date.now(), proposalId);
    recordEvent(proposalId, 'sent');
  }

  return { ok: r.ok, error: r.error };
}

export function cloneAsNewVersion(tenantId: string, proposalId: string): any {
  const db = getCrmDb();
  const prev = db.prepare('SELECT * FROM crm_proposals WHERE id = ? AND tenant_id = ?').get(proposalId, tenantId) as any;
  if (!prev) return null;
  const nextVersion = ((db.prepare('SELECT COALESCE(MAX(version), 0) m FROM crm_proposals WHERE tenant_id = ? AND card_id = ?').get(tenantId, prev.card_id) as any).m || 0) + 1;
  const newId = nid('crm_prop');
  db.prepare(`
    INSERT INTO crm_proposals
      (id, tenant_id, card_id, version, subtotal_cents, discount_cents, tax_cents, total_cents, valid_until_ts, status, terms, created_at, updated_at, auto_convert_on_accept)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)
  `).run(
    newId, tenantId, prev.card_id, nextVersion,
    prev.subtotal_cents, prev.discount_cents, prev.tax_cents, prev.total_cents,
    prev.valid_until_ts, prev.terms, Date.now(), Date.now(), prev.auto_convert_on_accept ?? 1,
  );
  return store.getProposal(tenantId, newId);
}

/** Called when a proposal transitions to 'accepted'. If auto_convert=1, move card to won column. */
export function onAccept(tenantId: string, proposalId: string): void {
  const db = getCrmDb();
  const prop = db.prepare('SELECT * FROM crm_proposals WHERE id = ? AND tenant_id = ?').get(proposalId, tenantId) as any;
  if (!prop) return;
  if (!prop.auto_convert_on_accept) return;

  const card = db.prepare('SELECT * FROM crm_cards WHERE id = ? AND tenant_id = ?').get(prop.card_id, tenantId) as any;
  if (!card) return;

  // Prefer explicit stage_type='won' column; fallback to terminal column matching /ganho|won/i
  let wonCol = db.prepare(
    "SELECT id FROM crm_columns WHERE board_id = ? AND stage_type = 'won' ORDER BY position ASC LIMIT 1"
  ).get(card.board_id) as any;
  if (!wonCol) {
    const terminals = db.prepare(
      "SELECT id, name FROM crm_columns WHERE board_id = ? AND is_terminal = 1"
    ).all(card.board_id) as any[];
    wonCol = terminals.find((t: any) => /ganho|won/i.test(t.name)) || null;
  }
  if (!wonCol) return;

  if (card.column_id !== wonCol.id) {
    store.moveCard(tenantId, prop.card_id, wonCol.id);
    db.prepare('UPDATE crm_cards SET won_reason = COALESCE(won_reason, ?), updated_at = ? WHERE id = ?')
      .run('Proposta v' + prop.version + ' aceita', Date.now(), prop.card_id);
    recordEvent(proposalId, 'converted');
  }
}

export function listEvents(tenantId: string, proposalId: string): any[] {
  const db = getCrmDb();
  // Verify ownership
  const p = db.prepare('SELECT id FROM crm_proposals WHERE id = ? AND tenant_id = ?').get(proposalId, tenantId);
  if (!p) return [];
  return db.prepare('SELECT * FROM crm_proposal_events WHERE proposal_id = ? ORDER BY ts ASC').all(proposalId) as any[];
}
