/**
 * PermissionPipeline.ts — The 7-Stage Permission Gauntlet
 *
 * Based on Claude Code's hasPermissionsToUseToolInner() (1,487 lines)
 *
 * STAGE ORDER IS RIGID. DO NOT REORDER.
 *   1. validateInput (Zod + custom)
 *   2. tool.checkPermissions (tool's own logic)
 *   3. Mode enforcement (plan/bypass/acceptEdits)
 *   4. Persisted rules (workspace > user > tier)
 *   5. Auto-classifier (skip prompt for obvious cases)
 *   6. Already-denied dedup (don't ask twice)
 *   7. Interactive prompt (last resort)
 *
 * Fail-closed: any exception in the pipeline = deny.
 */

import type { Tool } from '../../tools/Tool.js';
import type { PermissionResult, PermissionAuditEntry } from './types.js';
import type { PermissionContext } from './PermissionContext.js';
import { PermissionStorage } from './PermissionStorage.js';
import { PermissionMatcher } from './PermissionMatcher.js';
import { PermissionClassifier } from './PermissionClassifier.js';
import { PermissionModes } from './PermissionModes.js';
import { PermissionPrompt } from './PermissionPrompt.js';

export class PermissionPipeline {
  private storage: PermissionStorage;
  private matcher: PermissionMatcher;
  private classifier: PermissionClassifier;
  private prompt: PermissionPrompt;

  constructor(
    storage?: PermissionStorage,
    matcher?: PermissionMatcher,
    classifier?: PermissionClassifier,
    promptInstance?: PermissionPrompt,
  ) {
    this.storage = storage || new PermissionStorage();
    this.matcher = matcher || new PermissionMatcher();
    this.classifier = classifier || new PermissionClassifier();
    this.prompt = promptInstance || new PermissionPrompt();
  }

  /**
   * The 7-stage pipeline. Returns allow/deny/ask with reason.
   * Fail-closed: any error = deny.
   */
  async checkPermission(
    tool: Tool,
    input: unknown,
    context: PermissionContext,
  ): Promise<PermissionResult> {
    const startTime = Date.now();

    try {
      // ── Stage 1: validateInput ──────────────────────────────────────
      const stage1 = await this.stage1_validate(tool, input, context);
      if (stage1) return this.audit(tool, input, context, stage1, startTime);

      // ── Stage 2: tool.checkPermissions ──────────────────────────────
      const stage2 = await this.stage2_toolCheck(tool, input, context);
      if (stage2.behavior === 'deny') {
        return this.audit(tool, input, context, stage2, startTime);
      }

      // ── Stage 3: Mode enforcement ──────────────────────────────────
      const stage3 = PermissionModes.applyMode(context.getMode(), tool, input, stage2);
      if (stage3.decisionReason.type === 'mode') {
        return this.audit(tool, input, context, stage3, startTime);
      }

      // ── Stage 4: Persisted rules ───────────────────────────────────
      const stage4 = await this.stage4_rules(tool, input, context);
      if (stage4) return this.audit(tool, input, context, stage4, startTime);

      // ── Stage 5: Auto-classifier ───────────────────────────────────
      const stage5 = this.stage5_classifier(tool, input);
      if (stage5) return this.audit(tool, input, context, stage5, startTime);

      // ── Stage 6: Already-denied dedup ──────────────────────────────
      if (context.wasDeniedThisTurn(tool.name, input)) {
        const dedup: PermissionResult = {
          behavior: 'deny',
          decisionReason: { type: 'rule', message: 'Already denied this turn (dedup)' },
        };
        return this.audit(tool, input, context, dedup, startTime);
      }

      // ── Stage 7: Interactive prompt ────────────────────────────────
      const stage7 = await this.prompt.ask({ tool, input, context, message: stage2.message });

      // Persist rule if user chose to remember
      if (stage7.persistRule) {
        await this.persistRule(stage7.persistRule, context);
      }

      const result: PermissionResult = {
        behavior: stage7.decision,
        decisionReason: { type: 'user', message: 'User decision via prompt' },
        updatedInput: input,
      };

      if (stage7.decision === 'deny') {
        context.markDenied(tool.name, input);
      }

      return this.audit(tool, input, context, result, startTime);

    } catch (error) {
      // FAIL-CLOSED: any error = deny
      const failResult: PermissionResult = {
        behavior: 'deny',
        decisionReason: { type: 'tool', message: `Pipeline error: ${(error as Error).message}` },
      };
      return this.audit(tool, input, context, failResult, startTime);
    }
  }

