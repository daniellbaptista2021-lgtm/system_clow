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
// Resolved on every read/write so tests can flip CLOW_HOME between cases
// without re-importing the module.

function storePath(): string {
  const home = process.env.CLOW_HOME || path.join(os.homedir(), '.clow');
  return path.join(home, 'tenants.json');
}

// ─── Read / Write Operations ────────────────────────────────────────────────
// In PM2 cluster mode multiple workers can mutate tenants.json
// concurrently. Two workers reading current_month_messages=499 and both
// writing 500 = quota under-counted by 1 → effective rate = 2× plan.
// `mutateStore(fn)` solves this by holding an exclusive file lock for
// the read-modify-write window. Pure read paths (`readStore()` callers
// like getTenant, listTenants) don't need the lock — better-sqlite3-
// style concurrent readers are fine on a JSON file.
//
// proper-lockfile is already a dependency. We use the sync API so the
// rest of the module stays sync (most call sites are deep inside CRUD
// helpers that aren't async). The lock files (.lock subdir created by
// proper-lockfile) live next to tenants.json.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const lockfile: typeof import('proper-lockfile') = require('proper-lockfile');

function readStore(): StoreData {
  try {
    const raw = fs.readFileSync(storePath(), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { tenants: [], api_keys: [], whatsapp_numbers: [] };
  }
}

function writeStoreUnsafe(data: StoreData): void {
  const p = storePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2), { mode: 0o600 });
}

/**
 * Atomically read-modify-write the tenant store under an exclusive
 * file lock. The mutator receives a fresh snapshot and may modify it
 * in place; we re-serialize and write under lock when it returns.
 *
 * Returns whatever the mutator returns, so call sites can produce a
 * derived value (the new tenant, the updated api key, etc.) in one go.
 *
 * `stale: 8000` means an abandoned lock (process killed mid-write) is
 * cleaned up after 8 seconds. `retries.retries: 8 / minTimeout: 30`
 * gives ~1s of total wait for normal contention, which is plenty for
 * a 2-worker cluster's quota-increment latency.
 */
function mutateStore<T>(mutator: (store: StoreData) => T): T {
  // proper-lockfile requires the target file to exist for lockSync.
  // Ensure storePath() exists (touch an empty store if needed).
  const p = storePath();
  if (!fs.existsSync(p)) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    writeStoreUnsafe({ tenants: [], api_keys: [], whatsapp_numbers: [] });
  }
  // proper-lockfile's sync API does NOT accept the `retries` option (it's
  // async-only), so we implement a tiny retry loop ourselves. Under cluster
  // contention the typical wait is <100ms; the busy-spin between attempts
  // is bounded and acceptable for a hot path that gates on a file lock.
  const release = acquireLockWithRetry(p);
  try {
    const store = readStore();
    const result = mutator(store);
    writeStoreUnsafe(store);
    return result;
  } finally {
    release();
  }
}

function acquireLockWithRetry(filepath: string, attempts = 10): () => void {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return lockfile.lockSync(filepath, { stale: 8000 });
    } catch (err) {
      lastErr = err;
      // Spin-wait briefly; backoff grows linearly. Most contention
      // resolves on attempt 1 or 2 (single-cluster, short writes).
      const waitMs = 20 + i * 25;
      const deadline = Date.now() + waitMs;
      // eslint-disable-next-line no-empty
      while (Date.now() < deadline) {}
    }
  }
  throw lastErr;
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
  return mutateStore((store) => {
    // Check duplicate email — must run inside the lock so two workers
    // can't both pass the check before either has written.
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
    return { tenant, apiKey: rawKey };
  });
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
  return mutateStore((store) => {
    const idx = store.tenants.findIndex((t) => t.id === id);
    if (idx === -1) return null;
    store.tenants[idx] = { ...store.tenants[idx], ...updates } as Tenant;
    return store.tenants[idx];
  });
}

export function listTenants(): Tenant[] {
  return readStore().tenants;
}

