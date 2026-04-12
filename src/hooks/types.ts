/**
 * types.ts — Hook system vocabulary
 *
 * Based on Claude Code's hook types (~300 lines)
 *
 * Complete type definitions for:
 *   - 24 event types
 *   - 4 hook executor types (command, http, agent, function)
 *   - Hook I/O protocol
 *   - Configured hook structure
 *   - Aggregated results
 *   - Async hook tracking
 *   - Hook metrics
 */

import type { ChildProcess } from 'child_process';

// ════════════════════════════════════════════════════════════════════════════
// Hook Events
// ════════════════════════════════════════════════════════════════════════════

export type HookEventName =
  | 'SessionStart'
  | 'SessionEnd'
  | 'Setup'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'PermissionDenied'
  | 'PermissionRequest'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'TeammateIdle'
  | 'UserPromptSubmit'
  | 'ConfigChange'
  | 'CwdChanged'
  | 'FileChanged'
  | 'InstructionsLoaded'
  | 'TaskCreated'
  | 'TaskCompleted'
  | 'StatusLine'
  | 'FileSuggestion'
  | 'Stop'
  | 'StopFailure'
  | 'Elicitation'
  | 'ElicitationResult';

export const ALL_HOOK_EVENTS: HookEventName[] = [
  'SessionStart', 'SessionEnd', 'Setup',
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'PermissionDenied', 'PermissionRequest',
  'SubagentStart', 'SubagentStop', 'TeammateIdle',
  'UserPromptSubmit', 'ConfigChange', 'CwdChanged',
  'FileChanged', 'InstructionsLoaded',
  'TaskCreated', 'TaskCompleted',
  'StatusLine', 'FileSuggestion',
  'Stop', 'StopFailure',
  'Elicitation', 'ElicitationResult',
];

/**
 * Event categories for filtering and display.
 */
export const EVENT_CATEGORIES: Record<string, HookEventName[]> = {
  session: ['SessionStart', 'SessionEnd', 'Setup'],
  tools: ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'],
  permissions: ['PermissionDenied', 'PermissionRequest'],
  agents: ['SubagentStart', 'SubagentStop', 'TeammateIdle'],
  user: ['UserPromptSubmit', 'Elicitation', 'ElicitationResult'],
  config: ['ConfigChange', 'CwdChanged', 'FileChanged', 'InstructionsLoaded'],
  tasks: ['TaskCreated', 'TaskCompleted'],
  ui: ['StatusLine', 'FileSuggestion'],
  lifecycle: ['Stop', 'StopFailure'],
};

// ════════════════════════════════════════════════════════════════════════════
// Hook Types (4 executor types)
// ════════════════════════════════════════════════════════════════════════════

export type HookType = 'command' | 'http' | 'agent' | 'function';

export interface CommandHookConfig {
  type: 'command';
  /** Shell command to execute */
  command: string;
  /** Working directory (defaults to session cwd) */
  cwd?: string;
  /** Timeout in milliseconds (default 30s) */
  timeout_ms?: number;
  /** Additional environment variables */
  env?: Record<string, string>;
}

export interface HttpHookConfig {
  type: 'http';
  /** Webhook URL */
  url: string;
  /** HTTP method (default POST) */
  method?: 'POST' | 'PUT';
  /** Additional headers */
  headers?: Record<string, string>;
  /** Timeout in milliseconds (default 10s) */
  timeout_ms?: number;
}

export interface AgentHookConfig {
  type: 'agent';
  /** Agent name or description */
  agent: string;
  /** Subagent type for spawning */
  subagent_type?: string;
}

export interface FunctionHookConfig {
  type: 'function';
  /** In-process callback function */
  callback: (input: HookInput) => Promise<HookOutput | null>;
}

export type HookConfig = CommandHookConfig | HttpHookConfig | AgentHookConfig | FunctionHookConfig;

// ════════════════════════════════════════════════════════════════════════════
// Configured Hook (runtime representation)
// ════════════════════════════════════════════════════════════════════════════

export interface ConfiguredHook {
  /** Unique ID for this hook instance */
  id: string;
  /** Event this hook listens for */
  event: HookEventName;
  /** Optional matcher pattern (e.g., "Bash(git *)" or tool name) */
  matcher?: string;
  /** Hook executor configuration */
  hook: HookConfig;
  /** Where this hook was loaded from */
  source: 'user' | 'project' | 'plugin' | 'sdk';
  /** Path to the config file that defined this hook */
  sourcePath?: string;
  /** Whether this hook is active */
  enabled: boolean;
  /** Priority (higher = runs first) */
  priority: number;
  /** When this hook was registered */
  createdAt: number;
}

// ════════════════════════════════════════════════════════════════════════════
// Hook Input (passed to executors)
// ════════════════════════════════════════════════════════════════════════════

