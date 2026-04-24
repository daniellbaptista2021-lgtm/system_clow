/**
 * autoCompact.ts — Auto-compaction trigger + circuit breaker + warning state
 *
 * Threshold: effective_window - configurable buffer
 * Circuit breaker: configurable consecutive failures → stop trying
 * Recursion guard: never compact from within compact/session_memory
 *
 * Tier selection logic:
 *   - micro: token usage > 60% but below auto-compact threshold, or stale cache
 *   - session_memory: token usage crosses auto-compact threshold and memory is available
 *   - full: token usage crosses auto-compact threshold with no session memory, or PTL recovery
 *
 * Rate limiting: minimum interval between compactions to avoid thrashing
 * History tracking: records every compaction event for diagnostics
 */

import type { ClovMessage } from '../../api/anthropic.js';
import { estimateMessageTokens } from './microCompact.js';
import type { CompactionConfig, CompactType, CompactTrigger } from './types.js';
import { DEFAULT_CONFIG } from './types.js';

// ─── Model Context Windows ─────────────────────────────────────────────────

/** Known context window sizes for supported models. */
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  'glm-5.1': 128_000,
  'glm-5': 128_000,
  'glm-4.5': 128_000,
  'glm-4': 128_000,
};

/** Known max output token limits for supported models. */
const MODEL_MAX_OUTPUT: Record<string, number> = {
  'glm-5.1': 8_192,
  'glm-5': 8_192,
  'glm-4.5': 8_192,
  'glm-4': 8_192,
};

export function getContextWindowForModel(model: string): number {
  // Exact match first
  if (MODEL_CONTEXT_WINDOWS[model]) return MODEL_CONTEXT_WINDOWS[model];
  // Substring match fallback
  for (const [key, value] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
    if (model.includes(key)) return value;
  }
  // Conservative default
  return 128_000;
}

export function getMaxOutputTokens(model: string): number {
  if (MODEL_MAX_OUTPUT[model]) return MODEL_MAX_OUTPUT[model];
  for (const [key, value] of Object.entries(MODEL_MAX_OUTPUT)) {
    if (model.includes(key)) return value;
  }
  return 8_000;
}

export function getEffectiveWindow(model: string): number {
  const contextWindow = getContextWindowForModel(model);
  const maxOutput = getMaxOutputTokens(model);
  // Reserve space for output tokens, capped at 20K to avoid over-reserving
  const outputReserve = Math.min(maxOutput, 20_000);
  return contextWindow - outputReserve;
}

// ─── Token Warning State ────────────────────────────────────────────────────

export interface TokenWarningState {
  estimatedTokens: number;
  effectiveWindow: number;
  percentLeft: number;
  percentUsed: number;
  isAboveWarningThreshold: boolean;
  isAboveAutoCompactThreshold: boolean;
  isAtBlockingLimit: boolean;
  /** Recommended tier if compaction is needed */
  recommendedTier: CompactType | null;
  /** Human-readable explanation of the current state */
  explanation: string;
}

export function getTokenWarningState(
  messages: ClovMessage[],
  model: string = 'glm-5.1',
  config: CompactionConfig = DEFAULT_CONFIG,
): TokenWarningState {
  const tokens = estimateMessageTokens(messages);
  const effective = getEffectiveWindow(model);
  const remaining = effective - tokens;
  const percentLeft = (remaining / effective) * 100;
  const percentUsed = 100 - percentLeft;

  const isAboveWarningThreshold = remaining < config.warningBufferTokens;
  const isAboveAutoCompactThreshold = remaining < config.autoCompactBufferTokens;
  const isAtBlockingLimit = remaining < config.blockingLimitBufferTokens;

  // Determine recommended tier based on usage level
  let recommendedTier: CompactType | null = null;
  let explanation = `${tokens} tokens used of ${effective} effective window (${percentUsed.toFixed(1)}%)`;

  if (isAtBlockingLimit) {
    recommendedTier = 'full';
    explanation += ' — BLOCKING: full compaction required immediately';
  } else if (isAboveAutoCompactThreshold) {
    recommendedTier = 'session_memory';
    explanation += ' — above auto-compact threshold, session_memory or full recommended';
  } else if (isAboveWarningThreshold) {
    recommendedTier = 'micro';
    explanation += ' — in warning zone, micro-compact may help';
  } else {
    explanation += ' — within safe operating range';
  }

  return {
    estimatedTokens: tokens,
    effectiveWindow: effective,
    percentLeft,
    percentUsed,
    isAboveWarningThreshold,
    isAboveAutoCompactThreshold,
    isAtBlockingLimit,
    recommendedTier,
    explanation,
  };
}

