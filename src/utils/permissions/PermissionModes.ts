/**
 * PermissionModes.ts — Mode enforcement (plan, bypass, acceptEdits)
 * Each mode has specific rules for how 'ask' decisions resolve.
 */

import type { PermissionMode, PermissionResult } from './types.js';
import type { Tool } from '../../tools/Tool.js';

/** Tools allowed in plan mode (read-only + plan exit) */
const PLAN_MODE_ALLOWED = new Set([
  'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite',
  'EnterPlanMode', 'ExitPlanMode',
]);

export class PermissionModes {
  /**
   * Apply mode-specific rules to an intermediate permission result.
   * Can force allow (bypass), force deny (plan), or upgrade ask→allow (acceptEdits).
   */
  static applyMode(
    mode: PermissionMode,
    tool: Tool,
    input: unknown,
    prev: PermissionResult,
  ): PermissionResult {
    switch (mode) {
      case 'bypassPermissions':
        return this.applyBypass(tool, input);
      case 'acceptEdits':
        return this.applyAcceptEdits(tool, input, prev);
      case 'plan':
        return this.applyPlanMode(tool, input, prev);
      case 'dontAsk':
        return this.applyDontAsk(prev);
      case 'default':
      case 'auto':
      default:
        return prev;
    }
  }

  private static applyBypass(_tool: Tool, input: unknown): PermissionResult {
    return {
      behavior: 'allow',
      decisionReason: { type: 'mode', message: 'bypassPermissions mode — all operations allowed' },
      updatedInput: input,
    };
  }

  private static applyAcceptEdits(tool: Tool, input: unknown, prev: PermissionResult): PermissionResult {
    if (prev.behavior === 'deny') return prev; // Don't override explicit deny

    const isFileOp = tool.name === 'FileEdit' || tool.name === 'FileWrite' || tool.name === 'Edit' || tool.name === 'Write';
    if (isFileOp) {
      return {
        behavior: 'allow',
        decisionReason: { type: 'mode', message: 'acceptEdits mode auto-allows file operations' },
        updatedInput: input,
      };
    }
    return prev;
  }

  private static applyPlanMode(tool: Tool, input: unknown, prev: PermissionResult): PermissionResult {
    // Whitelisted tools pass through
    if (PLAN_MODE_ALLOWED.has(tool.name)) {
      // Bash only allowed if read-only
      if (tool.name === 'Bash' && !tool.isReadOnly(input)) {
        return {
          behavior: 'deny',
          decisionReason: { type: 'mode', message: 'Plan mode: destructive Bash commands blocked' },
          message: 'Plan mode active. Only read-only commands allowed. Use ExitPlanMode when ready.',
        };
      }
      // Agent only as researcher
      if (tool.name === 'Agent') {
        const agentInput = input as any;
        if (agentInput?.subagent_type && agentInput.subagent_type !== 'researcher') {
          return {
            behavior: 'deny',
            decisionReason: { type: 'mode', message: 'Plan mode: only researcher agents allowed' },
          };
        }
      }
      return prev;
    }

    // Read-only tools not in whitelist — check flag
    if (tool.isReadOnly(input)) return prev;

    // Block everything else
    return {
      behavior: 'deny',
      decisionReason: { type: 'mode', message: `Plan mode: "${tool.name}" blocked (not read-only)` },
      message: 'Plan mode active. Call ExitPlanMode with your plan to execute changes.',
    };
  }

  private static applyDontAsk(prev: PermissionResult): PermissionResult {
    if (prev.behavior === 'ask') {
      return {
        behavior: 'deny',
        decisionReason: { type: 'mode', message: 'dontAsk mode: ask → deny' },
      };
    }
    return prev;
  }

  static canTransition(from: PermissionMode, to: PermissionMode): boolean {
    if (from === 'plan') return true;
    if (to === 'bypassPermissions') return false; // Only via CLI flag
    return true;
  }
}
