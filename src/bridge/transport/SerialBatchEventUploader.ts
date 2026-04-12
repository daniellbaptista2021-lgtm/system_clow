/**
 * Serial Batch Event Uploader
 *
 * Accumulates {@link CCREvent} objects and flushes them in batches via
 * HTTP POST to the configured endpoint.  Key properties:
 *
 *  - Batches are capped at {@link CCR_BATCH_SIZE} events.
 *  - A flush is scheduled every {@link CCR_FLUSH_INTERVAL_MS} ms.
 *  - Only one flush runs at a time (serial execution).
 *  - Failed batches (5xx / 429) are re-queued for the next flush.
 *  - Statistics are tracked for diagnostics.
 */

import type { CCREvent } from '../types.js';
import { CCR_BATCH_SIZE, CCR_FLUSH_INTERVAL_MS } from '../types.js';

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

export interface UploaderStats {
  totalEnqueued: number;
  totalFlushed: number;
  totalRetries: number;
  totalDropped: number;
  lastFlushAt: number | null;
  lastErrorAt: number | null;
}

// ---------------------------------------------------------------------------
// SerialBatchEventUploader
// ---------------------------------------------------------------------------

export class SerialBatchEventUploader {
  private queue: CCREvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;
  private epoch: number;

  private readonly stats: UploaderStats = {
    totalEnqueued: 0,
    totalFlushed: 0,
    totalRetries: 0,
    totalDropped: 0,
    lastFlushAt: null,
    lastErrorAt: null,
  };

  private readonly maxRetries = 3;

  constructor(
    private readonly endpointUrl: string,
    private readonly headers: Record<string, string>,
    initialEpoch: number,
  ) {
    this.epoch = initialEpoch;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /** Add an event to the queue; triggers a scheduled flush if needed. */
  enqueue(event: CCREvent): void {
    this.queue.push(event);
    this.stats.totalEnqueued++;

    // Flush immediately if we hit the batch size cap.
    if (this.queue.length >= CCR_BATCH_SIZE) {
      void this.flush();
    } else {
      this.scheduleFlush();
    }
  }

  /** Force a flush of whatever is currently queued. */
  async flush(): Promise<void> {
    // Cancel any pending scheduled flush.
    this.cancelScheduledFlush();

    // Serial guard: if another flush is running, let it finish first.
    if (this.flushing) {
      return;
    }

    this.flushing = true;
    try {
      await this.doFlush();
    } finally {
      this.flushing = false;
    }
  }

  /** Update the epoch value attached to every batch. */
  setEpoch(epoch: number): void {
    this.epoch = epoch;
  }

  /** Return a snapshot of diagnostic statistics. */
  getStats(): Readonly<UploaderStats> {
    return { ...this.stats };
  }

  /** Number of events currently waiting in the queue. */
  get pending(): number {
    return this.queue.length;
  }

  // -----------------------------------------------------------------------
  // Scheduled flush
  // -----------------------------------------------------------------------

  private scheduleFlush(): void {
    if (this.flushTimer !== null) return; // Already scheduled.
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, CCR_FLUSH_INTERVAL_MS);
  }

  private cancelScheduledFlush(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  // -----------------------------------------------------------------------
  // Core flush logic
  // -----------------------------------------------------------------------

  private async doFlush(): Promise<void> {
    while (this.queue.length > 0) {
      // Take up to CCR_BATCH_SIZE events.
      const batch = this.queue.splice(0, CCR_BATCH_SIZE);
      const success = await this.sendBatch(batch);

      if (!success) {
        // Re-queue at the front so ordering is preserved.
        this.queue.unshift(...batch);
        // Don't keep retrying endlessly in this flush cycle.
        break;
      }

      this.stats.totalFlushed += batch.length;
      this.stats.lastFlushAt = Date.now();
    }
  }

  private async sendBatch(batch: CCREvent[]): Promise<boolean> {
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        this.stats.totalRetries++;
        // Simple back-off: 500ms, 1s, 2s.
        await this.sleep(500 * Math.pow(2, attempt - 1));
      }

      try {
        const res = await fetch(this.endpointUrl, {
          method: 'POST',
          headers: this.headers,
          body: JSON.stringify({
            epoch: this.epoch,
            events: batch,
          }),
        });

        if (res.ok) {
          return true;
        }

        // 429 or 5xx: retryable.
        if (res.status === 429 || res.status >= 500) {
          continue;
        }

        // 4xx (not 429): not retryable; drop the batch.
        // eslint-disable-next-line no-console
        console.error(
          `[SerialBatchEventUploader] Non-retryable error ${res.status}; dropping ${batch.length} events`,
        );
        this.stats.totalDropped += batch.length;
        this.stats.lastErrorAt = Date.now();
        return true; // "true" so we don't re-queue.
      } catch {
        // Network error: retryable.
        continue;
      }
    }

    // Exhausted retries — signal failure so the batch gets re-queued.
    this.stats.lastErrorAt = Date.now();
    return false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
