/**
 * grouping.ts — Group messages by API round boundaries
 *
 * A "round" is one user turn + the assistant response (including tool calls
 * and their results). Boundary fires when a NEW assistant messageId appears.
 *
 * Features:
 *   - Message age analysis (recency scoring)
 *   - API round cost estimation (approximate token cost per round)
 *   - Protected message detection (user instructions, error fixes)
 *   - Grouping statistics (round count, avg size, etc.)
 */

import type { ClovMessage } from '../../api/anthropic.js';

// ─── Message Grouping ──────────────────────────────────────────────────────

/** Group messages by API round (assistant messageId boundaries). */
export function groupMessagesByApiRound(messages: ClovMessage[]): ClovMessage[][] {
  const groups: ClovMessage[][] = [];
  let current: ClovMessage[] = [];
  let currentMsgId: string | undefined;

  for (const msg of messages) {
    // Detect new assistant response by checking tool_calls id pattern
    if (msg.role === 'assistant' && msg.tool_calls) {
      const newId = msg.tool_calls[0]?.id;
      if (newId && newId !== currentMsgId) {
        if (current.length > 0) groups.push(current);
        current = [];
        currentMsgId = newId;
      }
    }
    // Also detect new round when a user message follows a non-user message
    if (msg.role === 'user' && current.length > 0 && current[current.length - 1].role !== 'user') {
      // Only split if there's meaningful content in the current group
      if (current.some((m) => m.role === 'assistant')) {
        groups.push(current);
        current = [];
        currentMsgId = undefined;
      }
    }
    current.push(msg);
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

// ─── Compact Boundary Detection ────────────────────────────────────────────

/** Find index of first message after last compact boundary marker. */
export function findCompactBoundaryIndex(messages: ClovMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'user' && msg.content?.includes('[System Clow: Conversation was compacted')) {
      return i + 1;
    }
    if (msg.role === 'user' && msg.content?.includes('[System Clow: Session memory compact applied')) {
      return i + 1;
    }
  }
  return 0;
}

/** Get only messages after the most recent compact boundary. */
export function getMessagesAfterBoundary(messages: ClovMessage[]): ClovMessage[] {
  return messages.slice(findCompactBoundaryIndex(messages));
}

// ─── Message Age Analysis ──────────────────────────────────────────────────

export interface MessageAgeInfo {
  /** Index of the message */
  index: number;
  /** Role of the message */
  role: string;
  /** Recency score (0-1, where 1 is the most recent) */
  recencyScore: number;
  /** Distance from end (0 = last message) */
  distanceFromEnd: number;
  /** Estimated age bucket */
  ageBucket: 'recent' | 'middle' | 'old';
}

/**
 * Analyze message ages relative to the conversation.
 * Since ClovMessage doesn't have timestamps, we approximate age
 * from position in the array. Most recent messages are at the end.
 */
export function analyzeMessageAges(messages: ClovMessage[]): MessageAgeInfo[] {
  const total = messages.length;
  if (total === 0) return [];

  return messages.map((msg, i) => {
    const distanceFromEnd = total - 1 - i;
    const recencyScore = total > 1 ? i / (total - 1) : 1;

    let ageBucket: 'recent' | 'middle' | 'old';
    if (recencyScore >= 0.75) {
      ageBucket = 'recent';
    } else if (recencyScore >= 0.35) {
      ageBucket = 'middle';
    } else {
      ageBucket = 'old';
    }

    return {
      index: i,
      role: msg.role,
      recencyScore,
      distanceFromEnd,
      ageBucket,
    };
  });
}

/**
 * Get the count of messages in each age bucket.
 */
export function getAgeBucketCounts(messages: ClovMessage[]): { recent: number; middle: number; old: number } {
  const ages = analyzeMessageAges(messages);
  return {
    recent: ages.filter((a) => a.ageBucket === 'recent').length,
    middle: ages.filter((a) => a.ageBucket === 'middle').length,
    old: ages.filter((a) => a.ageBucket === 'old').length,
  };
}

// ─── API Round Cost Estimation ─────────────────────────────────────────────

export interface RoundCostEstimate {
  /** Index of this round in the grouped array */
  roundIndex: number;
  /** Number of messages in this round */
  messageCount: number;
  /** Estimated token count for this round */
  estimatedTokens: number;
  /** Number of tool calls in this round */
  toolCallCount: number;
  /** Whether this round has user messages */
  hasUserMessage: boolean;
  /** Cost weight (relative importance for keeping) */
  costWeight: number;
}

/**
 * Estimate the token cost of each API round.
 * Useful for deciding which rounds to drop during compaction.
 */
