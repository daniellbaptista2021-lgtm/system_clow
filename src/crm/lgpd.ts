/**
 * LGPD / Compliance — Onda 28.
 *
 * Implements the 5 main requirements of LGPD (Lei Geral de Proteção de Dados):
 *   1. Consent: explicit per channel/purpose (art. 7, 8)
 *   2. Right to erasure / forgotten (art. 18 VI)
 *   3. Access log for sensitive data (art. 37)
 *   4. Data portability (art. 18 V): export all data of a subject
 *   5. Retention policies (art. 15): auto-delete after N days
 */

import { randomBytes } from 'crypto';
import { getCrmDb } from './schema.js';

function nid(prefix: string): string { return prefix + '_' + randomBytes(6).toString('hex'); }
const now = () => Date.now();

export type ConsentChannel = 'email' | 'sms' | 'whatsapp' | 'phone' | 'all';
export type ConsentPurpose = 'marketing' | 'transactional' | 'all';
export type ConsentSource = 'form' | 'manual' | 'api' | 'double_optin';

// ─── Consents ──────────────────────────────────────────────────────────
export interface Consent {
  id: string;
  tenantId: string;
  contactId: string;
  channel: ConsentChannel;
  purpose: ConsentPurpose;
  granted: boolean;
  grantedAt?: number;
  revokedAt?: number;
  source: ConsentSource;
  evidence?: Record<string, any>;
}

function rowToConsent(r: any): Consent {
  return {
    id: r.id, tenantId: r.tenant_id, contactId: r.contact_id,
    channel: r.channel as ConsentChannel, purpose: r.purpose as ConsentPurpose,
    granted: r.granted === 1,
    grantedAt: r.granted_at ?? undefined, revokedAt: r.revoked_at ?? undefined,
    source: r.source as ConsentSource,
    evidence: r.evidence_json ? JSON.parse(r.evidence_json) : undefined,
  };
}

