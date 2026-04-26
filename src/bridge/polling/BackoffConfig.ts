import type { BackoffConfig } from '../types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BackoffState {
  connBackoffMs: number;
  generalBackoffMs: number;
  connStartedAt: number | null;
  generalStartedAt: number | null;
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

/**
 * Calculate the backoff delay for a given attempt number.
 */
export function calculateBackoff(attempt: number, config: BackoffConfig): number {
  if (attempt <= 0) return config.initialDelayMs;
  const delay = config.initialDelayMs * Math.pow(config.multiplier, attempt);
  return Math.min(delay, config.maxDelayMs);
}

/**
 * Check whether an error is a connection-level error.
 */
export function isConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  return (
    msg.includes('econnrefused') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('enetunreach') ||
    msg.includes('fetch failed') ||
    msg.includes('socket hang up') ||
    msg.includes('network')
  );
}

/**
 * Check whether we should give up retrying.
 */
export function shouldGiveUp(startedAt: number | null, giveUpMs: number): boolean {
  if (startedAt === null) return false;
  return Date.now() - startedAt >= giveUpMs;
}

/**
 * Create a fresh backoff state.
 */
export function resetBackoff(): BackoffState {
  return {
    connBackoffMs: 0,
    generalBackoffMs: 0,
    connStartedAt: null,
    generalStartedAt: null,
  };
}

/**
 * Add random jitter to a delay.
 */
export function addJitter(delayMs: number, maxJitterMs: number): number {
  const jitter = Math.random() * maxJitterMs;
  return Math.max(0, delayMs + jitter - maxJitterMs / 2);
}
