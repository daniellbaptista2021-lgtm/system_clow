/** Match skills against context: keyword, regex, glob, tool_use, always, first_message. */

import type { ParsedSkill, SkillTrigger, SkillContext, SkillMatchResult } from './types.js';

export class SkillMatcher {
  async matchAll(skills: ParsedSkill[], ctx: SkillContext): Promise<SkillMatchResult[]> {
    const results: SkillMatchResult[] = [];
    for (const s of skills) {
      if (!this.tierOk(s, ctx.tier)) continue;
      if (s.frontmatter.always_active) { results.push({ skill: s, score: 1, matchedTriggers: [], matchedTerms: ['always_active'] }); continue; }
      if (!s.frontmatter.triggers?.length) continue;
      const r = this.matchSkill(s, ctx);
      if (r.score > 0) results.push(r);
    }
    return results.sort((a, b) => b.score - a.score);
  }

  private matchSkill(skill: ParsedSkill, ctx: SkillContext): SkillMatchResult {
    const matched: SkillTrigger[] = [], terms: string[] = [];
    let total = 0;
    for (const t of skill.frontmatter.triggers ?? []) {
      const s = this.evalTrigger(t, ctx, terms);
      if (s > 0) { total += s * (t.weight ?? 1); matched.push(t); }
    }
    const norm = matched.length > 0 ? Math.min(1, total / Math.max(1, skill.frontmatter.triggers!.length)) : 0;
    return { skill, score: norm, matchedTriggers: matched, matchedTerms: terms };
  }

  private evalTrigger(t: SkillTrigger, ctx: SkillContext, terms: string[]): number {
    switch (t.type) {
      case 'always': return 1;
      case 'first_message': return ctx.isFirstMessage ? 1 : 0;
      case 'keyword': return this.matchKw(t, ctx, terms);
      case 'regex': return this.matchRe(t, ctx, terms);
      case 'glob': return this.matchGlob(t, ctx, terms);
      case 'tool_use': return (ctx.toolName && t.tools?.includes(ctx.toolName)) ? 1 : 0;
      case 'hook_event': return (ctx.hookEvent && t.events?.includes(ctx.hookEvent)) ? 1 : 0;
      case 'context_match': return this.matchCtx(t, ctx, terms);
      default: return 0;
    }
  }

  private matchKw(t: SkillTrigger, ctx: SkillContext, terms: string[]): number {
    if (!ctx.userMessage || !t.patterns) return 0;
    const msg = ctx.userMessage.toLowerCase();
    let hits = 0;
    for (const p of t.patterns) {
      const pl = p.toLowerCase();
      if (pl.includes(' ') ? msg.includes(pl) : new RegExp(`\\b${this.esc(pl)}\\b`).test(msg)) { hits++; terms.push(p); }
    }
    return hits > 0 ? Math.min(1, hits / t.patterns.length) : 0;
  }

  private matchRe(t: SkillTrigger, ctx: SkillContext, terms: string[]): number {
    if (!ctx.userMessage || !t.patterns) return 0;
    let hits = 0;
    for (const p of t.patterns) { try { const m = ctx.userMessage.match(new RegExp(p, 'i')); if (m) { hits++; terms.push(m[0]); } } catch {} }
    return hits > 0 ? Math.min(1, hits / t.patterns.length) : 0;
  }

