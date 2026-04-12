/**
 * PermissionMatcher.ts — Match rules against (toolName, input)
 * Priority: workspace > user > tier > session
 * Within same scope: deny > ask > allow
 */

import stringify from 'json-stable-stringify';
import * as crypto from 'crypto';
import type { PermissionRule, PermissionScope, PermissionDecision } from './types.js';
import type { Tool } from '../../tools/Tool.js';

const SCOPE_PRIORITY: Record<PermissionScope, number> = {
  session: 4,   // highest (most recent)
  workspace: 3,
  user: 2,
  tier: 1,      // lowest
};

const DECISION_PRIORITY: Record<PermissionDecision, number> = {
  deny: 3,      // most restrictive wins
  ask: 2,
  allow: 1,
};

export class PermissionMatcher {

  /**
   * Find the highest-priority rule that matches this tool call.
   * Returns null if no rule matches (fall through to classifier/prompt).
   */
  async findMatchingRule(
    rules: readonly PermissionRule[],
    toolName: string,
    input: unknown,
    tool: Tool,
  ): Promise<PermissionRule | null> {
    // 1. Filter rules that match tool name
    const candidates = rules.filter(
      (r) => r.toolName === toolName || r.toolName === '*',
    );

    if (candidates.length === 0) return null;

    // 2. Check pattern matching
    const matched: PermissionRule[] = [];
    let toolMatcher: ((pattern: string) => boolean) | null = null;

    // Prepare matcher once (expensive for some tools)
    if (tool.preparePermissionMatcher) {
      try {
        toolMatcher = await tool.preparePermissionMatcher(input);
      } catch {
        toolMatcher = null;
      }
    }

    for (const rule of candidates) {
      // No pattern = match all instances of this tool
      if (!rule.pattern) {
        matched.push(rule);
        continue;
      }

      // Use tool's own matcher if available
      if (toolMatcher && toolMatcher(rule.pattern)) {
        matched.push(rule);
        continue;
      }

      // Fallback: simple string matching
      if (!toolMatcher) {
        const inputStr = typeof input === 'string'
          ? input
          : (input as any)?.command || (input as any)?.file_path || '';
        if (this.simpleMatch(rule.pattern, inputStr)) {
          matched.push(rule);
        }
      }
    }

    if (matched.length === 0) return null;

    // 3. Select by priority
    return this.selectByPriority(matched);
  }

  /**
   * Simple glob-like pattern matching (fallback when tool has no matcher).
   * Supports: "*" (match all), "prefix *" (prefix match), exact match.
   */
  private simpleMatch(pattern: string, value: string): boolean {
    if (pattern === '*') return true;
    if (pattern.endsWith(' *')) {
      const prefix = pattern.slice(0, -2);
      return value === prefix || value.startsWith(prefix + ' ');
    }
    if (pattern.startsWith('*') && pattern.endsWith('*')) {
      return value.includes(pattern.slice(1, -1));
    }
    if (pattern.startsWith('*.')) {
      return value.endsWith(pattern.slice(1));
    }
    return value === pattern;
  }

  private selectByPriority(rules: PermissionRule[]): PermissionRule {
    return rules.sort((a, b) => {
      // Higher scope wins
      const scopeDiff = SCOPE_PRIORITY[b.scope] - SCOPE_PRIORITY[a.scope];
      if (scopeDiff !== 0) return scopeDiff;
      // Within same scope: more restrictive wins
      return DECISION_PRIORITY[b.decision] - DECISION_PRIORITY[a.decision];
    })[0];
  }

  /**
   * Deterministic hash for (toolName, input) — used for dedup.
   */
  hashToolCall(toolName: string, input: unknown): string {
    const normalized = stringify(input) || '';
    return crypto.createHash('sha256')
      .update(`${toolName}|${normalized}`)
      .digest('hex')
      .slice(0, 16);
  }
}