// ─── Tier Selection ────────────────────────────────────────────────────────

export type TierRecommendation = 'micro' | 'session_memory' | 'full' | 'none';

export interface TierSelectionResult {
  tier: TierRecommendation;
  reason: string;
  urgency: 'low' | 'medium' | 'high' | 'critical';
  tokenUsagePercent: number;
}

/**
 * Determine which compaction tier to use based on current token pressure,
 * message count, and session state.
 */
export function selectCompactionTier(
  messages: ClovMessage[],
  model: string = 'glm-5.1',
  hasSessionMemory: boolean = false,
  config: CompactionConfig = DEFAULT_CONFIG,
): TierSelectionResult {
  const tokens = estimateMessageTokens(messages);
  const effective = getEffectiveWindow(model);
  const remaining = effective - tokens;
  const usagePercent = (tokens / effective) * 100;

  // Critical: at blocking limit — must do full compact
  if (remaining < config.blockingLimitBufferTokens) {
    return {
      tier: 'full',
      reason: `Critical: only ${remaining} tokens remaining (blocking limit: ${config.blockingLimitBufferTokens})`,
      urgency: 'critical',
      tokenUsagePercent: usagePercent,
    };
  }

  // High: past auto-compact threshold
  if (remaining < config.autoCompactBufferTokens) {
    // Prefer session_memory if available — it's faster and cheaper
    if (hasSessionMemory) {
      return {
        tier: 'session_memory',
        reason: `${remaining} tokens remaining, session memory available`,
        urgency: 'high',
        tokenUsagePercent: usagePercent,
      };
    }
    // Fall back to full compaction
    return {
      tier: 'full',
      reason: `${remaining} tokens remaining, no session memory — full compact needed`,
      urgency: 'high',
      tokenUsagePercent: usagePercent,
    };
  }

  // Medium: in warning zone — micro-compact can buy time
  if (remaining < config.warningBufferTokens) {
    return {
      tier: 'micro',
      reason: `${remaining} tokens remaining — micro-compact to free tool results`,
      urgency: 'medium',
      tokenUsagePercent: usagePercent,
    };
  }

  // Low: usage above 60% — consider proactive micro-compact
  if (usagePercent > 60 && messages.length > 20) {
    return {
      tier: 'micro',
      reason: `Proactive: ${usagePercent.toFixed(1)}% used with ${messages.length} messages`,
      urgency: 'low',
      tokenUsagePercent: usagePercent,
    };
  }

  return {
    tier: 'none',
    reason: `${usagePercent.toFixed(1)}% used — no compaction needed`,
    urgency: 'low',
    tokenUsagePercent: usagePercent,
  };
}

// ─── Circuit Breaker ────────────────────────────────────────────────────────

const failures = new Map<string, number>();

export function recordCompactSuccess(sessionId: string = 'default'): void {
  failures.set(sessionId, 0);
}

export function recordCompactFailure(sessionId: string = 'default'): number {
  const n = (failures.get(sessionId) ?? 0) + 1;
  failures.set(sessionId, n);
  return n;
}

export function getConsecutiveFailures(sessionId: string = 'default'): number {
  return failures.get(sessionId) ?? 0;
}

export function isCircuitBroken(
  sessionId: string = 'default',
  max: number = DEFAULT_CONFIG.maxConsecutiveFailures,
): boolean {
  return (failures.get(sessionId) ?? 0) >= max;
}