/**
 * Atomically read-modify-write a single tenant under the same exclusive
 * lock as updateTenant. The mutator callback receives the LIVE tenant
 * object (not a copy) and can return a value passed back to the caller.
 *
 * Use this for check-then-write hot paths where read and write must see
 * the same version of the row — e.g. quota counter increment with a
 * limit-check guard. A naive `getTenant() → check → updateTenant()`
 * sequence is racey under cluster mode because two workers can both
 * pass the check before either writes.
 */
export function mutateTenant<T>(
  tenantId: string,
  mutator: (tenant: Tenant) => T,
): T | null {
  return mutateStore((store) => {
    const tenant = store.tenants.find((t) => t.id === tenantId);
    if (!tenant) return null;
    return mutator(tenant);
  });
}

// ─── API Key Management ─────────────────────────────────────────────────────

export function createApiKeyForTenant(tenantId: string, name: string): string {
  return mutateStore((store) => {
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
    return rawKey;
  });
}

export function revokeApiKey(keyId: string): boolean {
  return mutateStore((store) => {
    const key = store.api_keys.find((k) => k.id === keyId);
    if (!key) return false;
    key.revoked_at = new Date().toISOString();
    return true;
  });
}

export function revokeOldCrmShellKeys(tenantId: string): number {
  return mutateStore((store) => {
    let count = 0;
    const now = new Date().toISOString();
    for (const k of store.api_keys) {
      if (k.tenant_id === tenantId && !k.revoked_at && k.name && k.name.startsWith('crm-shell-')) {
        k.revoked_at = now;
        count++;
      }
    }
    return count;
  });
}

export function listApiKeysForTenant(tenantId: string): ApiKey[] {
  const store = readStore();
  return store.api_keys.filter((k) => k.tenant_id === tenantId && !k.revoked_at);
}

export function touchApiKey(keyHash: string): void {
  mutateStore((store) => {
    const key = store.api_keys.find((k) => k.key_hash === keyHash);
    if (key) key.last_used_at = new Date().toISOString();
  });
}

// ─── Usage Tracking ─────────────────────────────────────────────────────────

export function incrementUsage(tenantId: string, usage: {
  messages?: number;
  cost_usd?: number;
}): void {
  // The hot path: this is what gets hit on every AI message. Must be
  // atomic across cluster workers — without the lock, two concurrent
  // increments collapse into one and the quota under-counts.
  mutateStore((store) => {
    const tenant = store.tenants.find((t) => t.id === tenantId);
    if (!tenant) return;
    if (usage.messages) tenant.current_month_messages += usage.messages;
    if (usage.cost_usd) tenant.current_month_cost_usd += usage.cost_usd;
  });
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
  mutateStore((store) => {
    store.whatsapp_numbers.push({
      tenant_id: tenantId,
      phone_number: phoneNumber,
      zapi_instance_id: instanceId,
      zapi_token: token,
    });
  });
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
// Cluster-shared via clusterStore — without it, each PM2 worker tracks
// its own session set, the count is wrong, and a tenant can spawn N×
// max_concurrent_sessions across the cluster. With Redis configured the
// SADD/SREM/SCARD round-trips give the cluster-wide truth; without
// Redis it falls back to a single-process Map (current single-worker
// behavior preserved).

import { getCluster } from '../utils/clusterStore.js';

function sessionsKey(tenantId: string): string {
  return `tenant:active-sessions:${tenantId}`;
}

export async function registerSession(tenantId: string, sessionId: string): Promise<void> {
  const store = await getCluster();
  await store.sAdd(sessionsKey(tenantId), sessionId);
}

export async function unregisterSession(tenantId: string, sessionId: string): Promise<void> {
  const store = await getCluster();
  await store.sRem(sessionsKey(tenantId), sessionId);
}

export async function countActiveSessions(tenantId: string): Promise<number> {
  const store = await getCluster();
  return store.sCard(sessionsKey(tenantId));
}
