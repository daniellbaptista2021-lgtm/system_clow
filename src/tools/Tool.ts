/**
 * Tool.ts — The Universal Tool Interface (Full Implementation)
 *
 * Based on Claude Code's Tool.ts (793 lines, 30+ methods)
 * Every action System Clow takes — reading files, running bash, spawning agents,
 * calling MCP servers — goes through this single interface.
 *
 * Design principles:
 *   1. Behavioral flags over capability classes (no ReadOnlyTool/WritableTool inheritance)
 *   2. Flags can be INPUT-DEPENDENT (BashTool.isReadOnly('ls') = true, isReadOnly('rm') = false)
 *   3. Fail-closed defaults via buildTool() factory
 *   4. Every tool is self-contained: impl + prompt + render + validation in one module
 */

import { z } from 'zod';

// ════════════════════════════════════════════════════════════════════════════
// Core Types
// ════════════════════════════════════════════════════════════════════════════

export type ToolName = string;

// ─── Permission Types ───────────────────────────────────────────────────────

export type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'dontAsk'
  | 'auto'
  | 'plan';

export type PermissionBehavior = 'allow' | 'deny' | 'ask' | 'passthrough';

export interface PermissionResult {
  behavior: PermissionBehavior;
  message?: string;
  updatedInput?: unknown;
  decisionReason?: PermissionDecisionReason;
}

export type PermissionDecisionReason =
  | { type: 'rule'; ruleSource: string }
  | { type: 'mode'; mode: PermissionMode }
  | { type: 'tool'; reason: string }
  | { type: 'user' }
  | { type: 'hook'; hookId: string }
  | { type: 'classifier'; confidence: number };

export interface PermissionRule {
  toolName: ToolName;
  ruleContent?: string;
  decision: 'allow' | 'deny' | 'ask';
  source: 'session' | 'user' | 'project' | 'policy' | 'cli' | 'tier';
}

// ─── Validation Types ───────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  message?: string;
  errorCode?: string;
  errorBehavior?: 'fail' | 'warn';
}

// ─── Tool Result ────────────────────────────────────────────────────────────

export interface ToolResult<Output = unknown> {
  output: Output;
  /** String representation sent to the model */
  outputText: string;
  /** Whether the tool produced an error */
  isError?: boolean;
  /** Metadata not sent to the model */
  metadata?: ToolResultMeta;
}

export interface ToolResultMeta {
  durationMs?: number;
  tokensUsed?: number;
  filesModified?: string[];
  filesRead?: string[];
  costUsd?: number;
  [key: string]: unknown;
}

// ─── Tool Error ─────────────────────────────────────────────────────────────

export interface ToolError {
  code: string;
  message: string;
  recoverable: boolean;
  userActionRequired?: boolean;
}

// ─── Tool Use Context ───────────────────────────────────────────────────────

export interface ToolUseContext {
  /** Current working directory */
  cwd: string;
  /** Session identifier */
  sessionId: string;
  /** Tenant identifier (multi-tenant mode) */
  tenantId?: string;
  /** Workspace root for path isolation */
  workspaceRoot?: string;
  /** Current permission mode */
  permissionMode: string;
  /** Abort signal for cancellation */
  abortSignal?: AbortSignal;
  /** Agent nesting depth (0 = root) */
  depth?: number;
  /** Tools available in this context */
  options: {
    tools: Tool[];
  };
}

// ─── Render Options ─────────────────────────────────────────────────────────

export interface RenderOptions {
  verbose: boolean;
  width: number;
  isInteractive: boolean;
}

// ─── CanUseTool Function ────────────────────────────────────────────────────

export type CanUseToolFn = (
  tool: Tool,
  input: unknown,
  toolUseId: string,
) => Promise<PermissionResult>;

// ════════════════════════════════════════════════════════════════════════════
// The Tool Interface — 30+ Methods, One Contract
// ════════════════════════════════════════════════════════════════════════════

export interface Tool<Input = unknown, Output = unknown, Progress = unknown> {
  // ── Identity ──────────────────────────────────────────────────────────
  readonly name: ToolName;
  /** Legacy name support */
  aliases?: ToolName[];
  /** Keyword for ToolSearch discovery */
  searchHint?: string;
  /** Human-facing name for UI display */
  userFacingName(input?: Input): string;