export function resetCircuitBreaker(sessionId: string = 'default'): void {
  failures.delete(sessionId);
}

// ─── Rate Limiting ─────────────────────────────────────────────────────────

/** Minimum interval between compactions in milliseconds (default 60 seconds). */
const DEFAULT_RATE_LIMIT_MS = 60_000;

const lastCompactTimestamps = new Map<string, number>();

export function recordCompactTimestamp(sessionId: string = 'default'): void {
  lastCompactTimestamps.set(sessionId, Date.now());
}

export function getLastCompactTimestamp(sessionId: string = 'default'): number | undefined {
  return lastCompactTimestamps.get(sessionId);
}

export function isRateLimited(
  sessionId: string = 'default',
  minIntervalMs: number = DEFAULT_RATE_LIMIT_MS,
): boolean {
  const lastTs = lastCompactTimestamps.get(sessionId);
  if (!lastTs) return false;
  return (Date.now() - lastTs) < minIntervalMs;
}

export function getTimeSinceLastCompact(sessionId: string = 'default'): number {
  const lastTs = lastCompactTimestamps.get(sessionId);
  if (!lastTs) return Infinity;
  return Date.now() - lastTs;
}

// ─── Auto-Compact History ──────────────────────────────────────────────────

export interface CompactHistoryEntry {
  timestamp: number;
  type: CompactType;
  trigger: CompactTrigger;
  tokensBefore: number;
  tokensAfter: number;
  tokensSaved: number;
  durationMs: number;
  success: boolean;
  failureReason?: string;
}

/** Per-session compaction history (ring buffer, max 50 entries). */
const compactHistory = new Map<string, CompactHistoryEntry[]>();
const MAX_HISTORY_ENTRIES = 50;

export function recordCompactHistory(sessionId: string, entry: CompactHistoryEntry): void {
  const history = compactHistory.get(sessionId) ?? [];
  history.push(entry);
  // Ring buffer — drop oldest when exceeding max
  while (history.length > MAX_HISTORY_ENTRIES) {
    history.shift();
  }
  compactHistory.set(sessionId, history);
}

export function getCompactHistory(sessionId: string = 'default'): CompactHistoryEntry[] {
  return compactHistory.get(sessionId) ?? [];
}

export function getCompactHistoryStats(sessionId: string = 'default'): {
  totalCompactions: number;
  successCount: number;
  failureCount: number;
  totalTokensSaved: number;
  avgDurationMs: number;
  avgTokensSaved: number;
  lastCompactType: CompactType | null;
} {
  const history = getCompactHistory(sessionId);
  if (history.length === 0) {
    return {
      totalCompactions: 0, successCount: 0, failureCount: 0,
      totalTokensSaved: 0, avgDurationMs: 0, avgTokensSaved: 0,
      lastCompactType: null,
    };
  }

  const successes = history.filter((e) => e.success);
  const totalTokensSaved = successes.reduce((sum, e) => sum + e.tokensSaved, 0);
  const totalDuration = history.reduce((sum, e) => sum + e.durationMs, 0);

  return {
    totalCompactions: history.length,
    successCount: successes.length,
    failureCount: history.length - successes.length,
    totalTokensSaved,
    avgDurationMs: Math.round(totalDuration / history.length),
    avgTokensSaved: successes.length > 0 ? Math.round(totalTokensSaved / successes.length) : 0,
    lastCompactType: history[history.length - 1].type,
  };
}

/** Clear history for a session (for testing). */
export function clearCompactHistory(sessionId: string = 'default'): void {
  compactHistory.delete(sessionId);
}

// ─── Adaptive Threshold Calculation ────────────────────────────────────────

/**
 * Calculate an adaptive auto-compact threshold based on conversation velocity.
 * If the user is sending messages rapidly, trigger compaction earlier to avoid
 * hitting the blocking limit before the next check.
 *
 * Returns adjusted buffer tokens (higher = trigger sooner).
 */
