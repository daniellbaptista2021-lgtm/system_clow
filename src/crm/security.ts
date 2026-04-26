/**
 * Security layer — Onda 31.
 *
 * 5 subsystems:
 *   1. RBAC — roles catalog + agent assignments + permission check
 *   2. 2FA — TOTP (RFC 6238) com 6-digit codes + backup codes
 *   3. Sessions — token-based session tracking with revoke
 *   4. IP whitelist — optional CIDR-based access control per tenant
 *   5. Audit log — generic append-only record of all sensitive actions
 */

import { randomBytes, createHmac, createHash } from 'crypto';
import { getCrmDb } from './schema.js';

function nid(prefix: string): string { return prefix + '_' + randomBytes(6).toString('hex'); }
const now = () => Date.now();

// ═══ RBAC ═════════════════════════════════════════════════════════════
export type Permission =
  | 'contacts.read' | 'contacts.write' | 'contacts.delete'
  | 'cards.read' | 'cards.write' | 'cards.delete' | 'cards.move'
  | 'activities.read' | 'activities.write'
  | 'proposals.read' | 'proposals.write' | 'proposals.sign_admin'
  | 'documents.read' | 'documents.write' | 'documents.sign_admin'
  | 'campaigns.read' | 'campaigns.write' | 'campaigns.send'
  | 'reports.read' | 'reports.export'
  | 'settings.read' | 'settings.write'
  | 'agents.read' | 'agents.write'
  | 'billing.read' | 'billing.write'
  | 'admin.full'   // superuser
  ;

export interface Role {
  id: string;
  tenantId: string;
  name: string;
  description?: string;
  permissions: Permission[];
  isAdmin: boolean;
  createdAt: number;
}

function rowToRole(r: any): Role {
  return {
    id: r.id, tenantId: r.tenant_id, name: r.name,
    description: r.description ?? undefined,
    permissions: JSON.parse(r.permissions_json || '[]'),
    isAdmin: r.is_admin === 1, createdAt: r.created_at,
  };
}