export function recordConsent(tenantId: string, input: {
  contactId: string; channel: ConsentChannel; purpose: ConsentPurpose;
  granted: boolean; source?: ConsentSource; evidence?: Record<string, any>;
}): Consent {
  const db = getCrmDb();
  // Revoke any prior conflicting consent on same channel+purpose
  db.prepare(`
    UPDATE crm_consents SET revoked_at = ?
    WHERE tenant_id = ? AND contact_id = ? AND channel = ? AND purpose = ? AND revoked_at IS NULL
  `).run(now(), tenantId, input.contactId, input.channel, input.purpose);

  const id = nid('crm_consent');
  db.prepare(`
    INSERT INTO crm_consents (id, tenant_id, contact_id, channel, purpose, granted, granted_at, source, evidence_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, tenantId, input.contactId, input.channel, input.purpose,
    input.granted ? 1 : 0, input.granted ? now() : null,
    input.source || 'manual', input.evidence ? JSON.stringify(input.evidence) : null);
  return rowToConsent(db.prepare('SELECT * FROM crm_consents WHERE id = ?').get(id));
}

export function listContactConsents(tenantId: string, contactId: string): Consent[] {
  return (getCrmDb().prepare(
    'SELECT * FROM crm_consents WHERE tenant_id = ? AND contact_id = ? ORDER BY granted_at DESC NULLS LAST, revoked_at DESC'
  ).all(tenantId, contactId) as any[]).map(rowToConsent);
}

export function hasConsent(tenantId: string, contactId: string, channel: ConsentChannel, purpose: ConsentPurpose): boolean {
  const db = getCrmDb();
  // "all" consents imply specific ones
  const r = db.prepare(`
    SELECT granted, revoked_at FROM crm_consents
    WHERE tenant_id = ? AND contact_id = ?
      AND (channel = ? OR channel = 'all')
      AND (purpose = ? OR purpose = 'all')
      AND revoked_at IS NULL
    ORDER BY granted_at DESC LIMIT 1
  `).get(tenantId, contactId, channel, purpose) as any;
  return r?.granted === 1;
}

// ─── Access log ────────────────────────────────────────────────────────
export interface AccessLogEntry {
  tenantId: string;
  actorAgentId?: string;
  action: 'view' | 'export' | 'modify' | 'delete';
  targetEntity: string;       // contact | card | activity | document | proposal
  targetId: string;
  accessedFields?: string[];
  ip?: string;
  ua?: string;
}

export function logAccess(entry: AccessLogEntry): void {
  const db = getCrmDb();
  db.prepare(`
    INSERT INTO crm_data_access_log
      (id, tenant_id, actor_agent_id, action, target_entity, target_id, accessed_fields_json, ip, ua, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(nid('crm_acl'), entry.tenantId, entry.actorAgentId ?? null,
    entry.action, entry.targetEntity, entry.targetId,
    entry.accessedFields ? JSON.stringify(entry.accessedFields) : null,
    entry.ip ?? null, entry.ua ?? null, now());
}

export function queryAccessLog(tenantId: string, opts: {
  contactId?: string; targetEntity?: string; action?: string; agentId?: string;
  from?: number; to?: number; limit?: number;
} = {}): any[] {
  const wh: string[] = ['tenant_id = ?'];
  const params: any[] = [tenantId];
  if (opts.targetEntity) { wh.push('target_entity = ?'); params.push(opts.targetEntity); }
  if (opts.contactId)    { wh.push('target_entity = ? AND target_id = ?'); params.push('contact', opts.contactId); }
  if (opts.action)       { wh.push('action = ?'); params.push(opts.action); }
  if (opts.agentId)      { wh.push('actor_agent_id = ?'); params.push(opts.agentId); }
  if (opts.from != null) { wh.push('created_at >= ?'); params.push(opts.from); }
  if (opts.to != null)   { wh.push('created_at <= ?'); params.push(opts.to); }
  const limit = Math.min(1000, opts.limit || 200);
  return getCrmDb().prepare(
    `SELECT * FROM crm_data_access_log WHERE ${wh.join(' AND ')} ORDER BY created_at DESC LIMIT ?`
  ).all(...params, limit) as any[];
}

// ─── Portability (data export) ─────────────────────────────────────────
export function exportContactData(tenantId: string, contactId: string, actorAgentId?: string): any {
  const db = getCrmDb();
  const contact = db.prepare('SELECT * FROM crm_contacts WHERE id = ? AND tenant_id = ?').get(contactId, tenantId) as any;
  if (!contact) return null;

  logAccess({
    tenantId, actorAgentId, action: 'export', targetEntity: 'contact', targetId: contactId,
    accessedFields: ['all'],
  });

  const activities = db.prepare('SELECT * FROM crm_activities WHERE tenant_id = ? AND contact_id = ? ORDER BY created_at ASC').all(tenantId, contactId);
  const cards = db.prepare('SELECT * FROM crm_cards WHERE tenant_id = ? AND contact_id = ?').all(tenantId, contactId);
  const consents = listContactConsents(tenantId, contactId);
  const notes = db.prepare('SELECT * FROM crm_contact_notes WHERE tenant_id = ? AND contact_id = ?').all(tenantId, contactId);
  const appointments = db.prepare('SELECT * FROM crm_appointments WHERE tenant_id = ? AND contact_id = ?').all(tenantId, contactId);
  const documents = db.prepare('SELECT id, title, version, status, signed_at, created_at FROM crm_documents WHERE tenant_id = ? AND contact_id = ?').all(tenantId, contactId);
  const proposals = db.prepare('SELECT id, version, status, total_cents, created_at FROM crm_proposals WHERE tenant_id = ? AND card_id IN (SELECT id FROM crm_cards WHERE contact_id = ?)').all(tenantId, contactId);
  const campaignSends = db.prepare(`
    SELECT cs.email, cs.sent_at, cs.opened_at, cs.clicked_at, c.name AS campaign_name
    FROM crm_campaign_sends cs
    JOIN crm_email_campaigns c ON c.id = cs.campaign_id
    WHERE c.tenant_id = ? AND cs.contact_id = ?
  `).all(tenantId, contactId);

  return {
    exportedAt: new Date().toISOString(),
    subjectId: contactId,
    profile: {
      ...contact,
      tags: JSON.parse(contact.tags_json || '[]'),
      custom_fields: JSON.parse(contact.custom_fields_json || '{}'),
      tags_json: undefined, custom_fields_json: undefined,
    },
    consents,
    activities: activities.map((a: any) => ({ ...a, metadata: a.metadata_json ? JSON.parse(a.metadata_json) : null, metadata_json: undefined })),
    cards: cards.map((c: any) => ({ ...c, labels: JSON.parse(c.labels_json || '[]'), labels_json: undefined })),
    notes, appointments, documents, proposals,
    marketingSends: campaignSends,
  };
}

// ─── Right to erasure (forget) ─────────────────────────────────────────
export type ForgetMode = 'anonymize' | 'delete';

export function forgetContact(tenantId: string, contactId: string, opts: {
  mode: ForgetMode; actorAgentId?: string; reason?: string;
}): { ok: boolean; mode: ForgetMode; wiped: Record<string, number> } {
  const db = getCrmDb();
  const contact = db.prepare('SELECT id, email FROM crm_contacts WHERE id = ? AND tenant_id = ?').get(contactId, tenantId) as any;
  if (!contact) return { ok: false, mode: opts.mode, wiped: {} };

  const wiped: Record<string, number> = {};
  const tx = db.transaction(() => {
    if (opts.mode === 'anonymize') {
      // Wipe PII but keep structural references (for reporting/financial records)
      const anon = 'anonymized_' + contactId.slice(-8);
      wiped.contacts = db.prepare(`
        UPDATE crm_contacts
        SET name = ?, email = NULL, phone = NULL, avatar_url = NULL,
            notes = NULL, custom_fields_json = '{}', tags_json = '[]',
            updated_at = ?
        WHERE id = ? AND tenant_id = ?
      `).run(anon, now(), contactId, tenantId).changes;

      // Redact PII from activities (keep metadata + timestamps)
      wiped.activities = db.prepare(`
        UPDATE crm_activities SET content = '[anonimizado]', media_url = NULL
        WHERE tenant_id = ? AND contact_id = ?
      `).run(tenantId, contactId).changes;

      wiped.notes = db.prepare('DELETE FROM crm_contact_notes WHERE tenant_id = ? AND contact_id = ?').run(tenantId, contactId).changes;
      wiped.chat_messages = 0; // no direct chat_messages link to contact
    } else {
      // Full delete — cascade via FK
      wiped.activities = db.prepare('DELETE FROM crm_activities WHERE tenant_id = ? AND contact_id = ?').run(tenantId, contactId).changes;
      wiped.cards = db.prepare('DELETE FROM crm_cards WHERE tenant_id = ? AND contact_id = ?').run(tenantId, contactId).changes;
      wiped.notes = db.prepare('DELETE FROM crm_contact_notes WHERE tenant_id = ? AND contact_id = ?').run(tenantId, contactId).changes;
      wiped.consents = db.prepare('DELETE FROM crm_consents WHERE tenant_id = ? AND contact_id = ?').run(tenantId, contactId).changes;
      wiped.appointments = db.prepare('DELETE FROM crm_appointments WHERE tenant_id = ? AND contact_id = ?').run(tenantId, contactId).changes;
      wiped.contacts = db.prepare('DELETE FROM crm_contacts WHERE id = ? AND tenant_id = ?').run(contactId, tenantId).changes;
    }

    // Add to unsubscribes list (if email known) — prevents re-contacting
    if (contact.email) {
      try {
        db.prepare('INSERT INTO crm_unsubscribes (tenant_id, email, reason, created_at) VALUES (?, ?, ?, ?)')
          .run(tenantId, String(contact.email).toLowerCase(), 'LGPD forget', now());
      } catch { /* already unsubbed */ }
    }
  });
  tx();

  logAccess({
    tenantId, actorAgentId: opts.actorAgentId, action: 'delete', targetEntity: 'contact', targetId: contactId,
    accessedFields: ['all'],
  });

  return { ok: true, mode: opts.mode, wiped };
}

// ─── Deletion requests (for async processing with cooldown) ────────────
export interface DeletionRequest {
  id: string;
  tenantId: string;
  contactId: string;
  requestedByEmail: string;
  reason?: string;
  status: 'pending' | 'completed' | 'denied';
  scheduledFor: number;
  completedAt?: number;
  mode: ForgetMode;
}

function rowToRequest(r: any): DeletionRequest {
  return {
    id: r.id, tenantId: r.tenant_id, contactId: r.contact_id,
    requestedByEmail: r.requested_by_email, reason: r.reason ?? undefined,
    status: r.status as any, scheduledFor: r.scheduled_for,
    completedAt: r.completed_at ?? undefined, mode: r.mode as ForgetMode,
  };
}

export function createDeletionRequest(tenantId: string, input: {
  contactId: string; requestedByEmail: string; reason?: string;
  mode?: ForgetMode; coolDownDays?: number;
}): DeletionRequest {
  const id = nid('crm_delreq');
  const scheduled = now() + (input.coolDownDays ?? 15) * 86400_000;
  getCrmDb().prepare(`
    INSERT INTO crm_deletion_requests (id, tenant_id, contact_id, requested_by_email, reason, status, scheduled_for, mode, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
  `).run(id, tenantId, input.contactId, input.requestedByEmail, input.reason ?? null,
    scheduled, input.mode || 'anonymize', now());
  return getDeletionRequest(tenantId, id)!;
}

export function getDeletionRequest(tenantId: string, id: string): DeletionRequest | null {
  const r = getCrmDb().prepare('SELECT * FROM crm_deletion_requests WHERE id = ? AND tenant_id = ?').get(id, tenantId) as any;
  return r ? rowToRequest(r) : null;
}

export function listDeletionRequests(tenantId: string, status?: string): DeletionRequest[] {
  const wh = ['tenant_id = ?'];
  const params: any[] = [tenantId];
  if (status) { wh.push('status = ?'); params.push(status); }
  return (getCrmDb().prepare(`SELECT * FROM crm_deletion_requests WHERE ${wh.join(' AND ')} ORDER BY created_at DESC`).all(...params) as any[])
    .map(rowToRequest);
}

export function cancelDeletionRequest(tenantId: string, id: string): boolean {
  return getCrmDb().prepare(
    "UPDATE crm_deletion_requests SET status = 'denied', completed_at = ? WHERE id = ? AND tenant_id = ? AND status = 'pending'"
  ).run(now(), id, tenantId).changes > 0;
}

/** Scheduler: processes pending deletion requests where scheduled_for <= now. */
export function processScheduledDeletions(): number {
  const db = getCrmDb();
  const due = db.prepare(
    "SELECT * FROM crm_deletion_requests WHERE status = 'pending' AND scheduled_for <= ? LIMIT 20"
  ).all(now()) as any[];
  let processed = 0;
  for (const r of due) {
    const req = rowToRequest(r);
    try {
      const result = forgetContact(req.tenantId, req.contactId, { mode: req.mode, reason: req.reason });
      db.prepare("UPDATE crm_deletion_requests SET status = 'completed', completed_at = ? WHERE id = ?").run(now(), req.id);
      if (result.ok) processed++;
    } catch (err: any) {
      console.warn('[lgpd deletion]', req.id, err.message);
    }
  }
  return processed;
}

// ─── Retention policies ────────────────────────────────────────────────
export interface RetentionPolicy {
  id: string;
  tenantId: string;
  entity: 'activities' | 'consents' | 'deletion_requests' | 'data_access_log' | 'contacts_inactive';
  daysToKeep: number;
  autoAnonymize: boolean;
  enabled: boolean;
  createdAt: number;
}

function rowToPolicy(r: any): RetentionPolicy {
  return {
    id: r.id, tenantId: r.tenant_id, entity: r.entity,
    daysToKeep: r.days_to_keep, autoAnonymize: r.auto_anonymize === 1,
    enabled: r.enabled === 1, createdAt: r.created_at,
  };
}

export function createRetentionPolicy(tenantId: string, input: {
  entity: RetentionPolicy['entity']; daysToKeep: number; autoAnonymize?: boolean;
}): RetentionPolicy {
  const id = nid('crm_retp');
  getCrmDb().prepare(`
    INSERT INTO crm_retention_policies (id, tenant_id, entity, days_to_keep, auto_anonymize, enabled, created_at)
    VALUES (?, ?, ?, ?, ?, 1, ?)
  `).run(id, tenantId, input.entity, input.daysToKeep, input.autoAnonymize ? 1 : 0, now());
  return getRetentionPolicy(tenantId, id)!;
}

export function getRetentionPolicy(tenantId: string, id: string): RetentionPolicy | null {
  const r = getCrmDb().prepare('SELECT * FROM crm_retention_policies WHERE id = ? AND tenant_id = ?').get(id, tenantId) as any;
  return r ? rowToPolicy(r) : null;
}

export function listRetentionPolicies(tenantId: string): RetentionPolicy[] {
  return (getCrmDb().prepare('SELECT * FROM crm_retention_policies WHERE tenant_id = ? ORDER BY created_at DESC').all(tenantId) as any[])
    .map(rowToPolicy);
}

export function updateRetentionPolicy(tenantId: string, id: string, patch: Partial<RetentionPolicy>): RetentionPolicy | null {
  const ex = getRetentionPolicy(tenantId, id);
  if (!ex) return null;
  const m = { ...ex, ...patch };
  getCrmDb().prepare(
    'UPDATE crm_retention_policies SET days_to_keep = ?, auto_anonymize = ?, enabled = ? WHERE id = ? AND tenant_id = ?'
  ).run(m.daysToKeep, m.autoAnonymize ? 1 : 0, m.enabled ? 1 : 0, id, tenantId);
  return getRetentionPolicy(tenantId, id);
}

export function deleteRetentionPolicy(tenantId: string, id: string): boolean {
  return getCrmDb().prepare('DELETE FROM crm_retention_policies WHERE id = ? AND tenant_id = ?').run(id, tenantId).changes > 0;
}

/** Scheduler: apply retention policies (daily). */
let _lastRetentionDay = -1;
export function processRetentionPolicies(): { processed: Record<string, number> } {
  const day = new Date().getUTCDate();
  if (_lastRetentionDay === day) return { processed: {} };
  _lastRetentionDay = day;

  const db = getCrmDb();
  const policies = db.prepare('SELECT * FROM crm_retention_policies WHERE enabled = 1').all() as any[];
  const processed: Record<string, number> = {};

  for (const p of policies) {
    const pol = rowToPolicy(p);
    const cutoff = now() - pol.daysToKeep * 86400_000;
    try {
      if (pol.entity === 'activities') {
        const r = db.prepare('DELETE FROM crm_activities WHERE tenant_id = ? AND created_at < ?').run(pol.tenantId, cutoff);
        processed.activities = (processed.activities || 0) + r.changes;
      } else if (pol.entity === 'data_access_log') {
        const r = db.prepare('DELETE FROM crm_data_access_log WHERE tenant_id = ? AND created_at < ?').run(pol.tenantId, cutoff);
        processed.data_access_log = (processed.data_access_log || 0) + r.changes;
      } else if (pol.entity === 'deletion_requests') {
        const r = db.prepare("DELETE FROM crm_deletion_requests WHERE tenant_id = ? AND status != 'pending' AND created_at < ?").run(pol.tenantId, cutoff);
        processed.deletion_requests = (processed.deletion_requests || 0) + r.changes;
      } else if (pol.entity === 'consents') {
        // Keep all consents (legal requirement typically > years) — only prune revoked > daysToKeep
        const r = db.prepare('DELETE FROM crm_consents WHERE tenant_id = ? AND revoked_at IS NOT NULL AND revoked_at < ?').run(pol.tenantId, cutoff);
        processed.consents = (processed.consents || 0) + r.changes;
      } else if (pol.entity === 'contacts_inactive') {
        // Anonymize contacts with no activity > N days
        const stale = db.prepare(`
          SELECT id FROM crm_contacts
          WHERE tenant_id = ? AND COALESCE(last_interaction_at, created_at) < ?
          LIMIT 50
        `).all(pol.tenantId, cutoff) as any[];
        for (const c of stale) {
          if (pol.autoAnonymize) {
            forgetContact(pol.tenantId, c.id, { mode: 'anonymize' });
            processed.contacts_inactive = (processed.contacts_inactive || 0) + 1;
          }
        }
      }
    } catch (err: any) { console.warn('[lgpd retention]', pol.entity, err.message); }
  }
  return { processed };
}
