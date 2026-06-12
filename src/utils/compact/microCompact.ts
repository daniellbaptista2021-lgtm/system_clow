/**
 * microCompact.ts — Surgical tool result clearing (Tier 1)
 *
 * Two paths:
 *   A: Cached MC — doesn't mutate messages, generates cache_edits block
 *   B: Time-based MC — directly clears old tool result content (cache cold anyway)
 *
 * Features:
 *   - Granular tool result truncation (partial vs full clear)
 *   - Image/binary content detection and removal
 *   - Duplicate tool result coalescing (same file read twice)
 *   - Truncation priority scoring (clear least-valuable results first)
 *   - Statistics tracking (per-session metrics)
 *
 * Only targets high-volume reproducible tools. AgentTool, MCP tools preserved.
 */

import type { ClovMessage } from '../../api/anthropic.js';
import type { MicroCompactResult, CompactionConfig } from './types.js';
import { DEFAULT_CONFIG } from './types.js';
import { suppressWarnings } from './compactWarningState.js';
import { evaluateTimeBasedTriggerWithTimestamp } from './timeBasedMCConfig.js';

// ─── Tool Classification ───────────────────────────────────────────────────

/** Tools whose results can be safely cleared (reproducible, re-runnable). */
const COMPACTABLE_TOOLS = new Set([
  'Read', 'FileRead', 'Bash', 'PowerShell', 'Grep', 'Glob',
  'WebSearch', 'WebFetch', 'Edit', 'FileEdit', 'Write', 'FileWrite',
]);

/** Tools whose results should only be partially truncated, never fully cleared. */
const PARTIAL_TRUNCATE_TOOLS = new Set([
  'Edit', 'FileEdit', 'Write', 'FileWrite',
]);

/** Tools that are never touched. */
const PROTECTED_TOOLS = new Set([
  'AgentTool', 'TodoRead', 'TodoWrite', 'Task', 'Skill',
]);

const CLEARED_MARKER = '[Tool result cleared by microcompact]';
const TRUNCATED_MARKER = ' ... [truncated by microcompact]';

// ─── Binary / Image Detection ──────────────────────────────────────────────

/** Patterns that indicate binary or image content embedded in tool results. */
const BINARY_CONTENT_PATTERNS = [
  /data:image\/[a-z]+;base64,/i,
  /data:application\/octet-stream;base64,/i,
  /data:application\/pdf;base64,/i,
  /[\x00-\x08\x0E-\x1F]{10,}/,  // long runs of control characters
];

const BASE64_PATTERN = /data:[a-z]+\/[a-z.+-]+;base64,[A-Za-z0-9+/=]{100,}/g;

/**
 * Detect if content contains binary or base64-encoded data.
 */
function containsBinaryContent(content: string): boolean {
  return BINARY_CONTENT_PATTERNS.some((pat) => pat.test(content));
}

/**
 * Strip base64-encoded content from a string, replacing with markers.
 */
function stripBinaryContent(content: string): string {
  let result = content.replace(BASE64_PATTERN, '[base64 data removed]');
  // Also strip long hex dumps (e.g., from binary file reads)
  result = result.replace(/(?:[0-9a-f]{2}\s){20,}/gi, '[hex dump removed] ');
  return result;
}

// ─── Tool Result Reference ─────────────────────────────────────────────────

interface ToolResultRef {
  msgIndex: number;
  toolCallId?: string;
  toolName: string;
  contentLength: number;
  /** Higher priority = cleared first (lower value = more important to keep) */
  truncationPriority: number;
  /** Whether this is a duplicate of another result (same tool + same args) */
  isDuplicate: boolean;
  /** Whether this contains binary/image data */
  hasBinaryContent: boolean;
  /** Tool call arguments hash for duplicate detection */
  argsHash: string;
}

// ─── Truncation Priority Scoring ───────────────────────────────────────────

/**
 * Compute truncation priority for a tool result.
 * Higher priority number = less important = cleared first.
 *
 * Factors:
 *   - Tool type (Read results are cheapest to re-obtain)
 *   - Content length (larger = higher priority to clear)
 *   - Position (older = higher priority)
 *   - Binary content (always high priority)
 *   - Duplicates (always highest priority)
 */
