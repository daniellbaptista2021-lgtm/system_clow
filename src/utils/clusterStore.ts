import { logger } from './logger.js';
/**
 * clusterStore.ts — async key/value primitives shared across PM2 cluster
 * workers, with a transparent in-memory fallback when Redis is absent.
 *
 * Why exist: when System Clow runs in PM2 cluster mode (2+ workers),
 * any state held in module-scoped Maps/Sets is duplicated per worker.
 * Rate limit windows count the wrong scope, dedup sets miss cross-
 * worker collisions, etc. This module gives the rate limiter, the
 * health endpoint, the automation dedup, and the active-session
 * tracker a single shared backend.
 *
 * Backends:
 *   - Redis (preferred). Picks up REDIS_URL or CLOW_REDIS_URL.
 *   - In-memory Map (fallback). Same API, single-process semantics.
 *     Used in dev (no Redis), tests, and as a graceful degradation if
 *     Redis becomes unreachable mid-flight.
 *
 * The init is async (`await getCluster()`) but ALL primitive operations
 * are async too — keep call sites uniform regardless of backend so that
 * swapping in Redis later doesn't change consumer code.
 *
 * Atomicity:
 *   - `incr(key, ttlSec)` is atomic (Redis INCR; in-memory uses ++).
 *   - `setNxEx(key, value, ttlSec)` returns true iff the key was created.
 *     Used for dedup with TTL — Redis SET NX EX maps directly.
 *   - `sAdd / sRem / sCard` operate on a Set keyed by name.
 */

export interface ClusterStore {
  /** Atomic increment. If the key doesn't exist, sets to 1 with TTL. */
  incr(key: string, ttlSec: number): Promise<number>;
  /**
   * SET key value NX EX ttlSec → true iff key was newly created.
   * Used for "did anyone else dedupe this in the last N seconds?".
   */
  setNxEx(key: string, value: string, ttlSec: number): Promise<boolean>;
  /** Add member to a set. Returns true if newly added. */
  sAdd(setKey: string, member: string): Promise<boolean>;
  /** Remove member from a set. */
  sRem(setKey: string, member: string): Promise<void>;
  /** Cardinality of a set. */
  sCard(setKey: string): Promise<number>;
  /** Best-effort disconnect — for tests. */
  close(): Promise<void>;
  /** What backend is in use. Useful for observability + tests. */
  readonly backend: 'redis' | 'memory';
}

// ─── In-memory backend ────────────────────────────────────────────────────

class MemoryStore implements ClusterStore {
  readonly backend = 'memory' as const;
  private counters = new Map<string, { value: number; expiresAt: number }>();
  private dedupes = new Map<string, number>();
  private sets = new Map<string, Set<string>>();

  private gc(): void {
    const now = Date.now();
    for (const [k, v] of this.counters) if (now >= v.expiresAt) this.counters.delete(k);
    for (const [k, expiresAt] of this.dedupes) if (now >= expiresAt) this.dedupes.delete(k);
  }

  async incr(key: string, ttlSec: number): Promise<number> {
    this.gc();
    const now = Date.now();
    const cur = this.counters.get(key);
    if (!cur || now >= cur.expiresAt) {
      this.counters.set(key, { value: 1, expiresAt: now + ttlSec * 1000 });
      return 1;
    }
    cur.value += 1;
    return cur.value;
  }

  async setNxEx(key: string, _value: string, ttlSec: number): Promise<boolean> {
    this.gc();
    const now = Date.now();
    const exp = this.dedupes.get(key);
    if (exp && now < exp) return false;
    this.dedupes.set(key, now + ttlSec * 1000);
    return true;
  }

  async sAdd(setKey: string, member: string): Promise<boolean> {
    let s = this.sets.get(setKey);
    if (!s) { s = new Set(); this.sets.set(setKey, s); }
    if (s.has(member)) return false;
    s.add(member);
    return true;
  }

  async sRem(setKey: string, member: string): Promise<void> {
    this.sets.get(setKey)?.delete(member);
  }

  async sCard(setKey: string): Promise<number> {
    return this.sets.get(setKey)?.size ?? 0;
  }

  async close(): Promise<void> {
    this.counters.clear();
    this.dedupes.clear();
    this.sets.clear();
  }
}

// ─── Redis backend ────────────────────────────────────────────────────────

class RedisStore implements ClusterStore {
  readonly backend = 'redis' as const;
  // Loose typing — ioredis is loaded dynamically (matches the rest of
  // the codebase) and we touch only a small surface.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private client: any) {}

  async incr(key: string, ttlSec: number): Promise<number> {
    // Multi-pipeline so INCR + EXPIRE are atomic (in the sense that a
    // crash between them can't leave a non-expiring counter).
    const pipe = this.client.multi();
    pipe.incr(key);
    pipe.expire(key, ttlSec, 'NX');  // only set TTL if key was new
    const res = await pipe.exec();
    return Number(res?.[0]?.[1] ?? 0);
  }

  async setNxEx(key: string, value: string, ttlSec: number): Promise<boolean> {
    const reply = await this.client.set(key, value, 'EX', ttlSec, 'NX');
    return reply === 'OK';
  }

  async sAdd(setKey: string, member: string): Promise<boolean> {
    const added = (await this.client.sadd(setKey, member)) as number;
    return added === 1;
  }

  async sRem(setKey: string, member: string): Promise<void> {
    await this.client.srem(setKey, member);
  }

  async sCard(setKey: string): Promise<number> {
    return Number(await this.client.scard(setKey));
  }

  async close(): Promise<void> {
    try { await this.client.quit?.(); } catch { /* best effort */ }
    try { this.client.disconnect?.(); } catch { /* best effort */ }
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────

let _store: Promise<ClusterStore> | null = null;

async function tryRedis(url: string): Promise<ClusterStore | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { default: Redis } = (await import('ioredis' as string)) as any;
    const client = new Redis(url, {
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      connectTimeout: 1500,
      enableOfflineQueue: false,
    });
    await client.connect();
    return new RedisStore(client);
  } catch (err) {
    logger.warn(`[clusterStore] Redis at ${url} unreachable, falling back to memory: ${(err as Error).message}`);
    return null;
  }
}

export async function getCluster(): Promise<ClusterStore> {
  if (_store) return _store;
  _store = (async () => {
    const url = process.env.CLOW_REDIS_URL ?? process.env.REDIS_URL;
    if (url) {
      const r = await tryRedis(url);
      if (r) return r;
    }
    return new MemoryStore();
  })();
  return _store;
}

/**
 * Test-only: reset the singleton between specs. Calling this releases
 * any open Redis socket; the next getCluster() call will re-init.
 */
export async function _resetClusterStoreForTests(): Promise<void> {
  if (_store) {
    const s = await _store;
    await s.close();
  }
  _store = null;
}
