// CRM channelsStore module — split out from the legacy monolithic file in a refactor.
// Edit this file directly; scripts/split-store.cjs is retained only as a record
// of how the original was decomposed (it ran once against the .ts.bak snapshot).
import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import { getCrmDb } from '.././schema.js';
import type {
  Board, BoardColumn, Contact, Card, Activity, Agent, Channel2,
  Subscription, Automation, InventoryItem, BoardType, ActivityType,
  Channel, MediaType, ChannelType, ChannelStatus, BillingCycle, SubscriptionStatus, AgentRole,
} from '.././types.js';
import type { Segment, SegmentFilter, BulkContactOp } from '.././types.js';
import type { Swimlane, Checklist, ChecklistItem, BoardSettings, ColumnStageType } from '.././types.js';
import type { Team, AgentPermissions, AgentMetricsPro, SlaRule,
              Label, QuickReply, InboxRule } from '.././types.js';
import type { ActivityFilter, ReminderChannel, ReminderStatus, ReminderPro } from '.././types.js';
import type { InventoryCategory, InventoryVariant, InventoryMovement,
              Proposal, ProposalStatus, ProposalTemplate } from '.././types.js';
import type { StripeConnectAccount, InvoicePro, InvoiceStatus, Coupon, DunningLog, MrrSnapshot } from '.././types.js';
import type { AutomationLog, AssignmentRule, AssignmentConditions, AssignmentLog } from '.././types.js';
import type { ChannelTemplate, ChannelHealth, ChannelMetrics } from '.././types.js';
import { now, getAutoAssign, getCommitStock, getPublish, getEmit, nid, J, HEADER_ALIASES } from './_internals.js';
import type { ImportResult, EvalContext } from './_internals.js';


