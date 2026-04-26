/**
 * errorWatermark.ts — Turn-scoped error tracking
 *
 * Based on Claude Code's errorWatermark.ts (~150 lines)
 *
 * Uses a watermark pattern to track which errors are new since
 * the last query turn began. This prevents reporting old errors
 * to the user on subsequent turns.
 *
 * Features:
 *   - Global error buffer (ring buffer, max 100 entries)
 *   - Watermark-based slicing (only new errors since begin())
 *   - Buffer rotation handling (graceful degradation)
 *   - Error categorization
 *   - Statistics
 *   - Multiple concurrent watermarks (for nested agents)
 */

import { randomUUID } from 'crypto';

// ─── Types ──────────────────────────────────────────────────────────────────

interface ErrorRef {
  id: string;
  error: Error;
  timestamp: number;
  category?: string;
  context?: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const ERROR_BUFFER_SIZE = 100;

// ─── Global Error Buffer ────────────────────────────────────────────────────

const errorBuffer: ErrorRef[] = [];

/**
 * Record an error in the global buffer.
 */
export function recordError(error: Error, category?: string, context?: string): void {
  errorBuffer.push({
    id: randomUUID(),
    error,
    timestamp: Date.now(),
    category,
    context,
  });
  if (errorBuffer.length > ERROR_BUFFER_SIZE) {
    errorBuffer.shift();
  }
}

/**
 * Get all errors in the buffer (readonly).
 */
export function getInMemoryErrors(): readonly ErrorRef[] {
  return errorBuffer;
}

/**
 * Clear all errors from the buffer.
 */
export function clearErrors(): void {
  errorBuffer.length = 0;
}

// ════════════════════════════════════════════════════════════════════════════
// ErrorWatermark Class
// ════════════════════════════════════════════════════════════════════════════

export class ErrorWatermark {
  private watermarkId: string | undefined;

  /**
   * Mark the current position in the error buffer.
   * Errors before this position belong to previous turns.
   */
  begin(): void {
    const last = errorBuffer[errorBuffer.length - 1];
    this.watermarkId = last?.id;
  }

  /**
   * Get errors that occurred since the last begin() call.
   * Handles buffer rotation gracefully (returns all if watermark was pruned).
   */
  getNewErrors(): Error[] {
    if (!this.watermarkId) {
      // No watermark set — return all errors
      return errorBuffer.map(e => e.error);
    }

    const idx = errorBuffer.findIndex(e => e.id === this.watermarkId);
    if (idx === -1) {
      // Watermark was pruned (buffer rotated) — return all current errors
      return errorBuffer.map(e => e.error);
    }

    // Return errors after the watermark
    return errorBuffer.slice(idx + 1).map(e => e.error);
  }

  /**
   * Get new errors with full metadata.
   */
  getNewErrorRefs(): ErrorRef[] {
    if (!this.watermarkId) return [...errorBuffer];
    const idx = errorBuffer.findIndex(e => e.id === this.watermarkId);
    if (idx === -1) return [...errorBuffer];
    return errorBuffer.slice(idx + 1);
  }

  /**
   * Check if there are any new errors since begin().
   */
  hasNewErrors(): boolean {
    return this.getNewErrors().length > 0;
  }

  /**
   * Get count of new errors.
   */
  getNewErrorCount(): number {
    return this.getNewErrors().length;
  }

  /**
   * Reset the watermark.
   */
  reset(): void {
    this.watermarkId = undefined;
  }
}
