/**
 * ZipCacheAdapters.ts — Storage backend abstraction for ZipCache
 *
 * Based on Claude Code's zipCacheAdapters.ts (350 lines)
 *
 * Backends:
 *   - FilesystemCacheBackend (default, always available)
 *   - MemoryCacheBackend (for testing, no disk I/O)
 *   - TieredCacheBackend (memory + filesystem combined, write-through)
 *   - (future: S3CacheBackend, GCSCacheBackend for cloud)
 *
 * All backends implement the CacheBackend interface:
 *   - read(key) → Buffer | null
 *   - write(key, data) → void
 *   - delete(key) → void
 *   - exists(key) → boolean
 *   - list() → string[]
 *   - size() → number (total bytes)
 *
 * Additional features:
 *   - Cache migration between backends
 *   - Backend health checking
 *   - Throughput tracking per backend
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';

// ─── Interface ──────────────────────────────────────────────────────────────

export interface CacheBackend {
  /** Read data by key. Returns null if not found. */
  read(key: string): Promise<Buffer | null>;
  /** Write data with key. Overwrites if exists. */
  write(key: string, data: Buffer): Promise<void>;
  /** Delete data by key. No-op if not found. */
  delete(key: string): Promise<void>;
  /** Check if key exists. */
  exists(key: string): Promise<boolean>;
  /** List all keys. */
  list(): Promise<string[]>;
  /** Get total size in bytes across all entries. */
  totalSize(): Promise<number>;
  /** Get number of entries. */
  count(): Promise<number>;
  /** Clear all entries. */
  clear(): Promise<void>;
}

// ─── Throughput Tracker ─────────────────────────────────────────────────────

interface ThroughputSnapshot {
  readBytes: number;
  writeBytes: number;
  readOps: number;
  writeOps: number;
  deleteOps: number;
  startedAt: number;
}

export class BackendThroughputTracker {
  private readBytes = 0;
  private writeBytes = 0;
  private readOps = 0;
  private writeOps = 0;
  private deleteOps = 0;
  private startedAt = Date.now();

  recordRead(bytes: number): void {
    this.readBytes += bytes;
    this.readOps++;
  }

  recordWrite(bytes: number): void {
    this.writeBytes += bytes;
    this.writeOps++;
  }

  recordDelete(): void {
    this.deleteOps++;
  }

  getSnapshot(): ThroughputSnapshot {
    return {
      readBytes: this.readBytes,
      writeBytes: this.writeBytes,
      readOps: this.readOps,
      writeOps: this.writeOps,
      deleteOps: this.deleteOps,
      startedAt: this.startedAt,
    };
  }

  /**
   * Get average read throughput in bytes per second since tracking began.
   */
  getReadBytesPerSecond(): number {
    const elapsedSec = (Date.now() - this.startedAt) / 1000;
    return elapsedSec > 0 ? this.readBytes / elapsedSec : 0;
  }

  /**
   * Get average write throughput in bytes per second since tracking began.
   */
  getWriteBytesPerSecond(): number {
    const elapsedSec = (Date.now() - this.startedAt) / 1000;
    return elapsedSec > 0 ? this.writeBytes / elapsedSec : 0;
  }

  reset(): void {
    this.readBytes = 0;
    this.writeBytes = 0;
    this.readOps = 0;
    this.writeOps = 0;
    this.deleteOps = 0;
    this.startedAt = Date.now();
  }
}

// ─── Health Check ───────────────────────────────────────────────────────────

export interface BackendHealthStatus {
  healthy: boolean;
  latencyMs: number;
  errorMessage?: string;
  checkedAt: number;
}

/**
 * Perform a health check on a backend by writing and reading a sentinel value.
 */
