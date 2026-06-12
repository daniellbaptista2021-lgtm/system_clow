/**
 * PermissionRules.ts — Rule creation, validation, merging, dedup, expiry
 */

import { randomUUID } from 'crypto';
import type {
  PermissionRule, PermissionDecision, PermissionScope,
  PermissionSource, RuleConflict, RuleSuggestion,
} from './types.js';
import type { Tool } from '../../tools/Tool.js';

export class PermissionRules {

  static create(params: {
    toolName: string;
    pattern?: string;
    decision: PermissionDecision;
    scope: PermissionScope;
    source: PermissionSource;
    reason?: string;
    expiresAt?: number;
  }): PermissionRule {
    return {
      id: randomUUID(),
      createdAt: Date.now(),
      ...params,
    };
  }

  static validate(rule: PermissionRule): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (!rule.id) errors.push('Missing id');
    if (!rule.toolName) errors.push('Missing toolName');
    if (!['allow', 'deny', 'ask'].includes(rule.decision)) errors.push(`Invalid decision: ${rule.decision}`);
    if (!['session', 'workspace', 'user', 'tier'].includes(rule.scope)) errors.push(`Invalid scope: ${rule.scope}`);
    if (rule.expiresAt && rule.expiresAt < rule.createdAt) errors.push('expiresAt before createdAt');
    return { valid: errors.length === 0, errors };
  }

  /** Overlay rules on base (overlay wins on conflict) */
  static merge(base: readonly PermissionRule[], overlay: readonly PermissionRule[]): PermissionRule[] {
    const byKey = new Map<string, PermissionRule>();
    for (const r of base) byKey.set(`${r.toolName}|${r.pattern || '*'}`, r);
    for (const r of overlay) byKey.set(`${r.toolName}|${r.pattern || '*'}`, r);
    return Array.from(byKey.values());
  }

  /** Remove duplicate rules (same tool+pattern+decision) */
  static dedupe(rules: PermissionRule[]): PermissionRule[] {
    const seen = new Set<string>();
    return rules.filter((r) => {
      const key = `${r.toolName}|${r.pattern || '*'}|${r.decision}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /** Remove expired rules */
  static expire(rules: PermissionRule[], now: number = Date.now()): PermissionRule[] {
    return rules.filter((r) => !r.expiresAt || r.expiresAt > now);
  }

  /** Find conflicting rules (same tool+pattern, different decisions) */
  static findConflicts(rules: PermissionRule[]): RuleConflict[] {
    const byKey = new Map<string, PermissionRule[]>();
    for (const r of rules) {
      const key = `${r.toolName}|${r.pattern || '*'}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key)!.push(r);
    }

    const conflicts: RuleConflict[] = [];
    for (const [key, group] of byKey) {
      const decisions = new Set(group.map((r) => r.decision));
      if (decisions.size > 1) {
        conflicts.push({
          ruleA: group[0],
          ruleB: group[1],
          description: `Conflicting decisions for ${key}: ${Array.from(decisions).join(' vs ')}`,
        });
      }
    }
    return conflicts;
  }

  /** Suggest a rule from a tool call */
  static suggestFromCall(tool: Tool, input: unknown): RuleSuggestion | null {
    if (tool.name === 'Bash') {
      const cmd = (input as any)?.command as string;
      if (!cmd) return null;
      const first = cmd.trim().split(/\s+/)[0];
      if (!first) return null;
      return {
        rule: { toolName: 'Bash', pattern: `${first} *`, decision: 'allow', scope: 'workspace', source: 'user' },
        prompt: `Allow all "${first}" commands in this workspace?`,
      };
    }
    return null;
  }
}
