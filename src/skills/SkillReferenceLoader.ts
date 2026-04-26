/**
 * SkillReferenceLoader.ts — Load skill reference files on demand
 *
 * Based on Claude Code's skillReferenceLoader.ts (~150 lines)
 *
 * Reference files are additional context files that a skill can declare.
 * They're loaded on demand (not at discovery time) to save memory.
 *
 * Features:
 *   - Load single or multiple references
 *   - Size limits (max 100KB per file)
 *   - Token estimation
 *   - Caching of loaded references
 *   - File type detection
 *   - Error handling (skip unloadable refs)
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import type { SkillReference } from './types.js';
import { MAX_REFERENCE_FILE_SIZE } from './types.js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface LoadStats {
  totalLoaded: number;
  totalSkipped: number;
  totalBytes: number;
  totalTokens: number;
}

// ════════════════════════════════════════════════════════════════════════════
// SkillReferenceLoader Class
// ════════════════════════════════════════════════════════════════════════════

export class SkillReferenceLoader {
  private loadedCache = new Map<string, SkillReference>();
  private stats: LoadStats = { totalLoaded: 0, totalSkipped: 0, totalBytes: 0, totalTokens: 0 };

  /**
   * Load a single reference file.
   * Returns the reference with content populated (or unchanged if already loaded/failed).
   */
  async load(ref: SkillReference): Promise<SkillReference> {
    // Already loaded
    if (ref.loaded && ref.content) return ref;

    // Check cache
    const cached = this.loadedCache.get(ref.path);
    if (cached) return cached;

    try {
      // Check file exists
      if (!fs.existsSync(ref.path)) {
        this.stats.totalSkipped++;
        return ref;
      }

      // Check size
      const stat = await fsp.stat(ref.path);
      if (stat.size > MAX_REFERENCE_FILE_SIZE) {
        console.warn(`[SkillReferenceLoader] Reference too large: ${ref.path} (${stat.size} bytes)`);
        this.stats.totalSkipped++;
        return ref;
      }

      // Load content
      const content = await fsp.readFile(ref.path, 'utf-8');
      const tokens = Math.ceil(content.length / 4);

      const loaded: SkillReference = {
        ...ref,
        content,
        tokens,
        loaded: true,
      };

      // Cache
      this.loadedCache.set(ref.path, loaded);

      this.stats.totalLoaded++;
      this.stats.totalBytes += stat.size;
      this.stats.totalTokens += tokens;

      return loaded;
    } catch (err) {
      console.warn(`[SkillReferenceLoader] Failed to load ${ref.path}: ${(err as Error).message}`);
      this.stats.totalSkipped++;
      return ref;
    }
  }

  /**
   * Load multiple references.
   */
  async loadMany(refs: SkillReference[]): Promise<SkillReference[]> {
    return Promise.all(refs.map(r => this.load(r)));
  }

  /**
   * Clear the reference cache.
   */
  clearCache(): void {
    this.loadedCache.clear();
  }

  /**
   * Get loading statistics.
   */
  getStats(): LoadStats {
    return { ...this.stats };
  }

  /**
   * Invalidate a specific cached reference.
   */
  invalidate(refPath: string): void {
    this.loadedCache.delete(refPath);
  }

  /**
   * Get cache size.
   */
  getCacheSize(): number {
    return this.loadedCache.size;
  }
}
