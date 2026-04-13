/**
 * timeBasedMCConfig.ts — Time-based MicroCompact trigger configuration
 *
 * Controls when the time-based (non-cached) MicroCompact path fires.
 * The idea: if enough time has passed since the last assistant response,
 * the prompt cache is likely cold anyway, so we can safely
 * mutate tool results in place without worrying about cache invalidation.
 *
 * Features:
 *   - Multiple configuration presets (interactive, batch, idle)
 *   - Adaptive threshold calculation based on conversation velocity
 *   - Session-level configuration override
 *   - Gap analysis utilities
 */

import type { ClovMessage } from '../../api/anthropic.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface TimeBasedTrigger {
  shouldFire: boolean;
  gapMinutes: number;
  reason: string;
  /** Confidence that cache is cold (0-1) */
  cacheColdConfidence: number;
}

// ─── Configuration Presets ─────────────────────────────────────────────────

export interface TimeBasedMCPreset {
  /** Name of the preset */
  name: string;
  /** Minimum gap in minutes before triggering */
  gapThresholdMinutes: number;
  /** Description of when to use this preset */
  description: string;
}

/** Interactive: user is actively working, cache likely warm. */
export const PRESET_INTERACTIVE: TimeBasedMCPreset = {
  name: 'interactive',
  gapThresholdMinutes: 30,
  description: 'User is actively sending messages; cache is likely warm',
};

/** Batch: user sends bursts of messages with pauses. */
export const PRESET_BATCH: TimeBasedMCPreset = {
  name: 'batch',
  gapThresholdMinutes: 15,
  description: 'User works in bursts; cache may cool between bursts',
};

/** Idle: user has been away; cache is almost certainly cold. */
export const PRESET_IDLE: TimeBasedMCPreset = {
  name: 'idle',
  gapThresholdMinutes: 5,
  description: 'User has been idle; cache is likely cold',
};

/** Conservative: never fire unless gap is very large. */
export const PRESET_CONSERVATIVE: TimeBasedMCPreset = {
  name: 'conservative',
  gapThresholdMinutes: 60,
  description: 'Only fire after a long gap; preserve cache aggressively',
};

export const ALL_PRESETS: TimeBasedMCPreset[] = [
  PRESET_INTERACTIVE,
  PRESET_BATCH,
  PRESET_IDLE,
  PRESET_CONSERVATIVE,
];

export function getPresetByName(name: string): TimeBasedMCPreset | undefined {
  return ALL_PRESETS.find((p) => p.name === name);
}

// ─── Session-Level Override ────────────────────────────────────────────────

const sessionOverrides = new Map<string, number>();

export function setSessionGapOverride(sessionId: string, gapMinutes: number): void {
  sessionOverrides.set(sessionId, gapMinutes);
}

export function getSessionGapOverride(sessionId: string): number | undefined {
  return sessionOverrides.get(sessionId);
}

export function clearSessionGapOverride(sessionId: string): void {
  sessionOverrides.delete(sessionId);
}

// ─── Core Trigger Evaluation ───────────────────────────────────────────────

export function evaluateTimeBasedTrigger(
  messages: ClovMessage[],
  gapThresholdMinutes: number = 30,
): TimeBasedTrigger {
  // ClovMessage doesn't have timestamps — we can't evaluate time-based triggers
  // from messages alone. This function exists for interface compatibility.
  // The real evaluation happens in evaluateTimeBasedTriggerWithTimestamp().
  return {
    shouldFire: false,
    gapMinutes: 0,
    reason: 'time_tracking_not_available',
    cacheColdConfidence: 0,
  };
}

/**
 * Evaluate time-based trigger using an explicit last-assistant timestamp.
 * This is the primary evaluation path — the session manager passes in the
 * timestamp of the last assistant response.
 */
