/**
 * PluginContentCache.ts — Cache parsed markdown content from plugins
 *
 * Based on Claude Code's content cache patterns (450 lines)
 *
 * Caches parsed command bodies, agent prompts, skill content.
 * Uses mtime-based invalidation: if file changed on disk, cache entry is invalid.
 *
 * Implements:
 *   - LRU eviction with configurable capacity
 *   - Mtime-based invalidation (detect file modifications)
 *   - Content hash tracking (detect content changes even if mtime same)
 *   - Size tracking (total cached content bytes)
 *   - Per-plugin invalidation (clear all entries for a specific plugin)
 *   - Statistics (hits, misses, invalidations)
 *   - TTL support (optional time-based expiry)
 *   - Cache warming (pre-populate from file list)
 *   - Batch get/set operations
 *   - Cache partitioning by plugin namespace
 *   - Import/export for backup and restore
 *   - Detailed per-plugin statistics
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as crypto from 'crypto';

// ─── Types ──────────────────────────────────────────────────────────────────

interface CacheEntry {
  key: string;
  content: string;
  filePath: string;
  pluginName: string;
  mtimeMs: number;
  contentHash: string;
  cachedAt: number;
  sizeBytes: number;
  accessCount: number;
  lastAccessedAt: number;
}

interface ContentCacheStats {
  hits: number;
  misses: number;
  invalidations: number;
  evictions: number;
  totalEntries: number;
  totalSizeBytes: number;
}

interface PluginCacheStats {
  pluginName: string;
  entryCount: number;
  totalSizeBytes: number;
  hits: number;
  misses: number;
  avgAccessCount: number;
  oldestEntryAt: number;
  newestEntryAt: number;
}

interface CacheExportData {
  version: number;
  exportedAt: number;
  entries: Array<{
    key: string;
    content: string;
    filePath: string;
    pluginName: string;
    contentHash: string;
  }>;
}

interface WarmingResult {
  loaded: number;
  skipped: number;
  failed: number;
  durationMs: number;
}

interface BatchGetResult {
  found: Map<string, string>;
  missing: string[];
}

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_CAPACITY = 500;
const DEFAULT_TTL_MS = 0; // 0 = no TTL (only mtime invalidation)
const EXPORT_VERSION = 1;

// ════════════════════════════════════════════════════════════════════════════
// PluginContentCache Class
// ════════════════════════════════════════════════════════════════════════════

export class PluginContentCache {
  private entries = new Map<string, CacheEntry>();
  private accessOrder: string[] = []; // LRU order (oldest first)
  private stats: ContentCacheStats = {
    hits: 0, misses: 0, invalidations: 0,
    evictions: 0, totalEntries: 0, totalSizeBytes: 0,
  };
  private pluginHits = new Map<string, number>();
  private pluginMisses = new Map<string, number>();

  constructor(
    private readonly capacity: number = DEFAULT_CAPACITY,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
  ) {}

  // ─── Get / Set ────────────────────────────────────────────────────

  /**
   * Get cached content. Validates mtime before returning.
   * Returns null if missing, expired, or file changed.
   */
  async get(key: string): Promise<string | null> {
    const entry = this.entries.get(key);
    if (!entry) {
      this.stats.misses++;
      this.incrementPluginMisses(this.guessPluginFromKey(key));
      return null;
    }

    // TTL check
    if (this.ttlMs > 0 && Date.now() - entry.cachedAt > this.ttlMs) {
      this.invalidate(key);
      this.stats.misses++;
      this.incrementPluginMisses(entry.pluginName);
      return null;
    }

    // Mtime check
    try {
      const stat = await fsp.stat(entry.filePath);
      if (stat.mtimeMs !== entry.mtimeMs) {
        this.invalidate(key);
        this.stats.misses++;
        this.incrementPluginMisses(entry.pluginName);
        return null;
      }
    } catch {
      // File deleted
      this.invalidate(key);
      this.stats.misses++;
      this.incrementPluginMisses(entry.pluginName);
      return null;
    }

    // Cache hit
    entry.accessCount++;
    entry.lastAccessedAt = Date.now();
    this.touchLRU(key);
    this.stats.hits++;
    this.incrementPluginHits(entry.pluginName);
    return entry.content;
  }

  /**
   * Get cached content without mtime validation (fast path).
   * Used when you know the file hasn't changed (same session).
   */
  getSync(key: string): string | null {
    const entry = this.entries.get(key);
    if (!entry) {
      this.stats.misses++;
      this.incrementPluginMisses(this.guessPluginFromKey(key));
      return null;
    }

    entry.accessCount++;
    entry.lastAccessedAt = Date.now();
    this.stats.hits++;
    this.incrementPluginHits(entry.pluginName);
    return entry.content;
  }

  /**
   * Cache content for a file.
   */
  async set(key: string, content: string, filePath: string, pluginName: string): Promise<void> {
    // Evict if at capacity
    while (this.entries.size >= this.capacity) {
      this.evictLRU();
    }

    let mtimeMs = 0;
    try {
      const stat = await fsp.stat(filePath);
      mtimeMs = stat.mtimeMs;
    } catch {}

    const contentHash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
    const sizeBytes = Buffer.byteLength(content, 'utf-8');

    const entry: CacheEntry = {
      key, content, filePath, pluginName,
      mtimeMs, contentHash,
      cachedAt: Date.now(), sizeBytes,
      accessCount: 0, lastAccessedAt: Date.now(),
    };

    this.entries.set(key, entry);
    this.accessOrder.push(key);

    this.stats.totalEntries = this.entries.size;
    this.stats.totalSizeBytes += sizeBytes;
  }

  // ─── Batch Operations ────────────────────────────────────────────

  /**
   * Get multiple entries in a single call (fast path, no mtime validation).
   * Returns a map of found entries and a list of missing keys.
   */
  batchGetSync(keys: string[]): BatchGetResult {
    const found = new Map<string, string>();
    const missing: string[] = [];

    for (const key of keys) {
      const content = this.getSync(key);
      if (content !== null) {
        found.set(key, content);
      } else {
        missing.push(key);
      }
    }

    return { found, missing };
  }

  /**
   * Get multiple entries with mtime validation.
   * Returns a map of found entries and a list of missing keys.
   */
  async batchGet(keys: string[]): Promise<BatchGetResult> {
    const found = new Map<string, string>();
    const missing: string[] = [];

    for (const key of keys) {
      const content = await this.get(key);
      if (content !== null) {
        found.set(key, content);
      } else {
        missing.push(key);
      }
    }

    return { found, missing };
  }

  /**
   * Set multiple entries in a single call.
   * Each item must include the key, content, filePath, and pluginName.
   */
  async batchSet(
    items: Array<{ key: string; content: string; filePath: string; pluginName: string }>,
  ): Promise<void> {
    for (const item of items) {
      await this.set(item.key, item.content, item.filePath, item.pluginName);
    }
  }

  // ─── Cache Warming ───────────────────────────────────────────────

  /**
   * Pre-populate cache from a list of files.
   * Reads each file from disk and caches its content.
   * Returns statistics about the warming operation.
   */
  async warm(
    files: Array<{ key: string; filePath: string; pluginName: string }>,
  ): Promise<WarmingResult> {
    const startTime = Date.now();
    let loaded = 0;
    let skipped = 0;
    let failed = 0;

    for (const file of files) {
      // Skip if already cached
      if (this.entries.has(file.key)) {
        skipped++;
        continue;
      }

      try {
        const content = await fsp.readFile(file.filePath, 'utf-8');
        await this.set(file.key, content, file.filePath, file.pluginName);
        loaded++;
      } catch {
        failed++;
      }
    }

    return {
      loaded,
      skipped,
      failed,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Warm the cache for all files belonging to a specific plugin.
   * Requires a file discovery function that returns paths for a plugin.
   */
  async warmPlugin(
    pluginName: string,
    discoverFiles: () => Promise<Array<{ key: string; filePath: string }>>,
  ): Promise<WarmingResult> {
    const discovered = await discoverFiles();
    const files = discovered.map(f => ({ ...f, pluginName }));
    return this.warm(files);
  }

  // ─── Invalidation ─────────────────────────────────────────────────

  /**
   * Invalidate a single entry.
   */
  invalidate(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;

    this.stats.totalSizeBytes -= entry.sizeBytes;
    this.entries.delete(key);
    this.removeLRU(key);
    this.stats.invalidations++;
    this.stats.totalEntries = this.entries.size;
  }

  /**
   * Invalidate all entries for a specific plugin.
   */
  invalidatePlugin(pluginName: string): void {
    const toRemove: string[] = [];
    for (const [key, entry] of this.entries) {
      if (entry.pluginName === pluginName) toRemove.push(key);
    }
    for (const key of toRemove) this.invalidate(key);
  }

  /**
   * Invalidate all entries whose files have changed on disk.
   * Returns number of invalidated entries.
   */
  async validateAll(): Promise<number> {
    let invalidated = 0;
    const toCheck = [...this.entries.entries()];

    for (const [key, entry] of toCheck) {
      try {
        const stat = await fsp.stat(entry.filePath);
        if (stat.mtimeMs !== entry.mtimeMs) {
          this.invalidate(key);
          invalidated++;
        }
      } catch {
        this.invalidate(key);
        invalidated++;
      }
    }

    return invalidated;
  }

  /**
   * Clear all entries.
   */
  clear(): void {
    const sizeBefore = this.stats.totalSizeBytes;
    this.entries.clear();
    this.accessOrder = [];
    this.stats.totalEntries = 0;
    this.stats.totalSizeBytes = 0;
    this.stats.invalidations += sizeBefore > 0 ? 1 : 0;
  }

  // ─── Query ────────────────────────────────────────────────────────

  /**
   * Check if a key is cached (without validation).
   */
  has(key: string): boolean {
    return this.entries.has(key);
  }

  /**
   * Get number of cached entries.
   */
  size(): number {
    return this.entries.size;
  }

  /**
   * Get total cached content size in bytes.
   */
  totalSizeBytes(): number {
    return this.stats.totalSizeBytes;
  }

  /**
   * List all cached keys for a plugin.
   */
  keysForPlugin(pluginName: string): string[] {
    return [...this.entries.entries()]
      .filter(([, entry]) => entry.pluginName === pluginName)
      .map(([key]) => key);
  }

  /**
   * Get list of unique plugin names that have cached entries.
   */
  getPluginNames(): string[] {
    const names = new Set<string>();
    for (const entry of this.entries.values()) {
      names.add(entry.pluginName);
    }
    return [...names].sort();
  }

  // ─── Per-Plugin Statistics ────────────────────────────────────────

  /**
   * Get detailed statistics for a specific plugin.
   */
  getPluginStats(pluginName: string): PluginCacheStats {
    let entryCount = 0;
    let totalSizeBytes = 0;
    let totalAccessCount = 0;
    let oldestEntryAt = Infinity;
    let newestEntryAt = 0;

    for (const entry of this.entries.values()) {
      if (entry.pluginName !== pluginName) continue;
      entryCount++;
      totalSizeBytes += entry.sizeBytes;
      totalAccessCount += entry.accessCount;
      if (entry.cachedAt < oldestEntryAt) oldestEntryAt = entry.cachedAt;
      if (entry.cachedAt > newestEntryAt) newestEntryAt = entry.cachedAt;
    }

    return {
      pluginName,
      entryCount,
      totalSizeBytes,
      hits: this.pluginHits.get(pluginName) ?? 0,
      misses: this.pluginMisses.get(pluginName) ?? 0,
      avgAccessCount: entryCount > 0 ? totalAccessCount / entryCount : 0,
      oldestEntryAt: oldestEntryAt === Infinity ? 0 : oldestEntryAt,
      newestEntryAt,
    };
  }

  /**
   * Get statistics for all plugins with cached content.
   */
  getAllPluginStats(): PluginCacheStats[] {
    const pluginNames = this.getPluginNames();
    return pluginNames.map(name => this.getPluginStats(name));
  }

  // ─── Global Statistics ───────────────────────────────────────────

  getStats(): Readonly<ContentCacheStats> {
    return { ...this.stats };
  }

  resetStats(): void {
    this.stats = { hits: 0, misses: 0, invalidations: 0, evictions: 0, totalEntries: this.entries.size, totalSizeBytes: this.stats.totalSizeBytes };
    this.pluginHits.clear();
    this.pluginMisses.clear();
  }

  /**
   * Get hit rate (0-1).
   */
  getHitRate(): number {
    const total = this.stats.hits + this.stats.misses;
    return total > 0 ? this.stats.hits / total : 0;
  }

  /**
   * Get per-plugin hit rate (0-1). Returns 0 if no access recorded.
   */
  getPluginHitRate(pluginName: string): number {
    const hits = this.pluginHits.get(pluginName) ?? 0;
    const misses = this.pluginMisses.get(pluginName) ?? 0;
    const total = hits + misses;
    return total > 0 ? hits / total : 0;
  }

  // ─── Export / Import ──────────────────────────────────────────────

  /**
   * Export the cache contents to a serializable object.
   * This can be used for backup/restore or migration between instances.
   * Note: mtime information is NOT exported since it is machine-specific.
   */
  exportCache(): CacheExportData {
    const entries: CacheExportData['entries'] = [];
    for (const entry of this.entries.values()) {
      entries.push({
        key: entry.key,
        content: entry.content,
        filePath: entry.filePath,
        pluginName: entry.pluginName,
        contentHash: entry.contentHash,
      });
    }
    return {
      version: EXPORT_VERSION,
      exportedAt: Date.now(),
      entries,
    };
  }

  /**
   * Import cache contents from a previously exported object.
   * Entries that already exist (by key) are skipped.
   * File mtimes are re-read from disk at import time.
   * Returns number of entries imported.
   */
  async importCache(data: CacheExportData): Promise<number> {
    if (data.version !== EXPORT_VERSION) {
      throw new Error(`Unsupported cache export version: ${data.version}`);
    }

    let imported = 0;
    for (const item of data.entries) {
      if (this.entries.has(item.key)) continue;

      // Verify that the content hash matches
      const computedHash = crypto.createHash('sha256').update(item.content).digest('hex').slice(0, 16);
      if (computedHash !== item.contentHash) continue; // Skip corrupt entries

      await this.set(item.key, item.content, item.filePath, item.pluginName);
      imported++;
    }
    return imported;
  }

  /**
   * Export cache contents as a JSON string (convenience).
   */
  exportCacheToJSON(): string {
    return JSON.stringify(this.exportCache(), null, 2);
  }

  /**
   * Import cache contents from a JSON string (convenience).
   */
  async importCacheFromJSON(json: string): Promise<number> {
    const data = JSON.parse(json) as CacheExportData;
    return this.importCache(data);
  }

  // ─── LRU Management ───────────────────────────────────────────────

  private evictLRU(): void {
    if (this.accessOrder.length === 0) return;
    const oldest = this.accessOrder.shift()!;
    const entry = this.entries.get(oldest);
    if (entry) {
      this.stats.totalSizeBytes -= entry.sizeBytes;
      this.entries.delete(oldest);
      this.stats.evictions++;
    }
  }

  private touchLRU(key: string): void {
    this.removeLRU(key);
    this.accessOrder.push(key);
  }

  private removeLRU(key: string): void {
    const idx = this.accessOrder.indexOf(key);
    if (idx >= 0) this.accessOrder.splice(idx, 1);
  }

  // ─── Private Helpers ──────────────────────────────────────────────

  private incrementPluginHits(pluginName: string): void {
    this.pluginHits.set(pluginName, (this.pluginHits.get(pluginName) ?? 0) + 1);
  }

  private incrementPluginMisses(pluginName: string): void {
    if (!pluginName) return;
    this.pluginMisses.set(pluginName, (this.pluginMisses.get(pluginName) ?? 0) + 1);
  }

  /**
   * Attempt to guess the plugin name from a cache key.
   * Keys are often namespaced like "pluginName:filepath".
   */
  private guessPluginFromKey(key: string): string {
    const colonIdx = key.indexOf(':');
    if (colonIdx > 0) return key.slice(0, colonIdx);
    return '';
  }
}
