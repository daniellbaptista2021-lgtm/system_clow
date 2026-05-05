/**
 * External integrations — Onda 23.
 *
 * One-way batch sync scaffolds for:
 *   - HubSpot:   import contacts from HubSpot CRM (needs private app token)
 *   - RD Station: import contacts (needs Bearer token)
 *   - Gmail/Outlook email tracking: register token, future Tick syncs inbox
 *
 * Each provider has its own import function that pulls a page of contacts
 * and upserts into crm_contacts (dedupe by email).
 */

import { randomBytes } from 'crypto';
import { getCrmDb } from './schema.js';

function nid(prefix: string): string { return prefix + '_' + randomBytes(6).toString('hex'); }
const now = () => Date.now();

export type IntegrationProvider = 'gmail' | 'outlook' | 'hubspot' | 'rdstation';

export interface ExternalIntegration {
  id: string;
  tenantId: string;
  provider: IntegrationProvider;
  agentId?: string;
  enabled: boolean;
  lastSyncAt?: number;
  totalSynced: number;
  config: Record<string, any>; // provider-specific config (token, calendar id, etc.) — stored plaintext for now
  createdAt: number;
}

function rowToInt(r: any): ExternalIntegration {
  return {
    id: r.id, tenantId: r.tenant_id, provider: r.provider as IntegrationProvider,
    agentId: r.agent_id ?? undefined, enabled: r.enabled === 1,
    lastSyncAt: r.last_sync_at ?? undefined,
    totalSynced: r.total_synced || 0,
    config: JSON.parse(r.config_json || '{}'),
    createdAt: r.created_at,
  };
}

export function createIntegration(tenantId: string, input: {
  provider: IntegrationProvider; agentId?: string; config: Record<string, any>;
}): ExternalIntegration {
  const id = nid('crm_extint');
  getCrmDb().prepare(`
    INSERT INTO crm_external_integrations
      (id, tenant_id, provider, agent_id, config_json, enabled, total_synced, created_at)
    VALUES (?, ?, ?, ?, ?, 1, 0, ?)
  `).run(id, tenantId, input.provider, input.agentId ?? null,
    JSON.stringify(input.config), now());
  return getIntegration(tenantId, id)!;
}

export function getIntegration(tenantId: string, id: string): ExternalIntegration | null {
  const r = getCrmDb().prepare('SELECT * FROM crm_external_integrations WHERE id = ? AND tenant_id = ?').get(id, tenantId) as any;
  return r ? rowToInt(r) : null;
}

export function listIntegrations(tenantId: string): ExternalIntegration[] {
  return (getCrmDb().prepare('SELECT * FROM crm_external_integrations WHERE tenant_id = ? ORDER BY created_at DESC').all(tenantId) as any[])
    .map(rowToInt);
}

export function updateIntegration(tenantId: string, id: string, patch: Partial<ExternalIntegration>): ExternalIntegration | null {
  const ex = getIntegration(tenantId, id);
  if (!ex) return null;
  const merged = { ...ex, ...patch };
  getCrmDb().prepare(
    'UPDATE crm_external_integrations SET enabled=?, config_json=? WHERE id = ? AND tenant_id = ?'
  ).run(merged.enabled ? 1 : 0, JSON.stringify(merged.config), id, tenantId);
  return getIntegration(tenantId, id);
}

export function deleteIntegration(tenantId: string, id: string): boolean {
  return getCrmDb().prepare('DELETE FROM crm_external_integrations WHERE id = ? AND tenant_id = ?').run(id, tenantId).changes > 0;
}

