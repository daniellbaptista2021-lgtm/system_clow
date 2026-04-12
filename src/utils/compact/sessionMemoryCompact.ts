/**
 * sessionMemoryCompact.ts — Tier 2: Skip LLM, use pre-built session memory
 * Avoids expensive API call. Preserves API invariants (tool_use/result pairs).
 *
 * Features:
 *   - Conversation section analysis (detect logical segments)
 *   - Important message detection (user instructions, error resolutions)
 *   - Tool result summarization (collapse verbose tool output)
 *   - Token budget management (stay within target)
 *   - Summary quality validation (reject bad summaries)
 */

import type { ClovMessage } from '../../api/deepseek.js';
import { estimateMessageTokens } from './microCompact.js';
import type { CompactionConfig, CompactionResult } from './types.js';
import { DEFAULT_CONFIG } from './types.js';

export interface SessionMemoryProvider {
  getMemory(sessionId: string): Promise<{ summary: string } | null>;
}

// ─── Conversation Section Analysis ─────────────────────────────────────────

export interface ConversationSection {
  /** Index of first message in this section */
  startIndex: number;
  /** Index of last message (inclusive) */
  endIndex: number;
  /** Estimated tokens in this section */
  tokens: number;
  /** Number of user messages in this section */
  userMessageCount: number;
  /** Number of tool calls in this section */
  toolCallCount: number;
  /** Whether this section contains error-related messages */
  hasErrors: boolean;
  /** Whether this section contains important user instructions */
  hasImportantInstructions: boolean;
  /** Importance score (0-10) — higher means harder to drop */
  importance: number;
}