  // ── Schemas ───────────────────────────────────────────────────────────
  /** Runtime validation + TS inference via Zod */
  readonly inputSchema: z.ZodType<Input, any, any>;
  /** Output validation (optional) */
  outputSchema?: z.ZodType<Output>;

  // ── Description (LLM-facing) ──────────────────────────────────────────
  /** Description text sent to the LLM */
  description: string;

  // ── Core Execution ────────────────────────────────────────────────────
  call(
    input: Input,
    context: ToolUseContext,
    canUseTool: CanUseToolFn,
    toolUseId: string,
    onProgress?: (p: Progress) => void,
  ): Promise<ToolResult<Output>>;

  // ── Validation ────────────────────────────────────────────────────────
  /** Validate input BEFORE permission check (Zod schema + custom rules) */
  validateInput?(input: Input, context: ToolUseContext): Promise<ValidationResult>;

  // ── Permission Pipeline ───────────────────────────────────────────────
  /** Tool-specific permission check */
  checkPermissions(input: Input, context: ToolUseContext): Promise<PermissionResult>;
  /** Pre-compile a matcher closure for pattern-based permission rules */
  preparePermissionMatcher?(input: Input): Promise<(pattern: string) => boolean>;
  /** String representation for the auto-permission classifier */
  toAutoClassifierInput?(input: Input): string;

  // ── Behavioral Flags (input-dependent) ────────────────────────────────
  /** Is this tool available? */
  isEnabled(): boolean;
  /** Is this operation read-only for the given input? */
  isReadOnly(input: Input): boolean;
  /** Can this operation run in parallel with others? */
  isConcurrencySafe(input: Input): boolean;
  /** Is this operation irreversible (delete, overwrite)? */
  isDestructive?(input: Input): boolean;

  // ── Interrupt Behavior ────────────────────────────────────────────────
  /** What to do on Ctrl+C: 'cancel' kills immediately, 'block' waits for completion */
  interruptBehavior?(): 'cancel' | 'block';

  // ── Tool Loading (ToolSearch) ─────────────────────────────────────────
  /** If true, tool is deferred and discovered via ToolSearch keyword */
  shouldDefer?: boolean;
  /** If true, tool is always loaded even when ToolSearch is active */
  alwaysLoad?: boolean;

  // ── Rendering (CLI + Hooks) ───────────────────────────────────────────
  /** How to display tool being called */
  renderToolUseMessage(input: Input, options: RenderOptions): string;
  /** How to display tool result */
  renderToolResultMessage?(content: Output, progress: Progress | undefined, options: RenderOptions): string;
  /** How to display in-progress streaming */
  renderToolUseProgressMessage?(progress: Progress, options: RenderOptions): string;
  /** How to display permission denial */
  renderToolUseRejectedMessage?(input: Input, reason: string, options: RenderOptions): string;
  /** How to display tool error */
  renderToolUseErrorMessage?(error: ToolError, options: RenderOptions): string;
  /** Fallback generic renderer */
  renderToolResultGenericMessage?(content: unknown, options: RenderOptions): string;
  /** Group multiple calls of same tool (e.g., 5 Grep calls → one summary) */
  renderGroupedToolUse?(
    toolUses: Array<{ input: Input; result?: Output }>,
    options: RenderOptions,
  ): string | null;
}

// ════════════════════════════════════════════════════════════════════════════
// buildTool() Factory — Fail-Closed Defaults
// ════════════════════════════════════════════════════════════════════════════
//
// A tool that forgets to declare isConcurrencySafe → defaults to false (serialize)
// A tool that forgets isReadOnly → defaults to false (requires permission)
// A tool that forgets isDestructive → defaults to false (but NOT safe — isReadOnly is false)
// This is FAIL-CLOSED security by default.

/** Minimum required fields to define a tool */
type PartialTool<Input = unknown, Output = unknown, Progress = unknown> =
  Partial<Tool<Input, Output, Progress>> &
  Pick<Tool<Input, Output, Progress>, 'name' | 'inputSchema' | 'call' | 'description'>;

