/**
 * TombstoneResolver.ts — Resolve tombstone entries in JSONL transcripts
 *
 * Based on Claude Code's tombstoneResolver.ts (~200 lines)
 *
 * When compaction removes messages, it writes tombstone entries that reference
 * the UUIDs of removed messages. When loading a transcript, the resolver
 * filters out both the original messages AND their tombstones to produce
 * a clean view.
 *
 * Features:
 *   - Build tombstone set from entries
 *   - Filter entries to remove tombstoned messages
 *   - Remove tombstone entries themselves from output
 *   - Track tombstone chains (tombstone of a tombstone)
 *   - Statistics (how many resolved, bytes saved)
 *   - Compact boundary awareness
 *   - Validation (orphan tombstone detection)
 */

import type { JSONLEntry, MessageEntry, TombstoneEntry } from './types.js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface ResolveResult {
  activeMessages: unknown[];
  tombstonedUuids: Set<string>;
  tombstoneCount: number;
  resolveTimeMs: number;
  chainDepth: number;
}

interface ValidationResult {
  valid: boolean;
  orphans: string[];
  duplicateTombstones: string[];
  totalTombstones: number;
}

// ════════════════════════════════════════════════════════════════════════════
// TombstoneResolver Class
// ════════════════════════════════════════════════════════════════════════════

export class TombstoneResolver {
  /**
   * Resolve tombstones: filter out tombstoned entries from the message list.
   * Returns active messages (not tombstoned) and statistics.
   */
  static resolve(entries: JSONLEntry[]): ResolveResult {
    const startTime = Date.now();
    const tombstoned = new Set<string>();
    const messages: unknown[] = [];

    // Pass 1: Collect all tombstoned UUIDs
    for (const entry of entries) {
      if (entry.type === 'tombstone') {
        const data = entry.data as TombstoneEntry;
        if (data?.removedUuid) {
          tombstoned.add(data.removedUuid);
        }
      }
    }

    // Pass 2: Resolve tombstone chains (tombstone of a tombstone)
    let changed = true;
    let chainDepth = 0;
    while (changed && chainDepth < 10) {
      changed = false;
      chainDepth++;
      for (const entry of entries) {
        if (entry.type === 'tombstone' && tombstoned.has(entry.uuid)) {
          const data = entry.data as TombstoneEntry;
          if (data?.removedUuid && !tombstoned.has(data.removedUuid)) {
            tombstoned.add(data.removedUuid);
            changed = true;
          }
        }
      }
    }

    // Pass 3: Collect active messages
    for (const entry of entries) {
      if (entry.type === 'message') {
        const data = entry.data as MessageEntry;
        if (data?.message) {
          const msg = data.message as { uuid?: string };
          if (!msg.uuid || !tombstoned.has(msg.uuid)) {
            messages.push(data.message);
          }
        }
      }
    }

    return {
      activeMessages: messages,
      tombstonedUuids: tombstoned,
      tombstoneCount: tombstoned.size,
      resolveTimeMs: Date.now() - startTime,
      chainDepth,
    };
  }

  /**
   * Resolve with full entry filtering (not just messages).
   * Returns all non-tombstoned, non-tombstone entries.
   */
  static resolveEntries(entries: JSONLEntry[]): JSONLEntry[] {
    const tombstoned = new Set<string>();

    // Collect tombstoned UUIDs
    for (const entry of entries) {
      if (entry.type === 'tombstone') {
        const data = entry.data as TombstoneEntry;
        if (data?.removedUuid) tombstoned.add(data.removedUuid);
      }
    }

    if (tombstoned.size === 0) return entries;

    // Filter out tombstoned entries and tombstone entries themselves
    return entries.filter(entry => {
      if (entry.type === 'tombstone') return false;
      if (tombstoned.has(entry.uuid)) return false;
      return true;
    });
  }

  /**
   * Validate tombstone consistency.
   * Checks for orphan tombstones (referring to non-existent messages)
   * and duplicate tombstones.
   */
  static validate(entries: JSONLEntry[]): ValidationResult {
    const messageUuids = new Set<string>();
    const tombstoneTargets = new Map<string, number>();
    const orphans: string[] = [];
    const duplicates: string[] = [];

    // Collect message UUIDs
    for (const entry of entries) {
      if (entry.type === 'message') {
        const data = entry.data as MessageEntry;
        const msg = data?.message as { uuid?: string };
        if (msg?.uuid) messageUuids.add(msg.uuid);
      }
    }

    // Check tombstones
    for (const entry of entries) {
      if (entry.type !== 'tombstone') continue;
      const data = entry.data as TombstoneEntry;
      if (!data?.removedUuid) continue;

      const target = data.removedUuid;

      // Check for orphan
      if (!messageUuids.has(target)) {
        orphans.push(target);
      }

      // Check for duplicate
      const count = (tombstoneTargets.get(target) ?? 0) + 1;
      tombstoneTargets.set(target, count);
      if (count > 1 && !duplicates.includes(target)) {
        duplicates.push(target);
      }
    }

    return {
      valid: orphans.length === 0 && duplicates.length === 0,
      orphans,
      duplicateTombstones: duplicates,
      totalTombstones: tombstoneTargets.size,
    };
  }

  /**
   * Create tombstone entries for a list of message UUIDs.
   * Used by compaction to generate tombstones.
   */
  static createTombstones(
    messageUuids: string[],
    reason: string,
    compactBoundaryUuid?: string,
  ): JSONLEntry[] {
    const now = Date.now();
    return messageUuids.map((removedUuid, i) => ({
      v: 3,
      uuid: `tombstone_${now}_${i}_${Math.random().toString(36).slice(2, 8)}`,
      type: 'tombstone' as const,
      ts: now,
      data: {
        removedUuid,
        reason,
        compactBoundaryUuid,
      } satisfies TombstoneEntry,
    }));
  }

  /**
   * Count how many entries would be removed by tombstone resolution.
   */
  static countRemovable(entries: JSONLEntry[]): number {
    const tombstoned = new Set<string>();
    for (const entry of entries) {
      if (entry.type === 'tombstone') {
        const data = entry.data as TombstoneEntry;
        if (data?.removedUuid) tombstoned.add(data.removedUuid);
      }
    }
    return tombstoned.size;
  }
}
