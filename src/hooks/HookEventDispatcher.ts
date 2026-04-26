/**
 * HookEventDispatcher.ts — Convenience wrapper for firing hook events
 *
 * Based on Claude Code's hookEventDispatcher.ts (~200 lines)
 *
 * Provides typed methods for each hook event type.
 * Builds HookInput correctly for each event type.
 *
 * Features:
 *   - One method per event type (type-safe)
 *   - Automatic HookInput construction
 *   - Session context injection
 *   - Sync and async fire modes
 *   - Tenant/tier context
 *   - Timestamp auto-generation
 */

import type { AggregatedHookResult, HookInput, HookEventName } from './types.js';
import type { HookEngine } from './HookEngine.js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface DispatcherContext {
  sessionId: string;
  transcriptPath: string;
  cwd: string;
  workspaceRoot: string;
  tenantId?: string;
  tier?: string;
  agentDepth: number;
}

// ════════════════════════════════════════════════════════════════════════════
// HookEventDispatcher Class
// ════════════════════════════════════════════════════════════════════════════

export class HookEventDispatcher {
  constructor(
    private readonly engine: HookEngine,
    private readonly ctx: DispatcherContext,
  ) {}

  // ─── Base Input Builder ──────────────────────────────────────────

  private base(event: HookEventName, extras: Partial<HookInput> = {}): HookInput {
    return {
      hook_event_name: event,
      hook_id: '',
      session_id: this.ctx.sessionId,
      transcript_path: this.ctx.transcriptPath,
      cwd: this.ctx.cwd,
      workspace_root: this.ctx.workspaceRoot,
      permission_mode: 'default',
      agent_depth: this.ctx.agentDepth,
      timestamp: Date.now(),
      tenant_id: this.ctx.tenantId,
      tier: this.ctx.tier,
      ...extras,
    };
  }

  // ─── Tool Events ─────────────────────────────────────────────────

  firePreToolUse(
    toolName: string,
    input: unknown,
    toolUseId: string,
    permissionMode: string,
  ): Promise<AggregatedHookResult> {
    return this.engine.fire('PreToolUse', this.base('PreToolUse', {
      tool_name: toolName,
      tool_input: input,
      tool_use_id: toolUseId,
      permission_mode: permissionMode,
    }));
  }

  firePostToolUse(
    toolName: string,
    input: unknown,
    output: unknown,
    toolUseId: string,
    durationMs: number,
  ): Promise<AggregatedHookResult> {
    return this.engine.fire('PostToolUse', this.base('PostToolUse', {
      tool_name: toolName,
      tool_input: input,
      tool_output: output,
      tool_use_id: toolUseId,
      tool_duration_ms: durationMs,
    }));
  }

  firePostToolUseFailure(
    toolName: string,
    input: unknown,
    error: string,
    toolUseId: string,
  ): Promise<AggregatedHookResult> {
    return this.engine.fire('PostToolUseFailure', this.base('PostToolUseFailure', {
      tool_name: toolName,
      tool_input: input,
      tool_error: error,
      tool_use_id: toolUseId,
    }));
  }

  // ─── Session Events ──────────────────────────────────────────────

  fireSessionStart(): Promise<AggregatedHookResult> {
    return this.engine.fire('SessionStart', this.base('SessionStart'));
  }

  fireSessionEnd(): void {
    this.engine.fireAsync('SessionEnd', this.base('SessionEnd'));
  }

  fireSetup(): Promise<AggregatedHookResult> {
    return this.engine.fire('Setup', this.base('Setup'));
  }

  // ─── User Events ─────────────────────────────────────────────────

  fireUserPromptSubmit(message: string, uuid: string): Promise<AggregatedHookResult> {
    return this.engine.fire('UserPromptSubmit', this.base('UserPromptSubmit', {
      user_message: message,
      user_message_uuid: uuid,
    }));
  }

  // ─── Permission Events ───────────────────────────────────────────

  firePermissionDenied(toolName: string, input: unknown, reason: string): Promise<AggregatedHookResult> {
    return this.engine.fire('PermissionDenied', this.base('PermissionDenied', {
      tool_name: toolName,
      tool_input: input,
      permission_reason: reason,
    }));
  }

  firePermissionRequest(toolName: string, input: unknown, decision: string): Promise<AggregatedHookResult> {
    return this.engine.fire('PermissionRequest', this.base('PermissionRequest', {
      tool_name: toolName,
      tool_input: input,
      permission_decision: decision,
    }));
  }

  // ─── Agent Events ────────────────────────────────────────────────

  fireSubagentStart(agentId: string, parentId: string, type: string): Promise<AggregatedHookResult> {
    return this.engine.fire('SubagentStart', this.base('SubagentStart', {
      agent_id: agentId,
      parent_agent_id: parentId,
      subagent_type: type,
    }));
  }

  fireSubagentStop(agentId: string): Promise<AggregatedHookResult> {
    return this.engine.fire('SubagentStop', this.base('SubagentStop', {
      agent_id: agentId,
    }));
  }

  // ─── File Events ─────────────────────────────────────────────────

  fireFileChanged(filePath: string, changeType: string): Promise<AggregatedHookResult> {
    return this.engine.fire('FileChanged', this.base('FileChanged', {
      file_path: filePath,
      file_change_type: changeType,
    }));
  }

  fireCwdChanged(): Promise<AggregatedHookResult> {
    return this.engine.fire('CwdChanged', this.base('CwdChanged'));
  }

  // ─── Task Events ─────────────────────────────────────────────────

  fireTaskCreated(taskId: string, title: string): Promise<AggregatedHookResult> {
    return this.engine.fire('TaskCreated', this.base('TaskCreated', {
      task_id: taskId,
      task_title: title,
    }));
  }

  fireTaskCompleted(taskId: string): Promise<AggregatedHookResult> {
    return this.engine.fire('TaskCompleted', this.base('TaskCompleted', {
      task_id: taskId,
      task_status: 'completed',
    }));
  }

  // ─── Config Events ───────────────────────────────────────────────

  fireConfigChange(): Promise<AggregatedHookResult> {
    return this.engine.fire('ConfigChange', this.base('ConfigChange'));
  }

  fireInstructionsLoaded(): Promise<AggregatedHookResult> {
    return this.engine.fire('InstructionsLoaded', this.base('InstructionsLoaded'));
  }

  // ─── Lifecycle Events ────────────────────────────────────────────

  fireStop(): Promise<AggregatedHookResult> {
    return this.engine.fire('Stop', this.base('Stop'));
  }

  fireStopFailure(): Promise<AggregatedHookResult> {
    return this.engine.fire('StopFailure', this.base('StopFailure'));
  }

  // ─── Context Update ──────────────────────────────────────────────

  /**
   * Update the dispatcher context (e.g., after cwd change).
   */
  updateContext(updates: Partial<DispatcherContext>): HookEventDispatcher {
    return new HookEventDispatcher(this.engine, { ...this.ctx, ...updates });
  }
}
