/**
 * types.ts — Session storage vocabulary
 *
 * Based on Claude Code's session types (~300 lines)
 *
 * Complete type definitions for:
 *   - JSONL file format (append-only log)
 *   - Session metadata
 *   - All entry types (message, tombstone, compact, cost, etc.)
 *   - Resume options
 *   - Session index
 *   - Migration types
 *   - Constants
 */

// ════════════════════════════════════════════════════════════════════════════
// Constants
// ════════════════════════════════════════════════════════════════════════════

/** Current JSONL schema version */
export const SESSION_SCHEMA_VERSION = 3;

/** Maximum session file size before warning (100MB) */
export const MAX_SESSION_FILE_SIZE = 100 * 1024 * 1024;

/** Maximum number of entries in a single session */
export const MAX_SESSION_ENTRIES = 100_000;

/** Default coalesce interval for writes */
export const WRITE_COALESCE_MS = 100;

/** Maximum write queue depth before force-flush */
export const MAX_WRITE_QUEUE = 10_000;

/** Session GC: max age for archived sessions (30 days) */
export const SESSION_GC_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Session GC: max total sessions on disk */
export const SESSION_GC_MAX_SESSIONS = 1000;

/** Bounded UUID set capacity for deduplication */
export const DEDUP_SET_CAPACITY = 2000;

/** Lock file stale timeout (5 minutes) */
export const LOCK_STALE_TIMEOUT_MS = 5 * 60 * 1000;

// ════════════════════════════════════════════════════════════════════════════
// Session Status
// ════════════════════════════════════════════════════════════════════════════

export type SessionStatus = 'active' | 'closed' | 'crashed' | 'archived';

export type SessionCloseReason =
  | 'user_exit'
  | 'budget_exceeded'
  | 'crash'
  | 'timeout'
  | 'error'
  | 'idle_timeout'
  | 'context_limit'
  | 'manual_close';

// ════════════════════════════════════════════════════════════════════════════
// JSONL Entry Types
// ════════════════════════════════════════════════════════════════════════════

export type JSONLEntryType =
  | 'session_start'
  | 'message'
  | 'tombstone'
  | 'compact_boundary'
  | 'preserved_segment'
  | 'cost_record'
  | 'permission_decision'
  | 'session_end'
  | 'metadata'
  | 'tool_use'
  | 'tool_result'
  | 'error'
  | 'checkpoint';

/**
 * A single entry in the JSONL file.
 * Every entry has a version, unique ID, type, timestamp, and data payload.
 */
export interface JSONLEntry {
  /** Schema version */
  v: number;
  /** Unique identifier for this entry */
  uuid: string;
  /** Entry type */
  type: JSONLEntryType;
  /** Timestamp in ms since epoch */
  ts: number;
  /** Entry-specific data payload */
  data: unknown;
  /** Parent entry UUID (for threading) */
  parentUuid?: string;
}

// ════════════════════════════════════════════════════════════════════════════
// Session Metadata
// ════════════════════════════════════════════════════════════════════════════

/**
 * Runtime metadata for a session.
 * Maintained in memory and persisted as session_start + incremental updates.
 */
export interface SessionMetadata {
  id: string;
  schemaVersion: number;
  workspaceHash: string;
  workspaceRoot: string;
  cwd: string;
  tenantId?: string;
  startedAt: number;
  lastMessageAt: number;
  messageCount: number;
  rawMessageCount: number;
  totalCostUsd: number;
  totalTokens: number;
  cacheHitTokens: number;
  model: string;
  firstUserMessage?: string;
  lastUserMessage?: string;
  status: SessionStatus;
  permissionMode: string;
  closedAt?: number;
  closedReason?: SessionCloseReason;
  parentSessionId?: string;
  children: string[];
  compactCount: number;
  preservedSegmentCount: number;
  ownerPid?: number;
  agentDepth: number;
  /** File size in bytes (updated lazily) */
  fileSizeBytes?: number;
  /** Last compaction timestamp */
  lastCompactAt?: number;
}

// ════════════════════════════════════════════════════════════════════════════
// Entry Data Types
// ════════════════════════════════════════════════════════════════════════════

export interface SessionStartEntry {
  workspaceHash: string;
  workspaceRoot: string;
  cwd: string;
  tenantId?: string;
  model: string;
  schemaVersion: number;
  parentSessionId?: string;
  agentDepth: number;
  pid: number;
  permissionMode?: string;
  clowVersion?: string;
}

export interface MessageEntry {
  message: unknown;
  role?: string;
  content?: string;
  tokenCount?: number;
}

export interface TombstoneEntry {
  /** UUID of the entry being removed */
  removedUuid: string;
  /** Reason for removal (e.g., 'compaction', 'user_delete') */
  reason: string;
  /** UUID of the compact boundary that created this tombstone */
  compactBoundaryUuid?: string;
}

export interface CompactBoundaryEntry {
  /** Token count before compaction */
  preCompactTokens: number;
  /** Token count after compaction */
  postCompactTokens: number;
  /** What triggered the compaction */
  trigger: string;
  /** Compaction type (micro, session_memory, full_llm) */
  type: string;
  /** UUIDs of messages removed by this compaction */
  removedMessageUuids?: string[];
  /** Summary text generated by compaction */
  summary?: string;
  /** Duration of compaction in ms */
  durationMs?: number;
}

export interface PreservedSegmentEntry {
  uuid: string;
  startUuid: string;
  endUuid: string;
  messageCount: number;
  tokenCount: number;
  storedAt: string;
}

export interface CostRecordEntry {
  turnNumber: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  costUsd: number;
  latencyMs?: number;
}

export interface PermissionDecisionEntry {
  toolName: string;
  decision: 'allow' | 'deny' | 'ask';
  reason: string;
  permanent: boolean;
}

export interface SessionEndEntry {
  reason: SessionCloseReason;
  totalMessages: number;
  totalTokens: number;
  totalCostUsd: number;
  durationMs: number;
  compactCount?: number;
}

export interface ToolUseEntry {
  toolName: string;
  input: unknown;
  output?: string;
  durationMs?: number;
  success?: boolean;
}

export interface CheckpointEntry {
  messageCount: number;
  tokenCount: number;
  costUsd: number;
  memoryUsageMb?: number;
}

// ════════════════════════════════════════════════════════════════════════════
// Resume
// ════════════════════════════════════════════════════════════════════════════

export interface ResumeOptions {
  /** Resume a specific session by ID */
  sessionId?: string;
  /** Resume the most recent session in the current workspace */
  continueLastInCwd?: boolean;
  /** Override working directory for resume lookup */
  cwd?: string;
  /** Verify workspace hash matches before resuming */
  validateWorkspace?: boolean;
  /** Maximum age of session to resume (ms) */
  maxAge?: number;
}

// ════════════════════════════════════════════════════════════════════════════
// Session Index
// ════════════════════════════════════════════════════════════════════════════

export interface SessionIndexEntry {
  sessionId: string;
  workspaceHash: string;
  workspaceRoot: string;
  startedAt: number;
  lastMessageAt: number;
  messageCount: number;
  status: SessionStatus;
  filePath: string;
  fileSizeBytes: number;
  model: string;
  totalCostUsd: number;
}

// ════════════════════════════════════════════════════════════════════════════
// Migration
// ════════════════════════════════════════════════════════════════════════════

export interface MigrationResult {
  success: boolean;
  fromVersion: number;
  toVersion: number;
  entriesMigrated: number;
  entriesSkipped: number;
  durationMs: number;
  errors: string[];
}

export type MigrationFunction = (entry: JSONLEntry) => JSONLEntry | null;
