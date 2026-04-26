/**
 * types.ts — Query system type vocabulary
 * Every message type, SDK output type, and config lives here.
 */

import type { Tool, CanUseToolFn, ToolUseContext } from '../tools/Tool.js';
import type { PermissionContext } from '../utils/permissions/PermissionContext.js';
import type { HookEventDispatcher } from '../hooks/HookEventDispatcher.js';
import type { SkillEngine } from '../skills/SkillEngine.js';

// ════════════════════════════════════════════════════════════════════════════
// Message Types (internal — discriminated union)
// ════════════════════════════════════════════════════════════════════════════

export type Message =
  | UserMessage
  | AssistantMessage
  | SystemMessage
  | ProgressMessage
  | TombstoneMessage;

export interface UserMessage {
  type: 'user';
  uuid: string;
  content: string;
  parentUuid?: string;
  turnNumber: number;
  timestamp: number;
  source: 'user' | 'tool_result' | 'hook' | 'rewake' | 'compaction';
  toolCallId?: string; // for tool_result messages in API format
}

export interface AssistantMessage {
  type: 'assistant';
  uuid: string;
  messageId: string;
  content: string;
  toolCalls?: ToolCallInfo[];
  parentUuid?: string;
  turnNumber: number;
  timestamp: number;
  stopReason?: StopReason;
  usage?: TokenUsage;
  model: string;
}

export interface ToolCallInfo {
  id: string;
  name: string;
  arguments: string;
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';

export interface SystemMessage {
  type: 'system';
  uuid: string;
  subtype: SystemMessageSubtype;
  content: string;
  metadata?: Record<string, unknown>;
  turnNumber: number;
  timestamp: number;
}

export type SystemMessageSubtype =
  | 'compact_boundary'
  | 'snip_boundary'
  | 'api_error'
  | 'fallback_triggered'
  | 'budget_warning'
  | 'permission_denied'
  | 'hook_message'
  | 'skill_message'
  | 'session_resumed'
  | 'tool_result_truncated'
  | 'compacting'
  | 'compact_complete'
  | 'compact_failed';

export interface ProgressMessage {
  type: 'progress';
  uuid: string;
  toolName: string;
  toolInput?: unknown;
  progress?: unknown;
  timestamp: number;
}

export interface TombstoneMessage {
  type: 'tombstone';
  uuid: string;
  removedUuid: string;
  reason: TombstoneReason;
  timestamp: number;
}

export type TombstoneReason =
  | 'fallback_orphan'
  | 'compact_replaced'
  | 'snip_removed'
  | 'manual_remove';

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
}

// ════════════════════════════════════════════════════════════════════════════
// SDK Output (yielded to consumer)
// ════════════════════════════════════════════════════════════════════════════

export type SDKMessage =
  | { type: 'user'; content: string; uuid: string }
  | { type: 'assistant'; content: string; uuid: string; messageId?: string }
  | { type: 'system'; subtype: string; content: string }
  | { type: 'progress'; toolName: string; toolInput?: unknown }
  | { type: 'tool_result'; toolName: string; toolUseId: string; isError: boolean }
  | { type: 'tombstone'; removedUuid: string; reason: TombstoneReason }
  | { type: 'result'; subtype: ResultSubtype; content?: string; cost?: number; usage?: TokenUsage };

export type ResultSubtype =
  | 'success'
  | 'error_during_execution'
  | 'error_max_turns'
  | 'error_max_budget_usd'
  | 'error_max_tokens'
  | 'error_fallback_failed'
  | 'error_user_aborted';

// ════════════════════════════════════════════════════════════════════════════
// Configuration
// ════════════════════════════════════════════════════════════════════════════

export interface QueryEngineConfig {
  tools: Tool[];
  systemPrompt: string;
  maxTurns: number;
  maxBudgetUsd?: number;
  maxTokensPerTurn?: number;
  canUseTool: CanUseToolFn;
  depth?: number;
  dynamicContext?: string;
  fallbackModel?: string;
  getExecutionContext?: () => Pick<ToolUseContext, 'cwd' | 'sessionId' | 'permissionMode' | 'tenantId' | 'workspaceRoot'>;
  features?: {
    HISTORY_SNIP?: boolean;
    REACTIVE_COMPACT?: boolean;
    TOMBSTONE?: boolean;
    TOOL_RESULT_BUDGET?: boolean;
  };
  // Callbacks
  onText?: (text: string) => void;
  onToolUse?: (toolName: string, input: unknown) => void;
  onToolResult?: (toolName: string, result: unknown) => void;
  onTurnComplete?: (turnCount: number) => void;
  onCompact?: (originalTokens: number, newTokens: number) => void;
  onContextWarning?: (percentLeft: number) => void;
  onError?: (error: Error) => void;
  onSessionStart?: () => void;
  onSessionEnd?: (reason: string) => void;
  hookDispatcher?: HookEventDispatcher;
  skillEngine?: SkillEngine;
}

