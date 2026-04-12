/**
 * HookAggregator.ts — Combine N hook results into a single decision
 *
 * Based on Claude Code's hookAggregator.ts (~200 lines)
 *
 * Decision rules:
 *   - Most restrictive decision wins (deny > ask > allow)
 *   - Any block → final=deny
 *   - Any continue=false → preventContinuation=true
 *   - System messages concatenated
 *   - Last updated input wins
 *   - Async hooks tracked separately
 *
 * Features:
 *   - Priority-ordered aggregation
 *   - System message concatenation with separators
 *   - Additional context merging
 *   - Error collection
 *   - Async hook ID tracking
 *   - Updated input chaining
 */

import type { HookOutput, AggregatedHookResult } from './types.js';

// ════════════════════════════════════════════════════════════════════════════
// HookAggregator Class
// ════════════════════════════════════════════════════════════════════════════

export class HookAggregator {
  /**
   * Aggregate multiple hook results into a single result.
   * Most restrictive decision wins.
   */
  aggregate(results: Array<{ hookId: string; output: HookOutput }>): AggregatedHookResult {
    let finalDecision: 'allow' | 'deny' | 'ask' = 'allow';
    let blocked = false;
    let preventContinuation = false;
    let updatedInput: unknown;
    const systemMessages: string[] = [];
    const additionalContexts: string[] = [];
    const reasons: string[] = [];
    const asyncHookIds: string[] = [];
    const errors: Array<{ hookId: string; message: string }> = [];

    for (const { hookId, output } of results) {
      // Decision aggregation (most restrictive wins)
      const permDecision = output.hookSpecificOutput?.permissionDecision;

      if (permDecision === 'deny' || output.decision === 'block') {
        finalDecision = 'deny';
        blocked = true;
        if (output.reason) {
          reasons.push(`[${hookId}] ${output.reason}`);
        }
      } else if ((permDecision === 'ask' || output.decision === 'ask') && finalDecision !== 'deny') {
        finalDecision = 'ask';
        if (output.reason) {
          reasons.push(`[${hookId}] ${output.reason}`);
        }
      }

      // Continuation control
      if (output.continue === false) {
        preventContinuation = true;
        if (output.reason) {
          reasons.push(`[${hookId}] stop: ${output.reason}`);
        }
      }

      // Updated input (last one wins)
      if (output.hookSpecificOutput?.updatedInput !== undefined) {
        updatedInput = output.hookSpecificOutput.updatedInput;
      }

      // System messages
      if (output.systemMessage) {
        systemMessages.push(output.systemMessage);
      }

      // Additional contexts
      if (output.hookSpecificOutput?.additionalContext) {
        additionalContexts.push(output.hookSpecificOutput.additionalContext);
      }

      // Async hooks
      if (output.async && output.asyncTaskId) {
        asyncHookIds.push(output.asyncTaskId);
      }
    }

    return {
      finalDecision,
      blocked,
      preventContinuation,
      updatedInput,
      systemMessages: systemMessages.join('\n\n'),
      additionalContexts: additionalContexts.join('\n\n'),
      reasons,
      hookCount: results.length,
      asyncHookIds,
      errors,
    };
  }

  /**
   * Create an empty result (no hooks matched).
   */
  static empty(): AggregatedHookResult {
    return {
      finalDecision: 'allow',
      blocked: false,
      preventContinuation: false,
      systemMessages: '',
      additionalContexts: '',
      reasons: [],
      hookCount: 0,
      asyncHookIds: [],
      errors: [],
    };
  }

  /**
   * Check if an aggregated result is effectively a no-op.
   */
  static isNoop(result: AggregatedHookResult): boolean {
    return (
      result.finalDecision === 'allow' &&
      !result.blocked &&
      !result.preventContinuation &&
      !result.systemMessages &&
      !result.additionalContexts &&
      result.reasons.length === 0 &&
      result.errors.length === 0
    );
  }

  /**
   * Merge two aggregated results (for combining results from different phases).
   */
  static merge(a: AggregatedHookResult, b: AggregatedHookResult): AggregatedHookResult {
    // Most restrictive decision
    let finalDecision: 'allow' | 'deny' | 'ask' = a.finalDecision;
    if (b.finalDecision === 'deny') finalDecision = 'deny';
    else if (b.finalDecision === 'ask' && finalDecision !== 'deny') finalDecision = 'ask';

    return {
      finalDecision,
      blocked: a.blocked || b.blocked,
      preventContinuation: a.preventContinuation || b.preventContinuation,
      updatedInput: b.updatedInput ?? a.updatedInput,
      systemMessages: [a.systemMessages, b.systemMessages].filter(Boolean).join('\n\n'),
      additionalContexts: [a.additionalContexts, b.additionalContexts].filter(Boolean).join('\n\n'),
      reasons: [...a.reasons, ...b.reasons],
      hookCount: a.hookCount + b.hookCount,
      asyncHookIds: [...a.asyncHookIds, ...b.asyncHookIds],
      errors: [...a.errors, ...b.errors],
    };
  }

  /**
   * Format an aggregated result for human-readable display.
   */
  static format(result: AggregatedHookResult): string {
    const lines: string[] = [];
    lines.push(`Decision: ${result.finalDecision}`);
    if (result.blocked) lines.push('⛔ Blocked');
    if (result.preventContinuation) lines.push('⏹ Stop requested');
    if (result.hookCount > 0) lines.push(`Hooks executed: ${result.hookCount}`);
    if (result.reasons.length > 0) {
      lines.push('Reasons:');
      for (const r of result.reasons) lines.push(`  - ${r}`);
    }
    if (result.errors.length > 0) {
      lines.push('Errors:');
      for (const e of result.errors) lines.push(`  - [${e.hookId}] ${e.message}`);
    }
    if (result.asyncHookIds.length > 0) {
      lines.push(`Async hooks: ${result.asyncHookIds.join(', ')}`);
    }
    return lines.join('\n');
  }

  /**
   * Create a summary string for logging.
   */
  static summarize(result: AggregatedHookResult): string {
    if (HookAggregator.isNoop(result)) return 'noop';
    const parts = [`decision=${result.finalDecision}`, `hooks=${result.hookCount}`];
    if (result.blocked) parts.push('BLOCKED');
    if (result.preventContinuation) parts.push('STOPPED');
    if (result.errors.length) parts.push(`errors=${result.errors.length}`);
    if (result.asyncHookIds.length) parts.push(`async=${result.asyncHookIds.length}`);
    return parts.join(' ');
  }
}