function computeTruncationPriority(
  toolName: string,
  contentLength: number,
  positionFromEnd: number,
  hasBinary: boolean,
  isDuplicate: boolean,
): number {
  let priority = 0;

  // Duplicates are always cleared first
  if (isDuplicate) priority += 1000;

  // Binary content is high priority for clearing
  if (hasBinary) priority += 500;

  // Tool type weights (higher = cleared first)
  const toolWeights: Record<string, number> = {
    'Read': 10, 'FileRead': 10,
    'Grep': 20, 'Glob': 20,
    'Bash': 30, 'PowerShell': 30,
    'WebSearch': 40, 'WebFetch': 50,
    'Edit': 5, 'FileEdit': 5,     // Edit results are small, keep them
    'Write': 5, 'FileWrite': 5,
  };
  priority += toolWeights[toolName] ?? 15;

  // Larger content = higher priority to clear
  priority += Math.floor(contentLength / 500);

  // Older results (farther from end) get higher priority
  priority += positionFromEnd * 2;

  return priority;
}

// ─── Statistics Tracking ───────────────────────────────────────────────────

export interface MicroCompactStats {
  totalInvocations: number;
  totalResultsCleared: number;
  totalTokensRecovered: number;
  totalDuplicatesFound: number;
  totalBinaryStripped: number;
  byTool: Record<string, { cleared: number; tokensRecovered: number }>;
}

const sessionStats = new Map<string, MicroCompactStats>();

function getOrCreateStats(sessionId: string): MicroCompactStats {
  let stats = sessionStats.get(sessionId);
  if (!stats) {
    stats = {
      totalInvocations: 0,
      totalResultsCleared: 0,
      totalTokensRecovered: 0,
      totalDuplicatesFound: 0,
      totalBinaryStripped: 0,
      byTool: {},
    };
    sessionStats.set(sessionId, stats);
  }
  return stats;
}

function recordToolCleared(stats: MicroCompactStats, toolName: string, tokensRecovered: number): void {
  stats.totalResultsCleared++;
  stats.totalTokensRecovered += tokensRecovered;
  if (!stats.byTool[toolName]) {
    stats.byTool[toolName] = { cleared: 0, tokensRecovered: 0 };
  }
  stats.byTool[toolName].cleared++;
  stats.byTool[toolName].tokensRecovered += tokensRecovered;
}

export function getMicroCompactStats(sessionId: string): MicroCompactStats | null {
  return sessionStats.get(sessionId) ?? null;
}

export function clearMicroCompactStats(sessionId: string): void {
  sessionStats.delete(sessionId);
}

// ─── Duplicate Detection ───────────────────────────────────────────────────

/**
 * Simple hash of tool call arguments for duplicate detection.
 * Two Read calls to the same file path are duplicates.
 */
function hashToolCallArgs(toolName: string, messages: ClovMessage[], toolCallId: string | undefined): string {
  if (!toolCallId) return '';

  for (const msg of messages) {
    if (msg.role !== 'assistant' || !msg.tool_calls) continue;
    for (const tc of msg.tool_calls) {
      if (tc.id === toolCallId) {
        // For Read/FileRead, extract file_path; for others, use full args
        if (toolName === 'Read' || toolName === 'FileRead') {
          try {
            const args = JSON.parse(tc.function.arguments);
            return `${toolName}:${args.file_path ?? args.path ?? ''}`;
          } catch {
            return `${toolName}:${tc.function.arguments}`;
          }
        }
        return `${toolName}:${tc.function.arguments}`;
      }
    }
  }
  return '';
}

// ─── Main MicroCompactor Class ─────────────────────────────────────────────

export class MicroCompactor {
  constructor(
    private readonly config: CompactionConfig = DEFAULT_CONFIG,
    private readonly cachedMCEnabled: boolean = false,
  ) {}