export function createChannel(tenantId: string, input: {
  type: ChannelType; name: string; credentialsEncrypted: string;
  phoneNumber?: string; phoneNumberId?: string; webhookSecret?: string;
  status?: ChannelStatus;
}): Channel2 {
  const db = getCrmDb();
  const ch: Channel2 = {
    id: nid('crm_ch'), tenantId, type: input.type, name: input.name,
    status: input.status ?? 'pending', credentialsEncrypted: input.credentialsEncrypted,
    phoneNumber: input.phoneNumber, phoneNumberId: input.phoneNumberId,
    webhookSecret: input.webhookSecret ?? randomUUID().replace(/-/g, ''),
    createdAt: now(),
  };
  db.prepare(`
    INSERT INTO crm_channels (id, tenant_id, type, name, status, credentials_encrypted,
      phone_number, phone_number_id, webhook_secret, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(ch.id, ch.tenantId, ch.type, ch.name, ch.status, ch.credentialsEncrypted,
    ch.phoneNumber ?? null, ch.phoneNumberId ?? null, ch.webhookSecret, ch.createdAt);
  return ch;
}

export function listChannels(tenantId: string): Channel2[] {
  const db = getCrmDb();
  const rows = db.prepare('SELECT * FROM crm_channels WHERE tenant_id = ? ORDER BY created_at ASC').all(tenantId) as any[];
  return rows.map(rowToChannel);
}

export function getChannel(tenantId: string, channelId: string): Channel2 | null {
  const db = getCrmDb();
  const r = db.prepare('SELECT * FROM crm_channels WHERE id = ? AND tenant_id = ?').get(channelId, tenantId) as any;
  return r ? rowToChannel(r) : null;
}

export function findChannelByWebhookSecret(secret: string): Channel2 | null {
  const db = getCrmDb();
  const r = db.prepare('SELECT * FROM crm_channels WHERE webhook_secret = ?').get(secret) as any;
  return r ? rowToChannel(r) : null;
}

export function findChannelByPhoneId(phoneNumberId: string): Channel2 | null {
  const db = getCrmDb();
  const r = db.prepare('SELECT * FROM crm_channels WHERE phone_number_id = ?').get(phoneNumberId) as any;
  return r ? rowToChannel(r) : null;
}

export function updateChannel(tenantId: string, channelId: string, patch: Partial<Omit<Channel2, 'id' | 'tenantId' | 'createdAt'>>): Channel2 | null {
  const db = getCrmDb();
  const existing = getChannel(tenantId, channelId);
  if (!existing) return null;
  const upd = { ...existing, ...patch };
  db.prepare(`
    UPDATE crm_channels SET name = ?, status = ?, credentials_encrypted = ?,
      phone_number = ?, phone_number_id = ?, webhook_secret = ?, last_inbound_at = ?
    WHERE id = ? AND tenant_id = ?
  `).run(upd.name, upd.status, upd.credentialsEncrypted, upd.phoneNumber ?? null,
    upd.phoneNumberId ?? null, upd.webhookSecret ?? null, upd.lastInboundAt ?? null, channelId, tenantId);
  return upd;
}

export function deleteChannel(tenantId: string, channelId: string): boolean {
  const db = getCrmDb();
  const r = db.prepare('DELETE FROM crm_channels WHERE id = ? AND tenant_id = ?').run(channelId, tenantId);
  return r.changes > 0;
}

function rowToChannel(r: any): Channel2 {
  return {
    id: r.id, tenantId: r.tenant_id, type: r.type as ChannelType, name: r.name,
    status: r.status as ChannelStatus, credentialsEncrypted: r.credentials_encrypted,
    phoneNumber: r.phone_number ?? undefined, phoneNumberId: r.phone_number_id ?? undefined,
    webhookSecret: r.webhook_secret ?? undefined, lastInboundAt: r.last_inbound_at ?? undefined,
    createdAt: r.created_at,
    allowSelfChat: r.allow_self_chat === 1,
  };
}

export async function channelHealthCheck(tenantId: string, channelId: string): Promise<ChannelHealth> {
  const ch = getChannel(tenantId, channelId);
  if (!ch) return { ok: false, lastCheck: Date.now(), apiReachable: false, tokenValid: false, errors: ['channel_not_found'] };

  const errors: string[] = [];
  let apiReachable = false, tokenValid = false, phoneActive = undefined as boolean | undefined;

  try {
    const { decryptJson } = await import('.././crypto.js');
    const creds = decryptJson<any>(ch.credentialsEncrypted);
    if (ch.type === 'meta') {
      const apiVersion = creds.apiVersion || 'v22.0';
      const res = await fetch(`https://graph.facebook.com/${apiVersion}/${creds.phoneNumberId}?fields=display_phone_number,verified_name,status,quality_rating`, {
        headers: { 'Authorization': 'Bearer ' + creds.accessToken },
      });
      apiReachable = true;
      if (res.ok) {
        const data: any = await res.json();
        tokenValid = true;
        phoneActive = data.status === 'CONNECTED';
        if (!phoneActive) errors.push('phone_status=' + data.status);
      } else {
        errors.push(`meta_api_http_${res.status}`);
      }
    } else if (ch.type === 'zapi') {
      // Z-API /status endpoint
      const url = `https://api.z-api.io/instances/${creds.instanceId}/token/${creds.instanceToken}/status`;
      const res = await fetch(url);
      apiReachable = true;
      if (res.ok) {
        const data: any = await res.json();
        tokenValid = true;
        phoneActive = !!(data.connected || data.session);
      } else { errors.push(`zapi_http_${res.status}`); }
    }
  } catch (err: any) {
    errors.push(err.message || 'health_check_failed');
  }

  const health: ChannelHealth = { ok: errors.length === 0, lastCheck: Date.now(),
    apiReachable, tokenValid, phoneNumberActive: phoneActive, errors };
  getCrmDb().prepare('UPDATE crm_channels SET health_json=?, last_health_check=?, last_error=? WHERE id=? AND tenant_id=?')
    .run(JSON.stringify(health), health.lastCheck, errors[0] ?? null, channelId, tenantId);
  return health;
}