// ════════════════════════════════════════════════════════════════════════════
// Query Engine State
// ════════════════════════════════════════════════════════════════════════════

export type QueryPhase =
  | 'idle'
  | 'preparing_context'
  | 'calling_api'
  | 'streaming_response'
  | 'processing_tool_calls'
  | 'executing_tool'
  | 'compacting'
  | 'error_recovery'
  | 'complete'
  | 'aborted';

export interface QueryState {
  phase: QueryPhase;
  turnNumber: number;
  totalCostUsd: number;
  totalTokens: number;
  currentToolName?: string;
  lastError?: string;
  startedAt: number;
  lastActivityAt: number;
}

// ════════════════════════════════════════════════════════════════════════════
// Tool Execution Types
// ════════════════════════════════════════════════════════════════════════════

export interface ToolExecutionResult {
  toolName: string;
  toolUseId: string;
  result: string;
  isError: boolean;
  durationMs: number;
  permissionDecision?: 'allow' | 'deny' | 'ask';
  truncated?: boolean;
}

export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: string;
  parsedArguments?: Record<string, unknown>;
}

// ════════════════════════════════════════════════════════════════════════════
// API Call Types
// ════════════════════════════════════════════════════════════════════════════

export interface APICallResult {
  messageId: string;
  content: string;
  toolCalls: ToolCallRequest[];
  stopReason: StopReason;
  usage: TokenUsage;
  model: string;
  durationMs: number;
  cacheHit: boolean;
}

// ════════════════════════════════════════════════════════════════════════════
// Query Statistics
// ════════════════════════════════════════════════════════════════════════════

export interface QueryStats {
  turnCount: number;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheHitTokens: number;
  cacheHitRate: number;
  toolCallCount: number;
  uniqueToolsUsed: string[];
  avgTurnDurationMs: number;
  compactCount: number;
  errorCount: number;
  fallbackCount: number;
  sessionDurationMs: number;
}

// ════════════════════════════════════════════════════════════════════════════
// Context Assembly Types
// ════════════════════════════════════════════════════════════════════════════

export interface AssembledContext {
  /** Static system prompt (for prompt cache) */
  systemPrompt: string;
  /** Dynamic context (first user message for cache optimization) */
  dynamicContext: string;
  /** Conversation messages (after tombstone resolution) */
  messages: unknown[];
  /** Estimated total tokens */
  estimatedTokens: number;
  /** Available tools */
  tools: unknown[];
  /** Injected skill content */
  skillContent?: string;
}

// ════════════════════════════════════════════════════════════════════════════
// Error Types
// ════════════════════════════════════════════════════════════════════════════

export type QueryErrorType =
  | 'api_error'
  | 'rate_limit'
  | 'context_overflow'
  | 'tool_error'
  | 'permission_denied'
  | 'budget_exceeded'
  | 'timeout'
  | 'user_abort'
  | 'unknown';

export interface QueryError {
  type: QueryErrorType;
  message: string;
  recoverable: boolean;
  turnNumber: number;
  timestamp: number;
  toolName?: string;
}

// ════════════════════════════════════════════════════════════════════════════
// Streaming Types
// ════════════════════════════════════════════════════════════════════════════

/**
 * A chunk emitted during streaming.
 */
export interface StreamingChunk {
  type: 'text' | 'tool_call_start' | 'tool_call_args' | 'tool_call_end' | 'done';
  content?: string;
  toolName?: string;
  toolCallId?: string;
  toolArgs?: string;
  finishReason?: StopReason;
  usage?: TokenUsage;
}

// ════════════════════════════════════════════════════════════════════════════
// Permission Check Types
// ════════════════════════════════════════════════════════════════════════════

export interface PermissionCheckResult {
  allowed: boolean;
  reason: string;
  source: 'default' | 'user_rule' | 'session_rule' | 'hook' | 'classifier' | 'mode';
  permanent: boolean;
  toolName: string;
}

// ════════════════════════════════════════════════════════════════════════════
// Query Engine Events
// ════════════════════════════════════════════════════════════════════════════

export type QueryEngineEventType =
  | 'turn_start'
  | 'turn_end'
  | 'api_call_start'
  | 'api_call_end'
  | 'tool_start'
  | 'tool_end'
  | 'compact_start'
  | 'compact_end'
  | 'error'
  | 'abort'
  | 'budget_warning'
  | 'context_warning'
  | 'text_chunk'
  | 'session_start'
  | 'session_end';

export interface QueryEngineEvent {
  type: QueryEngineEventType;
  timestamp: number;
  data: Record<string, unknown>;
}