// ─── Upsert contact helper ──────────────────────────────────────────────
function upsertContact(tenantId: string, input: {
  name: string; email?: string; phone?: string; source: string;
  customFields?: Record<string, any>; tags?: string[];
}): { contactId: string; created: boolean } {
  const db = getCrmDb();
  let existing: any = null;
  if (input.email) {
    existing = db.prepare('SELECT id FROM crm_contacts WHERE tenant_id = ? AND LOWER(email) = LOWER(?)').get(tenantId, input.email);
  }
  if (!existing && input.phone) {
    existing = db.prepare('SELECT id FROM crm_contacts WHERE tenant_id = ? AND phone = ?').get(tenantId, input.phone);
  }
  if (existing) {
    db.prepare(`
      UPDATE crm_contacts SET name = ?, email = COALESCE(?, email), phone = COALESCE(?, phone),
        custom_fields_json = json_patch(COALESCE(custom_fields_json,'{}'), ?), updated_at = ?
      WHERE id = ? AND tenant_id = ?
    `).run(input.name, input.email ?? null, input.phone ?? null,
      JSON.stringify(input.customFields || {}), now(), existing.id, tenantId);
    return { contactId: existing.id, created: false };
  }
  const id = nid('crm_contact');
  const t = now();
  db.prepare(`
    INSERT INTO crm_contacts (id, tenant_id, name, email, phone, source, tags_json, custom_fields_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, tenantId, input.name, input.email ?? null, input.phone ?? null, input.source,
    JSON.stringify(input.tags || []), JSON.stringify(input.customFields || {}), t, t);
  return { contactId: id, created: true };
}

// ─── HubSpot: import contacts ──────────────────────────────────────────
export async function importFromHubSpot(tenantId: string, integrationId: string, opts: { limit?: number } = {}): Promise<{ imported: number; updated: number; errors: number }> {
  const integ = getIntegration(tenantId, integrationId);
  if (!integ || integ.provider !== 'hubspot') throw new Error('invalid integration');
  const token = integ.config.accessToken || integ.config.token;
  if (!token) throw new Error('missing accessToken');

  const limit = Math.min(100, opts.limit || 100);
  let imported = 0, updated = 0, errors = 0;
  try {
    const r = await fetch(`https://api.hubapi.com/crm/v3/objects/contacts?limit=${limit}&properties=firstname,lastname,email,phone,company,lifecyclestage,createdate`, {
      headers: { Authorization: 'Bearer ' + token },
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) throw new Error('hubspot_' + r.status);
    const data = await r.json() as any;
    for (const h of (data.results || [])) {
      try {
        const p = h.properties || {};
        const name = [p.firstname, p.lastname].filter(Boolean).join(' ').trim() || p.email || 'Sem nome';
        const res = upsertContact(tenantId, {
          name, email: p.email, phone: p.phone,
          source: 'hubspot',
          customFields: { company: p.company, hubspot_id: h.id, lifecyclestage: p.lifecyclestage },
        });
        if (res.created) imported++;
        else updated++;
      } catch { errors++; }
    }
  } catch (err: any) {
    throw err;
  }
  getCrmDb().prepare(
    'UPDATE crm_external_integrations SET last_sync_at = ?, total_synced = total_synced + ? WHERE id = ?'
  ).run(now(), imported + updated, integrationId);
  return { imported, updated, errors };
}

// ─── RD Station: import contacts ──────────────────────────────────────
export async function importFromRDStation(tenantId: string, integrationId: string): Promise<{ imported: number; updated: number; errors: number }> {
  const integ = getIntegration(tenantId, integrationId);
  if (!integ || integ.provider !== 'rdstation') throw new Error('invalid integration');
  const token = integ.config.accessToken;
  if (!token) throw new Error('missing accessToken');

  let imported = 0, updated = 0, errors = 0;
  try {
    const r = await fetch('https://api.rd.services/platform/contacts?page_size=100', {
      headers: { Authorization: 'Bearer ' + token },
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) throw new Error('rdstation_' + r.status);
    const data = await r.json() as any;
    for (const c of (data.contacts || [])) {
      try {
        const phone = c.phones?.[0]?.phone_number || c.mobile_phone;
        const res = upsertContact(tenantId, {
          name: c.name || c.email || 'Sem nome',
          email: c.email, phone,
          source: 'rdstation',
          customFields: { company: c.company?.name, rdstation_uuid: c.uuid, lead_stage: c.lead_stage },
        });
        if (res.created) imported++;
        else updated++;
      } catch { errors++; }
    }
  } catch (err: any) {
    throw err;
  }
  getCrmDb().prepare(
    'UPDATE crm_external_integrations SET last_sync_at = ?, total_synced = total_synced + ? WHERE id = ?'
  ).run(now(), imported + updated, integrationId);
  return { imported, updated, errors };
}

// ─── Gmail/Outlook: register token (OAuth flow is a future onda) ──────
export function registerGmailOrOutlook(tenantId: string, provider: 'gmail' | 'outlook', config: {
  agentId: string; accessToken: string; refreshToken?: string; email?: string;
}): ExternalIntegration {
  return createIntegration(tenantId, {
    provider, agentId: config.agentId,
    config: { accessToken: config.accessToken, refreshToken: config.refreshToken, email: config.email },
  });
}

// Placeholder for future scheduler hook
export async function tickEmailSync(): Promise<void> {
  // TODO: For each gmail/outlook integration with enabled=1,
  //  GET /gmail/v1/users/me/messages?labelIds=INBOX&q="newer_than:1d"
  //  Match "To" email to known contact (by email), insert activity type='email' direction='in'
  //  Track lastSyncAt to only fetch new messages.
  // Not yet implemented — scaffold stays for future onda.
}
