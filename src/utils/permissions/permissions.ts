/**
 * permissions.ts — Backward-compatible re-exports from new permission system
 *
 * Old code imports { createCanUseTool, hasPermission, PermissionContext } from here.
 * New code should import from specific modules directly.
 */

export type { PermissionResult, PermissionRule, PermissionDecision, PermissionMode } from './types.js';
export { PermissionContext } from './PermissionContext.js';
export { PermissionPipeline } from './PermissionPipeline.js';
export { PermissionStorage } from './PermissionStorage.js';
export { PermissionMatcher } from './PermissionMatcher.js';
export { PermissionClassifier } from './PermissionClassifier.js';
export { PermissionModes } from './PermissionModes.js';
export { PermissionPrompt } from './PermissionPrompt.js';
export { PermissionRules } from './PermissionRules.js';

// ─── Legacy Compatibility ───────────────────────────────────────────────────
// Old code used these. Keep them working.

import { PermissionPipeline } from './PermissionPipeline.js';
import { PermissionContext } from './PermissionContext.js';
import { PermissionRules as PermRulesHelper } from './PermissionRules.js';
import type { Tool, CanUseToolFn } from '../../tools/Tool.js';
import { getSessionId, getCwd, getPermissionMode } from '../../bootstrap/state.js';

/** Legacy interface for old code */
export interface LegacyPermissionContext {
  denyRules: string[];
  allowRules: string[];
  askRules: string[];
}

/**
 * Legacy: create a CanUseTool function compatible with old QueryEngine code.
 * Wraps the new PermissionPipeline.
 */
export function createCanUseTool(
  legacyCtx: LegacyPermissionContext,
  isInteractive: boolean = true,
  getExecutionContext?: () => {
    sessionId: string;
    cwd: string;
    permissionMode: string;
  },
): CanUseToolFn {
  const pipeline = new PermissionPipeline();

  return async (tool: Tool, input: unknown, _toolUseId: string) => {
    const execCtx = getExecutionContext?.() || {
      sessionId: getSessionId(),
      cwd: getCwd(),
      permissionMode: getPermissionMode(),
    };
    const ctx = new PermissionContext(
      execCtx.sessionId,
      undefined, // tenantId
      execCtx.cwd,
      execCtx.permissionMode as any,
      undefined, // tier
      isInteractive,
    );

    for (const toolName of legacyCtx.allowRules) {
      ctx.addSessionRule(PermRulesHelper.create({
        toolName,
        decision: 'allow',
        scope: 'session',
        source: 'rule',
        reason: 'Legacy allowRule',
      }));
    }
    for (const toolName of legacyCtx.denyRules) {
      ctx.addSessionRule(PermRulesHelper.create({
        toolName,
        decision: 'deny',
        scope: 'session',
        source: 'rule',
        reason: 'Legacy denyRule',
      }));
    }

    const result = await pipeline.checkPermission(tool, input, ctx);
    // Convert to old PermissionResult format
    return {
      behavior: result.behavior as any,
      message: result.message,
      updatedInput: result.updatedInput,
    };
  };
}

/**
 * Legacy: direct permission check (used by old tests)
 */
export async function hasPermission(
  tool: Tool,
  input: unknown,
  legacyCtx: LegacyPermissionContext,
): Promise<{ behavior: string; message?: string }> {
  const canUse = createCanUseTool(legacyCtx, false);
  return canUse(tool, input, 'legacy-check');
}

export function resetDenialTracking(): void {
  // No-op in new system (denial tracking is per-context)
}

export async function promptUserForPermission(
  _toolName: string,
  _message: string,
): Promise<'allow' | 'deny' | 'always_allow'> {
  // Legacy — not used anymore, pipeline handles prompting
  return 'deny';
}
