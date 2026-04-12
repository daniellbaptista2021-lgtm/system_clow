/**
 * compactWarningState.ts — Context window warning suppression
 *
 * Based on Claude Code's compactWarningState.ts (~100 lines)
 *
 * After a micro-compact frees space, suppress warnings for a period
 * to avoid annoying the user with repeated warnings.
 *
 * Features:
 *   - Per-session suppression
 *   - Configurable duration
 *   - Auto-expiry
 *   - Clear on explicit compact
 *   - Warning level tracking (warning, critical, blocking)
 */

// ─── Types ──────────────────────────────────────────────────────────────────

type WarningLevel = 'none' | 'warning' | 'critical' | 'blocking';

interface SuppressionEntry {
  suppressedUntil: number;
  level: WarningLevel;
  reason: string;
}

// ─── State ──────────────────────────────────────────────────────────────────

const suppressions = new Map<string, SuppressionEntry>();
const warningLevels = new Map<string, WarningLevel>();

// ─── Default Durations ──────────────────────────────────────────────────────

const DEFAULT_SUPPRESSION_MS = 5 * 60_000;  // 5 minutes
const CRITICAL_SUPPRESSION_MS = 2 * 60_000;  // 2 minutes (shorter for critical)

// ════════════════════════════════════════════════════════════════════════════
// Suppression Functions
// ════════════════════════════════════════════════════════════════════════════

/**
 * Suppress context warnings for a session.
 */
export function suppressWarnings(
  sessionId: string,
  durationMs: number = DEFAULT_SUPPRESSION_MS,
  reason: string = 'micro-compact',
): void {
  suppressions.set(sessionId, {
    suppressedUntil: Date.now() + durationMs,
    level: 'warning',
    reason,
  });
}

/**
 * Check if warnings should be shown for a session.
 */
export function shouldShowWarning(sessionId: string): boolean {
  const entry = suppressions.get(sessionId);
  if (!entry) return true;
  if (Date.now() >= entry.suppressedUntil) {
    suppressions.delete(sessionId);
    return true;
  }
  return false;
}

/**
 * Clear suppression for a session.
 */
export function clearSuppression(sessionId: string): void {
  suppressions.delete(sessionId);
}

// ════════════════════════════════════════════════════════════════════════════
// Warning Level Tracking
// ════════════════════════════════════════════════════════════════════════════

/**
 * Set the current warning level for a session.
 */
export function setWarningLevel(sessionId: string, level: WarningLevel): void {
  warningLevels.set(sessionId, level);
}

/**
 * Get the current warning level for a session.
 */
export function getWarningLevel(sessionId: string): WarningLevel {
  return warningLevels.get(sessionId) ?? 'none';
}

/**
 * Calculate warning level based on token usage.
 */
export function calculateWarningLevel(
  currentTokens: number,
  maxTokens: number,
  warningBuffer: number = 20_000,
  criticalBuffer: number = 13_000,
  blockingBuffer: number = 3_000,
): WarningLevel {
  const remaining = maxTokens - currentTokens;
  if (remaining <= blockingBuffer) return 'blocking';
  if (remaining <= criticalBuffer) return 'critical';
  if (remaining <= warningBuffer) return 'warning';
  return 'none';
}

/**
 * Clear all state (for testing).
 */
export function clearAllWarningState(): void {
  suppressions.clear();
  warningLevels.clear();
}