/** Default implementations for all optional Tool methods */
const TOOL_DEFAULTS = {
  // Identity
  aliases: undefined as string[] | undefined,
  searchHint: undefined as string | undefined,
  userFacingName(_input?: unknown): string {
    return (this as any).name || 'Tool';
  },

  // Schemas
  outputSchema: undefined,

  // Lifecycle — fail-closed
  isEnabled: () => true,
  isReadOnly: (_input: unknown) => false,       // assume writes
  isConcurrencySafe: (_input: unknown) => false, // assume NOT safe
  isDestructive: (_input: unknown) => false,

  // Interrupt
  interruptBehavior: () => 'cancel' as const,

  // Loading
  shouldDefer: false as boolean | undefined,
  alwaysLoad: false as boolean | undefined,

  // Validation — pass by default
  async validateInput(_input: unknown, _context: ToolUseContext): Promise<ValidationResult> {
    return { valid: true };
  },

  // Permissions — defer to general pipeline
  async checkPermissions(_input: unknown, _context: ToolUseContext): Promise<PermissionResult> {
    return { behavior: 'passthrough' };
  },

  // No matcher by default (only matches exact tool name)
  preparePermissionMatcher: undefined as
    | ((input: unknown) => Promise<(pattern: string) => boolean>)
    | undefined,

  // Auto-classifier: empty = skip
  toAutoClassifierInput: (_input: unknown) => '',

  // Render — minimal defaults
  renderToolUseMessage(input: unknown, _options: RenderOptions): string {
    const name = (this as any).name || 'Tool';
    try {
      const preview = JSON.stringify(input);
      return preview.length > 100 ? `${name}(${preview.slice(0, 97)}...)` : `${name}(${preview})`;
    } catch {
      return `${name}(...)`;
    }
  },

  renderToolResultMessage(_content: unknown, _progress: unknown, _options: RenderOptions): string {
    return '';
  },

  renderToolUseProgressMessage(_progress: unknown, _options: RenderOptions): string {
    return '';
  },

  renderToolUseRejectedMessage(input: unknown, reason: string, _options: RenderOptions): string {
    return `[${(this as any).name}] denied: ${reason}`;
  },

  renderToolUseErrorMessage(error: ToolError, _options: RenderOptions): string {
    return `[${(this as any).name}] error: ${error.message}`;
  },

  renderToolResultGenericMessage(content: unknown, _options: RenderOptions): string {
    return typeof content === 'string' ? content : JSON.stringify(content);
  },

  renderGroupedToolUse: undefined as
    | ((toolUses: Array<{ input: unknown; result?: unknown }>, options: RenderOptions) => string | null)
    | undefined,
};

/**
 * Build a tool with fail-closed defaults.
 * Only `name`, `inputSchema`, `call`, and `description` are required.
 * Everything else has a safe default.
 */
export function buildTool<Input = unknown, Output = unknown, Progress = unknown>(
  def: PartialTool<Input, Output, Progress>,
): Tool<Input, Output, Progress> {
  // Validate at construction time (fail fast)
  if (!def.name || typeof def.name !== 'string') {
    throw new Error('Tool must have a string name');
  }
  if (!def.inputSchema) {
    throw new Error(`Tool "${def.name}" missing inputSchema`);
  }
  if (typeof def.call !== 'function') {
    throw new Error(`Tool "${def.name}" missing call function`);
  }

  return {
    ...TOOL_DEFAULTS,
    userFacingName: () => def.name,
    ...def,
  } as unknown as Tool<Input, Output, Progress>;
}

// ════════════════════════════════════════════════════════════════════════════
// Type Guards
// ════════════════════════════════════════════════════════════════════════════

/** Check isReadOnly with error handling (fail-closed: false on error) */
export function isToolReadOnlyForInput(tool: Tool, input: unknown): boolean {
  try {
    return tool.isReadOnly(input);
  } catch {
    return false; // fail-closed
  }
}

/** Check isDestructive with error handling (fail-closed: true on error) */
export function isToolDestructiveForInput(tool: Tool, input: unknown): boolean {
  try {
    return tool.isDestructive?.(input) ?? false;
  } catch {
    return true; // fail-closed
  }
}

/** Check isConcurrencySafe with error handling (fail-closed: false on error) */
export function isToolConcurrencySafeForInput(tool: Tool, input: unknown): boolean {
  try {
    return tool.isConcurrencySafe(input);
  } catch {
    return false; // fail-closed
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Tool Array Type
// ════════════════════════════════════════════════════════════════════════════

export type Tools = Tool[];
