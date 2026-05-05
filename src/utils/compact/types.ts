/**
 * types.ts — Compact system vocabulary
 *
 * Based on Claude Code's compact types (~200 lines)
 *
 * Complete type definitions for the 3-tier compaction system:
 *   Tier 1: MicroCompact — truncate old tool results (no LLM call)
 *   Tier 2: SessionMemory — summarize middle section (cheap LLM call)
 *   Tier 3: Full Compact — summarize entire conversation (expensive LLM call)
 */

// ════════════════════════════════════════════════════════════════════════════
// Enums
// ════════════════════════════════════════════════════════════════════════════

/** What triggered the compaction */
export type CompactTrigger =
  | 'auto_threshold'     // Context window approaching limit
  | 'manual'             // User explicitly requested /compact
  | 'reactive'           // PTL (prompt too long) error recovery
  | 'memory_pressure';   // System memory pressure

/** Which compaction tier was used */
export type CompactType =
  | 'micro'              // Tier 1: truncate tool results
  | 'session_memory'     // Tier 2: summarize middle section
  | 'full';              // Tier 3: full conversation summary

// ════════════════════════════════════════════════════════════════════════════
// Compact Boundary (written to JSONL)
// ════════════════════════════════════════════════════════════════════════════

export interface CompactBoundaryMeta {
  type: CompactType;
  trigger: CompactTrigger;
  preCompactTokens: number;
  postCompactTokens: number;
  tokensSaved: number;
  /** Tools discovered during compaction (for post-compact context) */
  discoveredTools?: string[];
  /** Number of messages removed */
  droppedMessageCount?: number;
  /** Summary text (for session_memory and full types) */
  summary?: string;
  /** Duration of the compaction in ms */
  durationMs?: number;
}

// ════════════════════════════════════════════════════════════════════════════
// Compaction Results
// ════════════════════════════════════════════════════════════════════════════

export interface CompactionResult {
  success: boolean;
  type: CompactType;
  trigger: CompactTrigger;
  preCompactTokens: number;
  postCompactTokens: number;
  tokensSaved: number;
  /** Percentage of tokens saved (0-100) */
  reductionPercent: number;
  /** How long the compaction took */
  durationMs: number;
  /** New message array after compaction */
  newMessages: any[];
  /** Error message if compaction failed */
  failureReason?: string;
  /** Number of API calls used (0 for micro, 1+ for session/full) */
  apiCalls?: number;
}

export interface MicroCompactResult {
  /** Whether any changes were applied */
  applied: boolean;
  /** Number of tool results that were truncated */
  toolResultsCleared: number;
  /** Estimated tokens recovered */
  tokensRecovered: number;
  /** Whether prompt cache was preserved */
  cachePreserved: boolean;
  /** Messages that were modified */
  modifiedMessageIndexes?: number[];
}

// ════════════════════════════════════════════════════════════════════════════
// Configuration
// ════════════════════════════════════════════════════════════════════════════

export interface CompactionConfig {
  /** Tokens buffer before auto-compact triggers */
  autoCompactBufferTokens: number;
  /** Tokens buffer before blocking (hard limit) */
  blockingLimitBufferTokens: number;
  /** Tokens buffer for warning display */
  warningBufferTokens: number;

  // MicroCompact (Tier 1)
  /** Number of recent tool results to keep untruncated */
  microCompactKeepRecent: number;
  /** Minimum gap between micro-compactions (minutes) */
  microCompactGapMinutes: number;

  // Post-Compact Context
  /** Max files to include in post-compact context */
  postCompactMaxFiles: number;
  /** Token budget for post-compact file context */
  postCompactTokenBudget: number;
  /** Tokens per file in post-compact context */
  postCompactTokensPerFile: number;
  /** Token budget for post-compact skill context */
  postCompactSkillsBudget: number;
  /** Tokens per skill in post-compact context */
  postCompactTokensPerSkill: number;

  // Session Memory (Tier 2)
  /** Minimum tokens before session memory kicks in */
  sessionMemoryMinTokens: number;
  /** Minimum text messages before session memory */
  sessionMemoryMinTextMessages: number;
  /** Maximum tokens for session memory summary */
  sessionMemoryMaxTokens: number;

  // Error Recovery
  /** Max consecutive failures before giving up */
  maxConsecutiveFailures: number;
  /** Max PTL retries */
  maxPTLRetries: number;
  /** Percentage to drop on unknown PTL errors */
  ptlDropPercentageOnUnknown: number;
}

/**
 * Default compaction configuration.
 * Based on Claude Code's defaults optimized for Claude Sonnet.
 */
export const DEFAULT_CONFIG: CompactionConfig = {
  autoCompactBufferTokens: 13_000,
  blockingLimitBufferTokens: 3_000,
  warningBufferTokens: 20_000,
  microCompactKeepRecent: 5,
  microCompactGapMinutes: 30,
  postCompactMaxFiles: 5,
  postCompactTokenBudget: 50_000,
  postCompactTokensPerFile: 5_000,
  postCompactSkillsBudget: 25_000,
  postCompactTokensPerSkill: 5_000,
  maxConsecutiveFailures: 3,
  maxPTLRetries: 3,
  ptlDropPercentageOnUnknown: 0.2,
  sessionMemoryMinTokens: 10_000,
  sessionMemoryMinTextMessages: 5,
  sessionMemoryMaxTokens: 40_000,
};

// ════════════════════════════════════════════════════════════════════════════
// Compaction Report (for /cost command)
// ════════════════════════════════════════════════════════════════════════════

export interface CompactionReport {
  /** Total number of compactions */
  totalCompactions: number;
  /** Breakdown by type */
  breakdown: {
    micro: number;
    sessionMemory: number;
    full: number;
  };
  /** Total tokens saved across all compactions */
  totalTokensSaved: number;
  /** Average compaction duration in ms */
  avgDurationMs: number;
  /** Total cost saved (estimated) */
  estimatedCostSaved?: number;
}

// ════════════════════════════════════════════════════════════════════════════
// Auto-Compact State
// ════════════════════════════════════════════════════════════════════════════

export interface AutoCompactState {
  /** Whether auto-compact is enabled */
  enabled: boolean;
  /** Current context token count */
  currentTokens: number;
  /** Model's max context window */
  maxContextTokens: number;
  /** Tokens remaining before auto-compact triggers */
  tokensUntilCompact: number;
  /** Whether we're in warning zone */
  inWarningZone: boolean;
  /** Whether we're in blocking zone */
  inBlockingZone: boolean;
  /** Last compaction timestamp */
  lastCompactAt: number;
  /** Consecutive failure count */
  consecutiveFailures: number;
}