export interface HookInput {
  /** Event name that triggered this hook */
  hook_event_name: HookEventName;
  /** ID of the hook being executed */
  hook_id: string;
  /** Session ID */
  session_id: string;
  /** Path to the session JSONL file */
  transcript_path: string;
  /** Current working directory */
  cwd: string;
  /** Workspace root */
  workspace_root: string;
  /** Permission mode */
  permission_mode: string;
  /** Agent nesting depth */
  agent_depth: number;
  /** Timestamp of this event */
  timestamp: number;

  // Tool-related fields (PreToolUse, PostToolUse)
  tool_name?: string;
  tool_input?: unknown;
  tool_use_id?: string;
  tool_output?: unknown;
  tool_error?: string;
  tool_duration_ms?: number;

  // Agent fields (SubagentStart, SubagentStop)
  agent_id?: string;
  parent_agent_id?: string;
  subagent_type?: string;

  // User fields
  user_message?: string;
  user_message_uuid?: string;

  // File fields (FileChanged)
  file_path?: string;
  file_change_type?: string;

  // Task fields
  task_id?: string;
  task_title?: string;
  task_status?: string;

  // Permission fields
  permission_decision?: string;
  permission_reason?: string;

  // Multi-tenant fields
  tenant_id?: string;
  tier?: string;
}

// ════════════════════════════════════════════════════════════════════════════
// Hook Output (returned from executors)
// ════════════════════════════════════════════════════════════════════════════

export interface HookOutput {
  /** Whether to continue execution (false = stop) */
  continue?: boolean;
  /** Decision: approve, block, or ask the user */
  decision?: 'approve' | 'block' | 'ask';
  /** Human-readable reason */
  reason?: string;
  /** System message to inject into conversation */
  systemMessage?: string;
  /** Event-specific output data */
  hookSpecificOutput?: HookSpecificOutput;
  /** Whether this hook is running asynchronously */
  async?: boolean;
  /** Whether to wake the session when async hook completes */
  asyncRewake?: boolean;
  /** Task ID for async tracking */
  asyncTaskId?: string;
}

export interface HookSpecificOutput {
  /** Event name (for routing) */
  hookEventName?: string;
  /** Permission decision override */
  permissionDecision?: 'allow' | 'deny' | 'ask';
  /** Modified tool input */
  updatedInput?: unknown;
  /** Additional context to add to the conversation */
  additionalContext?: string;
}

// ════════════════════════════════════════════════════════════════════════════
// Aggregated Result (combined output from multiple hooks)
// ════════════════════════════════════════════════════════════════════════════

export interface AggregatedHookResult {
  /** Final permission decision (most restrictive wins) */
  finalDecision: 'allow' | 'deny' | 'ask';
  /** Whether any hook blocked execution */
  blocked: boolean;
  /** Whether to stop the current operation */
  preventContinuation: boolean;
  /** Modified tool input (if any hook updated it) */
  updatedInput?: unknown;
  /** Combined system messages from all hooks */
  systemMessages: string;
  /** Combined additional contexts */
  additionalContexts: string;
  /** Reasons from all hooks */
  reasons: string[];
  /** Number of hooks that executed */
  hookCount: number;
  /** IDs of hooks running asynchronously */
  asyncHookIds: string[];
  /** Errors from hook execution */
  errors: Array<{ hookId: string; message: string }>;
}

// ════════════════════════════════════════════════════════════════════════════
// Async Hook Tracking
// ════════════════════════════════════════════════════════════════════════════

export interface PendingAsyncHook {
  /** Unique ID for this async task */
  id: string;
  /** ID of the hook that spawned this task */
  hookId: string;
  /** Session ID */
  sessionId: string;
  /** Event that triggered this hook */
  event: HookEventName;
  /** When the async task started */
  startedAt: number;
  /** Whether to wake the session on completion */
  rewake: boolean;
  /** Process handle for command hooks */
  processHandle?: ChildProcess;
}

export interface AsyncHookCompletion {
  /** ID of the completed hook */
  hookId: string;
  /** Result from the hook */
  result: HookOutput;
  /** Duration in ms */
  durationMs: number;
}

// ════════════════════════════════════════════════════════════════════════════
// Hook Metrics
// ════════════════════════════════════════════════════════════════════════════

export interface HookMetrics {
  /** Total hooks registered */
  totalHooks: number;
  /** Hooks by event */
  hooksByEvent: Record<string, number>;
  /** Hooks by type */
  hooksByType: Record<string, number>;
  /** Total executions */
  totalExecutions: number;
  /** Total blocks */
  totalBlocks: number;
  /** Average execution time in ms */
  avgExecutionMs: number;
  /** Error count */
  errorCount: number;
}

// ════════════════════════════════════════════════════════════════════════════
// Hook Profile Type
// ════════════════════════════════════════════════════════════════════════════

/**
 * Performance profile for a single hook.
 * Tracks execution timing, success rate, and resource usage.
 */
