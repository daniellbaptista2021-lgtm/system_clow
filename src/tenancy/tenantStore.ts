/**
 * tenantStore.ts — Tenant persistence (JSON file for v1, Supabase later)
 *
 * Stores tenants + API keys in ~/.clow/tenants.json
 * All operations are atomic via read-modify-write with JSON.
 * Migrate to Supabase when >50 tenants.
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { TIERS, type TierName, type TierConfig } from './tiers.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface Tenant {
  id: string;
  email: string;
  name: string;
  tier: TierName;
  status: 'active' | 'suspended' | 'cancelled' | 'trial' | 'over_quota_disk';
  created_at: string;
  trial_ends_at?: string;

  // Quotas (copied from tier on creation, can be overridden)
  max_messages_per_month: number;
  max_cost_usd_per_month: number;
  max_concurrent_sessions: number;
  max_workspace_size_mb: number;

  // Tracking
  current_month_messages: number;
  current_month_cost_usd: number;
  current_month_started_at: string;

  // Billing
  external_customer_id?: string;
  last_payment_at?: string;
  next_billing_at?: string;

  // Stripe (Onda 53)
  stripe_customer_id?: string;
  stripe_subscription_id?: string;
  password_hash?: string;
  full_name?: string;
  cpf?: string;
  phone_e164?: string;
  authorized_phones?: string[];
  temp_password_for_email?: string;
  cancelled_at?: string;
}

export interface ApiKey {
  id: string;
  tenant_id: string;
  key_hash: string;
  name: string;
  last_used_at?: string;
  created_at: string;
  revoked_at?: string;
}

interface TenantWhatsAppNumber {
  tenant_id: string;
  phone_number: string;
  zapi_instance_id: string;
  zapi_token: string;
}

interface StoreData {
  tenants: Tenant[];
  api_keys: ApiKey[];
  whatsapp_numbers: TenantWhatsAppNumber[];
}

// ─── File Path ──────────────────────────────────────────────────────────────

const STORE_PATH = path.join(os.homedir(), '.clow', 'tenants.json');

// ─── Read / Write Operations ────────────────────────────────────────────────

function readStore(): StoreData {
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { tenants: [], api_keys: [], whatsapp_numbers: [] };
  }
}

function writeStore(data: StoreData): void {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2), { mode: 0o600 });
}

// ─── API Key Helpers ────────────────────────────────────────────────────────

export function generateApiKey(env: 'live' | 'test' = 'live'): string {
  const random = crypto.randomBytes(24).toString('base64url');
  return `clow_${env}_${random}`;
}

export function hashApiKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

// ─── Tenant CRUD ────────────────────────────────────────────────────────────

export function createTenant(opts: {
  email: string;
  name: string;
  tier: TierName;
  trial_days?: number;
}): { tenant: Tenant; apiKey: string } {
  const store = readStore();

  // Check duplicate email
  if (store.tenants.some((t) => t.email === opts.email)) {
    throw new Error(`Tenant with email ${opts.email} already exists`);
  }

  const tierConfig = TIERS[opts.tier];
  const now = new Date().toISOString();

  const tenant: Tenant = {
    id: crypto.randomUUID(),
    email: opts.email,
    name: opts.name,
    tier: opts.tier,
    status: opts.trial_days ? 'trial' : 'active',
    created_at: now,
    trial_ends_at: opts.trial_days
      ? new Date(Date.now() + opts.trial_days * 86400_000).toISOString()
      : undefined,
    max_messages_per_month: tierConfig.max_messages_per_month,
    max_cost_usd_per_month: tierConfig.max_cost_usd_per_month,
    max_concurrent_sessions: tierConfig.max_concurrent_sessions,
    max_workspace_size_mb: tierConfig.max_workspace_size_mb,
    current_month_messages: 0,
    current_month_cost_usd: 0,
    current_month_started_at: now,
  };

  // Generate API key
  const rawKey = generateApiKey('live');
  const apiKey: ApiKey = {
    id: crypto.randomUUID(),
    tenant_id: tenant.id,
    key_hash: hashApiKey(rawKey),
    name: 'default',
    created_at: now,
  };

  store.tenants.push(tenant);
  store.api_keys.push(apiKey);
  writeStore(store);

  return { tenant, apiKey: rawKey };
}

export function getTenant(id: string): Tenant | null {
  const store = readStore();
  return store.tenants.find((t) => t.id === id) || null;
}

export function findTenantByEmail(email: string): Tenant | null {
  const store = readStore();
  return store.tenants.find((t) => t.email === email) || null;
}

export function findTenantByApiKeyHash(keyHash: string): Tenant | null {
  const store = readStore();
  const key = store.api_keys.find(
    (k) => k.key_hash === keyHash && !k.revoked_at,
  );
  if (!key) return null;
  return store.tenants.find((t) => t.id === key.tenant_id) || null;
}

export function updateTenant(id: string, updates: Partial<Tenant>): Tenant | null {
  const store = readStore();
  const idx = store.tenants.findIndex((t) => t.id === id);
  if (idx === -1) return null;
  store.tenants[idx] = { ...store.tenants[idx], ...updates };
  writeStore(store);
  return store.tenants[idx];
}

export function listTenants(): Tenant[] {
  return readStore().tenants;
}

// ─── API Key Management ─────────────────────────────────────────────────────

export function createApiKeyForTenant(tenantId: string, name: string): string {
  const store = readStore();
  if (!store.tenants.some((t) => t.id === tenantId)) {
    throw new Error('Tenant not found');
  }

  const rawKey = generateApiKey('live');
  const apiKey: ApiKey = {
    id: crypto.randomUUID(),
    tenant_id: tenantId,
    key_hash: hashApiKey(rawKey),
    name,
    created_at: new Date().toISOString(),
  };

  store.api_keys.push(apiKey);
  writeStore(store);
  return rawKey;
}

export function revokeApiKey(keyId: string): boolean {
  const store = readStore();
  const key = store.api_keys.find((k) => k.id === keyId);
  if (!key) return false;
  key.revoked_at = new Date().toISOString();
  writeStore(store);
  return true;
}

export function revokeOldCrmShellKeys(tenantId: string): number {
  const store = readStore();
  let count = 0;
  const now = new Date().toISOString();
  for (const k of store.api_keys) {
    if (k.tenant_id === tenantId && !k.revoked_at && k.name && k.name.startsWith('crm-shell-')) {
      k.revoked_at = now;
      count++;
    }
  }
  if (count > 0) writeStore(store);
  return count;
}

export function listApiKeysForTenant(tenantId: string): ApiKey[] {
  const store = readStore();
  return store.api_keys.filter((k) => k.tenant_id === tenantId && !k.revoked_at);
}

export function touchApiKey(keyHash: string): void {
  const store = readStore();
  const key = store.api_keys.find((k) => k.key_hash === keyHash);
  if (key) {
    key.last_used_at = new Date().toISOString();
    writeStore(store);
  }
}

// ─── Usage Tracking ─────────────────────────────────────────────────────────

export function incrementUsage(tenantId: string, usage: {
  messages?: number;
  cost_usd?: number;
}): void {
  const store = readStore();
  const tenant = store.tenants.find((t) => t.id === tenantId);
  if (!tenant) return;

  if (usage.messages) tenant.current_month_messages += usage.messages;
  if (usage.cost_usd) tenant.current_month_cost_usd += usage.cost_usd;

  writeStore(store);
}

export function resetMonthlyUsage(tenantId: string): void {
  updateTenant(tenantId, {
    current_month_messages: 0,
    current_month_cost_usd: 0,
    current_month_started_at: new Date().toISOString(),
  });
}

// ─── WhatsApp Numbers ───────────────────────────────────────────────────────

export function findTenantByWhatsAppInstance(instanceId: string): Tenant | null {
  const store = readStore();
  const entry = store.whatsapp_numbers.find((w) => w.zapi_instance_id === instanceId);
  if (!entry) return null;
  return store.tenants.find((t) => t.id === entry.tenant_id) || null;
}

export function addWhatsAppNumber(
  tenantId: string,
  phoneNumber: string,
  instanceId: string,
  token: string,
): void {
  const store = readStore();
  store.whatsapp_numbers.push({
    tenant_id: tenantId,
    phone_number: phoneNumber,
    zapi_instance_id: instanceId,
    zapi_token: token,
  });
  writeStore(store);
}

// ─── Billing Helpers ────────────────────────────────────────────────────────

export function findTenantByExternalCustomerId(customerId: string): Tenant | null {
  const store = readStore();
  return store.tenants.find((t) => t.external_customer_id === customerId) || null;
}

export function findOverdueTenants(graceDays: number = 7): Tenant[] {
  const store = readStore();
  const cutoff = new Date(Date.now() - graceDays * 86400_000).toISOString();
  return store.tenants.filter(
    (t) => t.status === 'active' && t.next_billing_at && t.next_billing_at < cutoff,
  );
}

// ─── Concurrent Session Counting ────────────────────────────────────────────

// This is called by sessionPool — tracks active sessions per tenant externally
const activeSessions = new Map<string, Set<string>>();

export function registerSession(tenantId: string, sessionId: string): void {
  if (!activeSessions.has(tenantId)) activeSessions.set(tenantId, new Set());
  activeSessions.get(tenantId)!.add(sessionId);
}

export function unregisterSession(tenantId: string, sessionId: string): void {
  activeSessions.get(tenantId)?.delete(sessionId);
}

export function countActiveSessions(tenantId: string): number {
  return activeSessions.get(tenantId)?.size || 0;
}