export type QueryEngineEventHandler = (event: QueryEngineEvent) => void;

// ════════════════════════════════════════════════════════════════════════════
// Turn Types
// ════════════════════════════════════════════════════════════════════════════

export interface TurnRecord {
  turnNumber: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens: number;
  costUsd: number;
  toolCalls: number;
  durationMs: number;
  stopReason: StopReason;
  timestamp: number;
}

// ════════════════════════════════════════════════════════════════════════════
// Compaction Request (from QueryEngine to Compact system)
// ════════════════════════════════════════════════════════════════════════════

export interface CompactionRequest {
  trigger: 'auto' | 'manual' | 'reactive';
  currentTokens: number;
  maxTokens: number;
  messages: unknown[];
  model: string;
  systemPrompt: string;
}

// ════════════════════════════════════════════════════════════════════════════
// Constants
// ════════════════════════════════════════════════════════════════════════════

/** Default max turns before forcing stop */
export const DEFAULT_MAX_TURNS = 200;

/** Default max budget in USD */
export const DEFAULT_MAX_BUDGET_USD = 5.0;

/** Max tokens per turn (output limit) */
export const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

/** Context window size for Claude Sonnet */
export const CLAUDE_CONTEXT_WINDOW = 200_000;

/** Tokens reserved for output in each turn */
export const OUTPUT_TOKEN_RESERVATION = 8192;

/** Warning threshold (tokens remaining before warning) */
export const CONTEXT_WARNING_THRESHOLD = 20_000;

/** Critical threshold (tokens remaining before forced compaction) */
export const CONTEXT_CRITICAL_THRESHOLD = 5_000;

/** Max consecutive API errors before giving up */
export const MAX_CONSECUTIVE_ERRORS = 5;

/** Retry delay for transient API errors (ms) */
export const RETRY_DELAY_MS = 1000;

// ════════════════════════════════════════════════════════════════════════════
// Retry Configuration
// ════════════════════════════════════════════════════════════════════════════

/**
 * Configuration for API call retry behavior with exponential backoff.
 */
export interface RetryConfig {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries: number;
  /** Base delay in milliseconds before first retry (default: 1000) */
  baseDelayMs: number;
  /** Maximum delay cap in milliseconds (default: 30000) */
  maxDelayMs: number;
  /** Multiplier for exponential backoff (default: 2) */
  backoffMultiplier: number;
  /** Whether to add random jitter to delays (default: true) */
  jitterEnabled: boolean;
  /** Maximum jitter in milliseconds (default: 500) */
  maxJitterMs: number;
  /** Error types that should be retried */
  retryableErrors: QueryErrorType[];
  /** Error types that should never be retried */
  fatalErrors: QueryErrorType[];
  /** Callback invoked before each retry attempt */
  onRetry?: (attempt: number, error: Error, delayMs: number) => void;
  /** Callback invoked when all retries are exhausted */
  onExhausted?: (totalAttempts: number, lastError: Error) => void;
}

/**
 * Default retry configuration.
 */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
  jitterEnabled: true,
  maxJitterMs: 500,
  retryableErrors: ['api_error', 'rate_limit', 'timeout'],
  fatalErrors: ['context_overflow', 'permission_denied', 'user_abort'],
};

// ════════════════════════════════════════════════════════════════════════════
// Context Window Configuration
// ════════════════════════════════════════════════════════════════════════════

/**
 * Configuration for context window monitoring and auto-compaction.
 */
export interface ContextWindowConfig {
  /** Maximum context window size in tokens */
  maxTokens: number;
  /** Percentage of context usage that triggers a warning (default: 75) */
  warningThresholdPercent: number;
  /** Percentage of context usage that triggers auto-compaction (default: 90) */
  autoCompactThresholdPercent: number;
  /** Percentage of context usage considered critical (default: 95) */
  criticalThresholdPercent: number;
  /** Minimum tokens to reserve for output in each turn */
  outputReservation: number;
  /** Whether auto-compaction is enabled */
  autoCompactEnabled: boolean;
  /** Whether to emit warnings when approaching threshold */
  warningsEnabled: boolean;
  /** Target token count after compaction (percentage of max) */
  compactionTargetPercent: number;
  /** Callback when context enters warning zone */
  onWarning?: (usagePercent: number, remainingTokens: number) => void;
  /** Callback when auto-compaction triggers */
  onAutoCompact?: (preTokens: number, postTokens: number) => void;
  /** Callback when context reaches critical level */
  onCritical?: (usagePercent: number) => void;
}

/**
 * Default context window configuration for Claude Sonnet.
 */
