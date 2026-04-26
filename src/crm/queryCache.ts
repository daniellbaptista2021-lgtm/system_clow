/**
 * Query cache — Onda 32.
 *
 * LRU + TTL in-memory cache with optional Redis passthrough.
 * Key pattern: "{tenantId}:{namespace}:{hash-of-params}".
 * Invalidation: tag-based — tag queries by entity, bust tag on mutations.
 *
 * Usage:
 *   const r = await cache.wrap('contacts:list:' + tenantId, async () => store.list(tenantId), { ttl: 60000, tags: ['contacts:'+tenantId] });
 *   cache.bustTag('contacts:' + tenantId);  // after mutation
 */

import { createHash } from 'crypto';

interface Entry {
  value: any;
  expiresAt: number;
  tags: Set<string>;
  bytes: number;
}

class QueryCache {
  private cache = new Map<string, Entry>();
  private tagToKeys = new Map<string, Set<string>>();
  private maxEntries = 5000;
  private maxBytes = 50 * 1024 * 1024; // 50MB
  private currentBytes = 0;
  private hits = 0;
  private misses = 0;
  private redisClient: any = null;

  async initRedis(): Promise<void> {
    const url = process.env.REDIS_URL;
    if (!url) return;
    try {
      const { default: Redis } = await import('ioredis' as string) as any;
      this.redisClient = new Redis(url, { maxRetriesPerRequest: 1, lazyConnect: true });
      await this.redisClient.connect();
      console.log('[query-cache] Redis backend connected:', url.replace(/:[^@]+@/, ':***@'));
    } catch (err: any) {
      console.warn('[query-cache] Redis unavailable, using in-memory only:', err?.message);
      this.redisClient = null;
    }
  }

  get(key: string): any | null {
    const e = this.cache.get(key);
    if (!e) { this.misses++; return null; }
    if (e.expiresAt < Date.now()) {
      this.evict(key);
      this.misses++;
      return null;
    }
    this.hits++;
    return e.value;
  }

  set(key: string, value: any, opts: { ttl: number; tags?: string[] }): void {
    const json = JSON.stringify(value);
    const bytes = Buffer.byteLength(json, 'utf-8');
    if (bytes > this.maxBytes / 10) return; // skip huge entries

    // Evict old LRU if needed
    while (this.cache.size >= this.maxEntries || this.currentBytes + bytes > this.maxBytes) {
      const first = this.cache.keys().next().value;
      if (!first) break;
      this.evict(first);
    }

    const tags = new Set(opts.tags || []);
    this.cache.set(key, { value, expiresAt: Date.now() + opts.ttl, tags, bytes });
    this.currentBytes += bytes;

    for (const tag of tags) {
      const keys = this.tagToKeys.get(tag) || new Set();
      keys.add(key);
      this.tagToKeys.set(tag, keys);
    }

    // Fire-and-forget Redis mirror
    if (this.redisClient) {
      void this.redisClient.set(key, json, 'PX', opts.ttl).catch(() => {});
    }
  }

  async wrap<T>(key: string, fn: () => T | Promise<T>, opts: { ttl: number; tags?: string[] }): Promise<T> {
    const cached = this.get(key);
    if (cached !== null) return cached as T;

    // Try Redis
    if (this.redisClient) {
      try {
        const raw = await this.redisClient.get(key);
        if (raw) {
          const parsed = JSON.parse(raw);
          // Hydrate local LRU too (short TTL to avoid stale)
          this.set(key, parsed, { ttl: Math.min(opts.ttl, 30_000), tags: opts.tags });
          return parsed as T;
        }
      } catch { /* swallow */ }
    }

    const fresh = await fn();
    this.set(key, fresh, opts);
    return fresh;
  }

  bustTag(tag: string): number {
    const keys = this.tagToKeys.get(tag);
    if (!keys) return 0;
    let n = 0;
    for (const k of keys) {
      if (this.cache.delete(k)) n++;
      if (this.redisClient) { void this.redisClient.del(k).catch(() => {}); }
    }
    this.tagToKeys.delete(tag);
    return n;
  }

  private evict(key: string): void {
    const e = this.cache.get(key);
    if (!e) return;
    this.currentBytes -= e.bytes;
    for (const tag of e.tags) this.tagToKeys.get(tag)?.delete(key);
    this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
    this.tagToKeys.clear();
    this.currentBytes = 0;
  }

  stats(): { size: number; bytes: number; hits: number; misses: number; hitRate: number; redis: boolean } {
    const total = this.hits + this.misses;
    return {
      size: this.cache.size, bytes: this.currentBytes,
      hits: this.hits, misses: this.misses,
      hitRate: total > 0 ? this.hits / total : 0,
      redis: !!this.redisClient,
    };
  }

  keyOf(namespace: string, tenantId: string, params: Record<string, any>): string {
    const canon = JSON.stringify(Object.keys(params).sort().reduce((a: any, k) => (a[k] = params[k], a), {}));
    const hash = createHash('sha256').update(canon).digest('hex').slice(0, 16);
    return `${tenantId}:${namespace}:${hash}`;
  }
}

export const cache = new QueryCache();

// Initialize Redis on first access (lazy)
let initialized = false;
export async function ensureInitialized(): Promise<void> {
  if (initialized) return;
  initialized = true;
  await cache.initRedis();
}

// Auto-init on module load (fire-and-forget)
void ensureInitialized();