export function evaluateTimeBasedTriggerWithTimestamp(
  lastAssistantTimestamp: number | undefined,
  gapThresholdMinutes: number = 30,
): TimeBasedTrigger {
  if (!lastAssistantTimestamp) {
    return {
      shouldFire: false,
      gapMinutes: 0,
      reason: 'no_prior_assistant',
      cacheColdConfidence: 0,
    };
  }

  const gapMs = Date.now() - lastAssistantTimestamp;
  const gapMinutes = gapMs / 60_000;

  // Calculate cache cold confidence:
  // - 0 at 0 minutes gap
  // - ~0.5 at threshold
  // - ~0.9 at 2x threshold
  // - ~1.0 at 3x+ threshold
  const normalizedGap = gapMinutes / gapThresholdMinutes;
  const cacheColdConfidence = Math.min(1.0, 1 - Math.exp(-normalizedGap * 1.5));

  if (gapMinutes < gapThresholdMinutes) {
    return {
      shouldFire: false,
      gapMinutes,
      reason: `gap ${gapMinutes.toFixed(1)}m < ${gapThresholdMinutes}m`,
      cacheColdConfidence,
    };
  }

  return {
    shouldFire: true,
    gapMinutes,
    reason: `gap ${gapMinutes.toFixed(1)}m > threshold`,
    cacheColdConfidence,
  };
}

// ─── Adaptive Threshold Based on Conversation Velocity ─────────────────────

export interface VelocityEstimate {
  /** Estimated messages per minute (0 if unknown) */
  messagesPerMinute: number;
  /** Whether the user is in an active burst */
  isActiveBurst: boolean;
  /** Recommended gap threshold based on velocity */
  recommendedGapMinutes: number;
  /** Which preset best matches the current velocity */
  matchingPreset: string;
}

/**
 * Estimate conversation velocity from the session's message history
 * and timestamps. Adjusts the time-based trigger threshold so that
 * during active sessions, we wait longer (cache more likely warm),
 * and during idle sessions, we fire sooner (cache more likely cold).
 */
export function estimateConversationVelocity(
  messageCount: number,
  sessionAgeMinutes: number,
  lastGapMinutes: number,
): VelocityEstimate {
  if (sessionAgeMinutes <= 0 || messageCount <= 0) {
    return {
      messagesPerMinute: 0,
      isActiveBurst: false,
      recommendedGapMinutes: PRESET_INTERACTIVE.gapThresholdMinutes,
      matchingPreset: 'interactive',
    };
  }

  const messagesPerMinute = messageCount / sessionAgeMinutes;

  // Determine if user is in an active burst
  // Active burst: high message rate AND recent gap is short
  const isActiveBurst = messagesPerMinute > 1 && lastGapMinutes < 5;

  // Adaptive threshold:
  // - High velocity (>2 msg/min): use conservative (60m) — cache is warm
  // - Medium velocity (0.5-2 msg/min): use interactive (30m) — default
  // - Low velocity (0.1-0.5 msg/min): use batch (15m) — cache cools between turns
  // - Very low (<0.1 msg/min): use idle (5m) — cache is cold
  let recommendedGapMinutes: number;
  let matchingPreset: string;

  if (messagesPerMinute > 2) {
    recommendedGapMinutes = PRESET_CONSERVATIVE.gapThresholdMinutes;
    matchingPreset = 'conservative';
  } else if (messagesPerMinute > 0.5) {
    recommendedGapMinutes = PRESET_INTERACTIVE.gapThresholdMinutes;
    matchingPreset = 'interactive';
  } else if (messagesPerMinute > 0.1) {
    recommendedGapMinutes = PRESET_BATCH.gapThresholdMinutes;
    matchingPreset = 'batch';
  } else {
    recommendedGapMinutes = PRESET_IDLE.gapThresholdMinutes;
    matchingPreset = 'idle';
  }

  return {
    messagesPerMinute: Math.round(messagesPerMinute * 100) / 100,
    isActiveBurst,
    recommendedGapMinutes,
    matchingPreset,
  };
}

/**
 * Get the effective gap threshold for a session, considering:
 *   1. Session-level override (if set)
 *   2. Adaptive velocity-based calculation (if data available)
 *   3. Default fallback
 */
export function getEffectiveGapThreshold(
  sessionId: string,
  messageCount?: number,
  sessionAgeMinutes?: number,
  lastGapMinutes?: number,
  defaultMinutes: number = PRESET_INTERACTIVE.gapThresholdMinutes,
): number {
  // Check session override first
  const override = getSessionGapOverride(sessionId);
  if (override !== undefined) return override;

  // Try adaptive calculation if we have the data
  if (messageCount !== undefined && sessionAgeMinutes !== undefined && lastGapMinutes !== undefined) {
    const velocity = estimateConversationVelocity(messageCount, sessionAgeMinutes, lastGapMinutes);
    return velocity.recommendedGapMinutes;
  }

  return defaultMinutes;
}

// ─── Cleanup ───────────────────────────────────────────────────────────────

export function clearAllTimeBasedState(): void {
  sessionOverrides.clear();
}