  /**
   * Main entry. Decides which MC path to take.
   * Returns applied=false if nothing to do.
   */
  microcompact(
    messages: ClovMessage[],
    sessionId: string,
    querySource: string,
    lastAssistantTimestamp?: number,
  ): MicroCompactResult {
    // Recursion guard
    if (querySource === 'compact' || querySource === 'session_memory') {
      return noOp();
    }

    const stats = getOrCreateStats(sessionId);
    stats.totalInvocations++;

    // Step 0: Always strip binary content regardless of other conditions
    const binaryTokens = this.stripBinaryFromAll(messages);
    if (binaryTokens > 0) {
      stats.totalBinaryStripped++;
    }

    // Find compactable tool results with priority scoring
    const refs = this.findCompactableResults(messages);
    if (refs.length <= this.config.microCompactKeepRecent) {
      // Even if we can't clear tool results, report binary stripping
      if (binaryTokens > 0) {
        suppressWarnings(sessionId);
        return {
          applied: true,
          toolResultsCleared: 0,
          tokensRecovered: binaryTokens,
          cachePreserved: !binaryTokens,
        };
      }
      return noOp();
    }

    // Path A: Cached MC (preserve prompt cache)
    if (this.cachedMCEnabled) {
      return this.cachedPath(refs, stats);
    }

    // Path B: Time-based MC (cold cache, direct mutation)
    return this.timeBasedPath(messages, refs, sessionId, stats, lastAssistantTimestamp, binaryTokens);
  }

  // ── Step 0: Binary Content Stripping ─────────────────────────────

  /**
   * Strip binary/base64 content from all messages.
   * This is done unconditionally since binary data is never useful in context.
   */
  private stripBinaryFromAll(messages: ClovMessage[]): number {
    let tokensRecovered = 0;

    for (const msg of messages) {
      if (!msg.content || !containsBinaryContent(msg.content)) continue;
      const before = msg.content.length;
      const stripped = stripBinaryContent(msg.content);
      if (stripped.length < before) {
        tokensRecovered += Math.ceil((before - stripped.length) / 4);
        (msg as any).content = stripped;
      }
    }

    return tokensRecovered;
  }

  // ── Path A: Cached MC ─────────────────────────────────────────────

  private cachedPath(refs: ToolResultRef[], stats: MicroCompactStats): MicroCompactResult {
    // Sort by truncation priority (highest first = least important)
    const sorted = [...refs].sort((a, b) => b.truncationPriority - a.truncationPriority);
    const toClear = sorted.slice(0, sorted.length - this.config.microCompactKeepRecent);

    let tokensRecovered = 0;
    for (const r of toClear) {
      const tokens = Math.ceil(r.contentLength / 4);
      tokensRecovered += tokens;
      recordToolCleared(stats, r.toolName, tokens);
    }

    if (toClear.some((r) => r.isDuplicate)) {
      stats.totalDuplicatesFound += toClear.filter((r) => r.isDuplicate).length;
    }

    // Don't mutate — caller reads cache_edits block via consumeCacheEdits()
    return {
      applied: true,
      toolResultsCleared: toClear.length,
      tokensRecovered,
      cachePreserved: true,
    };
  }

  // ── Path B: Time-Based MC ─────────────────────────────────────────

  private timeBasedPath(
    messages: ClovMessage[],
    refs: ToolResultRef[],
    sessionId: string,
    stats: MicroCompactStats,
    lastAssistantTs?: number,
    binaryTokensAlreadyRecovered: number = 0,
  ): MicroCompactResult {
    // Only fire if cache is likely cold (gap > threshold)
    const trigger = evaluateTimeBasedTriggerWithTimestamp(lastAssistantTs, this.config.microCompactGapMinutes);

    // If time trigger doesn't fire, still clear if we have way too many results
    const forceThreshold = this.config.microCompactKeepRecent * 3;
    if (!trigger.shouldFire && refs.length < forceThreshold) {
      // Still report binary stripping if it happened
      if (binaryTokensAlreadyRecovered > 0) {
        return {
          applied: true,
          toolResultsCleared: 0,
          tokensRecovered: binaryTokensAlreadyRecovered,
          cachePreserved: false,
        };
      }
      return noOp();
    }

    // Sort by truncation priority (highest first = least important)
    const sorted = [...refs].sort((a, b) => b.truncationPriority - a.truncationPriority);
    const toClear = sorted.slice(0, sorted.length - this.config.microCompactKeepRecent);

    let tokensRecovered = binaryTokensAlreadyRecovered;
    const modifiedIndexes: number[] = [];

    for (const ref of toClear) {
      const msg = messages[ref.msgIndex];
      if (msg.role === 'tool' && msg.content && msg.content !== CLEARED_MARKER) {
        const contentLen = msg.content.length;

        // Decide: full clear or partial truncation
        if (PARTIAL_TRUNCATE_TOOLS.has(ref.toolName) && contentLen < 2000) {
          // Partial: keep first 200 chars for context
          const truncated = msg.content.slice(0, 200) + TRUNCATED_MARKER;
          const saved = Math.ceil((contentLen - truncated.length) / 4);
          tokensRecovered += saved;
          (msg as any).content = truncated;
          recordToolCleared(stats, ref.toolName, saved);
        } else {
          // Full clear
          const saved = Math.ceil(contentLen / 4);
          tokensRecovered += saved;
          (msg as any).content = CLEARED_MARKER;
          recordToolCleared(stats, ref.toolName, saved);
        }

        modifiedIndexes.push(ref.msgIndex);
      }
    }

    if (toClear.some((r) => r.isDuplicate)) {
      stats.totalDuplicatesFound += toClear.filter((r) => r.isDuplicate).length;
    }

    if (tokensRecovered > 0) {
      suppressWarnings(sessionId);
    }

    return {
      applied: tokensRecovered > 0,
      toolResultsCleared: toClear.length,
      tokensRecovered,
      cachePreserved: false,
      modifiedMessageIndexes: modifiedIndexes.length > 0 ? modifiedIndexes : undefined,
    };
  }

