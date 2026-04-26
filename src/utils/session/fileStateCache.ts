/**
 * fileStateCache.ts — LRU file state cache with mtime validation + content hash
 *
 * Features:
 *   - LRU eviction with configurable capacity
 *   - Mtime-based invalidation
 *   - Content hash for change detection
 *   - Batch invalidation
 *   - Cache statistics per tool
 *   - File change detection
 *   - Gitignore-aware caching
 *   - Cache warmup from recent files
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface FileStateCacheEntry {
  path: string; content: string; contentHash: string;
  mtimeMs: number; sizeBytes: number; lastReadAt: number;
  lastReadByTool: string; lineCount: number;
}

/** Per-tool cache statistics */
interface ToolCacheStats {
  toolName: string;
  hits: number;
  misses: number;
  puts: number;
  invalidations: number;
  totalBytesRead: number;
}

/** Global cache statistics */
interface CacheStatistics {
  totalHits: number;
  totalMisses: number;
  totalPuts: number;
  totalInvalidations: number;
  totalEvictions: number;
  currentSize: number;
  capacity: number;
  hitRate: number;
  totalBytesStored: number;
  perTool: ToolCacheStats[];
  warmupCount: number;
}

/** Result of a file change detection scan */
interface ChangeDetectionResult {
  changed: string[];
  deleted: string[];
  unchanged: string[];
  scannedAt: number;
  durationMs: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** Default patterns to ignore (similar to common .gitignore entries) */
const DEFAULT_IGNORE_PATTERNS = [
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.cache',
  'coverage',
  '__pycache__',
  '.DS_Store',
  'Thumbs.db',
];

// ════════════════════════════════════════════════════════════════════════════
// FileStateCache Class
// ════════════════════════════════════════════════════════════════════════════

export class FileStateCache {
  private entries = new Map<string, FileStateCacheEntry>();
  private order: string[] = [];

  // Statistics tracking
  private toolStats = new Map<string, ToolCacheStats>();
  private globalHits = 0;
  private globalMisses = 0;
  private globalPuts = 0;
  private globalInvalidations = 0;
  private globalEvictions = 0;
  private warmupCount = 0;

  // Gitignore patterns
  private ignorePatterns: string[] = [...DEFAULT_IGNORE_PATTERNS];
  private gitignoreLoaded = false;

  constructor(public readonly capacity: number = 100) {}

  // ─── Core Operations ────────────────────────────────────────────

  async get(filePath: string): Promise<FileStateCacheEntry | null> {
    const e = this.entries.get(filePath);
    if (!e) {
      this.globalMisses++;
      return null;
    }
    try {
      const st = await fsp.stat(filePath);
      if (st.mtimeMs !== e.mtimeMs) { this.invalidate(filePath); this.globalMisses++; return null; }
    } catch { this.invalidate(filePath); this.globalMisses++; return null; }

    this.globalHits++;
    this.recordToolHit(e.lastReadByTool);
    this.touch(filePath);
    return e;
  }

  async put(filePath: string, content: string, toolName: string): Promise<FileStateCacheEntry> {
    const st = await fsp.stat(filePath);
    const entry: FileStateCacheEntry = {
      path: filePath, content,
      contentHash: crypto.createHash('sha256').update(content).digest('hex').slice(0, 16),
      mtimeMs: st.mtimeMs, sizeBytes: st.size,
      lastReadAt: Date.now(), lastReadByTool: toolName,
      lineCount: content.split('\n').length,
    };
    if (this.entries.size >= this.capacity && !this.entries.has(filePath)) this.evict();
    this.entries.set(filePath, entry);
    this.touch(filePath);

    this.globalPuts++;
    this.recordToolPut(toolName, st.size);

    return entry;
  }

  invalidate(p: string): void {
    const entry = this.entries.get(p);
    this.entries.delete(p);
    const i = this.order.indexOf(p);
    if (i >= 0) this.order.splice(i, 1);

    this.globalInvalidations++;
    if (entry) {
      this.recordToolInvalidation(entry.lastReadByTool);
    }
  }

  clear(): void { this.entries.clear(); this.order = []; }
  size(): number { return this.entries.size; }

  getRecentlyRead(limit = 10): FileStateCacheEntry[] {
    return [...this.order].reverse().slice(0, limit).map(p => this.entries.get(p)).filter((e): e is FileStateCacheEntry => !!e);
  }

  clone(): FileStateCache {
    const c = new FileStateCache(this.capacity);
    c.entries = new Map(this.entries);
    c.order = [...this.order];
    return c;
  }

  serialize(): string { return JSON.stringify({ cap: this.capacity, entries: [...this.entries], order: this.order }); }

  static async deserialize(json: string): Promise<FileStateCache> {
    const d = JSON.parse(json);
    const c = new FileStateCache(d.cap);
    c.entries = new Map(d.entries);
    c.order = d.order;
    const bad: string[] = [];
    for (const [p, e] of c.entries) {
      try { const st = await fsp.stat(p); if (st.mtimeMs !== e.mtimeMs) bad.push(p); } catch { bad.push(p); }
    }
    for (const p of bad) c.invalidate(p);
    return c;
  }