/** Patterns that indicate important user instructions. */
const IMPORTANT_PATTERNS = [
  /\b(always|never|must|important|critical|don't forget|remember)\b/i,
  /\b(requirement|constraint|rule|invariant)\b/i,
  /\b(fix|bug|error|issue|problem|broken)\b/i,
  /\b(config|setting|preference|option)\b/i,
];

/** Patterns that indicate error-related content. */
const ERROR_PATTERNS = [
  /\b(error|exception|fail|crash|panic|abort)\b/i,
  /\b(stacktrace|stack trace|traceback)\b/i,
  /\bTypeError|ReferenceError|SyntaxError|RuntimeError\b/,
  /\b(ENOENT|EACCES|EPERM|ECONNREFUSED)\b/,
];

/**
 * Analyze a message to determine if it contains important instructions.
 */
function isImportantMessage(msg: ClovMessage): boolean {
  if (msg.role !== 'user') return false;
  const content = msg.content ?? '';
  if (content.length < 10) return false;
  return IMPORTANT_PATTERNS.some((pat) => pat.test(content));
}

/**
 * Check if a message contains error-related content.
 */
function hasErrorContent(msg: ClovMessage): boolean {
  const content = msg.content ?? '';
  return ERROR_PATTERNS.some((pat) => pat.test(content));
}

/**
 * Break a message array into logical conversation sections.
 * A new section starts each time a user message follows a non-user message
 * (i.e., each new user turn opens a section).
 */
export function analyzeConversationSections(messages: ClovMessage[]): ConversationSection[] {
  const sections: ConversationSection[] = [];
  let sectionStart = 0;

  for (let i = 0; i < messages.length; i++) {
    const isNewUserTurn = messages[i].role === 'user' && i > 0 && messages[i - 1].role !== 'user';
    const isLast = i === messages.length - 1;

    if ((isNewUserTurn && i > sectionStart) || isLast) {
      const endIdx = isNewUserTurn ? i - 1 : i;
      const sectionMsgs = messages.slice(sectionStart, endIdx + 1);

      let hasErrors = false;
      let hasImportantInstructions = false;
      let userMsgCount = 0;
      let toolCallCount = 0;

      for (const msg of sectionMsgs) {
        if (msg.role === 'user') userMsgCount++;
        if (msg.role === 'assistant' && msg.tool_calls) toolCallCount += msg.tool_calls.length;
        if (hasErrorContent(msg)) hasErrors = true;
        if (isImportantMessage(msg)) hasImportantInstructions = true;
      }

      const tokens = estimateMessageTokens(sectionMsgs);

      // Importance scoring: 0-10
      let importance = 3; // base
      if (hasImportantInstructions) importance += 3;
      if (hasErrors) importance += 2;
      if (userMsgCount > 0) importance += 1;
      // Most recent sections are more important
      const recencyBoost = Math.min(2, (i / messages.length) * 2);
      importance += recencyBoost;
      importance = Math.min(10, Math.round(importance));

      sections.push({
        startIndex: sectionStart,
        endIndex: endIdx,
        tokens,
        userMessageCount: userMsgCount,
        toolCallCount,
        hasErrors,
        hasImportantInstructions,
        importance,
      });

      if (isNewUserTurn) sectionStart = i;
    }
  }

  return sections;
}

// ─── Tool Result Summarization ─────────────────────────────────────────────

/**
 * Summarize a tool result message to reduce token count.
 * Keeps the first and last few lines for context.
 */
function summarizeToolResult(content: string, maxChars: number = 500): string {
  if (content.length <= maxChars) return content;

  const lines = content.split('\n');
  if (lines.length <= 6) {
    return content.slice(0, maxChars) + '... [truncated]';
  }

  // Keep first 3 lines and last 3 lines
  const head = lines.slice(0, 3).join('\n');
  const tail = lines.slice(-3).join('\n');
  const dropped = lines.length - 6;
  return `${head}\n... [${dropped} lines omitted] ...\n${tail}`;
}

// ─── Token Budget Management ───────────────────────────────────────────────

interface TokenBudget {
  /** Total budget for the post-compact message list */
  totalBudget: number;
  /** Budget allocated to the session memory summary */
  summaryBudget: number;
  /** Budget allocated to kept messages */
  keptMessagesBudget: number;
  /** Whether the budget is tight (requires aggressive cutting) */
  isTight: boolean;
}

function calculateTokenBudget(
  totalEffective: number,
  config: CompactionConfig,
): TokenBudget {
  // Target: use at most 60% of effective window after compaction
  const totalBudget = Math.floor(totalEffective * 0.6);
  const summaryBudget = Math.min(config.sessionMemoryMaxTokens, Math.floor(totalBudget * 0.3));
  const keptMessagesBudget = totalBudget - summaryBudget;
  const isTight = totalBudget < 30_000;

  return { totalBudget, summaryBudget, keptMessagesBudget, isTight };
}

// ─── Summary Quality Validation ────────────────────────────────────────────

interface QualityCheck {
  passed: boolean;
  issues: string[];
}

/**
 * Validate that a session memory summary is good enough to use.
 * Rejects summaries that are too short, too long, or missing key indicators.
 */
function validateSummaryQuality(summary: string, preCompactTokens: number): QualityCheck {
  const issues: string[] = [];

  // Must have meaningful content
  if (summary.length < 50) {
    issues.push('Summary too short (< 50 chars)');
  }

  // Should not be excessively long relative to what we're replacing
  const summaryTokens = Math.ceil(summary.length / 4);
  if (summaryTokens > preCompactTokens * 0.5) {
    issues.push(`Summary tokens (${summaryTokens}) > 50% of pre-compact tokens (${preCompactTokens})`);
  }

  // Should mention at least some concrete items (file paths, function names, etc.)
  const hasConcreteDetails = /[\/\\][\w.]+\.\w+|function\s+\w+|class\s+\w+|\b\w+\.\w+\(/.test(summary);
  if (!hasConcreteDetails && preCompactTokens > 5_000) {
    issues.push('Summary lacks concrete details (file paths, function names) for a non-trivial conversation');
  }

  return {
    passed: issues.length === 0,
    issues,
  };
}

// ─── Main Compactor Class ──────────────────────────────────────────────────

export class SessionMemoryCompactor {
  constructor(
    private readonly config: CompactionConfig = DEFAULT_CONFIG,
    private readonly memoryProvider?: SessionMemoryProvider,
  ) {}

  /**
   * Try to compact using session memory. Returns null if no memory available
   * or if the summary quality check fails.
   */
  async tryCompact(messages: ClovMessage[], sessionId: string): Promise<CompactionResult | null> {
    if (!this.memoryProvider) return null;
    const memory = await this.memoryProvider.getMemory(sessionId);
    if (!memory?.summary) return null;

    const startTime = Date.now();
    const preTokens = estimateMessageTokens(messages);

    // Validate summary quality before using it
    const quality = validateSummaryQuality(memory.summary, preTokens);
    if (!quality.passed) {
      // Summary is not good enough — fall through to full compact
      return null;
    }

    // Analyze conversation sections to find best cut point
    const sections = analyzeConversationSections(messages);

    // Find cut point — keep recent messages with minimum guarantees
    let cutPoint = this.findCutPoint(messages, sections);
    if (cutPoint <= 0) return null;

    // Adjust to preserve API invariants
    cutPoint = this.adjustForInvariants(messages, cutPoint);
    if (cutPoint <= 0) return null;

    const keptMessages = messages.slice(cutPoint);

    // Summarize verbose tool results in kept messages to save tokens
    const processedKept = this.summarizeKeptToolResults(keptMessages);

    // Build new message list
    const boundary: ClovMessage = {
      role: 'user',
      content: `[System Clow: Session memory compact applied]\n\n<session-memory>\n${memory.summary}\n</session-memory>`,
    };

    const newMessages = [boundary, ...processedKept];
    const postTokens = estimateMessageTokens(newMessages);

    // Verify we actually saved tokens — otherwise it wasn't worth it
    const tokensSaved = preTokens - postTokens;
    if (tokensSaved < preTokens * 0.1) {
      // Less than 10% savings — not worth the disruption
      return null;
    }

    return {
      success: true,
      type: 'session_memory',
      trigger: 'auto_threshold',
      preCompactTokens: preTokens,
      postCompactTokens: postTokens,
      tokensSaved,
      reductionPercent: (tokensSaved / preTokens) * 100,
      durationMs: Date.now() - startTime,
      newMessages,
    };
  }

  /**
   * Walk backwards from end, keeping messages until minimums met.
   * Uses section analysis to make smarter cut decisions.
   */
  private findCutPoint(messages: ClovMessage[], sections: ConversationSection[]): number {
    let tokens = 0;
    let textMsgs = 0;

    for (let i = messages.length - 1; i >= 0; i--) {
      tokens += estimateMessageTokens([messages[i]]);
      if (this.hasText(messages[i])) textMsgs++;

      // Hard cap — don't keep more than budget allows
      if (tokens > this.config.sessionMemoryMaxTokens) return i + 1;

      // Minimums met — but check if we're mid-section
      if (tokens >= this.config.sessionMemoryMinTokens && textMsgs >= this.config.sessionMemoryMinTextMessages) {
        // Try to align to section boundary for cleaner cuts
        const alignedIdx = this.alignToSectionBoundary(i, sections);
        return alignedIdx;
      }
    }
    return 0;
  }

  /**
   * Align a cut point to the nearest section boundary so we don't
   * cut in the middle of a logical conversation segment.
   */
  private alignToSectionBoundary(rawCutPoint: number, sections: ConversationSection[]): number {
    // Find the section that contains the raw cut point
    for (const section of sections) {
      if (rawCutPoint >= section.startIndex && rawCutPoint <= section.endIndex) {
        // Cut at the start of this section (keep entire section or drop it)
        // If the section is important, keep it (cut earlier)
        if (section.importance >= 7) {
          return section.startIndex;
        }
        // Otherwise cut at the start of the next section
        return section.endIndex + 1;
      }
    }
    return rawCutPoint;
  }

  /**
   * Summarize verbose tool results in kept messages to save extra tokens
   * while preserving enough context to be useful.
   */
  private summarizeKeptToolResults(messages: ClovMessage[]): ClovMessage[] {
    return messages.map((msg) => {
      if (msg.role !== 'tool' || !msg.content) return msg;
      // Only summarize very long tool results
      if (msg.content.length <= 1000) return msg;
      return { ...msg, content: summarizeToolResult(msg.content, 800) };
    });
  }

  /**
   * CRITICAL: Ensure kept range doesn't have orphaned tool_results.
   * Every tool_result must have its matching tool_use in a preceding assistant message.
   * Also ensures all tool_use messages have their corresponding tool results.
   */
  private adjustForInvariants(messages: ClovMessage[], cutPoint: number): number {
    let adjusted = cutPoint;
    let changed = true;
    let iterations = 0;
    const maxIterations = messages.length; // prevent infinite loop

    while (changed && iterations < maxIterations) {
      changed = false;
      iterations++;

      // Step 1: Find orphaned tool results — pull in their tool_use
      for (let i = adjusted; i < messages.length; i++) {
        const msg = messages[i];
        if (msg.role !== 'tool' || !msg.tool_call_id) continue;

        // Find assistant with matching tool_call
        const toolUseIdx = this.findToolUseIndex(messages, msg.tool_call_id);
        if (toolUseIdx !== -1 && toolUseIdx < adjusted) {
          adjusted = toolUseIdx;
          changed = true;
          break;
        }
      }

      // Step 2: If an assistant message in kept range has tool_calls,
      // ensure ALL its tool results are also in kept range
      for (let i = adjusted; i < messages.length; i++) {
        const msg = messages[i];
        if (msg.role !== 'assistant' || !msg.tool_calls) continue;

        for (const tc of msg.tool_calls) {
          const resultIdx = this.findToolResultIndex(messages, tc.id, i);
          if (resultIdx !== -1 && resultIdx < adjusted) {
            // Result is before our cut point — this shouldn't normally happen
            // but pull it in just in case
            adjusted = resultIdx;
            changed = true;
            break;
          }
        }
        if (changed) break;
      }
    }

    return adjusted;
  }

  private findToolUseIndex(messages: ClovMessage[], toolCallId: string): number {
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role !== 'assistant' || !msg.tool_calls) continue;
      if (msg.tool_calls.some((tc) => tc.id === toolCallId)) return i;
    }
    return -1;
  }

  private findToolResultIndex(messages: ClovMessage[], toolCallId: string, afterIndex: number): number {
    for (let i = afterIndex + 1; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role === 'tool' && msg.tool_call_id === toolCallId) return i;
    }
    return -1;
  }

  private hasText(msg: ClovMessage): boolean {
    return Boolean(msg.content && msg.content.length > 0 && msg.role !== 'tool');
  }
}

// ─── Exports for external use ──────────────────────────────────────────────

export { analyzeConversationSections as analyzeSections };
export { validateSummaryQuality };