  // ── Find compactable tool results ─────────────────────────────────

  private findCompactableResults(messages: ClovMessage[]): ToolResultRef[] {
    const results: ToolResultRef[] = [];

    // Build tool_call_id → tool_name map from assistant messages
    const toolNameMap = new Map<string, string>();
    for (const msg of messages) {
      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          toolNameMap.set(tc.id, tc.function.name);
        }
      }
    }

    // Track seen args hashes for duplicate detection
    const seenArgsHashes = new Map<string, number>(); // hash → first seen index

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role !== 'tool') continue;

      const toolName = toolNameMap.get(msg.tool_call_id || '') || 'unknown';

      // Skip protected tools
      if (PROTECTED_TOOLS.has(toolName)) continue;

      // Skip non-compactable tools
      if (!COMPACTABLE_TOOLS.has(toolName)) continue;

      // Skip already cleared
      if (msg.content === CLEARED_MARKER) continue;

      const contentLength = (msg.content || '').length;
      const hasBinary = containsBinaryContent(msg.content || '');
      const argsHash = hashToolCallArgs(toolName, messages, msg.tool_call_id);

      // Duplicate detection
      let isDuplicate = false;
      if (argsHash) {
        if (seenArgsHashes.has(argsHash)) {
          isDuplicate = true;
        } else {
          seenArgsHashes.set(argsHash, i);
        }
      }

      const positionFromEnd = messages.length - 1 - i;
      const truncationPriority = computeTruncationPriority(
        toolName, contentLength, positionFromEnd, hasBinary, isDuplicate,
      );

      results.push({
        msgIndex: i,
        toolCallId: msg.tool_call_id,
        toolName,
        contentLength,
        truncationPriority,
        isDuplicate,
        hasBinaryContent: hasBinary,
        argsHash,
      });
    }

    return results;
  }
}

// ─── Token Estimation ──────────────────────────────────────────────────────

/** Token estimation for ClovMessage[] (used by autoCompact and others). */
export function estimateMessageTokens(messages: ClovMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateSingleMessageTokens(msg);
  }
  return Math.ceil(total * (4 / 3)); // pad 4/3 for tokenizer imprecision
}

/** Token estimation for a single message. */
export function estimateSingleMessageTokens(msg: ClovMessage): number {
  let tokens = 4; // per-message overhead (role, separators)

  if (msg.content) {
    tokens += Math.ceil(msg.content.length / 4);
  }

  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      tokens += 3; // tool call overhead
      tokens += Math.ceil(tc.function.name.length / 4);
      tokens += Math.ceil(tc.function.arguments.length / 4);
    }
  }

  // tool_call_id adds a small overhead
  if (msg.tool_call_id) {
    tokens += Math.ceil(msg.tool_call_id.length / 4);
  }

  return tokens;
}

/**
 * Estimate tokens for a plain string (useful for prompt sizing).
 */
export function estimateStringTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function noOp(): MicroCompactResult {
  return { applied: false, toolResultsCleared: 0, tokensRecovered: 0, cachePreserved: true };
}
