/**
 * toolResultCache.ts — In-memory cache for tool results
 *
 * Caches results of Read, Glob, Grep tools for 5 minutes.
 * Eliminates redundant tool calls within the same session.
 * Cache is per-session to avoid cross-session data leakage.
 *
 * Only caches READ-ONLY tools. Write/Edit/Bash are never cached.
 */

import { createLogger } from '../utils/logger.js';

const log = createLogger('ToolCache');

// ════════════════════════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════════════════════════

interface CacheEntry {
  result: unknown;
  cachedAt: number;
  hitCount: number;
}

export interface ToolCacheStats {
  size: number;
  hits: number;
  misses: number;
  hitRate: string;
  evictions: number;
}

// ════════════════════════════════════════════════════════════════════════════
// Constants
// ════════════════════════════════════════════════════════════════════════════

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_ENTRIES = 200;
const CACHEABLE_TOOLS = new Set(['Read', 'FileRead', 'Glob', 'Grep']);

// Tools that INVALIDATE cache entries (because they modify files)
const INVALIDATING_TOOLS = new Set(['Write', 'FileWrite', 'Edit', 'FileEdit', 'Bash']);

// ════════════════════════════════════════════════════════════════════════════
// ToolResultCache Class
// ════════════════════════════════════════════════════════════════════════════

export class ToolResultCache {
  private cache = new Map<string, CacheEntry>();
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private ttlMs: number;

  constructor(ttlMs: number = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  /**
   * Check if a tool result is cached.
   * Returns the cached result or undefined.
   */
  get(toolName: string, toolInput: unknown): unknown | undefined {
    if (!CACHEABLE_TOOLS.has(toolName)) return undefined;

    const key = this.makeKey(toolName, toolInput);
    const entry = this.cache.get(key);

    if (!entry) {
      this.misses++;
      return undefined;
    }

    // Check TTL
    if (Date.now() - entry.cachedAt > this.ttlMs) {
      this.cache.delete(key);
      this.misses++;
      this.evictions++;
      return undefined;
    }

    this.hits++;
    entry.hitCount++;
    return entry.result;
  }

  /**
   * Cache a tool result.
   * Only caches results from cacheable tools.
   */
  set(toolName: string, toolInput: unknown, result: unknown): void {
    if (!CACHEABLE_TOOLS.has(toolName)) return;

    // Don't cache error results
    if (result && typeof result === 'object' && 'error' in (result as any)) return;

    const key = this.makeKey(toolName, toolInput);

    // Evict oldest if at capacity
    if (this.cache.size >= MAX_ENTRIES) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) {
        this.cache.delete(oldestKey);
        this.evictions++;
      }
    }

    this.cache.set(key, { result, cachedAt: Date.now(), hitCount: 0 });
  }

  /**
   * Invalidate cache entries affected by a write operation.
   * Called after Write, Edit, Bash tools to keep cache consistent.
   */
  invalidate(toolName: string, toolInput: unknown): void {
    if (!INVALIDATING_TOOLS.has(toolName)) return;

    if (toolName === 'Bash') {
      // Bash can change anything — clear entire cache
      if (this.cache.size > 0) {
        log.info('Cache cleared after Bash execution', { clearedEntries: this.cache.size });
        this.cache.clear();
      }
      return;
    }

    // For Write/Edit, invalidate entries matching the same file
    const input = toolInput as Record<string, unknown> | null;
    if (!input) return;

    const filePath = (input.file_path || input.path || '') as string;
    if (!filePath) return;

    let invalidated = 0;
    for (const [key] of this.cache) {
      if (key.includes(filePath)) {
        this.cache.delete(key);
        invalidated++;
      }
    }

    if (invalidated > 0) {
      log.info('Cache entries invalidated', { toolName, filePath, invalidated });
    }
  }

  /**
   * Get cache statistics.
   */
  getStats(): ToolCacheStats {
    const total = this.hits + this.misses;
    return {
      size: this.cache.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? `${Math.round((this.hits / total) * 100)}%` : '0%',
      evictions: this.evictions,
    };
  }

  /**
   * Clear the entire cache.
   */
  clear(): void {
    this.cache.clear();
  }

  // ─── Internal ──────────────────────────────────────────────────

  private makeKey(toolName: string, toolInput: unknown): string {
    // Stable serialization for cache key
    const inputStr = typeof toolInput === 'object' && toolInput !== null
      ? JSON.stringify(toolInput, Object.keys(toolInput as object).sort())
      : String(toolInput);
    return `${toolName}::${inputStr}`;
  }
}
