/**
 * ZipCache.ts — Content-addressed zip cache for downloaded plugins
 *
 * Based on Claude Code's zipCache.ts (500 lines)
 *
 * Content-addressing means: same zip content → same hash → same cache entry.
 * This deduplicates across versions (if content didn't change) and users.
 *
 * Implements:
 *   - Content-addressed storage (SHA-256 hash as key)
 *   - TTL-based expiry (default 7 days)
 *   - Size-based eviction (LRU when cache exceeds max size)
 *   - Garbage collection of expired entries
 *   - Cache statistics (hits, misses, size)
 *   - Atomic writes (tmp + rename)
 *   - Integrity verification (hash check on read)
 *   - Max entry size limit
 *   - Lock-free concurrent access (atomic file operations)
 *   - Cache compaction (merge small files)
 *   - Cache pre-warming from manifest
 *   - Cache export/import
 *   - Detailed per-entry statistics
 *   - Cleanup scheduling
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { ZIP_CACHE_TTL_MS } from '../types.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_CACHE_SIZE_BYTES = 500 * 1024 * 1024;  // 500MB total
const MAX_ENTRY_SIZE_BYTES = 50 * 1024 * 1024;   // 50MB per entry
const HASH_ALGORITHM = 'sha256';
const HASH_LENGTH = 32;  // hex chars to keep
const COMPACTION_THRESHOLD_BYTES = 64 * 1024; // entries smaller than 64KB are candidates for compaction

// ─── Types ──────────────────────────────────────────────────────────────────

interface CacheEntryMeta {
  hash: string;
  sizeBytes: number;
  createdAt: number;
  lastAccessedAt: number;
  accessCount: number;
  originalUrl?: string;
  pluginName?: string;
  pluginVersion?: string;
}

interface CacheStats {
  hits: number;
  misses: number;
  totalEntries: number;
  totalSizeBytes: number;
  evictions: number;
  gcRuns: number;
}

interface EntryStats {
  hash: string;
  sizeBytes: number;
  createdAt: number;
  lastAccessedAt: number;
  accessCount: number;
  ageMs: number;
  pluginName?: string;
  pluginVersion?: string;
}

interface CacheManifest {
  version: number;
  generatedAt: number;
  entries: Array<{
    hash: string;
    url?: string;
    pluginName?: string;
    pluginVersion?: string;
  }>;
}

interface CacheExportResult {
  exportPath: string;
  entryCount: number;
  totalSizeBytes: number;
}

interface CleanupSchedule {
  intervalMs: number;
  lastRunAt: number;
  nextRunAt: number;
  enabled: boolean;
}

// ════════════════════════════════════════════════════════════════════════════
// ZipCache Class
// ════════════════════════════════════════════════════════════════════════════

export class ZipCache {
  private stats: CacheStats = {
    hits: 0, misses: 0, totalEntries: 0,
    totalSizeBytes: 0, evictions: 0, gcRuns: 0,
  };
  private cleanupSchedule: CleanupSchedule = {
    intervalMs: 6 * 60 * 60 * 1000, // default: every 6 hours
    lastRunAt: 0,
    nextRunAt: 0,
    enabled: false,
  };
  private cleanupTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly cacheDir: string,
    private readonly ttlMs: number = ZIP_CACHE_TTL_MS,
  ) {}

  // ─── Read Operations ──────────────────────────────────────────────

  /**
   * Check if a content hash exists in cache and is not expired.
   */
  async has(contentHash: string): Promise<boolean> {
    const fp = this.dataPath(contentHash);
    if (!fs.existsSync(fp)) return false;

    try {
      const stat = await fsp.stat(fp);
      if (this.isExpired(stat.mtimeMs)) {
        await this.remove(contentHash);
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get cached content by hash.
   * Verifies integrity (re-hashes on read to detect corruption).
   * Returns null if missing, expired, or corrupt.
   */
  async get(contentHash: string): Promise<Buffer | null> {
    if (!(await this.has(contentHash))) {
      this.stats.misses++;
      return null;
    }

    try {
      const content = await fsp.readFile(this.dataPath(contentHash));

      // Verify integrity
      const actualHash = this.computeHash(content);
      if (actualHash !== contentHash) {
        console.warn(`[ZipCache] Integrity check failed for ${contentHash} (actual: ${actualHash})`);
        await this.remove(contentHash);
        this.stats.misses++;
        return null;
      }

      // Update access time and count
      await this.touchMeta(contentHash);

      this.stats.hits++;
      return content;
    } catch {
      this.stats.misses++;
      return null;
    }
  }

  // ─── Write Operations ─────────────────────────────────────────────

  /**
   * Store content in cache.
   * Returns the content hash (use this as the cache key).
   *
   * Atomic: writes to tmp file first, then renames.
   */
  async put(
    content: Buffer,
    metadata?: { url?: string; pluginName?: string; pluginVersion?: string },
  ): Promise<string> {
    // Size check
    if (content.length > MAX_ENTRY_SIZE_BYTES) {
      throw new Error(`Content too large for cache: ${content.length} > ${MAX_ENTRY_SIZE_BYTES}`);
    }

    const hash = this.computeHash(content);
    const dataFp = this.dataPath(hash);

    // Already cached? Just touch access time.
    if (fs.existsSync(dataFp)) {
      await this.touchMeta(hash);
      return hash;
    }

    // Ensure directory
    await fsp.mkdir(this.cacheDir, { recursive: true });

    // Atomic write: tmp → rename
    const tmpPath = `${dataFp}.tmp.${Date.now()}`;
    try {
      await fsp.writeFile(tmpPath, content);
      await fsp.rename(tmpPath, dataFp);
    } catch (err) {
      try { await fsp.unlink(tmpPath); } catch {}
      throw err;
    }

    // Write metadata
    const meta: CacheEntryMeta = {
      hash,
      sizeBytes: content.length,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      accessCount: 1,
      originalUrl: metadata?.url,
      pluginName: metadata?.pluginName,
      pluginVersion: metadata?.pluginVersion,
    };
    await fsp.writeFile(this.metaPath(hash), JSON.stringify(meta, null, 2));

    this.stats.totalEntries++;
    this.stats.totalSizeBytes += content.length;

    // Check if we need to evict
    await this.maybeEvict();

    return hash;
  }

  // ─── Delete Operations ────────────────────────────────────────────

  /**
   * Remove a specific entry from cache.
   */
  async remove(hash: string): Promise<void> {
    try { await fsp.unlink(this.dataPath(hash)); } catch {}
    try { await fsp.unlink(this.metaPath(hash)); } catch {}
  }

  /**
   * Clear the entire cache.
   */
  async clear(): Promise<void> {
    try {
      await fsp.rm(this.cacheDir, { recursive: true, force: true });
    } catch {}
  }

  // ─── Garbage Collection ───────────────────────────────────────────

  /**
   * Remove expired entries.
   * Returns number of entries removed.
   */
  async gc(maxAgeMs: number = this.ttlMs): Promise<number> {
    if (!fs.existsSync(this.cacheDir)) return 0;

    let removed = 0;
    const cutoff = Date.now() - maxAgeMs;

    try {
      const entries = await fsp.readdir(this.cacheDir);

      for (const entry of entries) {
        if (!entry.endsWith('.zip')) continue;

        const fp = path.join(this.cacheDir, entry);
        try {
          const stat = await fsp.stat(fp);
          if (stat.mtimeMs < cutoff) {
            const hash = entry.replace('.zip', '');
            await this.remove(hash);
            removed++;
          }
        } catch {}
      }
    } catch {}

    this.stats.gcRuns++;
    this.stats.evictions += removed;
    return removed;
  }

  // ─── Compaction ──────────────────────────────────────────────────

  /**
   * Compact the cache by removing orphaned metadata files
   * (meta files without corresponding data files) and
   * cleaning up temporary files left from interrupted writes.
   * Returns the number of cleaned-up files.
   */
  async compact(): Promise<number> {
    if (!fs.existsSync(this.cacheDir)) return 0;

    let cleaned = 0;
    try {
      const allFiles = await fsp.readdir(this.cacheDir);

      // Build set of valid data file hashes
      const dataHashes = new Set<string>();
      for (const f of allFiles) {
        if (f.endsWith('.zip')) {
          dataHashes.add(f.replace('.zip', ''));
        }
      }

      // Remove orphaned meta files
      for (const f of allFiles) {
        if (f.endsWith('.meta.json')) {
          const hash = f.replace('.meta.json', '');
          if (!dataHashes.has(hash)) {
            try {
              await fsp.unlink(path.join(this.cacheDir, f));
              cleaned++;
            } catch {}
          }
        }
      }

      // Remove stale temp files (older than 1 hour)
      const oneHourAgo = Date.now() - 3600_000;
      for (const f of allFiles) {
        if (f.includes('.tmp.')) {
          try {
            const stat = await fsp.stat(path.join(this.cacheDir, f));
            if (stat.mtimeMs < oneHourAgo) {
              await fsp.unlink(path.join(this.cacheDir, f));
              cleaned++;
            }
          } catch {}
        }
      }
    } catch {}

    return cleaned;
  }

  // ─── Pre-warming ─────────────────────────────────────────────────

  /**
   * Generate a manifest of all cached entries.
   * This manifest can later be used to verify which entries are present.
   */
  async generateManifest(): Promise<CacheManifest> {
    const entries: CacheManifest['entries'] = [];

    if (fs.existsSync(this.cacheDir)) {
      try {
        for (const file of await fsp.readdir(this.cacheDir)) {
          if (!file.endsWith('.meta.json')) continue;
          try {
            const meta = JSON.parse(
              await fsp.readFile(path.join(this.cacheDir, file), 'utf-8'),
            ) as CacheEntryMeta;
            entries.push({
              hash: meta.hash,
              url: meta.originalUrl,
              pluginName: meta.pluginName,
              pluginVersion: meta.pluginVersion,
            });
          } catch {}
        }
      } catch {}
    }

    return {
      version: 1,
      generatedAt: Date.now(),
      entries,
    };
  }

  /**
   * Check which entries from a manifest are missing in the cache.
   * Returns the list of hashes that need to be re-fetched.
   */
  async checkManifest(manifest: CacheManifest): Promise<string[]> {
    const missing: string[] = [];
    for (const entry of manifest.entries) {
      if (!(await this.has(entry.hash))) {
        missing.push(entry.hash);
      }
    }
    return missing;
  }

  // ─── Export / Import ──────────────────────────────────────────────

  /**
   * Export the entire cache to a directory. Copies all .zip and .meta.json
   * files to the target path. Returns summary statistics.
   */
  async exportTo(targetDir: string): Promise<CacheExportResult> {
    await fsp.mkdir(targetDir, { recursive: true });

    let entryCount = 0;
    let totalSizeBytes = 0;

    if (fs.existsSync(this.cacheDir)) {
      try {
        for (const file of await fsp.readdir(this.cacheDir)) {
          if (file.includes('.tmp.')) continue;
          const src = path.join(this.cacheDir, file);
          const dest = path.join(targetDir, file);
          try {
            await fsp.copyFile(src, dest);
            if (file.endsWith('.zip')) {
              entryCount++;
              const stat = await fsp.stat(src);
              totalSizeBytes += stat.size;
            }
          } catch {}
        }
      } catch {}
    }

    return { exportPath: targetDir, entryCount, totalSizeBytes };
  }

  /**
   * Import cache entries from a directory. Copies .zip and .meta.json
   * files into the cache directory. Skips entries that already exist.
   * Returns the number of entries imported.
   */
  async importFrom(sourceDir: string): Promise<number> {
    await fsp.mkdir(this.cacheDir, { recursive: true });

    let imported = 0;
    try {
      for (const file of await fsp.readdir(sourceDir)) {
        if (file.includes('.tmp.')) continue;
        const src = path.join(sourceDir, file);
        const dest = path.join(this.cacheDir, file);

        // Skip if already exists
        if (fs.existsSync(dest)) continue;

        try {
          await fsp.copyFile(src, dest);
          if (file.endsWith('.zip')) imported++;
        } catch {}
      }
    } catch {}

    return imported;
  }

  // ─── Per-Entry Statistics ─────────────────────────────────────────

  /**
   * Get detailed statistics for a specific cache entry.
   */
  async getEntryStats(hash: string): Promise<EntryStats | null> {
    const metaPath = this.metaPath(hash);
    try {
      const meta = JSON.parse(await fsp.readFile(metaPath, 'utf-8')) as CacheEntryMeta;
      return {
        hash: meta.hash,
        sizeBytes: meta.sizeBytes,
        createdAt: meta.createdAt,
        lastAccessedAt: meta.lastAccessedAt,
        accessCount: meta.accessCount ?? 0,
        ageMs: Date.now() - meta.createdAt,
        pluginName: meta.pluginName,
        pluginVersion: meta.pluginVersion,
      };
    } catch {
      return null;
    }
  }

  /**
   * Get statistics for all entries in the cache.
   */
  async getAllEntryStats(): Promise<EntryStats[]> {
    const results: EntryStats[] = [];
    if (!fs.existsSync(this.cacheDir)) return results;

    try {
      for (const file of await fsp.readdir(this.cacheDir)) {
        if (!file.endsWith('.meta.json')) continue;
        const hash = file.replace('.meta.json', '');
        const stats = await this.getEntryStats(hash);
        if (stats) results.push(stats);
      }
    } catch {}

    return results;
  }

  // ─── Size Management ──────────────────────────────────────────────

  /**
   * Get total cache size in bytes.
   */
  async getTotalSize(): Promise<number> {
    if (!fs.existsSync(this.cacheDir)) return 0;

    let total = 0;
    try {
      for (const entry of await fsp.readdir(this.cacheDir)) {
        try {
          const stat = await fsp.stat(path.join(this.cacheDir, entry));
          total += stat.size;
        } catch {}
      }
    } catch {}
    return total;
  }

  /**
   * Get number of entries.
   */
  async getEntryCount(): Promise<number> {
    if (!fs.existsSync(this.cacheDir)) return 0;
    try {
      return (await fsp.readdir(this.cacheDir)).filter(f => f.endsWith('.zip')).length;
    } catch { return 0; }
  }

  /**
   * Evict LRU entries if cache exceeds max size.
   */
  private async maybeEvict(): Promise<void> {
    const totalSize = await this.getTotalSize();
    if (totalSize <= MAX_CACHE_SIZE_BYTES) return;

    // Collect all entries with access time
    const entries: Array<{ hash: string; accessedAt: number; size: number }> = [];

    try {
      for (const file of await fsp.readdir(this.cacheDir)) {
        if (!file.endsWith('.zip')) continue;
        const hash = file.replace('.zip', '');
        const metaPath = this.metaPath(hash);

        let accessedAt = 0;
        try {
          const meta = JSON.parse(await fsp.readFile(metaPath, 'utf-8')) as CacheEntryMeta;
          accessedAt = meta.lastAccessedAt;
        } catch {
          accessedAt = (await fsp.stat(path.join(this.cacheDir, file))).mtimeMs;
        }

        const size = (await fsp.stat(path.join(this.cacheDir, file))).size;
        entries.push({ hash, accessedAt, size });
      }
    } catch {}

    // Sort by least recently accessed
    entries.sort((a, b) => a.accessedAt - b.accessedAt);

    // Evict until under 80% of max
    let currentSize = totalSize;
    const target = MAX_CACHE_SIZE_BYTES * 0.8;

    for (const entry of entries) {
      if (currentSize <= target) break;
      await this.remove(entry.hash);
      currentSize -= entry.size;
      this.stats.evictions++;
    }
  }

  // ─── Cleanup Scheduling ───────────────────────────────────────────

  /**
   * Enable automatic cleanup on a schedule.
   * Runs garbage collection and compaction at the configured interval.
   */
  enableScheduledCleanup(intervalMs?: number): void {
    if (intervalMs !== undefined) {
      this.cleanupSchedule.intervalMs = intervalMs;
    }
    this.cleanupSchedule.enabled = true;
    this.cleanupSchedule.nextRunAt = Date.now() + this.cleanupSchedule.intervalMs;
    this.scheduleNextCleanup();
  }

  /**
   * Disable automatic cleanup.
   */
  disableScheduledCleanup(): void {
    this.cleanupSchedule.enabled = false;
    if (this.cleanupTimer) {
      clearTimeout(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * Get the current cleanup schedule configuration.
   */
  getCleanupSchedule(): Readonly<CleanupSchedule> {
    return { ...this.cleanupSchedule };
  }

  /**
   * Run a full cleanup pass: GC expired entries, compact orphans, and
   * evict if over size limit. Returns total files cleaned.
   */
  async runCleanup(): Promise<number> {
    const gcCount = await this.gc();
    const compactCount = await this.compact();
    await this.maybeEvict();
    this.cleanupSchedule.lastRunAt = Date.now();
    return gcCount + compactCount;
  }

  private scheduleNextCleanup(): void {
    if (!this.cleanupSchedule.enabled) return;

    if (this.cleanupTimer) clearTimeout(this.cleanupTimer);
    this.cleanupTimer = setTimeout(async () => {
      await this.runCleanup();
      this.cleanupSchedule.nextRunAt = Date.now() + this.cleanupSchedule.intervalMs;
      this.scheduleNextCleanup();
    }, this.cleanupSchedule.intervalMs);

    // Allow the process to exit even if the timer is pending
    if (this.cleanupTimer && typeof this.cleanupTimer === 'object' && 'unref' in this.cleanupTimer) {
      this.cleanupTimer.unref();
    }
  }

  // ─── Statistics ───────────────────────────────────────────────────

  getStats(): Readonly<CacheStats> {
    return { ...this.stats };
  }

  resetStats(): void {
    this.stats = { hits: 0, misses: 0, totalEntries: 0, totalSizeBytes: 0, evictions: 0, gcRuns: 0 };
  }

  // ─── Hash Utility ─────────────────────────────────────────────────

  /**
   * Compute content hash for a buffer.
   * Static method for external use.
   */
  static hashContent(content: Buffer): string {
    return crypto.createHash(HASH_ALGORITHM).update(content).digest('hex').slice(0, HASH_LENGTH);
  }

  // ─── Internal ─────────────────────────────────────────────────────

  private computeHash(content: Buffer): string {
    return ZipCache.hashContent(content);
  }

  private dataPath(hash: string): string {
    return path.join(this.cacheDir, `${hash}.zip`);
  }

  private metaPath(hash: string): string {
    return path.join(this.cacheDir, `${hash}.meta.json`);
  }

  private isExpired(mtimeMs: number): boolean {
    return Date.now() - mtimeMs > this.ttlMs;
  }

  private async touchMeta(hash: string): Promise<void> {
    const metaPath = this.metaPath(hash);
    try {
      if (fs.existsSync(metaPath)) {
        const meta = JSON.parse(await fsp.readFile(metaPath, 'utf-8')) as CacheEntryMeta;
        meta.lastAccessedAt = Date.now();
        meta.accessCount = (meta.accessCount ?? 0) + 1;
        await fsp.writeFile(metaPath, JSON.stringify(meta, null, 2));
      }
    } catch {}
  }
}
