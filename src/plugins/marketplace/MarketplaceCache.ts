/**
 * MarketplaceCache.ts — Local cache for marketplace catalog
 *
 * Based on Claude Code's cache patterns (350 lines)
 *
 * Implements:
 *   - Catalog cache with configurable TTL (default 4 hours)
 *   - Manifest cache per plugin/version (1 hour TTL)
 *   - Blocklist cache (30 min TTL)
 *   - Atomic write (tmp + rename) to prevent corruption
 *   - Size tracking and max cache size enforcement
 *   - Cache statistics (hits, misses, evictions)
 *   - Manual invalidation
 *   - Conditional refresh (only fetch if expired)
 *   - ETag tracking for HTTP conditional requests
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import type { MarketplaceCatalog, PluginManifest } from '../types.js';
import { MARKETPLACE_CACHE_TTL_MS } from '../types.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const MANIFEST_CACHE_TTL_MS = 60 * 60 * 1_000;     // 1 hour
const BLOCKLIST_CACHE_TTL_MS = 30 * 60 * 1_000;     // 30 minutes
const MAX_CACHE_SIZE_BYTES = 100 * 1024 * 1024;     // 100MB total cache
const MAX_CACHED_MANIFESTS = 500;

// ─── Cache Stats ────────────────────────────────────────────────────────────

interface CacheStats {
  catalogHits: number;
  catalogMisses: number;
  manifestHits: number;
  manifestMisses: number;
  blocklistHits: number;
  blocklistMisses: number;
  evictions: number;
  totalBytesWritten: number;
}

// ─── Cached Entry ───────────────────────────────────────────────────────────

interface CachedEntry<T> {
  data: T;
  cachedAt: number;
  ttlMs: number;
  etag?: string;
  sizeBytes: number;
}

// ════════════════════════════════════════════════════════════════════════════
// MarketplaceCache Class
// ════════════════════════════════════════════════════════════════════════════

export class MarketplaceCache {
  private stats: CacheStats = {
    catalogHits: 0, catalogMisses: 0,
    manifestHits: 0, manifestMisses: 0,
    blocklistHits: 0, blocklistMisses: 0,
    evictions: 0, totalBytesWritten: 0,
  };

  constructor(
    private readonly cacheDir: string,
    private readonly catalogTtl: number = MARKETPLACE_CACHE_TTL_MS,
  ) {}

  // ─── Catalog Cache ────────────────────────────────────────────────

  /**
   * Get cached catalog. Returns null if expired or missing.
   */
  async get(): Promise<MarketplaceCatalog | null> {
    const entry = await this.loadEntry<MarketplaceCatalog>(this.catalogPath());
    if (!entry) {
      this.stats.catalogMisses++;
      return null;
    }
    if (this.isExpired(entry)) {
      this.stats.catalogMisses++;
      return null;
    }
    this.stats.catalogHits++;
    return entry.data;
  }

  /**
   * Cache a catalog.
   */
  async set(catalog: MarketplaceCatalog, etag?: string): Promise<void> {
    const enriched = { ...catalog, lastFetchedAt: Date.now() };
    await this.saveEntry(this.catalogPath(), enriched, this.catalogTtl, etag);
  }

  /**
   * Get the ETag for the cached catalog (for conditional HTTP requests).
   */
  async getCatalogEtag(): Promise<string | null> {
    const entry = await this.loadEntry<MarketplaceCatalog>(this.catalogPath());
    return entry?.etag ?? null;
  }

  // ─── Manifest Cache ───────────────────────────────────────────────

  /**
   * Get cached manifest for a specific plugin version.
   */
  async getManifest(pluginId: string, version: string): Promise<PluginManifest | null> {
    const entry = await this.loadEntry<PluginManifest>(this.manifestPath(pluginId, version));
    if (!entry || this.isExpired(entry)) {
      this.stats.manifestMisses++;
      return null;
    }
    this.stats.manifestHits++;
    return entry.data;
  }

  /**
   * Cache a plugin manifest.
   */
  async setManifest(pluginId: string, version: string, manifest: PluginManifest): Promise<void> {
    await this.saveEntry(this.manifestPath(pluginId, version), manifest, MANIFEST_CACHE_TTL_MS);
  }

  // ─── Blocklist Cache ──────────────────────────────────────────────

  /**
   * Get cached blocklist.
   */
  async getBlocklist(): Promise<string[] | null> {
    const entry = await this.loadEntry<string[]>(this.blocklistPath());
    if (!entry || this.isExpired(entry)) {
      this.stats.blocklistMisses++;
      return null;
    }
    this.stats.blocklistHits++;
    return entry.data;
  }

  /**
   * Cache the blocklist.
   */
  async setBlocklist(blocked: string[]): Promise<void> {
    await this.saveEntry(this.blocklistPath(), blocked, BLOCKLIST_CACHE_TTL_MS);
  }

  // ─── Invalidation ─────────────────────────────────────────────────

  /**
   * Invalidate the catalog cache.
   */
  async invalidate(): Promise<void> {
    try { await fsp.unlink(this.catalogPath()); } catch {}
  }

  /**
   * Invalidate a specific manifest cache.
   */
  async invalidateManifest(pluginId: string, version: string): Promise<void> {
    try { await fsp.unlink(this.manifestPath(pluginId, version)); } catch {}
  }

  /**
   * Clear all caches.
   */
  async clearAll(): Promise<void> {
    try { await fsp.rm(this.cacheDir, { recursive: true, force: true }); } catch {}
    this.stats.evictions++;
  }

  // ─── Cache Size Management ────────────────────────────────────────

  /**
   * Get total cache size in bytes.
   */
  async getCacheSize(): Promise<number> {
    if (!fs.existsSync(this.cacheDir)) return 0;
    let total = 0;
    const walk = async (dir: string) => {
      try {
        for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
          const fp = path.join(dir, entry.name);
          if (entry.isDirectory()) await walk(fp);
          else total += (await fsp.stat(fp)).size;
        }
      } catch {}
    };
    await walk(this.cacheDir);
    return total;
  }

  /**
   * Evict old entries if cache exceeds max size.
   */
  async enforceMaxSize(): Promise<number> {
    const currentSize = await this.getCacheSize();
    if (currentSize <= MAX_CACHE_SIZE_BYTES) return 0;

    // Collect all cache files with mtime
    const files: Array<{ path: string; size: number; mtime: number }> = [];
    const walk = async (dir: string) => {
      try {
        for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
          const fp = path.join(dir, entry.name);
          if (entry.isDirectory()) await walk(fp);
          else {
            const stat = await fsp.stat(fp);
            files.push({ path: fp, size: stat.size, mtime: stat.mtimeMs });
          }
        }
      } catch {}
    };
    await walk(this.cacheDir);

    // Sort by oldest first
    files.sort((a, b) => a.mtime - b.mtime);

    let freed = 0;
    let remaining = currentSize;
    let evicted = 0;

    for (const file of files) {
      if (remaining <= MAX_CACHE_SIZE_BYTES * 0.8) break; // Target 80%
      try {
        await fsp.unlink(file.path);
        freed += file.size;
        remaining -= file.size;
        evicted++;
      } catch {}
    }

    this.stats.evictions += evicted;
    return evicted;
  }

  // ─── Statistics ───────────────────────────────────────────────────

  getStats(): Readonly<CacheStats> {
    return { ...this.stats };
  }

  resetStats(): void {
    this.stats = {
      catalogHits: 0, catalogMisses: 0,
      manifestHits: 0, manifestMisses: 0,
      blocklistHits: 0, blocklistMisses: 0,
      evictions: 0, totalBytesWritten: 0,
    };
  }

  // ─── Internal ─────────────────────────────────────────────────────

  private async loadEntry<T>(filePath: string): Promise<CachedEntry<T> | null> {
    if (!fs.existsSync(filePath)) return null;
    try {
      const raw = await fsp.readFile(filePath, 'utf-8');
      return JSON.parse(raw) as CachedEntry<T>;
    } catch {
      // Corrupt cache file — remove it
      try { await fsp.unlink(filePath); } catch {}
      return null;
    }
  }

  private async saveEntry<T>(filePath: string, data: T, ttlMs: number, etag?: string): Promise<void> {
    const json = JSON.stringify(data);
    const entry: CachedEntry<T> = {
      data,
      cachedAt: Date.now(),
      ttlMs,
      etag,
      sizeBytes: Buffer.byteLength(json, 'utf-8'),
    };

    const dir = path.dirname(filePath);
    await fsp.mkdir(dir, { recursive: true });

    // Atomic write: tmp + rename
    const tmpPath = `${filePath}.tmp.${Date.now()}`;
    const content = JSON.stringify(entry);
    await fsp.writeFile(tmpPath, content);
    await fsp.rename(tmpPath, filePath);

    this.stats.totalBytesWritten += Buffer.byteLength(content, 'utf-8');
  }

  private isExpired<T>(entry: CachedEntry<T>): boolean {
    return Date.now() - entry.cachedAt > entry.ttlMs;
  }

  // ─── Paths ────────────────────────────────────────────────────────

  private catalogPath(): string { return path.join(this.cacheDir, 'catalog.json'); }
  private blocklistPath(): string { return path.join(this.cacheDir, 'blocklist.json'); }
  private manifestPath(pluginId: string, version: string): string {
    return path.join(this.cacheDir, 'manifests', `${pluginId}@${version}.json`);
  }
}
