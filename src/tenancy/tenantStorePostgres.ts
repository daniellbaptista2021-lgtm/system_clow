/**
 * tenantStorePostgres.ts — PostgreSQL adapter for tenant storage
 *
 * Drop-in replacement for tenantStore.ts (JSON file).
 * Activated via CLOW_DB_URL environment variable.
 * If not set, falls back to JSON file storage.
 *
 * Schema auto-migrates on first connection.
 * Compatible with Supabase, Neon, or any PostgreSQL 14+.
 */

import { createHash, randomBytes } from 'crypto';
import type { TierName } from './tiers.js';
import { getTierConfig } from './tiers.js';

// ════════════════════════════════════════════════════════════════════════════
// Types (same as tenantStore.ts)
// ════════════════════════════════════════════════════════════════════════════

export interface PgTenant {
  id: string;
  email: string;
  name: string;
  tier: TierName;
  status: 'active' | 'suspended' | 'cancelled' | 'trial' | 'over_quota_disk';
  created_at: string;
  trial_ends_at?: string;
  max_messages_per_month: number;
  max_cost_usd_per_month: number;
  max_concurrent_sessions: number;
  max_workspace_size_mb: number;
  current_month_messages: number;
  current_month_cost_usd: number;
  current_month_started_at: string;
  external_customer_id?: string;
  last_payment_at?: string;
  next_billing_at?: string;
  has_system_clow?: boolean;
}