  // ─── Batch Invalidation ─────────────────────────────────────────

  /**
   * Invalidate multiple cache entries at once.
   * More efficient than calling invalidate() in a loop.
   */
  batchInvalidate(paths: string[]): number {
    let count = 0;
    for (const p of paths) {
      if (this.entries.has(p)) {
        this.invalidate(p);
        count++;
      }
    }
    return count;
  }

  /**
   * Invalidate all entries matching a directory prefix.
   */
  invalidateByDirectory(dirPath: string): number {
    const normalized = dirPath.replace(/\\/g, '/');
    const toInvalidate: string[] = [];

    for (const p of this.entries.keys()) {
      const normalizedP = p.replace(/\\/g, '/');
      if (normalizedP.startsWith(normalized)) {
        toInvalidate.push(p);
      }
    }

    return this.batchInvalidate(toInvalidate);
  }

  /**
   * Invalidate all entries matching a file extension.
   */
  invalidateByExtension(ext: string): number {
    const normalizedExt = ext.startsWith('.') ? ext : `.${ext}`;
    const toInvalidate: string[] = [];

    for (const p of this.entries.keys()) {
      if (p.endsWith(normalizedExt)) {
        toInvalidate.push(p);
      }
    }

    return this.batchInvalidate(toInvalidate);
  }

  /**
   * Invalidate all entries read by a specific tool.
   */
  invalidateByTool(toolName: string): number {
    const toInvalidate: string[] = [];

    for (const [p, entry] of this.entries) {
      if (entry.lastReadByTool === toolName) {
        toInvalidate.push(p);
      }
    }

    return this.batchInvalidate(toInvalidate);
  }

  // ─── Cache Statistics Per Tool ──────────────────────────────────

  /**
   * Get cache statistics broken down by tool.
   */
  getStatistics(): CacheStatistics {
    let totalBytesStored = 0;
    for (const entry of this.entries.values()) {
      totalBytesStored += entry.sizeBytes;
    }

    const totalRequests = this.globalHits + this.globalMisses;

    return {
      totalHits: this.globalHits,
      totalMisses: this.globalMisses,
      totalPuts: this.globalPuts,
      totalInvalidations: this.globalInvalidations,
      totalEvictions: this.globalEvictions,
      currentSize: this.entries.size,
      capacity: this.capacity,
      hitRate: totalRequests > 0 ? this.globalHits / totalRequests : 0,
      totalBytesStored,
      perTool: [...this.toolStats.values()],
      warmupCount: this.warmupCount,
    };
  }

  /**
   * Get statistics for a specific tool.
   */
  getToolStats(toolName: string): ToolCacheStats | null {
    return this.toolStats.get(toolName) ?? null;
  }

  /**
   * Reset all statistics counters.
   */
  resetStatistics(): void {
    this.globalHits = 0;
    this.globalMisses = 0;
    this.globalPuts = 0;
    this.globalInvalidations = 0;
    this.globalEvictions = 0;
    this.warmupCount = 0;
    this.toolStats.clear();
  }

  private getOrCreateToolStats(toolName: string): ToolCacheStats {
    let stats = this.toolStats.get(toolName);
    if (!stats) {
      stats = { toolName, hits: 0, misses: 0, puts: 0, invalidations: 0, totalBytesRead: 0 };
      this.toolStats.set(toolName, stats);
    }
    return stats;
  }

  private recordToolHit(toolName: string): void {
    this.getOrCreateToolStats(toolName).hits++;
  }

  private recordToolMiss(toolName: string): void {
    this.getOrCreateToolStats(toolName).misses++;
  }

  private recordToolPut(toolName: string, bytes: number): void {
    const stats = this.getOrCreateToolStats(toolName);
    stats.puts++;
    stats.totalBytesRead += bytes;
  }

  private recordToolInvalidation(toolName: string): void {
    this.getOrCreateToolStats(toolName).invalidations++;
  }

  // ─── File Change Detection ──────────────────────────────────────