export function getChannelMetrics(tenantId: string, channelId: string): ChannelMetrics | null {
  const r = getCrmDb().prepare('SELECT id, messages_sent, messages_received, last_inbound_at, last_error FROM crm_channels WHERE id=? AND tenant_id=?').get(channelId, tenantId) as any;
  if (!r) return null;
  return { channelId: r.id, messagesSent: r.messages_sent || 0, messagesReceived: r.messages_received || 0,
    lastInboundAt: r.last_inbound_at ?? undefined, lastError: r.last_error ?? undefined };
}

export function incChannelMsgCounter(tenantId: string, channelId: string, direction: 'sent' | 'received'): void {
  const col = direction === 'sent' ? 'messages_sent' : 'messages_received';
  getCrmDb().prepare(`UPDATE crm_channels SET ${col} = COALESCE(${col},0) + 1 WHERE id=? AND tenant_id=?`).run(channelId, tenantId);
}

export function upsertChannelTemplate(tenantId: string, input: Omit<ChannelTemplate,'id'|'tenantId'|'syncedAt'>): ChannelTemplate {
  const db = getCrmDb();
  const existing = db.prepare('SELECT * FROM crm_channel_templates WHERE channel_id=? AND template_name=? AND language_code=?')
    .get(input.channelId, input.templateName, input.languageCode) as any;
  const t = Date.now();
  if (existing) {
    db.prepare('UPDATE crm_channel_templates SET category=?, status=?, body=?, synced_at=? WHERE id=?')
      .run(input.category ?? null, input.status, input.body ?? null, t, existing.id);
    return { id: existing.id, tenantId: existing.tenant_id, channelId: existing.channel_id,
      templateName: existing.template_name, languageCode: existing.language_code,
      category: input.category, status: input.status, body: input.body, syncedAt: t };
  }
  const tmpl: ChannelTemplate = { id: nid('crm_tmpl'), tenantId, ...input, syncedAt: t };
  db.prepare('INSERT INTO crm_channel_templates (id,tenant_id,channel_id,template_name,language_code,category,status,body,synced_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(tmpl.id, tenantId, tmpl.channelId, tmpl.templateName, tmpl.languageCode, tmpl.category ?? null, tmpl.status, tmpl.body ?? null, t);
  return tmpl;
}

export function listChannelTemplates(tenantId: string, channelId: string): ChannelTemplate[] {
  return (getCrmDb().prepare('SELECT * FROM crm_channel_templates WHERE tenant_id=? AND channel_id=? ORDER BY template_name').all(tenantId, channelId) as any[])
    .map((r: any) => ({ id: r.id, tenantId: r.tenant_id, channelId: r.channel_id,
      templateName: r.template_name, languageCode: r.language_code,
      category: r.category ?? undefined, status: r.status,
      body: r.body ?? undefined, syncedAt: r.synced_at ?? undefined }));
}

export async function syncMetaTemplates(tenantId: string, channelId: string): Promise<{ synced: number; errors: string[] }> {
  const ch = getChannel(tenantId, channelId);
  if (!ch || ch.type !== 'meta') return { synced: 0, errors: ['channel_not_meta'] };
  const { decryptJson } = await import('.././crypto.js');
  const creds = decryptJson<any>(ch.credentialsEncrypted);
  const apiVersion = creds.apiVersion || 'v22.0';
  const url = `https://graph.facebook.com/${apiVersion}/${creds.businessAccountId}/message_templates?limit=50&fields=name,status,language,category,components`;
  const res = await fetch(url, { headers: { 'Authorization': 'Bearer ' + creds.accessToken } });
  if (!res.ok) return { synced: 0, errors: [`meta_http_${res.status}`] };
  const data: any = await res.json();
  let synced = 0;
  for (const t of (data.data || [])) {
    const body = (t.components || []).find((c: any) => c.type === 'BODY')?.text;
    upsertChannelTemplate(tenantId, {
      channelId, templateName: t.name, languageCode: t.language,
      category: t.category, status: t.status?.toLowerCase() === 'approved' ? 'approved' : t.status?.toLowerCase() === 'rejected' ? 'rejected' : 'pending',
      body,
    });
    synced++;
  }
  return { synced, errors: [] };
}