export function estimateRoundCosts(messages: ClovMessage[]): RoundCostEstimate[] {
  const groups = groupMessagesByApiRound(messages);
  const totalMessages = messages.length;

  return groups.map((group, roundIndex) => {
    let estimatedTokens = 0;
    let toolCallCount = 0;
    let hasUserMessage = false;

    for (const msg of group) {
      // Rough token estimate: content / 4 + overhead
      estimatedTokens += 4; // per-message overhead
      if (msg.content) estimatedTokens += Math.ceil(msg.content.length / 4);
      if (msg.tool_calls) {
        toolCallCount += msg.tool_calls.length;
        for (const tc of msg.tool_calls) {
          estimatedTokens += Math.ceil(tc.function.name.length / 4);
          estimatedTokens += Math.ceil(tc.function.arguments.length / 4);
        }
      }
      if (msg.role === 'user') hasUserMessage = true;
    }

    // Cost weight: higher = more important to keep
    // Recent rounds, rounds with user messages, and rounds with many tool calls
    // are weighted higher
    let costWeight = 1;
    const recency = totalMessages > 0 ? (roundIndex / Math.max(groups.length - 1, 1)) : 0;
    costWeight += recency * 3; // recency is most important factor
    if (hasUserMessage) costWeight += 2;
    if (toolCallCount > 3) costWeight += 1; // complex rounds are harder to summarize

    return {
      roundIndex,
      messageCount: group.length,
      estimatedTokens: Math.ceil(estimatedTokens * (4 / 3)), // pad like estimateMessageTokens
      toolCallCount,
      hasUserMessage,
      costWeight,
    };
  });
}

// ─── Protected Message Detection ───────────────────────────────────────────

/** Patterns indicating a message should not be dropped during compaction. */
const PROTECTION_PATTERNS = [
  /\b(always|never|must|important|critical|don't forget|remember)\b/i,
  /\b(requirement|constraint|config|setting|preference)\b/i,
  /\[System Clow:/,
  /\[Post-compact file restore:/,
  /<session-memory>/,
];

/**
 * Detect messages that should be protected from compaction.
 * These include system boundary markers, user-stated requirements,
 * and critical configuration instructions.
 */
export function detectProtectedMessages(messages: ClovMessage[]): Set<number> {
  const protectedIndexes = new Set<number>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    // Always protect compact boundary markers
    if (msg.role === 'user' && msg.content?.includes('[System Clow:')) {
      protectedIndexes.add(i);
      continue;
    }

    // Protect user messages with important instructions
    if (msg.role === 'user' && msg.content) {
      for (const pat of PROTECTION_PATTERNS) {
        if (pat.test(msg.content)) {
          protectedIndexes.add(i);
          break;
        }
      }
    }

    // Always protect the last 4 messages
    if (i >= messages.length - 4) {
      protectedIndexes.add(i);
    }
  }

  return protectedIndexes;
}

/**
 * Check if a specific message index is protected.
 */
export function isMessageProtected(messages: ClovMessage[], index: number): boolean {
  return detectProtectedMessages(messages).has(index);
}

// ─── Grouping Statistics ───────────────────────────────────────────────────

export interface GroupingStats {
  /** Total number of API rounds */
  totalRounds: number;
  /** Average messages per round */
  avgMessagesPerRound: number;
  /** Max messages in a single round */
  maxMessagesInRound: number;
  /** Number of rounds with tool calls */
  roundsWithToolCalls: number;
  /** Number of rounds with user messages */
  roundsWithUserMessages: number;
  /** Total estimated tokens across all rounds */
  totalEstimatedTokens: number;
  /** Number of protected messages */
  protectedMessageCount: number;
  /** Age bucket distribution */
  ageBuckets: { recent: number; middle: number; old: number };
}

export function getGroupingStats(messages: ClovMessage[]): GroupingStats {
  const groups = groupMessagesByApiRound(messages);
  const roundCosts = estimateRoundCosts(messages);
  const protectedMessages = detectProtectedMessages(messages);
  const ageBuckets = getAgeBucketCounts(messages);

  const messageCounts = groups.map((g) => g.length);
  const totalRounds = groups.length;
  const avgMessagesPerRound = totalRounds > 0
    ? messageCounts.reduce((a, b) => a + b, 0) / totalRounds
    : 0;
  const maxMessagesInRound = messageCounts.length > 0 ? Math.max(...messageCounts) : 0;

  const roundsWithToolCalls = roundCosts.filter((r) => r.toolCallCount > 0).length;
  const roundsWithUserMessages = roundCosts.filter((r) => r.hasUserMessage).length;
  const totalEstimatedTokens = roundCosts.reduce((sum, r) => sum + r.estimatedTokens, 0);

  return {
    totalRounds,
    avgMessagesPerRound: Math.round(avgMessagesPerRound * 10) / 10,
    maxMessagesInRound,
    roundsWithToolCalls,
    roundsWithUserMessages,
    totalEstimatedTokens,
    protectedMessageCount: protectedMessages.size,
    ageBuckets,
  };
}