export function calculateAdaptiveThreshold(
  messages: ClovMessage[],
  baseBufferTokens: number = DEFAULT_CONFIG.autoCompactBufferTokens,
  model: string = 'glm-5.1',
): number {
  const effective = getEffectiveWindow(model);

  // Count user messages in the last ~20 messages to gauge velocity
  const recentSlice = messages.slice(-20);
  const userMessageCount = recentSlice.filter((m) => m.role === 'user').length;

  // If the user is sending messages rapidly (>8 user messages in last 20),
  // increase the buffer by 30% so compaction triggers earlier
  if (userMessageCount > 8) {
    return Math.min(Math.ceil(baseBufferTokens * 1.3), effective * 0.25);
  }

  // If messages have large tool results, increase buffer slightly
  const avgContentLength = recentSlice.reduce((sum, m) => sum + (m.content?.length ?? 0), 0) / Math.max(recentSlice.length, 1);
  if (avgContentLength > 3000) {
    return Math.min(Math.ceil(baseBufferTokens * 1.15), effective * 0.2);
  }

  return baseBufferTokens;
}

// ─── Should Auto-Compact ────────────────────────────────────────────────────

export interface AutoCompactResult {
  shouldCompact: boolean;
  estimatedTokens: number;
  threshold: number;
  percentUsed: number;
  circuitBroken: boolean;
  rateLimited: boolean;
  reason: string;
  recommendedTier: TierRecommendation;
}

export function shouldAutoCompact(
  messages: ClovMessage[],
  model: string = 'glm-5.1',
  sessionId: string = 'default',
  querySource: string = 'user',
  config: CompactionConfig = DEFAULT_CONFIG,
  hasSessionMemory: boolean = false,
): AutoCompactResult {
  const tokens = estimateMessageTokens(messages);
  const effective = getEffectiveWindow(model);
  const adaptiveBuffer = calculateAdaptiveThreshold(messages, config.autoCompactBufferTokens, model);
  const threshold = effective - adaptiveBuffer;
  const percentUsed = (tokens / effective) * 100;

  const base = { estimatedTokens: tokens, threshold, percentUsed };

  // Recursion guard — never compact from within compact/session_memory/marble_origami
  if (querySource === 'compact' || querySource === 'session_memory' || querySource === 'marble_origami') {
    return { ...base, shouldCompact: false, circuitBroken: false, rateLimited: false, reason: 'recursion_guard', recommendedTier: 'none' };
  }

  // Circuit breaker — stop trying after repeated failures
  if (isCircuitBroken(sessionId, config.maxConsecutiveFailures)) {
    const failCount = getConsecutiveFailures(sessionId);
    return { ...base, shouldCompact: false, circuitBroken: true, rateLimited: false, reason: `circuit_breaker (${failCount} failures)`, recommendedTier: 'none' };
  }

  // Rate limiting — don't compact too frequently
  if (isRateLimited(sessionId)) {
    const elapsed = getTimeSinceLastCompact(sessionId);
    return { ...base, shouldCompact: false, circuitBroken: false, rateLimited: true, reason: `rate_limited (${Math.round(elapsed / 1000)}s since last)`, recommendedTier: 'none' };
  }

  // Check if above threshold
  if (tokens > threshold) {
    const tierResult = selectCompactionTier(messages, model, hasSessionMemory, config);
    return { ...base, shouldCompact: true, circuitBroken: false, rateLimited: false, reason: `${tokens} > ${threshold} (adaptive buffer: ${adaptiveBuffer})`, recommendedTier: tierResult.tier };
  }

  return { ...base, shouldCompact: false, circuitBroken: false, rateLimited: false, reason: `${tokens} < ${threshold}`, recommendedTier: 'none' };
}

// ─── Cleanup (for testing) ─────────────────────────────────────────────────

export function clearAllAutoCompactState(): void {
  failures.clear();
  lastCompactTimestamps.clear();
  compactHistory.clear();
}

// ─── Re-exports for backward compat ─────────────────────────────────────────
export { estimateMessageTokens } from './microCompact.js';
export { DEFAULT_CONFIG as COMPACT_CONFIG } from './types.js';
