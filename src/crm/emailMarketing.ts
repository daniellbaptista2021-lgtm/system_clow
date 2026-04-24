/**
 * Email Marketing — Onda 17.
 *
 * Three subsystems:
 *   1. Campaigns (one-shot blast): enqueued via crm_campaign_sends rows, scheduler
 *      picks up next batch every tick, interpolates template, sends via mailer,
 *      tracks opens (pixel) + clicks (redirect).
 *   2. Templates: reusable HTML body with {{placeholders}}.
 *   3. Sequences (drip): enrollment advances through steps over days/hours.
 *
 * Unsubscribe: single list per tenant (crm_unsubscribes.email) short-circuits sends.
 */

import { randomBytes } from 'crypto';
import { getCrmDb } from './schema.js';
import { sendEmail } from '../notifications/mailer.js';

const BATCH_SIZE = 20; // sends per tick per campaign — keeps tick under 5s
const PIXEL_BASE = '/p/e/o/';
const CLICK_BASE = '/p/e/c/';
const UNSUB_BASE = '/p/e/u/';

function nid(prefix: string): string { return prefix + '_' + randomBytes(6).toString('hex'); }
function genToken(): string { return randomBytes(16).toString('base64url'); }

// ─── Templates ──────────────────────────────────────────────────────────
export function interpolate(template: string, vars: Record<string, any>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_m, key) => {
    const parts = String(key).split('.');
    let v: any = vars;
    for (const p of parts) v = v?.[p];
    return v == null ? '' : String(v);
  });
}

function injectTrackingLinks(html: string, sendToken: string, baseUrl: string): string {
  // Append pixel
  const pixelTag = `<img src="${baseUrl}${PIXEL_BASE}${sendToken}" width="1" height="1" style="display:none" alt="">`;

  // Rewrite <a href="..."> to click tracker (skip unsubscribe links)
  const rewritten = html.replace(/<a\s+([^>]*?)href="([^"]+)"([^>]*)>/g, (full, pre, href, post) => {
    if (href.startsWith('mailto:') || href.includes(UNSUB_BASE) || href.includes(PIXEL_BASE) || href.includes(CLICK_BASE)) return full;
    const tracked = `${baseUrl}${CLICK_BASE}${sendToken}?u=${encodeURIComponent(href)}`;
    return `<a ${pre}href="${tracked}"${post}>`;
  });

  return rewritten + pixelTag;
}

function appendUnsubscribeFooter(html: string, unsubToken: string, baseUrl: string): string {
  const footer = `
<div style="margin-top:30px;padding:12px;border-top:1px solid #e5e7eb;color:#6b7280;font-size:11px;font-family:sans-serif">
  <a href="${baseUrl}${UNSUB_BASE}${unsubToken}" style="color:#6b7280">Cancelar inscrição</a>
</div>`;
  return html.replace(/<\/body>/i, footer + '</body>') || html + footer;
}

// ─── Campaign send pipeline ─────────────────────────────────────────────
export interface EnqueueResult { enqueued: number; skippedUnsubscribed: number; skippedNoEmail: number; }

