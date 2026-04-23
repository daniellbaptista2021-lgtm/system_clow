/**
 * CompactionMetrics.ts — Compaction telemetry tracking
 *
 * Based on Claude Code's compactionMetrics.ts (~200 lines)
 *
 * Tracks tokens saved, durations, and counts across all 3 tiers.
 *
 * Features:
 *   - Record micro/session/full compaction results
 *   - Running totals and averages
 *   - Report generation
 *   - Cost estimation (tokens saved × price)
 *   - History tracking
 *   - Reset for testing
 */

import type { CompactionReport, MicroCompactResult, CompactionResult, CompactType } from './types.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const GLM_INPUT_PRICE_PER_TOKEN = 0.95 / 1_000_000;  // GLM-5.1 via OpenRouter: $0.95 per 1M input tokens
const MAX_HISTORY = 100;

// ─── Types ──────────────────────────────────────────────────────────────────

interface CompactionHistoryEntry {
  type: CompactType;
  tokensSaved: number;
  durationMs: number;
  timestamp: number;
  success: boolean;
}

// ════════════════════════════════════════════════════════════════════════════
// CompactionMetrics Class
// ════════════════════════════════════════════════════════════════════════════

export class CompactionMetrics {
  private microCount = 0;
  private sessionMemoryCount = 0;
  private fullCount = 0;
  private totalTokensSaved = 0;
  private totalDurationMs = 0;
  private failureCount = 0;
  private history: CompactionHistoryEntry[] = [];

  /**
   * Record a micro compaction result.
   */
  recordMicro(result: MicroCompactResult): void {
    if (!result.applied) return;

    this.microCount++;
    this.totalTokensSaved += result.tokensRecovered;
    this.history.push({
      type: 'micro',
      tokensSaved: result.tokensRecovered,
      durationMs: 0,
      timestamp: Date.now(),
      success: true,
    });
    this.trimHistory();
  }

  /**
   * Record a session memory compaction result.
   */
  recordSessionMemory(result: CompactionResult): void {
    if (result.success) {
      this.sessionMemoryCount++;
      this.totalTokensSaved += result.tokensSaved;
      this.totalDurationMs += result.durationMs;
    } else {
      this.failureCount++;
    }
    this.history.push({
      type: 'session_memory',
      tokensSaved: result.tokensSaved,
      durationMs: result.durationMs,
      timestamp: Date.now(),
      success: result.success,
    });
    this.trimHistory();
  }

  /**
   * Record a full compaction result.
   */
  recordFull(result: CompactionResult): void {
    if (result.success) {
      this.fullCount++;
      this.totalTokensSaved += result.tokensSaved;
      this.totalDurationMs += result.durationMs;
    } else {
      this.failureCount++;
    }
    this.history.push({
      type: 'full',
      tokensSaved: result.tokensSaved,
      durationMs: result.durationMs,
      timestamp: Date.now(),
      success: result.success,
    });
    this.trimHistory();
  }

  /**
   * Generate a compaction report.
   */
  getReport(): CompactionReport {
    const total = this.microCount + this.sessionMemoryCount + this.fullCount;
    return {
      totalCompactions: total,
      breakdown: {
        micro: this.microCount,
        sessionMemory: this.sessionMemoryCount,
        full: this.fullCount,
      },
      totalTokensSaved: this.totalTokensSaved,
      avgDurationMs: total > 0 ? this.totalDurationMs / total : 0,
      estimatedCostSaved: this.totalTokensSaved * GLM_INPUT_PRICE_PER_TOKEN,
    };
  }

  /**
   * Get compaction history.
   */
  getHistory(): CompactionHistoryEntry[] {
    return [...this.history];
  }

  /**
   * Get failure rate.
   */
  getFailureRate(): number {
    const total = this.microCount + this.sessionMemoryCount + this.fullCount + this.failureCount;
    return total > 0 ? this.failureCount / total : 0;
  }

  /**
   * Reset all metrics.
   */
  reset(): void {
    this.microCount = 0;
    this.sessionMemoryCount = 0;
    this.fullCount = 0;
    this.totalTokensSaved = 0;
    this.totalDurationMs = 0;
    this.failureCount = 0;
    this.history = [];
  }

  private trimHistory(): void {
    if (this.history.length > MAX_HISTORY) {
      this.history = this.history.slice(-MAX_HISTORY);
    }
  }
}
