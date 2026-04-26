/**
 * fallbackHandler.ts — Model fallback + max output token recovery
 *
 * Based on Claude Code's fallbackHandler.ts (~200 lines)
 *
 * Two recovery mechanisms:
 *   1. Model Fallback: Switch to backup model on rate limit/overload
 *   2. Continuation: Inject "continue" prompt on max_tokens stop
 *
 * Features:
 *   - Rate limit detection (429, "rate limit")
 *   - Overload detection (503, "overloaded")
 *   - Continuation prompt injection
 *   - Max retry limit for continuations
 *   - Error classification (transient vs permanent)
 *   - Fallback statistics
 *   - Cooldown tracking
 */

import { randomUUID } from 'crypto';
import type { MessageState } from './messageState.js';
import type { UserMessage } from './types.js';

// ─── Constants ──────────────────────────────────────────────────────────────

export const MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 5;
const FALLBACK_COOLDOWN_MS = 60_000; // 1 minute cooldown after fallback

// ─── Types ──────────────────────────────────────────────────────────────────

interface FallbackStats {
  totalFallbacks: number;
  totalContinuations: number;
  fallbackReasons: Record<string, number>;
  lastFallbackAt: number;
}

// ════════════════════════════════════════════════════════════════════════════
// Custom Errors
// ════════════════════════════════════════════════════════════════════════════

export class FallbackTriggeredError extends Error {
  constructor(
    public readonly reason: 'rate_limit' | 'overload' | 'context_overflow',
    public readonly originalError: Error,
  ) {
    super(`Fallback triggered: ${reason}`);
    this.name = 'FallbackTriggeredError';
  }
}

// ════════════════════════════════════════════════════════════════════════════
// FallbackHandler Class
// ════════════════════════════════════════════════════════════════════════════

export class FallbackHandler {
  private stats: FallbackStats = {
    totalFallbacks: 0,
    totalContinuations: 0,
    fallbackReasons: {},
    lastFallbackAt: 0,
  };

  constructor(
    private readonly primaryModel: string,
    private readonly fallbackModel: string | undefined,
  ) {}

  /**
   * Check if an error should trigger fallback to backup model.
   * Returns FallbackTriggeredError if yes, null if no.
   */
  shouldFallback(error: Error): FallbackTriggeredError | null {
    if (!this.fallbackModel) return null;

    // Don't fallback again too quickly
    if (Date.now() - this.stats.lastFallbackAt < FALLBACK_COOLDOWN_MS) return null;

    const msg = error.message.toLowerCase();

    if (msg.includes('rate limit') || msg.includes('429') || msg.includes('too many requests')) {
      return this.createFallback('rate_limit', error);
    }

    if (msg.includes('overloaded') || msg.includes('503') || msg.includes('service unavailable')) {
      return this.createFallback('overload', error);
    }

    // Context overflow is handled by compaction, NOT fallback
    return null;
  }

  /**
   * Inject a continuation prompt when the model stops at max_tokens.
   * Returns true if retry should happen, false if max retries reached.
   */
  injectContinuation(state: MessageState, turnNumber: number, attempt: number): boolean {
    if (attempt >= MAX_OUTPUT_TOKENS_RECOVERY_LIMIT) return false;

    // Check that last message was an assistant message that stopped at max_tokens
    const lastAssistant = state.findLast(m => m.type === 'assistant');
    if (!lastAssistant || (lastAssistant as any).stopReason !== 'max_tokens') return false;

    const continuationMsg: UserMessage = {
      type: 'user',
      uuid: randomUUID(),
      content: 'Continue from where you stopped. Do not repeat what you already wrote.',
      turnNumber,
      timestamp: Date.now(),
      source: 'compaction',
    };

    state.push(continuationMsg);
    this.stats.totalContinuations++;
    return true;
  }

  /**
   * Check if an error is transient (worth retrying with same model).
   */
  isTransientError(error: Error): boolean {
    const msg = error.message.toLowerCase();
    return (
      msg.includes('network') ||
      msg.includes('timeout') ||
      msg.includes('econnreset') ||
      msg.includes('econnrefused') ||
      msg.includes('socket hang up')
    );
  }

  // ─── Getters ─────────────────────────────────────────────────────

  getFallbackModel(): string | undefined { return this.fallbackModel; }
  getPrimaryModel(): string { return this.primaryModel; }
  getStats(): FallbackStats { return { ...this.stats }; }

  // ─── Internal ────────────────────────────────────────────────────

  private createFallback(reason: 'rate_limit' | 'overload', error: Error): FallbackTriggeredError {
    this.stats.totalFallbacks++;
    this.stats.fallbackReasons[reason] = (this.stats.fallbackReasons[reason] ?? 0) + 1;
    this.stats.lastFallbackAt = Date.now();
    return new FallbackTriggeredError(reason, error);
  }
}
