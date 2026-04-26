/**
 * postCompactCleanup.ts — Post-compaction cache resets and memory reload
 *
 * Based on Claude Code's postCompactCleanup.ts (~100 lines)
 *
 * After compaction, several caches and state flags need to be reset:
 *   - Memory cache (context assembler cached state)
 *   - Warning suppression state
 *   - File state cache (files may have been mentioned in removed messages)
 *   - Skill injection state
 *
 * Features:
 *   - Cache invalidation
 *   - Warning suppression clear
 *   - Post-compact context building
 *   - Cleanup logging
 */

import { resetMemoryCache } from '../context/context.js';
import { clearSuppression } from './compactWarningState.js';
import type { CompactType } from './types.js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface CleanupResult {
  cachesCleared: string[];
  durationMs: number;
}

// ════════════════════════════════════════════════════════════════════════════
// Post-Compact Cleanup
// ════════════════════════════════════════════════════════════════════════════

/**
 * Run all post-compaction cleanup tasks.
 */
export async function runPostCompactCleanup(
  sessionId: string,
  compactType?: CompactType,
): Promise<CleanupResult> {
  const startTime = Date.now();
  const cleared: string[] = [];

  // Always clear memory cache
  try {
    resetMemoryCache();
    cleared.push('memoryCache');
  } catch (err) {
    console.warn(`[PostCompact] Failed to reset memory cache: ${(err as Error).message}`);
  }

  // Always clear warning suppression
  try {
    clearSuppression(sessionId);
    cleared.push('warningSuppression');
  } catch (err) {
    console.warn(`[PostCompact] Failed to clear suppression: ${(err as Error).message}`);
  }

  return {
    cachesCleared: cleared,
    durationMs: Date.now() - startTime,
  };
}

/**
 * Build the compact boundary message to inject into conversation.
 * This message marks where compaction occurred.
 */
export function buildCompactBoundaryMessage(
  compactType: CompactType,
  tokensSaved: number,
  summary?: string,
): string {
  const header = `[System Clow: Conversation was compacted (${compactType}). ${tokensSaved} tokens freed.]`;

  if (summary) {
    return `${header}\n\nSummary of previous conversation:\n\n${summary}`;
  }

  return header;
}

/**
 * Estimate the cost savings from a compaction.
 */
export function estimateCostSaving(tokensSaved: number): {
  inputCostSaved: number;
  description: string;
} {
  // Claude Sonnet pricing: $3.00/1M input (cache miss)
  const inputCostSaved = (tokensSaved / 1_000_000) * 0.28;

  return {
    inputCostSaved,
    description: `~$${inputCostSaved.toFixed(4)} saved (${tokensSaved} tokens)`,
  };
}
