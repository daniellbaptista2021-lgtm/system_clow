/**
 * HookErrorScope.ts — Turn-scoped hook error tracking
 *
 * Based on Claude Code's hookErrorScope.ts (~150 lines)
 *
 * Uses a watermark pattern to track which errors are new since the
 * last hook fire. This allows the query engine to report hook errors
 * to the user without duplicating old errors.
 *
 * Features:
 *   - Global error buffer (ring buffer, max 200 entries)
 *   - Per-session watermarking
 *   - Get new errors since last begin()
 *   - Error classification
 *   - Statistics
 */

import { randomUUID } from 'crypto';

// ─── Types ──────────────────────────────────────────────────────────────────

interface ErrorEntry {
  id: string;
  error: Error;
  ts: number;
  sessionId?: string;
  hookId?: string;
  event?: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_ERRORS = 200;

// ─── Global Error Buffer ────────────────────────────────────────────────────

const errorBuffer: ErrorEntry[] = [];

/**
 * Record a hook error in the global buffer.
 */
export function recordHookError(error: Error, sessionId?: string, hookId?: string, event?: string): void {
  errorBuffer.push({
    id: randomUUID(),
    error,
    ts: Date.now(),
    sessionId,
    hookId,
    event,
  });

  // Trim buffer
  while (errorBuffer.length > MAX_ERRORS) {
    errorBuffer.shift();
  }
}

/**
 * Get all errors in the buffer.
 */
export function getAllHookErrors(): ErrorEntry[] {
  return [...errorBuffer];
}

/**
 * Clear all errors.
 */
export function clearHookErrors(): void {
  errorBuffer.length = 0;
}

// ════════════════════════════════════════════════════════════════════════════
// HookErrorScope Class
// ════════════════════════════════════════════════════════════════════════════

export class HookErrorScope {
  private watermarks = new Map<string, string | undefined>();

  /**
   * Begin a new scope for a session.
   * Records the current watermark (last error ID).
   */
  begin(sessionId: string): void {
    const lastEntry = errorBuffer[errorBuffer.length - 1];
    this.watermarks.set(sessionId, lastEntry?.id);
  }

  /**
   * Get errors that occurred since the last begin() for this session.
   */
  getNewErrors(sessionId: string): Error[] {
    const watermark = this.watermarks.get(sessionId);

    if (!watermark) {
      // No watermark — return all errors for this session
      return errorBuffer
        .filter(e => !e.sessionId || e.sessionId === sessionId)
        .map(e => e.error);
    }

    // Find the watermark position
    const idx = errorBuffer.findIndex(e => e.id === watermark);
    if (idx === -1) {
      // Watermark was pruned — return all
      return errorBuffer
        .filter(e => !e.sessionId || e.sessionId === sessionId)
        .map(e => e.error);
    }

    // Return errors after the watermark
    return errorBuffer
      .slice(idx + 1)
      .filter(e => !e.sessionId || e.sessionId === sessionId)
      .map(e => e.error);
  }

  /**
   * Get count of new errors since last begin().
   */
  getNewErrorCount(sessionId: string): number {
    return this.getNewErrors(sessionId).length;
  }

  /**
   * Reset the watermark for a session.
   */
  reset(sessionId: string): void {
    this.watermarks.delete(sessionId);
  }

  /**
   * Check if there are any new errors.
   */
  hasNewErrors(sessionId: string): boolean {
    return this.getNewErrors(sessionId).length > 0;
  }

  /**
   * Get all active sessions with watermarks.
   */
  getActiveSessions(): string[] {
    return [...this.watermarks.keys()];
  }

  /**
   * Clear all watermarks.
   */
  clearAll(): void {
    this.watermarks.clear();
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Error Classification
// ════════════════════════════════════════════════════════════════════════════

export type HookErrorCategory = 'timeout' | 'network' | 'permission' | 'parse' | 'spawn' | 'unknown';

/**
 * Classify a hook error by its likely cause.
 */
export function classifyHookError(error: Error): HookErrorCategory {
  const msg = error.message.toLowerCase();
  if (msg.includes('timeout') || msg.includes('timed out')) return 'timeout';
  if (msg.includes('fetch') || msg.includes('network') || msg.includes('econnrefused')) return 'network';
  if (msg.includes('permission') || msg.includes('eacces') || msg.includes('eperm')) return 'permission';
  if (msg.includes('json') || msg.includes('parse') || msg.includes('unexpected token')) return 'parse';
  if (msg.includes('spawn') || msg.includes('enoent') || msg.includes('command not found')) return 'spawn';
  return 'unknown';
}

/**
 * Format a hook error for display.
 */
export function formatHookError(error: Error, hookId?: string): string {
  const category = classifyHookError(error);
  const prefix = hookId ? `[hook ${hookId}]` : '[hook]';
  return `${prefix} ${category}: ${error.message}`;
}

/**
 * Get error buffer statistics.
 */
export function getErrorBufferStats(): {
  totalErrors: number;
  oldestErrorAge: number;
  newestErrorAge: number;
  byCategory: Record<string, number>;
} {
  const errors = getAllHookErrors();
  const byCategory: Record<string, number> = {};
  const now = Date.now();

  for (const entry of errors) {
    const cat = classifyHookError(entry.error);
    byCategory[cat] = (byCategory[cat] ?? 0) + 1;
  }

  return {
    totalErrors: errors.length,
    oldestErrorAge: errors.length > 0 ? now - errors[0].ts : 0,
    newestErrorAge: errors.length > 0 ? now - errors[errors.length - 1].ts : 0,
    byCategory,
  };
}