export function createRole(tenantId: string, input: {
  name: string; description?: string; permissions: Permission[]; isAdmin?: boolean;
}): Role {
  const id = nid('crm_role');
  getCrmDb().prepare(`
    INSERT INTO crm_agent_roles (id, tenant_id, name, description, permissions_json, is_admin, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, tenantId, input.name, input.description ?? null,
    JSON.stringify(input.permissions), input.isAdmin ? 1 : 0, now());
  return getRole(tenantId, id)!;
}

export function getRole(tenantId: string, id: string): Role | null {
  const r = getCrmDb().prepare('SELECT * FROM crm_agent_roles WHERE id = ? AND tenant_id = ?').get(id, tenantId) as any;
  return r ? rowToRole(r) : null;
}

export function listRoles(tenantId: string): Role[] {
  return (getCrmDb().prepare('SELECT * FROM crm_agent_roles WHERE tenant_id = ? ORDER BY is_admin DESC, name').all(tenantId) as any[])
    .map(rowToRole);
}

export function deleteRole(tenantId: string, id: string): boolean {
  return getCrmDb().prepare('DELETE FROM crm_agent_roles WHERE id = ? AND tenant_id = ?').run(id, tenantId).changes > 0;
}

export function assignRoleToAgent(tenantId: string, agentId: string, roleId: string): boolean {
  const role = getRole(tenantId, roleId);
  if (!role) return false;
  getCrmDb().prepare(`
    INSERT INTO crm_agent_role_assignments (id, tenant_id, agent_id, role_id, assigned_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(agent_id, role_id) DO NOTHING
  `).run(nid('crm_asgn'), tenantId, agentId, roleId, now());
  return true;
}

export function revokeRoleFromAgent(tenantId: string, agentId: string, roleId: string): boolean {
  return getCrmDb().prepare(
    'DELETE FROM crm_agent_role_assignments WHERE tenant_id = ? AND agent_id = ? AND role_id = ?'
  ).run(tenantId, agentId, roleId).changes > 0;
}

export function agentRoles(tenantId: string, agentId: string): Role[] {
  return (getCrmDb().prepare(`
    SELECT r.* FROM crm_agent_roles r
    JOIN crm_agent_role_assignments a ON a.role_id = r.id
    WHERE r.tenant_id = ? AND a.agent_id = ?
  `).all(tenantId, agentId) as any[]).map(rowToRole);
}

export function agentPermissions(tenantId: string, agentId: string): Set<Permission> {
  const roles = agentRoles(tenantId, agentId);
  const perms = new Set<Permission>();
  for (const r of roles) {
    if (r.isAdmin || r.permissions.includes('admin.full' as any)) {
      return new Set(['admin.full'] as Permission[]);
    }
    for (const p of r.permissions) perms.add(p);
  }
  return perms;
}

export function hasPermission(tenantId: string, agentId: string, perm: Permission): boolean {
  const perms = agentPermissions(tenantId, agentId);
  return perms.has('admin.full') || perms.has(perm);
}

/** Seed built-in roles (owner, admin, agent, viewer). Idempotent. */
export function seedDefaultRoles(tenantId: string): void {
  const db = getCrmDb();
  const count = (db.prepare('SELECT COUNT(*) n FROM crm_agent_roles WHERE tenant_id = ?').get(tenantId) as any).n;
  if (count > 0) return;
  createRole(tenantId, { name: 'owner', description: 'Acesso total', permissions: ['admin.full'], isAdmin: true });
  createRole(tenantId, { name: 'admin', description: 'Admin operacional', permissions: [
    'contacts.read', 'contacts.write', 'contacts.delete',
    'cards.read', 'cards.write', 'cards.delete', 'cards.move',
    'activities.read', 'activities.write',
    'proposals.read', 'proposals.write', 'proposals.sign_admin',
    'documents.read', 'documents.write', 'documents.sign_admin',
    'campaigns.read', 'campaigns.write', 'campaigns.send',
    'reports.read', 'reports.export',
    'settings.read', 'settings.write',
    'agents.read', 'agents.write',
  ] });
  createRole(tenantId, { name: 'agent', description: 'Vendedor padrao', permissions: [
    'contacts.read', 'contacts.write',
    'cards.read', 'cards.write', 'cards.move',
    'activities.read', 'activities.write',
    'proposals.read', 'proposals.write',
    'documents.read', 'documents.write',
    'reports.read',
  ] });
  createRole(tenantId, { name: 'viewer', description: 'Leitura apenas', permissions: [
    'contacts.read', 'cards.read', 'activities.read',
    'proposals.read', 'documents.read', 'reports.read',
  ] });
}

// ═══ 2FA (TOTP RFC 6238) ══════════════════════════════════════════════
const BASE32_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) {
      out += BASE32_CHARS[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_CHARS[(value << (5 - bits)) & 0x1f];
  return out;
}

function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/=+$/, '').replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | BASE32_CHARS.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

/** Generate a TOTP secret (160 bits) + recovery URL for apps like Google Authenticator. */
export function setup2FA(tenantId: string, agentId: string, issuer = 'SystemClow'): { secret: string; otpauthUrl: string; backupCodes: string[] } {
  const secretBuf = randomBytes(20);
  const secret = base32Encode(secretBuf);
  const backupCodes = Array.from({ length: 8 }, () => randomBytes(4).toString('hex'));

  // Fetch agent email for labeling (fallback to agentId)
  const agent = getCrmDb().prepare('SELECT email, name FROM crm_agents WHERE id = ? AND tenant_id = ?').get(agentId, tenantId) as any;
  const label = encodeURIComponent(`${issuer}:${agent?.email || agentId}`);
  const otpauthUrl = `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&digits=6&period=30`;

  // Store pending (enabled=0 until verified)
  getCrmDb().prepare(`
    INSERT INTO crm_2fa (agent_id, tenant_id, secret_b32, enabled, backup_codes_json, created_at)
    VALUES (?, ?, ?, 0, ?, ?)
    ON CONFLICT(agent_id) DO UPDATE SET secret_b32 = excluded.secret_b32, enabled = 0, backup_codes_json = excluded.backup_codes_json
  `).run(agentId, tenantId, secret, JSON.stringify(backupCodes.map(c => createHash('sha256').update(c).digest('hex'))), now());
  return { secret, otpauthUrl, backupCodes };
}

/** Verify a 6-digit TOTP code and enable 2FA for agent. */
export function verify2FA(tenantId: string, agentId: string, code: string): { ok: boolean; error?: string } {
  const db = getCrmDb();
  const row = db.prepare('SELECT * FROM crm_2fa WHERE agent_id = ? AND tenant_id = ?').get(agentId, tenantId) as any;
  if (!row) return { ok: false, error: 'not_setup' };

  // Accept backup code (8-char hex)
  if (/^[a-f0-9]{8}$/i.test(code.replace(/\s/g, ''))) {
    const hash = createHash('sha256').update(code.toLowerCase()).digest('hex');
    const codes = JSON.parse(row.backup_codes_json || '[]') as string[];
    const idx = codes.indexOf(hash);
    if (idx !== -1) {
      codes.splice(idx, 1);
      db.prepare('UPDATE crm_2fa SET backup_codes_json = ?, enabled = 1, enabled_at = COALESCE(enabled_at, ?), last_used_at = ? WHERE agent_id = ?')
        .run(JSON.stringify(codes), now(), now(), agentId);
      return { ok: true };
    }
    return { ok: false, error: 'invalid_backup_code' };
  }

  const cleaned = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(cleaned)) return { ok: false, error: 'invalid_format' };

  // Accept current ±1 window (90s total)
  const nowStep = Math.floor(Date.now() / 30_000);
  const expected = [-1, 0, 1].map(drift => computeTOTP(row.secret_b32, nowStep + drift));
  if (!expected.includes(cleaned)) return { ok: false, error: 'invalid_code' };

  db.prepare('UPDATE crm_2fa SET enabled = 1, enabled_at = COALESCE(enabled_at, ?), last_used_at = ? WHERE agent_id = ?')
    .run(now(), now(), agentId);
  return { ok: true };
}

export function is2FAEnabled(agentId: string): boolean {
  const r = getCrmDb().prepare('SELECT enabled FROM crm_2fa WHERE agent_id = ?').get(agentId) as any;
  return r?.enabled === 1;
}

export function disable2FA(tenantId: string, agentId: string): boolean {
  return getCrmDb().prepare('DELETE FROM crm_2fa WHERE agent_id = ? AND tenant_id = ?').run(agentId, tenantId).changes > 0;
}

function computeTOTP(secretB32: string, step: number): string {
  const key = base32Decode(secretB32);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step), 0);
  const hmac = createHmac('sha1', key).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const truncated = ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  return String(truncated % 1000000).padStart(6, '0');
}

// ═══ Sessions ═════════════════════════════════════════════════════════
export interface Session {
  id: string;
  agentId: string;
  ip?: string;
  ua?: string;
  deviceFingerprint?: string;
  createdAt: number;
  lastActiveAt: number;
  expiresAt: number;
  revokedAt?: number;
}

function rowToSession(r: any): Session {
  return {
    id: r.id, agentId: r.agent_id,
    ip: r.ip ?? undefined, ua: r.ua ?? undefined,
    deviceFingerprint: r.device_fingerprint ?? undefined,
    createdAt: r.created_at, lastActiveAt: r.last_active_at, expiresAt: r.expires_at,
    revokedAt: r.revoked_at ?? undefined,
  };
}

export function createSession(agentId: string, opts: { ttlHours?: number; ip?: string; ua?: string; deviceFingerprint?: string } = {}): { session: Session; token: string } {
  const ttl = (opts.ttlHours ?? 720) * 3600_000; // default 30 dias
  const id = nid('crm_sess');
  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const t = now();
  getCrmDb().prepare(`
    INSERT INTO crm_sessions (id, agent_id, token_hash, ip, ua, device_fingerprint, created_at, last_active_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, agentId, tokenHash, opts.ip ?? null, opts.ua ?? null,
    opts.deviceFingerprint ?? null, t, t, t + ttl);
  return { session: getSessionById(id)!, token };
}

function getSessionById(id: string): Session | null {
  const r = getCrmDb().prepare('SELECT * FROM crm_sessions WHERE id = ?').get(id) as any;
  return r ? rowToSession(r) : null;
}

export function getSessionByToken(token: string): Session | null {
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const r = getCrmDb().prepare(
    'SELECT * FROM crm_sessions WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?'
  ).get(tokenHash, now()) as any;
  if (!r) return null;
  // Touch last_active_at
  getCrmDb().prepare('UPDATE crm_sessions SET last_active_at = ? WHERE id = ?').run(now(), r.id);
  return rowToSession(r);
}

export function listAgentSessions(agentId: string, activeOnly = true): Session[] {
  const wh = ['agent_id = ?'];
  const params: any[] = [agentId];
  if (activeOnly) { wh.push('revoked_at IS NULL AND expires_at > ?'); params.push(now()); }
  return (getCrmDb().prepare(
    `SELECT * FROM crm_sessions WHERE ${wh.join(' AND ')} ORDER BY last_active_at DESC`
  ).all(...params) as any[]).map(rowToSession);
}

export function revokeSession(id: string): boolean {
  return getCrmDb().prepare('UPDATE crm_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
    .run(now(), id).changes > 0;
}

export function revokeAllAgentSessions(agentId: string, exceptSessionId?: string): number {
  if (exceptSessionId) {
    return getCrmDb().prepare(
      'UPDATE crm_sessions SET revoked_at = ? WHERE agent_id = ? AND revoked_at IS NULL AND id != ?'
    ).run(now(), agentId, exceptSessionId).changes;
  }
  return getCrmDb().prepare(
    'UPDATE crm_sessions SET revoked_at = ? WHERE agent_id = ? AND revoked_at IS NULL'
  ).run(now(), agentId).changes;
}

// ═══ IP whitelist ═════════════════════════════════════════════════════
export function addIpToWhitelist(tenantId: string, cidr: string, label?: string): string {
  const id = nid('crm_ipwl');
  getCrmDb().prepare(`
    INSERT INTO crm_ip_whitelist (id, tenant_id, cidr, label, enabled, created_at)
    VALUES (?, ?, ?, ?, 1, ?)
  `).run(id, tenantId, cidr, label ?? null, now());
  return id;
}

export function removeFromWhitelist(tenantId: string, id: string): boolean {
  return getCrmDb().prepare('DELETE FROM crm_ip_whitelist WHERE id = ? AND tenant_id = ?').run(id, tenantId).changes > 0;
}

export function listWhitelist(tenantId: string): any[] {
  return getCrmDb().prepare('SELECT * FROM crm_ip_whitelist WHERE tenant_id = ? ORDER BY created_at').all(tenantId) as any[];
}

export function isIpAllowed(tenantId: string, ip: string): boolean {
  const entries = getCrmDb().prepare(
    'SELECT cidr FROM crm_ip_whitelist WHERE tenant_id = ? AND enabled = 1'
  ).all(tenantId) as any[];
  if (entries.length === 0) return true; // No whitelist = allow all
  for (const e of entries) {
    if (ipMatchesCidr(ip, e.cidr)) return true;
  }
  return false;
}

function ipMatchesCidr(ip: string, cidr: string): boolean {
  if (ip === cidr || cidr === '*') return true;
  if (!cidr.includes('/')) return ip === cidr;
  const [net, bitsStr] = cidr.split('/');
  const bits = parseInt(bitsStr, 10);
  if (isNaN(bits)) return false;
  const ipLong = ipv4ToLong(ip);
  const netLong = ipv4ToLong(net);
  if (ipLong === null || netLong === null) return false;
  const mask = bits === 0 ? 0 : ((-1 << (32 - bits)) >>> 0);
  return (ipLong & mask) === (netLong & mask);
}

function ipv4ToLong(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let out = 0;
  for (const p of parts) {
    const n = parseInt(p, 10);
    if (isNaN(n) || n < 0 || n > 255) return null;
    out = (out << 8) | n;
  }
  return out >>> 0;
}

// ═══ Audit log (generic) ══════════════════════════════════════════════
export interface AuditEntry {
  tenantId: string;
  actorAgentId?: string;
  action: string;          // e.g. 'card.created', 'proposal.signed', 'role.assigned'
  entity: string;          // e.g. 'card', 'proposal', 'agent_role'
  entityId?: string;
  before?: Record<string, any>;
  after?: Record<string, any>;
  ip?: string;
  ua?: string;
}

export function audit(entry: AuditEntry): void {
  const db = getCrmDb();
  db.prepare(`
    INSERT INTO crm_audit_log
      (id, tenant_id, actor_agent_id, action, entity, entity_id, before_json, after_json, ip, ua, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(nid('crm_audit'), entry.tenantId, entry.actorAgentId ?? null,
    entry.action, entry.entity, entry.entityId ?? null,
    entry.before ? JSON.stringify(entry.before) : null,
    entry.after ? JSON.stringify(entry.after) : null,
    entry.ip ?? null, entry.ua ?? null, now());
}

export function queryAudit(tenantId: string, opts: {
  actorAgentId?: string; action?: string; entity?: string; entityId?: string;
  from?: number; to?: number; limit?: number;
} = {}): any[] {
  const wh: string[] = ['tenant_id = ?'];
  const params: any[] = [tenantId];
  if (opts.actorAgentId) { wh.push('actor_agent_id = ?'); params.push(opts.actorAgentId); }
  if (opts.action)       { wh.push('action LIKE ?');      params.push('%' + opts.action + '%'); }
  if (opts.entity)       { wh.push('entity = ?');         params.push(opts.entity); }
  if (opts.entityId)     { wh.push('entity_id = ?');      params.push(opts.entityId); }
  if (opts.from != null) { wh.push('created_at >= ?');    params.push(opts.from); }
  if (opts.to != null)   { wh.push('created_at <= ?');    params.push(opts.to); }
  const limit = Math.min(1000, opts.limit || 200);
  return getCrmDb().prepare(
    `SELECT * FROM crm_audit_log WHERE ${wh.join(' AND ')} ORDER BY created_at DESC LIMIT ?`
  ).all(...params, limit) as any[];
}
