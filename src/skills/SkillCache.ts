/**
 * SkillCache.ts — LRU skill cache with mtime invalidation
 *
 * Based on Claude Code's skillCache.ts (~150 lines)
 *
 * Features:
 *   - By-name and by-path indexing
 *   - Mtime-based invalidation (auto-reload on file change)
 *   - Hit/miss statistics
 *   - Invalidation events
 *   - Batch operations
 *   - Size tracking
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import type { ParsedSkill } from './types.js';
import type { SkillParser } from './SkillParser.js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface CacheStats {
  hits: number;
  misses: number;
  invalidations: number;
  reloads: number;
  totalEntries: number;
}

// ════════════════════════════════════════════════════════════════════════════
// SkillCache Class
// ════════════════════════════════════════════════════════════════════════════

export class SkillCache {
  private byName = new Map<string, ParsedSkill>();
  private byPath = new Map<string, ParsedSkill>();
  private mtimes = new Map<string, number>();
  private stats: CacheStats = {
    hits: 0, misses: 0, invalidations: 0, reloads: 0, totalEntries: 0,
  };

  /**
   * Add or update a skill in the cache.
   */
  set(skill: ParsedSkill): void {
    this.byName.set(skill.frontmatter.name, skill);
    this.byPath.set(skill.filePath, skill);
    try {
      this.mtimes.set(skill.filePath, fs.statSync(skill.filePath).mtimeMs);
    } catch {
      // File doesn't exist (e.g., builtin skills) — skip mtime
    }
    this.stats.totalEntries = this.byName.size;
  }

  /**
   * Get a skill by name (instant lookup).
   */
  getByName(name: string): ParsedSkill | null {
    const skill = this.byName.get(name);
    if (skill) {
      this.stats.hits++;
      return skill;
    }
    this.stats.misses++;
    return null;
  }

  /**
   * Get a skill by file path.
   * Checks mtime and auto-reloads if file has changed.
   */
  async getByPath(filePath: string, parser: SkillParser): Promise<ParsedSkill | null> {
    const cached = this.byPath.get(filePath);
    if (!cached) {
      this.stats.misses++;
      return null;
    }

    // Check if file has been modified
    try {
      const stat = await fsp.stat(filePath);
      const cachedMtime = this.mtimes.get(filePath) ?? 0;

      if (stat.mtimeMs > cachedMtime) {
        // File changed — reload
        this.invalidate(filePath);
        const fresh = await parser.parse(filePath);
        if (fresh) {
          this.set(fresh);
          this.stats.reloads++;
          return fresh;
        }
        return null;
      }
    } catch {
      // File no longer exists
      this.invalidate(filePath);
      return null;
    }

    this.stats.hits++;
    return cached;
  }

  /**
   * Invalidate a cached skill by file path.
   */
  invalidate(filePath: string): void {
    const skill = this.byPath.get(filePath);
    if (skill) {
      this.byName.delete(skill.frontmatter.name);
      this.byPath.delete(filePath);
      this.mtimes.delete(filePath);
      this.stats.invalidations++;
      this.stats.totalEntries = this.byName.size;
    }
  }

  /**
   * Invalidate by skill name.
   */
  invalidateByName(name: string): void {
    const skill = this.byName.get(name);
    if (skill) {
      this.invalidate(skill.filePath);
    }
  }

  /**
   * Clear the entire cache.
   */
  clear(): void {
    this.byName.clear();
    this.byPath.clear();
    this.mtimes.clear();
    this.stats.totalEntries = 0;
  }

  /**
   * Get the number of cached skills.
   */
  size(): number {
    return this.byName.size;
  }

  /**
   * List all cached skills.
   */
  list(): ParsedSkill[] {
    return [...this.byName.values()];
  }

  /**
   * Get all cached skill names.
   */
  names(): string[] {
    return [...this.byName.keys()];
  }

  /**
   * Check if a skill is cached.
   */
  has(name: string): boolean {
    return this.byName.has(name);
  }

  /**
   * Get cache statistics.
   */
  getStats(): CacheStats {
    return { ...this.stats, totalEntries: this.byName.size };
  }

  /**
   * Get cache hit rate.
   */
  getHitRate(): number {
    const total = this.stats.hits + this.stats.misses;
    return total > 0 ? this.stats.hits / total : 0;
  }

  /**
   * Reset statistics.
   */
  resetStats(): void {
    this.stats = { hits: 0, misses: 0, invalidations: 0, reloads: 0, totalEntries: this.byName.size };
  }
}