/** Given a campaign id, create crm_campaign_sends rows for every segment contact (minus unsubs). */
export function enqueueCampaign(tenantId: string, campaignId: string): EnqueueResult {
  const db = getCrmDb();
  const camp = db.prepare('SELECT * FROM crm_email_campaigns WHERE id = ? AND tenant_id = ?').get(campaignId, tenantId) as any;
  if (!camp) throw new Error('campaign not found');

  const seg = db.prepare('SELECT filter_json FROM crm_segments WHERE id = ? AND tenant_id = ?').get(camp.segment_id, tenantId) as any;
  if (!seg) throw new Error('segment not found');
  const filter = JSON.parse(seg.filter_json || '{}');

  // Collect segment contacts (reuse store.runSegment — but inlined here to avoid circular)
  const contacts = resolveSegmentContacts(tenantId, filter);

  const unsubs = new Set<string>(
    (db.prepare('SELECT email FROM crm_unsubscribes WHERE tenant_id = ?').all(tenantId) as any[])
      .map((r: any) => String(r.email).toLowerCase())
  );

  const stmt = db.prepare(`
    INSERT INTO crm_campaign_sends
      (id, campaign_id, contact_id, email, send_token, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction(() => {
    let enqueued = 0, skippedUnsubscribed = 0, skippedNoEmail = 0;
    for (const c of contacts) {
      if (!c.email) { skippedNoEmail++; continue; }
      if (unsubs.has(String(c.email).toLowerCase())) { skippedUnsubscribed++; continue; }
      stmt.run(nid('crm_csend'), campaignId, c.id, c.email, genToken(), Date.now());
      enqueued++;
    }
    return { enqueued, skippedUnsubscribed, skippedNoEmail };
  });
  const result = tx();

  db.prepare('UPDATE crm_email_campaigns SET status = ?, started_at = COALESCE(started_at, ?), stats_queued = ? WHERE id = ?')
    .run('sending', Date.now(), result.enqueued, campaignId);

  return result;
}

function resolveSegmentContacts(tenantId: string, filter: any): any[] {
  const db = getCrmDb();
  // Simplified filter: name contains, tags (JSON array), source, hasEmail
  const wh: string[] = ['c.tenant_id = ?'];
  const params: any[] = [tenantId];
  if (filter.source)       { wh.push('c.source = ?'); params.push(filter.source); }
  if (filter.company)      { wh.push("c.custom_fields_json LIKE ?"); params.push('%"company":"' + filter.company + '"%'); }
  if (filter.nameContains) { wh.push('c.name LIKE ?'); params.push('%' + filter.nameContains + '%'); }
  if (filter.hasEmail)     { wh.push("c.email IS NOT NULL AND c.email != ''"); }
  if (filter.hasPhone)     { wh.push("c.phone IS NOT NULL AND c.phone != ''"); }
  if (filter.createdAfter != null)         { wh.push('c.created_at >= ?'); params.push(filter.createdAfter); }
  if (filter.createdBefore != null)        { wh.push('c.created_at <= ?'); params.push(filter.createdBefore); }
  if (filter.lastInteractionAfter != null) { wh.push('c.last_interaction_at >= ?'); params.push(filter.lastInteractionAfter); }

  let rows = db.prepare(`SELECT * FROM crm_contacts c WHERE ${wh.join(' AND ')}`).all(...params) as any[];

  // Tag filter — server-side JSON parse
  if (filter.tags?.length) {
    const mode = filter.tagsMode || 'any';
    rows = rows.filter(r => {
      const tags: string[] = JSON.parse(r.tags_json || '[]');
      if (mode === 'all') return filter.tags.every((t: string) => tags.includes(t));
      return filter.tags.some((t: string) => tags.includes(t));
    });
  }
  return rows;
}

/** Called every scheduler tick. Pick up pending sends across all campaigns, send, update stats. */
export async function tick(baseUrl: string = ''): Promise<void> {
  const db = getCrmDb();
  const campaigns = db.prepare("SELECT * FROM crm_email_campaigns WHERE status = 'sending'").all() as any[];
  for (const camp of campaigns) {
    const pending = db.prepare(`
      SELECT * FROM crm_campaign_sends
      WHERE campaign_id = ? AND sent_at IS NULL AND bounced = 0
      ORDER BY created_at ASC
      LIMIT ${BATCH_SIZE}
    `).all(camp.id) as any[];

    if (pending.length === 0) {
      // Done: mark campaign sent
      const remaining = db.prepare(
        'SELECT COUNT(*) n FROM crm_campaign_sends WHERE campaign_id = ? AND sent_at IS NULL AND bounced = 0'
      ).get(camp.id) as any;
      if (remaining.n === 0) {
        db.prepare("UPDATE crm_email_campaigns SET status = 'sent', finished_at = ? WHERE id = ?").run(Date.now(), camp.id);
      }
      continue;
    }

    for (const send of pending) {
      try {
        await sendOneCampaignSend(camp, send, baseUrl);
      } catch (err: any) {
        db.prepare('UPDATE crm_campaign_sends SET bounced = 1, error = ? WHERE id = ?').run(err?.message || 'unknown', send.id);
      }
    }
  }
}

async function sendOneCampaignSend(campaign: any, send: any, baseUrl: string): Promise<void> {
  const db = getCrmDb();
  // Load contact for interpolation
  const contact = db.prepare('SELECT * FROM crm_contacts WHERE id = ?').get(send.contact_id) as any;
  const vars = {
    name: contact?.name || '',
    firstName: (contact?.name || '').split(' ')[0] || '',
    email: contact?.email || send.email,
    phone: contact?.phone || '',
    company: (() => { try { return JSON.parse(contact?.custom_fields_json || '{}').company || ''; } catch { return ''; } })(),
  };

  const subject = interpolate(campaign.subject, vars);
  let html = interpolate(campaign.body_html, vars);

  // Unsubscribe token: per-send so we can track which campaign they unsubbed from
  const unsubToken = genToken();
  db.prepare('UPDATE crm_campaign_sends SET unsub_token = ? WHERE id = ?').run(unsubToken, send.id);

  html = injectTrackingLinks(html, send.send_token, baseUrl);
  html = appendUnsubscribeFooter(html, unsubToken, baseUrl);

  const r = await sendEmail({ to: send.email, subject, html });
  if (r.ok) {
    db.prepare('UPDATE crm_campaign_sends SET sent_at = ? WHERE id = ?').run(Date.now(), send.id);
    db.prepare('UPDATE crm_email_campaigns SET stats_sent = stats_sent + 1 WHERE id = ?').run(campaign.id);
  } else {
    db.prepare('UPDATE crm_campaign_sends SET bounced = 1, error = ? WHERE id = ?').run(r.error || 'unknown', send.id);
  }
}

// ─── Sequence (drip) runner ─────────────────────────────────────────────
export function enrollInSequence(tenantId: string, sequenceId: string, contactId: string): string | null {
  const db = getCrmDb();
  const seq = db.prepare('SELECT * FROM crm_email_sequences WHERE id = ? AND tenant_id = ? AND enabled = 1').get(sequenceId, tenantId) as any;
  if (!seq) return null;
  const existing = db.prepare('SELECT id FROM crm_sequence_enrollments WHERE sequence_id = ? AND contact_id = ? AND finished_at IS NULL').get(sequenceId, contactId);
  if (existing) return null;

  const id = nid('crm_enr');
  const steps = JSON.parse(seq.steps_json || '[]') as Array<{ delayHours?: number; delayDays?: number }>;
  if (steps.length === 0) return null;
  const first = steps[0];
  const delayMs = ((first.delayHours || 0) * 3600 + (first.delayDays || 0) * 86400) * 1000;
  db.prepare(`
    INSERT INTO crm_sequence_enrollments (id, sequence_id, contact_id, step_idx, next_run_at, created_at)
    VALUES (?, ?, ?, 0, ?, ?)
  `).run(id, sequenceId, contactId, Date.now() + delayMs, Date.now());
  return id;
}

export async function tickSequences(baseUrl: string = ''): Promise<void> {
  const db = getCrmDb();
  const now = Date.now();
  const due = db.prepare(`
    SELECT e.*, s.tenant_id, s.steps_json, s.name
    FROM crm_sequence_enrollments e
    JOIN crm_email_sequences s ON s.id = e.sequence_id
    WHERE e.next_run_at <= ? AND e.finished_at IS NULL AND s.enabled = 1
    LIMIT 50
  `).all(now) as any[];

  for (const enr of due) {
    const steps = JSON.parse(enr.steps_json || '[]') as Array<{ subject?: string; bodyHtml?: string; templateId?: string; delayHours?: number; delayDays?: number }>;
    const step = steps[enr.step_idx];
    if (!step) { db.prepare('UPDATE crm_sequence_enrollments SET finished_at = ? WHERE id = ?').run(now, enr.id); continue; }

    try {
      // Load contact
      const contact = db.prepare('SELECT * FROM crm_contacts WHERE id = ? AND tenant_id = ?').get(enr.contact_id, enr.tenant_id) as any;
      if (!contact?.email) { db.prepare('UPDATE crm_sequence_enrollments SET finished_at = ? WHERE id = ?').run(now, enr.id); continue; }

      // Check unsub
      const unsubbed = db.prepare('SELECT 1 FROM crm_unsubscribes WHERE tenant_id = ? AND LOWER(email) = LOWER(?)').get(enr.tenant_id, contact.email);
      if (unsubbed) { db.prepare('UPDATE crm_sequence_enrollments SET finished_at = ? WHERE id = ?').run(now, enr.id); continue; }

      // Resolve subject/body (prefer template reference)
      let subject = step.subject || '';
      let html = step.bodyHtml || '';
      if (step.templateId) {
        const tpl = db.prepare('SELECT subject, body_html FROM crm_email_templates WHERE id = ? AND tenant_id = ?').get(step.templateId, enr.tenant_id) as any;
        if (tpl) { subject = subject || tpl.subject; html = html || tpl.body_html; }
      }
      const vars = { name: contact.name, firstName: (contact.name || '').split(' ')[0], email: contact.email, phone: contact.phone || '' };
      subject = interpolate(subject, vars);
      html = interpolate(html, vars);
      // Light tracking for sequences too — reuse send_token pattern
      const seqToken = genToken();
      html = injectTrackingLinks(html, 'seq-' + seqToken, baseUrl);

      await sendEmail({ to: contact.email, subject, html });
    } catch (err) { /* advance anyway */ }

    // Advance
    const nextIdx = enr.step_idx + 1;
    const nextStep = steps[nextIdx];
    if (!nextStep) {
      db.prepare('UPDATE crm_sequence_enrollments SET step_idx = ?, finished_at = ? WHERE id = ?').run(nextIdx, now, enr.id);
    } else {
      const delayMs = ((nextStep.delayHours || 0) * 3600 + (nextStep.delayDays || 0) * 86400) * 1000;
      db.prepare('UPDATE crm_sequence_enrollments SET step_idx = ?, next_run_at = ? WHERE id = ?')
        .run(nextIdx, now + delayMs, enr.id);
    }
  }
}

// ─── Scheduled campaigns (status=scheduled and scheduled_at <= now → sending) ─
export function promoteScheduledCampaigns(): void {
  const db = getCrmDb();
  const due = db.prepare(
    "SELECT id, tenant_id FROM crm_email_campaigns WHERE status = 'scheduled' AND scheduled_at <= ?"
  ).all(Date.now()) as any[];
  for (const camp of due) {
    try { enqueueCampaign(camp.tenant_id, camp.id); }
    catch (err: any) { console.warn('[em] enqueue failed', camp.id, err.message); }
  }
}

// ─── Tracking helpers ───────────────────────────────────────────────────
export function recordOpen(sendToken: string, ip: string): void {
  const db = getCrmDb();
  const send = db.prepare('SELECT * FROM crm_campaign_sends WHERE send_token = ?').get(sendToken) as any;
  if (!send) return;
  const now = Date.now();
  db.prepare('UPDATE crm_campaign_sends SET opened_at = COALESCE(opened_at, ?), opened_count = COALESCE(opened_count, 0) + 1, opened_ip = COALESCE(opened_ip, ?) WHERE id = ?')
    .run(now, ip, send.id);
  if (!send.opened_at) {
    db.prepare('UPDATE crm_email_campaigns SET stats_opened = stats_opened + 1 WHERE id = ?').run(send.campaign_id);
  }
}

export function recordClick(sendToken: string, url: string, ip: string): string {
  const db = getCrmDb();
  const send = db.prepare('SELECT * FROM crm_campaign_sends WHERE send_token = ?').get(sendToken) as any;
  if (!send) return url;
  const now = Date.now();
  db.prepare('UPDATE crm_campaign_sends SET clicked_at = COALESCE(clicked_at, ?), click_count = COALESCE(click_count, 0) + 1, last_clicked_url = ? WHERE id = ?')
    .run(now, url, send.id);
  if (!send.clicked_at) {
    db.prepare('UPDATE crm_email_campaigns SET stats_clicked = stats_clicked + 1 WHERE id = ?').run(send.campaign_id);
  }
  return url;
}

export function unsubscribe(unsubToken: string, reason?: string): { ok: boolean; email?: string } {
  const db = getCrmDb();
  const send = db.prepare(`
    SELECT s.email, c.tenant_id FROM crm_campaign_sends s
    JOIN crm_email_campaigns c ON c.id = s.campaign_id
    WHERE s.unsub_token = ?
  `).get(unsubToken) as any;
  if (!send) return { ok: false };
  try {
    db.prepare('INSERT INTO crm_unsubscribes (tenant_id, email, reason, created_at) VALUES (?, ?, ?, ?)')
      .run(send.tenant_id, send.email.toLowerCase(), reason || null, Date.now());
  } catch { /* dup — already unsubbed */ }
  return { ok: true, email: send.email };
}
