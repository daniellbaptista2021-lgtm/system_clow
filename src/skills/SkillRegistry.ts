/**
 * SkillRegistry.ts — Global registry of loaded skills
 *
 * Based on Claude Code's skillRegistry.ts (~150 lines)
 *
 * Features:
 *   - Load/store all discovered skills
 *   - Lookup by name, category, tag
 *   - Track which skills have been invoked this session
 *   - Search by keyword
 *   - Statistics
 *   - Skill enable/disable
 */

import { SkillCache } from './SkillCache.js';
import type { ParsedSkill, SkillCategory } from './types.js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface RegistryStats {
  total: number;
  byCategory: Record<string, number>;
  bySource: Record<string, number>;
  invokedCount: number;
  alwaysActiveCount: number;
}

// ════════════════════════════════════════════════════════════════════════════
// SkillRegistry Class
// ════════════════════════════════════════════════════════════════════════════

export class SkillRegistry {
  private cache: SkillCache;
  private invoked = new Set<string>();
  private disabled = new Set<string>();
  private loaded = false;

  constructor(cache?: SkillCache) {
    this.cache = cache ?? new SkillCache();
  }

  /**
   * Load all skills into the registry.
   * Replaces any existing skills.
   */
  async loadAll(skills: ParsedSkill[]): Promise<void> {
    this.cache.clear();
    for (const skill of skills) {
      this.cache.set(skill);
    }
    this.loaded = true;
  }

  /**
   * Get a skill by exact name.
   */
  getByName(name: string): ParsedSkill | null {
    return this.cache.getByName(name);
  }

  /**
   * List all skills.
   */
  list(): ParsedSkill[] {
    return this.cache.list();
  }

  /**
   * List only active (non-disabled) skills.
   */
  listActive(): ParsedSkill[] {
    return this.list().filter(s => !this.disabled.has(s.frontmatter.name));
  }

  /**
   * List skills by category.
   */
  listByCategory(category: SkillCategory): ParsedSkill[] {
    return this.list().filter(s => s.frontmatter.category === category);
  }

  /**
   * List skills by tag.
   */
  listByTag(tag: string): ParsedSkill[] {
    return this.list().filter(s => s.frontmatter.tags?.includes(tag));
  }

  /**
   * List skills by source.
   */
  listBySource(source: string): ParsedSkill[] {
    return this.list().filter(s => s.frontmatter.source === source);
  }

  /**
   * Search skills by keyword (searches name, description, tags).
   */
  search(query: string): ParsedSkill[] {
    const q = query.toLowerCase();
    return this.list().filter(s => {
      if (s.frontmatter.name.toLowerCase().includes(q)) return true;
      if (s.frontmatter.description.toLowerCase().includes(q)) return true;
      if (s.frontmatter.tags?.some(t => t.toLowerCase().includes(q))) return true;
      return false;
    });
  }

  // ─── Invocation Tracking and Statistics ──────────────────────────

  markInvoked(name: string): void {
    this.invoked.add(name);
  }

  getInvoked(): string[] {
    return [...this.invoked];
  }

  isInvoked(name: string): boolean {
    return this.invoked.has(name);
  }

  clearInvoked(): void {
    this.invoked.clear();
  }

  // ─── Enable/Disable ──────────────────────────────────────────────

  disable(name: string): void {
    this.disabled.add(name);
  }

  enable(name: string): void {
    this.disabled.delete(name);
  }

  isDisabled(name: string): boolean {
    return this.disabled.has(name);
  }

  // ─── Statistics ──────────────────────────────────────────────────

  getStats(): RegistryStats {
    const skills = this.list();
    const byCategory: Record<string, number> = {};
    const bySource: Record<string, number> = {};
    let alwaysActive = 0;

    for (const s of skills) {
      const cat = s.frontmatter.category ?? 'unknown';
      byCategory[cat] = (byCategory[cat] ?? 0) + 1;
      const src = s.frontmatter.source ?? 'unknown';
      bySource[src] = (bySource[src] ?? 0) + 1;
      if (s.frontmatter.always_active) alwaysActive++;
    }

    return {
      total: skills.length,
      byCategory,
      bySource,
      invokedCount: this.invoked.size,
      alwaysActiveCount: alwaysActive,
    };
  }

  // ─── State ───────────────────────────────────────────────────────

  isLoaded(): boolean { return this.loaded; }
  size(): number { return this.cache.size(); }
  clear(): void { this.cache.clear(); this.invoked.clear(); this.loaded = false; }
}