export interface HookProfile {
  /** The hook ID this profile belongs to */
  hookId: string;
  /** Event this hook handles */
  event: HookEventName;
  /** Hook type (command, http, agent, function) */
  hookType: HookType;
  /** Total number of executions */
  executionCount: number;
  /** Total execution time across all runs (ms) */
  totalDurationMs: number;
  /** Average execution time (ms) */
  avgDurationMs: number;
  /** Minimum execution time (ms) */
  minDurationMs: number;
  /** Maximum execution time (ms) */
  maxDurationMs: number;
  /** P95 execution time (ms) — estimated from max */
  p95DurationMs: number;
  /** Number of errors during execution */
  errorCount: number;
  /** Error rate (0-1) */
  errorRate: number;
  /** Number of times this hook blocked an operation */
  blockCount: number;
  /** When this hook was last executed */
  lastExecutedAt: number;
  /** When this hook was first executed */
  firstExecutedAt: number;
  /** Whether this hook is considered slow (avg > 1000ms) */
  isSlow: boolean;
  /** Whether this hook has a high error rate (> 10%) */
  isUnreliable: boolean;
}

// ════════════════════════════════════════════════════════════════════════════
// Hook Dependency Type
// ════════════════════════════════════════════════════════════════════════════

/**
 * Describes a dependency relationship between hooks.
 * Used to ensure hooks execute in the correct order.
 */
export interface HookDependency {
  /** The hook that has the dependency */
  hookId: string;
  /** The hook that must execute first */
  dependsOn: string;
  /** Type of dependency relationship */
  relationship: HookDependencyRelationship;
  /** Whether this dependency is required (hard) or optional (soft) */
  required: boolean;
  /** Human-readable description of why this dependency exists */
  reason: string;
}

/**
 * Types of dependency relationships between hooks.
 */
export type HookDependencyRelationship =
  | 'must_run_before'   // dependsOn must complete before hookId runs
  | 'must_run_after'    // hookId must run after dependsOn completes
  | 'same_event_order'  // Both hooks on same event, order matters
  | 'lifecycle_pair';   // Start/Stop or Pre/Post pairing

/**
 * Result of validating hook dependencies.
 */
export interface HookDependencyValidation {
  /** Whether all dependencies are satisfied */
  valid: boolean;
  /** List of dependency issues found */
  issues: Array<{
    hookId: string;
    dependsOn: string;
    issue: string;
    severity: 'warning' | 'error';
  }>;
  /** Computed execution order (topological sort) */
  executionOrder: string[];
}

// ════════════════════════════════════════════════════════════════════════════
// Hook Event Statistics Type
// ════════════════════════════════════════════════════════════════════════════

/**
 * Statistics about a specific hook event.
 */
export interface HookEventStats {
  /** The event name */
  event: HookEventName;
  /** Total number of times this event was fired */
  fireCount: number;
  /** Number of hooks registered for this event */
  registeredHookCount: number;
  /** Number of enabled hooks for this event */
  enabledHookCount: number;
  /** Total execution time across all firings (ms) */
  totalExecutionMs: number;
  /** Average execution time per firing (ms) */
  avgExecutionMs: number;
  /** Number of times hooks blocked this event */
  blockCount: number;
  /** Number of errors during event handling */
  errorCount: number;
  /** When this event was last fired */
  lastFiredAt: number | null;
  /** When this event was first fired */
  firstFiredAt: number | null;
  /** Category this event belongs to */
  category: string;
}

// ════════════════════════════════════════════════════════════════════════════
// Hook System Configuration Type
// ════════════════════════════════════════════════════════════════════════════

/**
 * Configuration for the hook system as a whole.
 */
export interface HookSystemConfig {
  /** Whether the hook system is enabled */
  enabled: boolean;
  /** Maximum number of hooks that can be registered */
  maxHooks: number;
  /** Default timeout for hook execution in milliseconds */
  defaultTimeoutMs: number;
  /** Maximum timeout allowed for any hook */
  maxTimeoutMs: number;
  /** Whether to enable hook profiling */
  profilingEnabled: boolean;
  /** Whether to enable dependency validation */
  dependencyValidationEnabled: boolean;
  /** Maximum number of concurrent hook executions */
  maxConcurrentExecutions: number;
  /** Whether to log hook execution details */
  verboseLogging: boolean;
  /** Whether to skip hooks from untrusted workspaces */
  trustCheckEnabled: boolean;
  /** Maximum number of errors before disabling a hook */
  maxErrorsBeforeDisable: number;
  /** Whether to allow async (fire-and-forget) hooks */
  asyncHooksEnabled: boolean;
  /** Whether to allow agent-type hooks */
  agentHooksEnabled: boolean;
  /** Rate limit for hook firing (max fires per minute, 0 = unlimited) */
  rateLimitPerMinute: number;
}