export async function checkBackendHealth(backend: CacheBackend): Promise<BackendHealthStatus> {
  const sentinelKey = '__health_check__';
  const sentinelData = Buffer.from('ok');
  const start = Date.now();

  try {
    await backend.write(sentinelKey, sentinelData);
    const readBack = await backend.read(sentinelKey);
    await backend.delete(sentinelKey);

    if (!readBack || readBack.toString() !== 'ok') {
      return {
        healthy: false,
        latencyMs: Date.now() - start,
        errorMessage: 'Read-back verification failed',
        checkedAt: Date.now(),
      };
    }

    return {
      healthy: true,
      latencyMs: Date.now() - start,
      checkedAt: Date.now(),
    };
  } catch (err) {
    return {
      healthy: false,
      latencyMs: Date.now() - start,
      errorMessage: (err as Error).message,
      checkedAt: Date.now(),
    };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Filesystem Backend
// ════════════════════════════════════════════════════════════════════════════

export class FilesystemCacheBackend implements CacheBackend {
  readonly tracker = new BackendThroughputTracker();

  constructor(private readonly dir: string) {}

  async read(key: string): Promise<Buffer | null> {
    try {
      const data = await fsp.readFile(this.keyPath(key));
      this.tracker.recordRead(data.length);
      return data;
    } catch {
      return null;
    }
  }

  async write(key: string, data: Buffer): Promise<void> {
    await fsp.mkdir(this.dir, { recursive: true });
    // Atomic: write to tmp, then rename
    const tmpPath = `${this.keyPath(key)}.tmp.${Date.now()}`;
    try {
      await fsp.writeFile(tmpPath, data);
      await fsp.rename(tmpPath, this.keyPath(key));
      this.tracker.recordWrite(data.length);
    } catch (err) {
      try { await fsp.unlink(tmpPath); } catch {}
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await fsp.unlink(this.keyPath(key));
      this.tracker.recordDelete();
    } catch {}
  }

  async exists(key: string): Promise<boolean> {
    return fs.existsSync(this.keyPath(key));
  }

  async list(): Promise<string[]> {
    if (!fs.existsSync(this.dir)) return [];
    try {
      return (await fsp.readdir(this.dir)).filter(f => !f.includes('.tmp.'));
    } catch {
      return [];
    }
  }

  async totalSize(): Promise<number> {
    const keys = await this.list();
    let total = 0;
    for (const key of keys) {
      try {
        const stat = await fsp.stat(this.keyPath(key));
        total += stat.size;
      } catch {}
    }
    return total;
  }

  async count(): Promise<number> {
    return (await this.list()).length;
  }

  async clear(): Promise<void> {
    try {
      await fsp.rm(this.dir, { recursive: true, force: true });
    } catch {}
  }

  private keyPath(key: string): string {
    // Sanitize key to be filesystem-safe
    const safe = key.replace(/[^a-zA-Z0-9._-]/g, '_');
    return path.join(this.dir, safe);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Memory Backend (for testing)
// ════════════════════════════════════════════════════════════════════════════

export class MemoryCacheBackend implements CacheBackend {
  private store = new Map<string, Buffer>();
  readonly tracker = new BackendThroughputTracker();

  async read(key: string): Promise<Buffer | null> {
    const data = this.store.get(key) ?? null;
    if (data) this.tracker.recordRead(data.length);
    return data;
  }

  async write(key: string, data: Buffer): Promise<void> {
    this.store.set(key, Buffer.from(data));
    this.tracker.recordWrite(data.length);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
    this.tracker.recordDelete();
  }

  async exists(key: string): Promise<boolean> {
    return this.store.has(key);
  }

  async list(): Promise<string[]> {
    return [...this.store.keys()];
  }

  async totalSize(): Promise<number> {
    let total = 0;
    for (const buf of this.store.values()) total += buf.length;
    return total;
  }

  async count(): Promise<number> {
    return this.store.size;
  }

  async clear(): Promise<void> {
    this.store.clear();
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Tiered Cache Backend (Memory + Filesystem)
// ════════════════════════════════════════════════════════════════════════════

/**
 * TieredCacheBackend combines a fast in-memory layer with a durable
 * filesystem layer. Reads check memory first, then fall back to disk.
 * Writes go to both layers (write-through). The memory tier has a
 * configurable max entry count; when exceeded, LRU entries are evicted
 * from memory (but remain on disk).
 */
export class TieredCacheBackend implements CacheBackend {
  private memoryBackend: MemoryCacheBackend;
  private fsBackend: FilesystemCacheBackend;
  private memoryKeys: string[] = []; // LRU order (oldest first)
  private maxMemoryEntries: number;

  constructor(fsDir: string, maxMemoryEntries: number = 200) {
    this.memoryBackend = new MemoryCacheBackend();
    this.fsBackend = new FilesystemCacheBackend(fsDir);
    this.maxMemoryEntries = maxMemoryEntries;
  }

  async read(key: string): Promise<Buffer | null> {
    // Try memory first
    const memResult = await this.memoryBackend.read(key);
    if (memResult) {
      this.touchMemoryLRU(key);
      return memResult;
    }

    // Fall back to filesystem
    const fsResult = await this.fsBackend.read(key);
    if (fsResult) {
      // Promote to memory tier
      await this.memoryBackend.write(key, fsResult);
      this.addToMemoryLRU(key);
      await this.evictMemoryIfNeeded();
    }
    return fsResult;
  }

  async write(key: string, data: Buffer): Promise<void> {
    // Write-through: both tiers
    await this.fsBackend.write(key, data);
    await this.memoryBackend.write(key, data);
    this.addToMemoryLRU(key);
    await this.evictMemoryIfNeeded();
  }

  async delete(key: string): Promise<void> {
    await this.memoryBackend.delete(key);
    await this.fsBackend.delete(key);
    this.removeFromMemoryLRU(key);
  }

  async exists(key: string): Promise<boolean> {
    if (await this.memoryBackend.exists(key)) return true;
    return this.fsBackend.exists(key);
  }

  async list(): Promise<string[]> {
    // Filesystem is the source of truth for listing
    return this.fsBackend.list();
  }

  async totalSize(): Promise<number> {
    return this.fsBackend.totalSize();
  }

  async count(): Promise<number> {
    return this.fsBackend.count();
  }

  async clear(): Promise<void> {
    await this.memoryBackend.clear();
    await this.fsBackend.clear();
    this.memoryKeys = [];
  }

  /**
   * Get the number of entries currently held in the memory tier.
   */
  getMemoryEntryCount(): number {
    return this.memoryKeys.length;
  }

  private addToMemoryLRU(key: string): void {
    this.removeFromMemoryLRU(key);
    this.memoryKeys.push(key);
  }

  private touchMemoryLRU(key: string): void {
    this.removeFromMemoryLRU(key);
    this.memoryKeys.push(key);
  }

  private removeFromMemoryLRU(key: string): void {
    const idx = this.memoryKeys.indexOf(key);
    if (idx >= 0) this.memoryKeys.splice(idx, 1);
  }

  private async evictMemoryIfNeeded(): Promise<void> {
    while (this.memoryKeys.length > this.maxMemoryEntries) {
      const oldest = this.memoryKeys.shift();
      if (oldest) await this.memoryBackend.delete(oldest);
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Cache Migration
// ════════════════════════════════════════════════════════════════════════════

export interface MigrationResult {
  migrated: number;
  skipped: number;
  failed: number;
  durationMs: number;
}

/**
 * Migrate all entries from one backend to another.
 * Does not delete from the source backend.
 * Skips entries that already exist in the destination.
 */
export async function migrateBackend(
  source: CacheBackend,
  destination: CacheBackend,
): Promise<MigrationResult> {
  const startTime = Date.now();
  const keys = await source.list();
  let migrated = 0;
  let skipped = 0;
  let failed = 0;

  for (const key of keys) {
    if (await destination.exists(key)) {
      skipped++;
      continue;
    }

    try {
      const data = await source.read(key);
      if (data) {
        await destination.write(key, data);
        migrated++;
      } else {
        skipped++;
      }
    } catch {
      failed++;
    }
  }

  return {
    migrated,
    skipped,
    failed,
    durationMs: Date.now() - startTime,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Backend Factory
// ════════════════════════════════════════════════════════════════════════════

export type BackendType = 'filesystem' | 'memory' | 'tiered';

export function createCacheBackend(
  type: BackendType,
  config: { dir?: string; maxMemoryEntries?: number } = {},
): CacheBackend {
  switch (type) {
    case 'filesystem':
      if (!config.dir) throw new Error('Filesystem backend requires dir');
      return new FilesystemCacheBackend(config.dir);
    case 'memory':
      return new MemoryCacheBackend();
    case 'tiered':
      if (!config.dir) throw new Error('Tiered backend requires dir');
      return new TieredCacheBackend(config.dir, config.maxMemoryEntries);
    default:
      throw new Error(`Unknown cache backend: ${type}`);
  }
}
