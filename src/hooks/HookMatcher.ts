/**
 * HookMatcher.ts — Match hooks to events + tool patterns
 *
 * Based on Claude Code's hookMatcher.ts (~200 lines)
 *
 * Matching rules:
 *   1. Event must match exactly
 *   2. If hook has no matcher or matcher is "*", matches all
 *   3. "Bash" — exact tool name match
 *   4. "Bash(git *)" — tool name + input pattern match
 *   5. Glob-like patterns in matcher value
 *
 * Features:
 *   - Event-based primary filter
 *   - Tool name matching
 *   - Tool input pattern matching
 *   - Integration with Tool.preparePermissionMatcher
 *   - Priority-sorted results (highest first)
 *   - Match statistics tracking
 *   - Pattern validation
 */

import type { ConfiguredHook, HookEventName, HookInput } from './types.js';
import type { Tool } from '../tools/Tool.js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface MatchStats {
  totalChecks: number;
  totalMatches: number;
  matchesByEvent: Record<string, number>;
}

// ════════════════════════════════════════════════════════════════════════════
// HookMatcher Class
// ════════════════════════════════════════════════════════════════════════════

export class HookMatcher {
  private stats: MatchStats = {
    totalChecks: 0,
    totalMatches: 0,
    matchesByEvent: {},
  };

  constructor(private readonly tools: Map<string, Tool>) {}

  /**
   * Match hooks against an event and input.
   * Returns matching hooks sorted by priority (highest first).
   */
  async match(
    hooks: ConfiguredHook[],
    event: HookEventName,
    input: HookInput,
  ): Promise<ConfiguredHook[]> {
    const matched: ConfiguredHook[] = [];

    for (const hook of hooks) {
      // Skip disabled hooks
      if (!hook.enabled) continue;

      // Event must match
      if (hook.event !== event) continue;

      this.stats.totalChecks++;

      // Check matcher pattern
      if (await this.checkMatcher(hook, input)) {
        matched.push(hook);
        this.stats.totalMatches++;
        this.stats.matchesByEvent[event] = (this.stats.matchesByEvent[event] ?? 0) + 1;
      }
    }

    // Sort by priority (highest first)
    return matched.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Check if a single hook's matcher matches the input.
   */
  private async checkMatcher(hook: ConfiguredHook, input: HookInput): Promise<boolean> {
    // No matcher or wildcard = always match
    if (!hook.matcher || hook.matcher === '*') return true;

    const matcher = hook.matcher.trim();

    // Check for tool+pattern format: "ToolName(pattern)"
    const toolPatternMatch = matcher.match(/^(\w+)\((.+)\)$/);

    if (toolPatternMatch) {
      const [, toolName, pattern] = toolPatternMatch;

      // Tool name must match
      if (toolName !== input.tool_name) return false;

      // Try using tool's built-in matcher
      const tool = this.tools.get(toolName);
      if (tool?.preparePermissionMatcher) {
        try {
          const matchFn = await tool.preparePermissionMatcher(input.tool_input);
          return matchFn(pattern);
        } catch {
          return false;
        }
      }

      // Fallback: simple string match against serialized input
      return this.simplePatternMatch(input.tool_input, pattern);
    }

    // Simple tool name match
    if (/^\w+$/.test(matcher)) {
      return matcher === input.tool_name;
    }

    // Glob-like pattern match against tool name
    return this.globMatch(input.tool_name ?? '', matcher);
  }

  /**
   * Simple pattern matching against serialized tool input.
   */
  private simplePatternMatch(toolInput: unknown, pattern: string): boolean {
    const inputStr = typeof toolInput === 'string'
      ? toolInput
      : JSON.stringify(toolInput ?? '');

    // Exact match
    if (inputStr === pattern) return true;

    // Wildcard match (e.g., "git *")
    if (pattern.includes('*')) {
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      return regex.test(inputStr);
    }

    // Contains match
    return inputStr.includes(pattern);
  }

  /**
   * Glob-like pattern matching.
   */
  private globMatch(value: string, pattern: string): boolean {
    const regex = new RegExp(
      '^' + pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.') + '$',
    );
    return regex.test(value);
  }

  /**
   * Validate a matcher pattern.
   */
  static isValidMatcher(matcher: string): boolean {
    if (!matcher || typeof matcher !== 'string') return false;
    if (matcher === '*') return true;
    if (matcher.length > 500) return false;

    // Check tool+pattern format
    const toolPattern = matcher.match(/^(\w+)\((.+)\)$/);
    if (toolPattern) return true;

    // Simple word
    if (/^\w+$/.test(matcher)) return true;

    // Glob pattern
    if (/^[\w.*?-]+$/.test(matcher)) return true;

    return false;
  }

  /**
   * Get match statistics.
   */
  getStats(): MatchStats {
    return { ...this.stats };
  }

  resetStats(): void {
    this.stats = { totalChecks: 0, totalMatches: 0, matchesByEvent: {} };
  }

  /**
   * Get match rate (percentage of checks that result in a match).
   */
  getMatchRate(): number {
    if (this.stats.totalChecks === 0) return 0;
    return this.stats.totalMatches / this.stats.totalChecks;
  }

  /**
   * Find hooks that would match a hypothetical input (dry-run).
   * Returns hooks sorted by priority without executing them.
   */
  async findMatchingHooks(
    hooks: ConfiguredHook[],
    event: HookEventName,
    input: HookInput,
  ): Promise<Array<{ hook: ConfiguredHook; matchReason: string }>> {
    const results: Array<{ hook: ConfiguredHook; matchReason: string }> = [];

    for (const hook of hooks) {
      if (!hook.enabled || hook.event !== event) continue;

      let reason = '';
      if (!hook.matcher || hook.matcher === '*') {
        reason = 'Wildcard match (no matcher specified)';
      } else if (!hook.matcher.includes('(')) {
        if (hook.matcher === input.tool_name) reason = `Exact tool name match: ${hook.matcher}`;
      } else {
        const m = hook.matcher.match(/^(\w+)\((.+)\)$/);
        if (m && m[1] === input.tool_name) {
          reason = `Tool pattern match: ${hook.matcher}`;
        }
      }

      if (reason || await this.checkMatcher(hook, input)) {
        results.push({
          hook,
          matchReason: reason || `Pattern match: ${hook.matcher ?? '*'}`,
        });
      }
    }

    return results.sort((a, b) => b.hook.priority - a.hook.priority);
  }

  /**
   * Get hooks grouped by event.
   */
  groupByEvent(hooks: ConfiguredHook[]): Map<HookEventName, ConfiguredHook[]> {
    const groups = new Map<HookEventName, ConfiguredHook[]>();

    for (const hook of hooks) {
      if (!hook.enabled) continue;
      const existing = groups.get(hook.event) ?? [];
      existing.push(hook);
      groups.set(hook.event, existing);
    }

    return groups;
  }
}
