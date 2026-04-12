/**
 * CapacityWake — AbortController-based wake signal.
 *
 * Allows the poll loop to sleep until capacity becomes available,
 * then be woken by a signal from the session manager.
 */

export class CapacityWake {
  private waiters: Array<() => void> = [];

  /**
   * Wait until wake() is called. Returns a Promise that resolves
   * when the wake signal is received.
   */
  wait(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  /**
   * Wake all current waiters immediately.
   */
  wake(): void {
    const current = this.waiters;
    this.waiters = [];
    for (const resolve of current) {
      resolve();
    }
  }

  /**
   * Clear all pending waiters without resolving them.
   */
  reset(): void {
    this.waiters = [];
  }

  /** Number of waiters currently blocked. */
  get pendingCount(): number {
    return this.waiters.length;
  }
}
