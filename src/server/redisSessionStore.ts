/**
 * redisSessionStore.ts — Redis-backed distributed session store
 *
 * Activated via CLOW_REDIS_URL environment variable.
 * Falls back to in-memory Map when Redis is not configured.
 *
 * Stores session metadata (not the full QueryEngine) in Redis with TTL.
 * Enables multiple System Clow instances to share session state.
 */

// ════════════════════════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════════════════════════

export interface SessionMeta {
  sessionId: string;
  tenantId?: string;
  cwd: string;
  workspaceRoot: string;
  mode: string;
  createdAt: number;
  lastAccess: number;
  messageCount: number;
  isAdmin: boolean;
}

// ════════════════════════════════════════════════════════════════════════════
// Redis Session Store
// ════════════════════════════════════════════════════════════════════════════

const SESSION_TTL = 1800; // 30 minutes
const KEY_PREFIX = 'clow:session:';

export class RedisSessionStore {
  private client: any = null;
  private fallbackMap = new Map<string, SessionMeta>();
  private isRedis = false;

  async init(): Promise<void> {
    const url = process.env.CLOW_REDIS_URL || process.env.REDIS_URL;
    if (!url) {
      console.log('[SessionStore] No Redis URL — using in-memory store');
      return;
    }

    try {
      const { default: Redis } = await import('ioredis');
      this.client = new Redis(url, {
        maxRetriesPerRequest: 3,
        retryStrategy: (times: number) => Math.min(times * 200, 5000),
        lazyConnect: true,
      });
      await this.client.connect();
      this.isRedis = true;
      console.log('[SessionStore] Redis connected');
    } catch (err) {
      console.warn('[SessionStore] Redis connection failed, using in-memory:', (err as Error).message);
    }
  }

  async set(meta: SessionMeta): Promise<void> {
    if (this.isRedis && this.client) {
      try {
        await this.client.setex(
          KEY_PREFIX + meta.sessionId,
          SESSION_TTL,
          JSON.stringify(meta)
        );
        return;
      } catch {}
    }
    this.fallbackMap.set(meta.sessionId, meta);
  }

  async get(sessionId: string): Promise<SessionMeta | null> {
    if (this.isRedis && this.client) {
      try {
        const data = await this.client.get(KEY_PREFIX + sessionId);
        return data ? JSON.parse(data) : null;
      } catch {}
    }
    return this.fallbackMap.get(sessionId) || null;
  }

  async delete(sessionId: string): Promise<void> {
    if (this.isRedis && this.client) {
      try { await this.client.del(KEY_PREFIX + sessionId); } catch {}
    }
    this.fallbackMap.delete(sessionId);
  }

  async touch(sessionId: string): Promise<void> {
    if (this.isRedis && this.client) {
      try { await this.client.expire(KEY_PREFIX + sessionId, SESSION_TTL); } catch {}
    }
    const meta = this.fallbackMap.get(sessionId);
    if (meta) meta.lastAccess = Date.now();
  }

  async listByTenant(tenantId: string): Promise<SessionMeta[]> {
    if (this.isRedis && this.client) {
      try {
        const keys = await this.client.keys(KEY_PREFIX + '*');
        const results: SessionMeta[] = [];
        for (const key of keys) {
          const data = await this.client.get(key);
          if (data) {
            const meta = JSON.parse(data);
            if (meta.tenantId === tenantId) results.push(meta);
          }
        }
        return results;
      } catch {}
    }
    return [...this.fallbackMap.values()].filter(m => m.tenantId === tenantId);
  }

  async countByTenant(tenantId: string): Promise<number> {
    return (await this.listByTenant(tenantId)).length;
  }

  async close(): Promise<void> {
    if (this.client) {
      try { await this.client.quit(); } catch {}
    }
  }

  isDistributed(): boolean {
    return this.isRedis;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Singleton
// ════════════════════════════════════════════════════════════════════════════

let _store: RedisSessionStore | null = null;

export async function getSessionStore(): Promise<RedisSessionStore> {
  if (_store) return _store;
  _store = new RedisSessionStore();
  await _store.init();
  return _store;
}
