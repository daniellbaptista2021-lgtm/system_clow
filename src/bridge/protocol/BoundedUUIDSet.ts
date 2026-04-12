/**
 * BoundedUUIDSet — Dedup inbound/echo messages.
 *
 * A bounded set that evicts the oldest entries (FIFO) when the
 * capacity is exceeded. Used to deduplicate inbound messages by UUID.
 */

export class BoundedUUIDSet {
  private readonly maxSize: number;
  private readonly set: Set<string> = new Set();
  private readonly order: string[] = [];

  constructor(maxSize: number = 10_000) {
    this.maxSize = maxSize;
  }

  /** Check if a UUID is in the set. */
  has(uuid: string): boolean {
    return this.set.has(uuid);
  }

  /** Add a UUID, evicting the oldest if at capacity. */
  add(uuid: string): void {
    if (this.set.has(uuid)) return;
    this.set.add(uuid);
    this.order.push(uuid);

    while (this.order.length > this.maxSize) {
      const oldest = this.order.shift();
      if (oldest !== undefined) {
        this.set.delete(oldest);
      }
    }
  }

  /** Current size of the set. */
  size(): number {
    return this.set.size;
  }

  /** Clear all entries. */
  clear(): void {
    this.set.clear();
    this.order.length = 0;
  }
}
