/**
 * tombstone.ts — Orphan message removal system
 *
 * Based on Claude Code's tombstoneSystem.ts (~150 lines)
 *
 * Marks messages as removed without deleting (preserves chain integrity).
 * Used by:
 *   - Fallback handler (tombstone failed assistant turns)
 *   - Compaction (tombstone replaced messages)
 *   - History snip (tombstone range of messages)
 *
 * Features:
 *   - Tombstone individual messages
 *   - Tombstone failed turns (by message ID)
 *   - Tombstone compacted messages (batch)
 *   - Tombstone message ranges (for snip)
 *   - Statistics tracking
 */

import type { MessageState } from './messageState.js';
import type { TombstoneMessage, TombstoneReason } from './types.js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface TombstoneStats {
  totalTombstones: number;
  byReason: Record<string, number>;
}

// ════════════════════════════════════════════════════════════════════════════
// TombstoneSystem Class
// ════════════════════════════════════════════════════════════════════════════

export class TombstoneSystem {
  private static stats: TombstoneStats = {
    totalTombstones: 0,
    byReason: {},
  };

  /**
   * Tombstone all messages from a failed assistant turn.
   * Used when fallback is triggered (remove the failed response + tool results).
   */
  static tombstoneFailedTurn(state: MessageState, failedMessageId: string): TombstoneMessage[] {
    const tombstones = state.tombstoneByMessageId(failedMessageId, 'fallback_orphan');
    TombstoneSystem.recordStats(tombstones.length, 'fallback_orphan');
    return tombstones;
  }

  /**
   * Tombstone messages that were replaced by a compaction summary.
   * Used after session_memory or full compaction.
   */
  static tombstoneCompacted(state: MessageState, uuids: string[]): TombstoneMessage[] {
    const tombstones: TombstoneMessage[] = [];
    for (const uuid of uuids) {
      try {
        tombstones.push(state.tombstone(uuid, 'compact_replaced'));
      } catch {
        // Already tombstoned — skip
      }
    }
    TombstoneSystem.recordStats(tombstones.length, 'compact_replaced');
    return tombstones;
  }

  /**
   * Tombstone a range of messages (inclusive).
   * Used by history snip to remove a block of messages.
   */
  static tombstoneRange(
    state: MessageState,
    startUuid: string,
    endUuid: string,
  ): TombstoneMessage[] {
    const messages = state.snapshot();
    const startIdx = messages.findIndex(m => m.uuid === startUuid);
    const endIdx = messages.findIndex(m => m.uuid === endUuid);

    if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) return [];

    const tombstones: TombstoneMessage[] = [];
    for (let i = startIdx; i <= endIdx; i++) {
      try {
        tombstones.push(state.tombstone(messages[i].uuid, 'snip_removed'));
      } catch {
        // Already tombstoned — skip
      }
    }

    TombstoneSystem.recordStats(tombstones.length, 'snip_removed');
    return tombstones;
  }

  /**
   * Tombstone a single message by UUID.
   */
  static tombstoneOne(
    state: MessageState,
    uuid: string,
    reason: TombstoneReason,
  ): TombstoneMessage | null {
    try {
      const tombstone = state.tombstone(uuid, reason);
      TombstoneSystem.recordStats(1, reason);
      return tombstone;
    } catch {
      return null;
    }
  }

  // ─── Statistics ──────────────────────────────────────────────────

  static getStats(): TombstoneStats {
    return { ...TombstoneSystem.stats };
  }

  static resetStats(): void {
    TombstoneSystem.stats = { totalTombstones: 0, byReason: {} };
  }

  private static recordStats(count: number, reason: string): void {
    TombstoneSystem.stats.totalTombstones += count;
    TombstoneSystem.stats.byReason[reason] = (TombstoneSystem.stats.byReason[reason] ?? 0) + count;
  }
}
