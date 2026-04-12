/**
 * DelegationTracker.ts — Track pending permission delegation requests
 *
 * When a worker requests permission from the leader, the request is
 * tracked here until the leader responds or it times out.
 */

import type { PendingDelegation } from '../types.js';
import { PERMISSION_TIMEOUT_MS } from '../constants.js';

// ═══════════════���═════════════════════════���══════════════════════════════════
// DelegationTracker Class
// ═══���════════════════════════════════════════════════════════════════════════

export class DelegationTracker {
  private pending = new Map<string, PendingDelegation>();

  /**
   * Track a new permission request.
   */
  track(requestId: string, workerAgentId: string, toolName: string): void {
    this.pending.set(requestId, {
      requestId,
      workerAgentId,
      toolName,
      requestedAt: Date.now(),
    });
  }

  /**
   * Remove tracking for a completed/timed-out request.
   */
  untrack(requestId: string): void {
    this.pending.delete(requestId);
  }

  /**
   * Get a specific pending request.
   */
  get(requestId: string): PendingDelegation | undefined {
    return this.pending.get(requestId);
  }

  /**
   * Get all pending requests for a specific leader.
   */
  getAllForLeader(_leaderAgentId: string): PendingDelegation[] {
    return [...this.pending.values()];
  }

  /**
   * Get all pending requests for a specific worker.
   */
  getAllForWorker(workerAgentId: string): PendingDelegation[] {
    return [...this.pending.values()].filter(d => d.workerAgentId === workerAgentId);
  }

  /**
   * Clean up expired requests.
   */
  cleanupExpired(timeoutMs: number = PERMISSION_TIMEOUT_MS): number {
    const cutoff = Date.now() - timeoutMs;
    let cleaned = 0;

    for (const [id, delegation] of this.pending) {
      if (delegation.requestedAt < cutoff) {
        this.pending.delete(id);
        cleaned++;
      }
    }

    return cleaned;
  }

  /**
   * Get count of pending requests.
   */
  size(): number {
    return this.pending.size;
  }

  /**
   * Check if there are any pending requests.
   */
  hasPending(): boolean {
    return this.pending.size > 0;
  }

  /**
   * Clear all tracked requests.
   */
  clear(): void {
    this.pending.clear();
  }

  /**
   * Get the oldest pending request age in ms.
   */
  getOldestAge(): number {
    let oldest = 0;
    for (const d of this.pending.values()) {
      const age = Date.now() - d.requestedAt;
      if (age > oldest) oldest = age;
    }
    return oldest;
  }
}