  private matchGlob(t: SkillTrigger, ctx: SkillContext, terms: string[]): number {
    if (!ctx.filePath || !t.patterns) return 0;
    for (const p of t.patterns) {
      const re = p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '§').replace(/\*/g, '[^/]*').replace(/§/g, '.*').replace(/\?/g, '.');
      if (new RegExp(`^${re}$`).test(ctx.filePath)) { terms.push(p); return 1; }
    }
    return 0;
  }

  private matchCtx(t: SkillTrigger, ctx: SkillContext, terms: string[]): number {
    if (!t.context || !ctx.userMessage) return 0;
    const cl = t.context.toLowerCase(), ml = ctx.userMessage.toLowerCase();
    if (ml.includes(cl)) { terms.push(t.context); return 0.9; }
    const cw = cl.split(/\s+/).filter(w => w.length > 3), mw = new Set(ml.split(/\s+/));
    let overlap = 0; for (const w of cw) if (mw.has(w)) overlap++;
    const r = cw.length > 0 ? overlap / cw.length : 0;
    return r > 0.5 ? r * 0.8 : 0;
  }

  private tierOk(s: ParsedSkill, tier?: string): boolean {
    if (!s.frontmatter.min_tier) return true;
    if (!tier) return false;
    const order: Record<string,number> = { one: 1, smart: 2, profissional: 3, business: 4 };
    return (order[tier] ?? 0) >= (order[s.frontmatter.min_tier] ?? 0);
  }

  private esc(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  // ─── Match Statistics ────────────────────────────────────────────

  private totalMatches = 0;
  private totalChecks = 0;
  private matchesByTriggerType = new Map<string, number>();
  private matchHistory: Array<{ skillName: string; score: number; timestamp: number }> = [];

  /**
   * Get matcher statistics.
   */
  getStats(): {
    totalMatches: number;
    totalChecks: number;
    matchRate: number;
    matchesByTriggerType: Record<string, number>;
    recentMatches: Array<{ skillName: string; score: number; timestamp: number }>;
  } {
    return {
      totalMatches: this.totalMatches,
      totalChecks: this.totalChecks,
      matchRate: this.totalChecks > 0 ? this.totalMatches / this.totalChecks : 0,
      matchesByTriggerType: Object.fromEntries(this.matchesByTriggerType),
      recentMatches: this.matchHistory.slice(-20),
    };
  }

  /**
   * Reset statistics.
   */
  resetStats(): void {
    this.totalMatches = 0;
    this.totalChecks = 0;
    this.matchesByTriggerType.clear();
    this.matchHistory = [];
  }

  // ─── Trigger Debugging ───────────────────────────────────────────

  /**
   * Explain why a skill did or didn't match (for debugging).
   */
  explainMatch(skill: ParsedSkill, ctx: SkillContext): {
    matched: boolean;
    score: number;
    triggerResults: Array<{ type: string; matched: boolean; score: number; details: string }>;
    tierOk: boolean;
    alwaysActive: boolean;
  } {
    const tierCheck = this.tierOk(skill, ctx.tier);
    if (!tierCheck) {
      return { matched: false, score: 0, triggerResults: [], tierOk: false, alwaysActive: false };
    }

    if (skill.frontmatter.always_active) {
      return { matched: true, score: 1, triggerResults: [], tierOk: true, alwaysActive: true };
    }

    const triggerResults: Array<{ type: string; matched: boolean; score: number; details: string }> = [];
    let totalScore = 0;

    for (const trigger of skill.frontmatter.triggers ?? []) {
      const terms: string[] = [];
      const score = this.evalTrigger(trigger, ctx, terms);
      triggerResults.push({
        type: trigger.type,
        matched: score > 0,
        score,
        details: score > 0 ? `Matched terms: ${terms.join(', ')}` : 'No match',
      });
      totalScore += score * (trigger.weight ?? 1);
    }

    const triggersCount = skill.frontmatter.triggers?.length ?? 1;
    const normalizedScore = triggersCount > 0 ? Math.min(1, totalScore / triggersCount) : 0;

    return {
      matched: normalizedScore > 0,
      score: normalizedScore,
      triggerResults,
      tierOk: true,
      alwaysActive: false,
    };
  }

  /**
   * Get all skills that would match a given context (without scoring).
   */
  getMatchingSkillNames(skills: ParsedSkill[], ctx: SkillContext): string[] {
    return skills
      .filter(s => {
        if (!this.tierOk(s, ctx.tier)) return false;
        if (s.frontmatter.always_active) return true;
        if (!s.frontmatter.triggers?.length) return false;
        const terms: string[] = [];
        return s.frontmatter.triggers.some(t => this.evalTrigger(t, ctx, terms) > 0);
      })
      .map(s => s.frontmatter.name);
  }

  /**
   * Get supported trigger types.
   */
  static getSupportedTriggerTypes(): string[] {
    return ['keyword', 'regex', 'glob', 'tool_use', 'hook_event', 'context_match', 'always', 'first_message'];
  }

  // ─── Match Caching for Repeated Contexts ────────────────────────────

  private matchCache = new Map<string, { results: SkillMatchResult[]; timestamp: number }>();
  private matchCacheMaxSize = 100;
  private matchCacheTtlMs = 60_000; // 1 minute TTL

  /**
   * Build a cache key from the context.
   * Combines relevant fields to create a unique identifier.
   */
  private buildCacheKey(ctx: SkillContext): string {
    const parts: string[] = [];
    if (ctx.userMessage) parts.push(`msg:${ctx.userMessage.slice(0, 200)}`);
    if (ctx.toolName) parts.push(`tool:${ctx.toolName}`);
    if (ctx.filePath) parts.push(`file:${ctx.filePath}`);
    if (ctx.hookEvent) parts.push(`hook:${ctx.hookEvent}`);
    if (ctx.isFirstMessage) parts.push('first:1');
    if (ctx.tier) parts.push(`tier:${ctx.tier}`);
    return parts.join('|');
  }

  /**
   * Match skills with caching support.
   * Returns cached results if the same context was recently matched.
   *
   * @param skills - Available skills to match against
   * @param ctx - Current context to match
   * @param useCache - Whether to use caching (default: true)
   * @returns Sorted match results
   */
  async matchAllCached(skills: ParsedSkill[], ctx: SkillContext, useCache: boolean = true): Promise<SkillMatchResult[]> {
    if (!useCache) {
      return this.matchAll(skills, ctx);
    }

    const key = this.buildCacheKey(ctx);
    const cached = this.matchCache.get(key);

    if (cached && (Date.now() - cached.timestamp) < this.matchCacheTtlMs) {
      return cached.results;
    }

    const results = await this.matchAll(skills, ctx);

    // Evict oldest entries if cache is full
    if (this.matchCache.size >= this.matchCacheMaxSize) {
      let oldestKey: string | null = null;
      let oldestTime = Infinity;
      for (const [k, v] of this.matchCache) {
        if (v.timestamp < oldestTime) {
          oldestTime = v.timestamp;
          oldestKey = k;
        }
      }
      if (oldestKey) this.matchCache.delete(oldestKey);
    }

    this.matchCache.set(key, { results, timestamp: Date.now() });
    return results;
  }

  /**
   * Clear the match cache.
   */
  clearCache(): void {
    this.matchCache.clear();
  }

  /**
   * Get cache statistics.
   */
  getCacheStats(): {
    size: number;
    maxSize: number;
    ttlMs: number;
    oldestEntryAge: number | null;
  } {
    let oldestAge: number | null = null;
    for (const [, v] of this.matchCache) {
      const age = Date.now() - v.timestamp;
      if (oldestAge === null || age > oldestAge) oldestAge = age;
    }
    return {
      size: this.matchCache.size,
      maxSize: this.matchCacheMaxSize,
      ttlMs: this.matchCacheTtlMs,
      oldestEntryAge: oldestAge,
    };
  }

  // ─── Match Explanation Formatting for Debugging ─────────────────────

  /**
   * Format a detailed match explanation as a human-readable string.
   * Useful for debugging why a skill matched or didn't match.
   *
   * @param skill - The skill to explain matching for
   * @param ctx - The context to match against
   * @returns Multi-line formatted explanation string
   */
  formatMatchExplanation(skill: ParsedSkill, ctx: SkillContext): string {
    const explanation = this.explainMatch(skill, ctx);
    const lines: string[] = [];

    lines.push(`=== Match Explanation: ${skill.frontmatter.name} ===`);
    lines.push(`Matched: ${explanation.matched ? 'YES' : 'NO'}`);
    lines.push(`Score: ${explanation.score.toFixed(3)}`);
    lines.push(`Tier OK: ${explanation.tierOk ? 'YES' : 'NO'}`);
    lines.push(`Always Active: ${explanation.alwaysActive ? 'YES' : 'NO'}`);

    if (explanation.triggerResults.length > 0) {
      lines.push('');
      lines.push('Trigger Results:');
      for (const tr of explanation.triggerResults) {
        const status = tr.matched ? '[MATCH]' : '[MISS]';
        lines.push(`  ${status} ${tr.type} (score: ${tr.score.toFixed(3)})`);
        lines.push(`         ${tr.details}`);
      }
    }

    if (ctx.userMessage) {
      lines.push('');
      lines.push(`User Message: "${ctx.userMessage.slice(0, 100)}${ctx.userMessage.length > 100 ? '...' : ''}"`);
    }

    return lines.join('\n');
  }

  /**
   * Format match results for all skills as a debug report.
   *
   * @param results - Match results from matchAll
   * @returns Formatted report string
   */
  formatMatchReport(results: SkillMatchResult[]): string {
    if (results.length === 0) return 'No skills matched.';

    const lines: string[] = [];
    lines.push(`=== Skill Match Report (${results.length} matches) ===`);
    lines.push('');

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      lines.push(`${i + 1}. ${r.skill.frontmatter.name} (score: ${r.score.toFixed(3)})`);
      if (r.matchedTerms.length > 0) {
        lines.push(`   Terms: ${r.matchedTerms.join(', ')}`);
      }
      if (r.matchedTriggers.length > 0) {
        lines.push(`   Triggers: ${r.matchedTriggers.map(t => t.type).join(', ')}`);
      }
    }

    return lines.join('\n');
  }

  // ─── Configurable Score Thresholds ──────────────────────────────────

  private minimumScoreThreshold: number = 0;
  private highConfidenceThreshold: number = 0.8;

  /**
   * Set the minimum score threshold for a match to be included.
   * Skills scoring below this threshold are excluded from results.
   *
   * @param threshold - Minimum score (0-1, default: 0 = include all)
   */
  setMinimumScoreThreshold(threshold: number): void {
    this.minimumScoreThreshold = Math.max(0, Math.min(1, threshold));
  }

  /**
   * Set the high confidence threshold.
   * Skills scoring above this are considered strong matches.
   *
   * @param threshold - High confidence score (0-1, default: 0.8)
   */
  setHighConfidenceThreshold(threshold: number): void {
    this.highConfidenceThreshold = Math.max(0, Math.min(1, threshold));
  }

  /**
   * Get current threshold settings.
   */
  getThresholds(): { minimum: number; highConfidence: number } {
    return {
      minimum: this.minimumScoreThreshold,
      highConfidence: this.highConfidenceThreshold,
    };
  }

  /**
   * Match with threshold filtering applied.
   * Only returns matches above the minimum score threshold.
   * Results are tagged with confidence level.
   */
  async matchWithThresholds(skills: ParsedSkill[], ctx: SkillContext): Promise<Array<SkillMatchResult & { confidence: 'high' | 'medium' | 'low' }>> {
    const results = await this.matchAll(skills, ctx);

    return results
      .filter(r => r.score > this.minimumScoreThreshold)
      .map(r => ({
        ...r,
        confidence: r.score >= this.highConfidenceThreshold ? 'high' as const
          : r.score >= this.minimumScoreThreshold + (this.highConfidenceThreshold - this.minimumScoreThreshold) / 2 ? 'medium' as const
          : 'low' as const,
      }));
  }
}
