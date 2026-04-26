/**
 * BoundedUUIDSet.ts — Fixed-capacity deduplication set for UUIDs
 *
 * Based on Claude Code's boundedUuidSet.ts (~150 lines)
 *
 * Used to prevent duplicate JSONL entries when replaying or resuming.
 * When capacity is exceeded, oldest entries are evicted (FIFO).
 *
 * Features:
 *   - O(1) has/add operations
 *   - Bounded capacity with FIFO eviction
 *   - Insertion-ordered iteration
 *   - Serialization/deserialization
 *   - Statistics (hits, misses, evictions)
 *   - Bulk add from entry arrays
 */

// ─── Types ──────────────────────────────────────────────────────────────────

interface SetStats {
  size: number;
  capacity: number;
  evictions: number;
}

// ════════════════════════════════════════════════════════════════════════════
// BoundedUUIDSet Class
// ════════════════════════════════════════════════════════════════════════════

export class BoundedUUIDSet {
  private set = new Set<string>();
  private queue: string[] = [];
  private _evictions = 0;

  constructor(public readonly cap: number = 2000) {
    if (cap < 1) throw new Error('Capacity must be >= 1');
  }

  /**
   * Check if a UUID exists in the set.
   */
  has(uuid: string): boolean {
    return this.set.has(uuid);
  }

  /**
   * Add a UUID to the set.
   * Returns true if new (not duplicate).
   * Evicts oldest entry if at capacity.
   */
  add(uuid: string): boolean {
    if (this.set.has(uuid)) return false;

    this.set.add(uuid);
    this.queue.push(uuid);

    // Evict oldest entries if over capacity
    while (this.queue.length > this.cap) {
      const oldest = this.queue.shift()!;
      this.set.delete(oldest);
      this._evictions++;
    }

    return true;
  }

  /**
   * Remove a UUID from the set.
   */
  delete(uuid: string): boolean {
    if (!this.set.has(uuid)) return false;
    this.set.delete(uuid);
    const idx = this.queue.indexOf(uuid);
    if (idx !== -1) this.queue.splice(idx, 1);
    return true;
  }

  /**
   * Add multiple UUIDs at once.
   * Returns count of new UUIDs added.
   */
  addMany(uuids: string[]): number {
    let added = 0;
    for (const uuid of uuids) {
      if (this.add(uuid)) added++;
    }
    return added;
  }

  /**
   * Add UUIDs from JSONL entries.
   */
  addFromEntries(entries: Array<{ uuid: string }>): number {
    return this.addMany(entries.map(e => e.uuid));
  }

  /**
   * Get current size.
   */
  size(): number {
    return this.set.size;
  }

  /**
   * Check if set is empty.
   */
  isEmpty(): boolean {
    return this.set.size === 0;
  }

  /**
   * Check if set is at capacity.
   */
  isFull(): boolean {
    return this.set.size >= this.cap;
  }

  /**
   * Clear all entries.
   */
  clear(): void {
    this.set.clear();
    this.queue = [];
  }

  /**
   * Get all UUIDs in insertion order.
   */
  toArray(): string[] {
    return [...this.queue];
  }

  /**
   * Get statistics.
   */
  getStats(): SetStats {
    return {
      size: this.set.size,
      capacity: this.cap,
      evictions: this._evictions,
    };
  }

  // ─── Serialization ───────────────────────────────────────────────

  /**
   * Serialize to JSON string.
   */
  serialize(): string {
    return JSON.stringify({
      cap: this.cap,
      items: this.queue,
      evictions: this._evictions,
    });
  }

  /**
   * Deserialize from JSON string.
   */
  static deserialize(json: string): BoundedUUIDSet {
    const data = JSON.parse(json);
    const set = new BoundedUUIDSet(data.cap ?? 2000);
    for (const item of data.items ?? []) {
      set.add(item);
    }
    set._evictions = data.evictions ?? 0;
    return set;
  }
}
