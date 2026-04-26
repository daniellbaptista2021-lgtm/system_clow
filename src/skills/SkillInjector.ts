/**
 * SkillInjector.ts — Select top skills and format as system message
 *
 * Based on Claude Code's skillInjector.ts (~200 lines)
 *
 * Features:
 *   - Select top N skills by match score
 *   - Token budget enforcement
 *   - Format skills as markdown system message
 *   - Reference aggregation
 *   - Deduplication of references
 *   - Injection statistics
 */

import { MAX_SKILLS_PER_TURN, MAX_TOTAL_INJECTION_TOKENS, MIN_MATCH_SCORE } from './types.js';
import type { SkillMatchResult, SkillInjectionResult, ParsedSkill, SkillReference } from './types.js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface InjectionStats {
  skillsConsidered: number;
  skillsInjected: number;
  skillsSkippedBudget: number;
  skillsSkippedScore: number;
  totalTokensUsed: number;
  tokenBudget: number;
}

// ════════════════════════════════════════════════════════════════════════════
// SkillInjector Class
// ════════════════════════════════════════════════════════════════════════════

export class SkillInjector {
  private lastStats: InjectionStats | null = null;

  /**
   * Select and format skills for injection into the system message.
   */
  inject(matches: SkillMatchResult[]): SkillInjectionResult {
    const selected: ParsedSkill[] = [];
    const allRefs: SkillReference[] = [];
    const seenRefPaths = new Set<string>();
    let totalTokens = 0;
    let skippedBudget = 0;
    let skippedScore = 0;

    // Sort by score (highest first)
    const sorted = [...matches].sort((a, b) => b.score - a.score);

    for (const match of sorted) {
      // Score threshold
      if (match.score < MIN_MATCH_SCORE) {
        skippedScore++;
        continue;
      }

      // Max skills per turn
      if (selected.length >= MAX_SKILLS_PER_TURN) break;

      // Token budget check
      if (totalTokens + match.skill.bodyTokens > MAX_TOTAL_INJECTION_TOKENS) {
        skippedBudget++;
        continue;
      }

      selected.push(match.skill);
      totalTokens += match.skill.bodyTokens;

      // Collect unique references
      for (const ref of match.skill.references) {
        if (!seenRefPaths.has(ref.path)) {
          seenRefPaths.add(ref.path);
          allRefs.push(ref);
        }
      }
    }

    this.lastStats = {
      skillsConsidered: matches.length,
      skillsInjected: selected.length,
      skillsSkippedBudget: skippedBudget,
      skillsSkippedScore: skippedScore,
      totalTokensUsed: totalTokens,
      tokenBudget: MAX_TOTAL_INJECTION_TOKENS,
    };

    if (selected.length === 0) {
      return {
        injectedSkills: [],
        systemMessageAddition: '',
        estimatedTokens: 0,
        references: [],
      };
    }

    // Format as markdown
    const systemMessage = this.formatSkills(selected);

    return {
      injectedSkills: selected,
      systemMessageAddition: systemMessage,
      estimatedTokens: totalTokens + 200, // overhead for formatting
      references: allRefs,
    };
  }

  /**
   * Format selected skills as a markdown system message addition.
   */
  private formatSkills(skills: ParsedSkill[]): string {
    const lines: string[] = ['## Active Skills', ''];

    for (const skill of skills) {
      lines.push(`### ${skill.frontmatter.name}`);
      lines.push(`*${skill.frontmatter.description}*`);
      lines.push('');

      if (skill.frontmatter.uses_tools?.length) {
        lines.push(`Tools: ${skill.frontmatter.uses_tools.join(', ')}`);
        lines.push('');
      }

      lines.push(skill.body);
      lines.push('');
      lines.push('---');
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Get statistics from the last injection.
   */
  getLastStats(): InjectionStats | null {
    return this.lastStats;
  }
}