  /**
   * Scan all cached files and detect which have changed, been deleted, or remain unchanged.
   */
  async detectChanges(): Promise<ChangeDetectionResult> {
    const startTime = Date.now();
    const changed: string[] = [];
    const deleted: string[] = [];
    const unchanged: string[] = [];

    for (const [filePath, entry] of this.entries) {
      try {
        const stat = await fsp.stat(filePath);
        if (stat.mtimeMs !== entry.mtimeMs) {
          changed.push(filePath);
        } else {
          unchanged.push(filePath);
        }
      } catch {
        deleted.push(filePath);
      }
    }

    return {
      changed,
      deleted,
      unchanged,
      scannedAt: Date.now(),
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Detect changes and automatically invalidate stale entries.
   * Returns the number of entries invalidated.
   */
  async detectAndInvalidate(): Promise<number> {
    const result = await this.detectChanges();
    const toInvalidate = [...result.changed, ...result.deleted];
    return this.batchInvalidate(toInvalidate);
  }

  /**
   * Check if a specific file has changed since it was cached.
   */
  async hasFileChanged(filePath: string): Promise<boolean> {
    const entry = this.entries.get(filePath);
    if (!entry) return true; // Not cached means "changed" (unknown state)

    try {
      const stat = await fsp.stat(filePath);
      return stat.mtimeMs !== entry.mtimeMs;
    } catch {
      return true; // File deleted
    }
  }

  // ─── Gitignore-Aware Caching ────────────────────────────────────

  /**
   * Load .gitignore patterns from a workspace.
   */
  async loadGitignore(workspaceRoot: string): Promise<void> {
    const gitignorePath = path.join(workspaceRoot, '.gitignore');

    this.ignorePatterns = [...DEFAULT_IGNORE_PATTERNS];

    try {
      if (fs.existsSync(gitignorePath)) {
        const content = await fsp.readFile(gitignorePath, 'utf-8');
        const lines = content.split('\n')
          .map(l => l.trim())
          .filter(l => l && !l.startsWith('#'));

        for (const line of lines) {
          // Strip leading/trailing slashes for simple matching
          const pattern = line.replace(/^\/+|\/+$/g, '');
          if (pattern) {
            this.ignorePatterns.push(pattern);
          }
        }
      }
    } catch { /* ignore */ }

    this.gitignoreLoaded = true;
  }

  /**
   * Check if a file path should be ignored based on gitignore patterns.
   */
  shouldIgnore(filePath: string): boolean {
    const normalized = filePath.replace(/\\/g, '/');

    for (const pattern of this.ignorePatterns) {
      // Simple substring match for directory names
      if (normalized.includes(`/${pattern}/`) || normalized.endsWith(`/${pattern}`)) {
        return true;
      }
      // Exact filename match
      if (path.basename(normalized) === pattern) {
        return true;
      }
    }

    return false;
  }

  /**
   * Put a file into cache only if it is not gitignored.
   */
  async putIfNotIgnored(filePath: string, content: string, toolName: string): Promise<FileStateCacheEntry | null> {
    if (this.shouldIgnore(filePath)) return null;
    return this.put(filePath, content, toolName);
  }

  /**
   * Get the loaded ignore patterns.
   */
  getIgnorePatterns(): string[] {
    return [...this.ignorePatterns];
  }

  // ─── Cache Warmup ───────────────────────────────────────────────

  /**
   * Warm up the cache by reading recently modified files in a directory.
   * Reads up to `limit` files sorted by modification time (newest first).
   */
  async warmup(
    directory: string,
    options?: {
      limit?: number;
      extensions?: string[];
      toolName?: string;
      maxFileSizeBytes?: number;
    },
  ): Promise<number> {
    const limit = options?.limit ?? 20;
    const extensions = options?.extensions ?? ['.ts', '.tsx', '.js', '.jsx', '.json', '.md'];
    const toolName = options?.toolName ?? 'warmup';
    const maxFileSize = options?.maxFileSizeBytes ?? 500_000; // 500KB

    if (!fs.existsSync(directory)) return 0;

    // Collect candidate files
    const candidates: Array<{ filePath: string; mtimeMs: number }> = [];

    try {
      const entries = await fsp.readdir(directory, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isDirectory()) {
          // Skip ignored directories
          if (this.ignorePatterns.includes(entry.name)) continue;
          continue; // Only scan top-level for warmup
        }

        if (!entry.isFile()) continue;

        const ext = path.extname(entry.name);
        if (extensions.length > 0 && !extensions.includes(ext)) continue;

        const filePath = path.join(directory, entry.name);
        if (this.shouldIgnore(filePath)) continue;

        try {
          const stat = await fsp.stat(filePath);
          if (stat.size > maxFileSize) continue;
          candidates.push({ filePath, mtimeMs: stat.mtimeMs });
        } catch { /* skip */ }
      }
    } catch {
      return 0;
    }

    // Sort by mtime (newest first) and take limit
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const toWarm = candidates.slice(0, limit);

    let warmed = 0;
    for (const { filePath } of toWarm) {
      // Skip if already cached
      if (this.entries.has(filePath)) continue;

      try {
        const content = await fsp.readFile(filePath, 'utf-8');
        await this.put(filePath, content, toolName);
        warmed++;
      } catch { /* skip binary or unreadable files */ }
    }

    this.warmupCount += warmed;
    return warmed;
  }

  /**
   * Warm up cache from a list of specific file paths.
   */
  async warmupFiles(filePaths: string[], toolName: string = 'warmup'): Promise<number> {
    let warmed = 0;

    for (const filePath of filePaths) {
      if (this.entries.has(filePath)) continue;
      if (this.shouldIgnore(filePath)) continue;

      try {
        const content = await fsp.readFile(filePath, 'utf-8');
        await this.put(filePath, content, toolName);
        warmed++;
      } catch { /* skip */ }
    }

    this.warmupCount += warmed;
    return warmed;
  }

  // ─── Internal ───────────────────────────────────────────────────

  private touch(p: string): void {
    const i = this.order.indexOf(p);
    if (i >= 0) this.order.splice(i, 1);
    this.order.push(p);
  }

  private evict(): void {
    if (this.order.length === 0) return;
    const lru = this.order.shift()!;
    this.entries.delete(lru);
    this.globalEvictions++;
  }
}
