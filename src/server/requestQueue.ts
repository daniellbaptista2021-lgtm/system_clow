/**
 * requestQueue.ts — Concurrency-controlled request queue for Anthropic API
 *
 * Limits parallel API calls to prevent rate limiting and reduce costs.
 * FIFO queue with configurable max concurrency (default: 3).
 * Tracks queue depth and wait times for observability.
 */

import { createLogger } from '../utils/logger.js';

const log = createLogger('RequestQueue');

// ════════════════════════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════════════════════════

interface QueuedRequest<T> {
  execute: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  enqueuedAt: number;
  sessionId?: string;
}

export interface QueueStats {
  maxConcurrency: number;
  activeRequests: number;
  queueDepth: number;
  totalProcessed: number;
  totalWaitMs: number;
  avgWaitMs: number;
  peakQueueDepth: number;
}

// ════════════════════════════════════════════════════════════════════════════
// RequestQueue Class
// ════════════════════════════════════════════════════════════════════════════

export class RequestQueue {
  private queue: QueuedRequest<any>[] = [];
  private activeCount = 0;
  private totalProcessed = 0;
  private totalWaitMs = 0;
  private peakQueueDepth = 0;

  constructor(private readonly maxConcurrency: number = 3) {}

  /**
   * Enqueue a request. Resolves when the request completes.
   * If under concurrency limit, executes immediately.
   * Otherwise, waits in FIFO queue.
   */
  async enqueue<T>(execute: () => Promise<T>, sessionId?: string): Promise<T> {
    if (this.activeCount < this.maxConcurrency) {
      return this.executeNow(execute, sessionId);
    }

    // Queue it
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ execute, resolve, reject, enqueuedAt: Date.now(), sessionId });
      const depth = this.queue.length;
      if (depth > this.peakQueueDepth) this.peakQueueDepth = depth;
      log.info('Request queued', { sessionId, queueDepth: depth, activeRequests: this.activeCount });
    });
  }

  /**
   * Get queue statistics.
   */
  getStats(): QueueStats {
    return {
      maxConcurrency: this.maxConcurrency,
      activeRequests: this.activeCount,
      queueDepth: this.queue.length,
      totalProcessed: this.totalProcessed,
      totalWaitMs: this.totalWaitMs,
      avgWaitMs: this.totalProcessed > 0 ? Math.round(this.totalWaitMs / this.totalProcessed) : 0,
      peakQueueDepth: this.peakQueueDepth,
    };
  }

  // ─── Internal ──────────────────────────────────────────────────

  private async executeNow<T>(execute: () => Promise<T>, sessionId?: string): Promise<T> {
    this.activeCount++;
    const timer = log.startTimer('api_request');
    try {
      const result = await execute();
      this.totalProcessed++;
      timer.end({ sessionId, activeRequests: this.activeCount - 1, queueDepth: this.queue.length });
      return result;
    } catch (err) {
      log.error('Request failed', { sessionId, error: (err as Error).message });
      throw err;
    } finally {
      this.activeCount--;
      this.processNext();
    }
  }

  private processNext(): void {
    if (this.queue.length === 0 || this.activeCount >= this.maxConcurrency) return;

    const next = this.queue.shift()!;
    const waitMs = Date.now() - next.enqueuedAt;
    this.totalWaitMs += waitMs;

    if (waitMs > 1000) {
      log.warn('Request waited in queue', { sessionId: next.sessionId, waitMs });
    }

    this.executeNow(next.execute, next.sessionId)
      .then(next.resolve)
      .catch(next.reject);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Singleton
// ════════════════════════════════════════════════════════════════════════════

const MAX_CONCURRENT = parseInt(process.env.CLOW_MAX_CONCURRENT_REQUESTS || '3', 10);
export const apiQueue = new RequestQueue(MAX_CONCURRENT);