export const DEFAULT_CONTEXT_WINDOW_CONFIG: ContextWindowConfig = {
  maxTokens: CLAUDE_CONTEXT_WINDOW,
  warningThresholdPercent: 75,
  autoCompactThresholdPercent: 90,
  criticalThresholdPercent: 95,
  outputReservation: OUTPUT_TOKEN_RESERVATION,
  autoCompactEnabled: true,
  warningsEnabled: true,
  compactionTargetPercent: 50,
};

// ════════════════════════════════════════════════════════════════════════════
// Turn Record Array Type
// ════════════════════════════════════════════════════════════════════════════

/**
 * A detailed record of a single query turn with cost and token breakdown.
 */
export interface DetailedTurnRecord extends TurnRecord {
  /** Unique identifier for this turn record */
  id: string;
  /** Names of tools called during this turn */
  toolNames: string[];
  /** Whether the turn resulted in an error */
  hadError: boolean;
  /** Error message if the turn failed */
  errorMessage?: string;
  /** Whether a fallback model was used */
  usedFallback: boolean;
  /** Whether compaction occurred during this turn */
  compactionOccurred: boolean;
  /** Context usage percentage at the start of this turn */
  contextUsageAtStart: number;
  /** Context usage percentage at the end of this turn */
  contextUsageAtEnd: number;
}

/**
 * Collection of turn records with aggregate statistics.
 */
export interface TurnHistory {
  /** All turn records in chronological order */
  records: DetailedTurnRecord[];
  /** Total number of turns */
  totalTurns: number;
  /** Total cost across all turns */
  totalCostUsd: number;
  /** Total input tokens across all turns */
  totalInputTokens: number;
  /** Total output tokens across all turns */
  totalOutputTokens: number;
  /** Average cost per turn */
  avgCostPerTurn: number;
  /** Average duration per turn in milliseconds */
  avgDurationMs: number;
  /** Turn with the highest cost */
  mostExpensiveTurn: DetailedTurnRecord | null;
  /** Turn with the longest duration */
  slowestTurn: DetailedTurnRecord | null;
}

// ════════════════════════════════════════════════════════════════════════════
// Tool Permission Cache Type
// ════════════════════════════════════════════════════════════════════════════

/**
 * Cached permission decision for a tool + input combination.
 */
export interface CachedPermission {
  /** Tool name this permission applies to */
  toolName: string;
  /** Hash of the input that was checked */
  inputHash: string;
  /** The permission decision */
  decision: 'allow' | 'deny' | 'ask';
  /** Human-readable reason for the decision */
  reason: string;
  /** Source of the permission decision */
  source: 'rule' | 'user' | 'hook' | 'classifier' | 'mode';
  /** When this permission was cached */
  cachedAt: number;
  /** When this permission expires (0 = session lifetime) */
  expiresAt: number;
  /** Number of times this cached permission was used */
  hitCount: number;
}

/**
 * Permission cache for reducing redundant permission checks.
 */
export interface ToolPermissionCache {
  /** Cached permission entries keyed by "toolName:inputHash" */
  entries: Map<string, CachedPermission>;
  /** Maximum number of entries before eviction */
  maxEntries: number;
  /** Total cache hits */
  totalHits: number;
  /** Total cache misses */
  totalMisses: number;
  /** Cache hit rate */
  hitRate: number;
  /** Add or update a cache entry */
  set(toolName: string, inputHash: string, permission: Omit<CachedPermission, 'cachedAt' | 'hitCount' | 'inputHash' | 'toolName'>): void;
  /** Look up a cached permission */
  get(toolName: string, inputHash: string): CachedPermission | undefined;
  /** Clear all cached permissions */
  clear(): void;
  /** Remove expired entries */
  evictExpired(): number;
}

// ════════════════════════════════════════════════════════════════════════════
// Conversation Thread Type
// ════════════════════════════════════════════════════════════════════════════

/**
 * A logical thread within a conversation, grouped by user prompt.
 */
export interface ConversationThread {
  /** Unique thread identifier */
  threadId: string;
  /** Index of this thread in the conversation (0-based) */
  threadIndex: number;
  /** The user prompt that started this thread */
  userPrompt: string;
  /** Timestamp when the thread started */
  startTimestamp: number;
  /** Timestamp of the last message in this thread */
  endTimestamp: number;
  /** All messages in this thread */
  messages: Message[];
  /** Number of messages in this thread */
  messageCount: number;
  /** Tools used during this thread */
  toolsUsed: string[];
  /** Number of tool calls in this thread */
  toolCallCount: number;
  /** Whether any tool call resulted in an error */
  hasError: boolean;
  /** Estimated token count for this thread */
  estimatedTokens: number;
  /** Duration of this thread in milliseconds */
  durationMs: number;
  /** The final assistant response text (if any) */
  finalResponse?: string;
}