  // ─── Stage Implementations ──────────────────────────────────────────

  private async stage1_validate(
    tool: Tool, input: unknown, context: PermissionContext,
  ): Promise<PermissionResult | null> {
    if (!tool.validateInput) return null;

    const ctx = {
      cwd: context.workspaceRoot,
      sessionId: context.sessionId,
      permissionMode: context.getMode(),
      options: { tools: [] },
    };

    const validation = await tool.validateInput(input, ctx);
    if (!validation.valid) {
      return {
        behavior: 'deny',
        decisionReason: {
          type: 'tool',
          message: `Validation failed: ${validation.message || 'invalid input'}`,
        },
        message: validation.message,
      };
    }
    return null; // Pass through
  }

  private async stage2_toolCheck(
    tool: Tool, input: unknown, context: PermissionContext,
  ): Promise<PermissionResult> {
    const ctx = {
      cwd: context.workspaceRoot,
      sessionId: context.sessionId,
      permissionMode: context.getMode(),
      options: { tools: [] },
    };

    const result = await tool.checkPermissions(input, ctx);

    // Convert old-style PermissionResult to new format
    return {
      behavior: result.behavior === 'passthrough' ? 'ask' : result.behavior as any,
      decisionReason: (result as any).decisionReason || {
        type: 'tool' as const,
        message: result.message || `Tool ${tool.name} check`,
      },
      updatedInput: result.updatedInput,
      message: result.message,
    };
  }

  private async stage4_rules(
    tool: Tool, input: unknown, context: PermissionContext,
  ): Promise<PermissionResult | null> {
    const allRules = await this.storage.loadAllForContext(context);
    if (allRules.length === 0) return null;

    const matched = await this.matcher.findMatchingRule(allRules, tool.name, input, tool);
    if (!matched) return null;

    return {
      behavior: matched.decision,
      decisionReason: {
        type: 'rule',
        ruleId: matched.id,
        pattern: matched.pattern,
        message: `Matched rule: ${matched.toolName}${matched.pattern ? `(${matched.pattern})` : ''} → ${matched.decision} [${matched.scope}]`,
      },
      updatedInput: input,
    };
  }

  private stage5_classifier(tool: Tool, input: unknown): PermissionResult | null {
    const classification = this.classifier.classify(tool, input);

    if (this.classifier.shouldAutoApprove(classification)) {
      return {
        behavior: 'allow',
        decisionReason: {
          type: 'classifier',
          confidence: classification.confidence,
          message: classification.reason,
        },
        updatedInput: input,
      };
    }

    // Classifier not confident enough — fall through to prompt
    return null;
  }

  // ─── Rule Persistence ───────────────────────────────────────────────

  private async persistRule(rule: any, context: PermissionContext): Promise<void> {
    try {
      if (rule.scope === 'workspace') {
        await this.storage.addWorkspaceRule(context.workspaceRoot, rule);
      } else if (rule.scope === 'user') {
        await this.storage.addUserRule(rule);
      } else if (rule.scope === 'session') {
        context.addSessionRule(rule);
      }
    } catch (err) {
      console.error(`[permissions] Failed to persist rule: ${(err as Error).message}`);
    }
  }

  // ─── Audit ──────────────────────────────────────────────────────────

  private audit(
    tool: Tool,
    input: unknown,
    context: PermissionContext,
    result: PermissionResult,
    startTime: number,
  ): PermissionResult {
    const entry: PermissionAuditEntry = {
      timestamp: Date.now(),
      sessionId: context.sessionId,
      toolName: tool.name,
      toolInput: input,
      decision: result.behavior,
      decisionReason: result.decisionReason,
      durationMs: Date.now() - startTime,
    };
    context.recordDecision(entry);
    return result;
  }
}
