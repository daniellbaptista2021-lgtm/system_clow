/**
 * Tool.ts — The Universal Tool Interface
 *
 * Every action System Clow takes goes through this single interface.
 * Based on Claude Code's Tool.ts (793 lines, 30+ methods)
 *
 * Design: Behavioral flags over capability classes.
 * Instead of ReadOnlyTool/WritableTool inheritance, we use boolean methods
 * that can be INPUT-DEPENDENT (e.g., BashTool.isReadOnly('ls') = true, BashTool.isReadOnly('rm') = false)
 */

import { z } from 'zod';

// ─── Core Types ─────────────────────────────────────────────────────────────

export interface ToolResult<Output = unknown> {
  output: Output;
  /** String representation sent to the model */
  outputText: string;
  /** Whether the tool produced an error */
  isError?: boolean;
  /** Metadata not sent to the model */
  metadata?: Record<string, unknown>;
}

export interface ToolUseContext {
  cwd: string;
  sessionId: string;
  abortSignal?: AbortSignal;
  /** For permission checks */
  permissionMode: string;
  /** Tool options from tool registry */
  options: {
    tools: Tool[];
  };
}

export type PermissionResult =
  | { behavior: 'allow'; updatedInput?: unknown }
  | { behavior: 'deny'; message: string }
  | { behavior: 'ask'; message: string }
  | { behavior: 'passthrough' };

export type ValidationResult =
  | { valid: true }
  | { valid: false; message: string };

export type CanUseToolFn = (
  tool: Tool,
  input: unknown,
  toolUseId: string,
) => Promise<PermissionResult>;

// ─── The Tool Interface ─────────────────────────────────────────────────────

export interface Tool<Input = unknown, Output = unknown> {
  // ── Identity ──
  readonly name: string;
  aliases?: string[];
  searchHint?: string;

  // ── Schema (Zod) ──
  readonly inputSchema: z.ZodType<Input, any, any>;
  outputSchema?: z.ZodType<Output>;

  // ── Core Execution ──
  call(
    input: Input,
    context: ToolUseContext,
    canUseTool: CanUseToolFn,
    toolUseId: string,
  ): Promise<ToolResult<Output>>;

  // ── Permission Pipeline ──
  validateInput?(input: Input, context: ToolUseContext): Promise<ValidationResult>;
  checkPermissions(
    input: Input,
    context: ToolUseContext,
  ): Promise<PermissionResult>;
  preparePermissionMatcher?(input: Input): Promise<(pattern: string) => boolean>;

  // ── Behavioral Flags ──
  isEnabled(): boolean;
  isReadOnly(input: Input): boolean;
  isConcurrencySafe(input: Input): boolean;
  isDestructive?(input: Input): boolean;

  // ── UI ──
  userFacingName(input?: Input): string;

  // ── LLM Description ──
  description: string;

  // ── Deferred loading (for ToolSearch) ──
  shouldDefer?: boolean;
  alwaysLoad?: boolean;
}

// ─── buildTool() Factory — Fail-Closed Defaults ─────────────────────────────
// A tool that forgets to declare isConcurrencySafe defaults to false (serialize)
// A tool that forgets isReadOnly defaults to false (requires permission)

type PartialTool<Input = unknown, Output = unknown> = Partial<Tool<Input, Output>> &
  Pick<Tool<Input, Output>, 'name' | 'inputSchema' | 'call' | 'description'>;

const TOOL_DEFAULTS: Omit<Tool, 'name' | 'inputSchema' | 'call' | 'description'> = {
  isEnabled: () => true,
  isConcurrencySafe: () => false,
  isReadOnly: () => false,
  checkPermissions: async () => ({ behavior: 'passthrough' as const }),
  userFacingName: function (this: Tool) {
    return this.name;
  },
};

export function buildTool<Input = unknown, Output = unknown>(
  def: PartialTool<Input, Output>,
): Tool<Input, Output> {
  return {
    ...TOOL_DEFAULTS,
    userFacingName: () => def.name,
    ...def,
  } as Tool<Input, Output>;
}

// ─── Tool Array Type ────────────────────────────────────────────────────────

export type Tools = Tool[];