// ════════════════════════════════════════════════════════════════════════════
// Schema Migration
// ════════════════════════════════════════════════════════════════════════════

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  tier TEXT NOT NULL DEFAULT 'one',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  trial_ends_at TIMESTAMPTZ,
  max_messages_per_month INTEGER NOT NULL DEFAULT 1500,
  max_cost_usd_per_month NUMERIC(10,2) NOT NULL DEFAULT 5,
  max_concurrent_sessions INTEGER NOT NULL DEFAULT 3,
  max_workspace_size_mb INTEGER NOT NULL DEFAULT 200,
  current_month_messages INTEGER NOT NULL DEFAULT 0,
  current_month_cost_usd NUMERIC(10,4) NOT NULL DEFAULT 0,
  current_month_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  external_customer_id TEXT,
  last_payment_at TIMESTAMPTZ,
  next_billing_at TIMESTAMPTZ,
  has_system_clow BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key_hash TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT 'default',
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_api_keys_tenant ON api_keys(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenants_email ON tenants(email);
CREATE INDEX IF NOT EXISTS idx_tenants_status ON tenants(status);
CREATE INDEX IF NOT EXISTS idx_tenants_external ON tenants(external_customer_id);
`;

// ════════════════════════════════════════════════════════════════════════════
// PostgreSQL Store Class
// ════════════════════════════════════════════════════════════════════════════

export class TenantStorePostgres {
  private pool: any = null;
  private initialized = false;

  constructor(private readonly connectionString: string) {}

  async init(): Promise<void> {
    if (this.initialized) return;
    try {
      // Dynamic import — pg is optional dependency
      const { default: pg } = await import('pg');
      this.pool = new pg.Pool({
        connectionString: this.connectionString,
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
        ssl: this.connectionString.includes('sslmode=require') ? { rejectUnauthorized: false } : undefined,
      });

      // Run schema migration
      await this.pool.query(SCHEMA_SQL);
      this.initialized = true;
      console.log('[TenantStore] PostgreSQL connected and schema migrated');
    } catch (err) {
      console.error('[TenantStore] PostgreSQL connection failed:', (err as Error).message);
      throw err;
    }
  }

  private async query(sql: string, params: any[] = []): Promise<any> {
    if (!this.pool) throw new Error('PostgreSQL not initialized');
    const result = await this.pool.query(sql, params);
    return result.rows;
  }

  // ─── Tenant CRUD ───────────────────────────────────────────────

  async createTenant(opts: { email: string; name: string; tier?: TierName }): Promise<{ tenant: PgTenant; apiKey: string }> {
    const tier = opts.tier || 'one';
    const config = getTierConfig(tier);
    const id = `tenant_${randomBytes(12).toString('hex')}`;
    const now = new Date().toISOString();

    const [tenant] = await this.query(
      `INSERT INTO tenants (id, email, name, tier, status, created_at, max_messages_per_month, max_cost_usd_per_month, max_concurrent_sessions, max_workspace_size_mb, current_month_started_at)
       VALUES ($1,$2,$3,$4,'active',$5,$6,$7,$8,$9,$5) RETURNING *`,
      [id, opts.email, opts.name, tier, now, config?.max_messages_per_month || 1500, config?.max_cost_usd_per_month || 5, config?.max_concurrent_sessions || 3, config?.max_workspace_size_mb || 200]
    );

    const rawKey = `clow_live_${randomBytes(24).toString('base64url')}`;
    const keyHash = createHash('sha256').update(rawKey).digest('hex');
    const keyId = `key_${randomBytes(8).toString('hex')}`;

    await this.query(
      `INSERT INTO api_keys (id, tenant_id, key_hash, name, created_at) VALUES ($1,$2,$3,'default',$4)`,
      [keyId, id, keyHash, now]
    );

    return { tenant: tenant as PgTenant, apiKey: rawKey };
  }

  async getTenant(id: string): Promise<PgTenant | null> {
    const rows = await this.query('SELECT * FROM tenants WHERE id = $1', [id]);
    return rows[0] || null;
  }

  async findTenantByEmail(email: string): Promise<PgTenant | null> {
    const rows = await this.query('SELECT * FROM tenants WHERE email = $1', [email]);
    return rows[0] || null;
  }

  async findTenantByApiKeyHash(keyHash: string): Promise<PgTenant | null> {
    const rows = await this.query(
      `SELECT t.* FROM tenants t JOIN api_keys k ON t.id = k.tenant_id WHERE k.key_hash = $1 AND k.revoked_at IS NULL`,
      [keyHash]
    );
    return rows[0] || null;
  }

  async updateTenant(id: string, updates: Partial<PgTenant>): Promise<PgTenant | null> {
    const fields = Object.keys(updates).filter(k => k !== 'id');
    if (fields.length === 0) return this.getTenant(id);

    const sets = fields.map((f, i) => `${f} = $${i + 2}`);
    const values = fields.map(f => (updates as any)[f]);

    const rows = await this.query(
      `UPDATE tenants SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
      [id, ...values]
    );
    return rows[0] || null;
  }

  async listTenants(): Promise<PgTenant[]> {
    return this.query('SELECT * FROM tenants ORDER BY created_at DESC');
  }

  async incrementUsage(id: string, usage: { messages?: number; cost_usd?: number }): Promise<void> {
    await this.query(
      `UPDATE tenants SET current_month_messages = current_month_messages + $2, current_month_cost_usd = current_month_cost_usd + $3 WHERE id = $1`,
      [id, usage.messages || 0, usage.cost_usd || 0]
    );
  }

  async resetMonthlyUsage(id: string): Promise<void> {
    await this.query(
      `UPDATE tenants SET current_month_messages = 0, current_month_cost_usd = 0, current_month_started_at = NOW() WHERE id = $1`,
      [id]
    );
  }

  // ─── API Keys ──────────────────────────────────────────────────

  async createApiKey(tenantId: string, name: string): Promise<string> {
    const rawKey = `clow_live_${randomBytes(24).toString('base64url')}`;
    const keyHash = createHash('sha256').update(rawKey).digest('hex');
    const keyId = `key_${randomBytes(8).toString('hex')}`;

    await this.query(
      `INSERT INTO api_keys (id, tenant_id, key_hash, name) VALUES ($1,$2,$3,$4)`,
      [keyId, tenantId, keyHash, name]
    );
    return rawKey;
  }

  async revokeApiKey(keyId: string): Promise<void> {
    await this.query(`UPDATE api_keys SET revoked_at = NOW() WHERE id = $1`, [keyId]);
  }

  async listApiKeys(tenantId: string): Promise<any[]> {
    return this.query(
      `SELECT id, name, created_at, last_used_at, revoked_at FROM api_keys WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [tenantId]
    );
  }

  // ─── Cleanup ───────────────────────────────────────────────────

  async close(): Promise<void> {
    if (this.pool) await this.pool.end();
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Factory: auto-select PostgreSQL or JSON based on env
// ════════════════════════════════════════════════════════════════════════════

let _pgStore: TenantStorePostgres | null = null;

export function isPostgresEnabled(): boolean {
  return Boolean(process.env.CLOW_DB_URL || process.env.DATABASE_URL || process.env.SUPABASE_DB_URL);
}

export async function getPostgresStore(): Promise<TenantStorePostgres> {
  if (_pgStore) return _pgStore;
  const url = process.env.CLOW_DB_URL || process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
  if (!url) throw new Error('No PostgreSQL URL configured');
  _pgStore = new TenantStorePostgres(url);
  await _pgStore.init();
  return _pgStore;
}
