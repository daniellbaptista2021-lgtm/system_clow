/**
 * PermissionDelegation.ts — Worker→Leader permission delegation
 *
 * When a worker needs permission to use a tool, it sends a
 * permission_request to the leader's mailbox. The leader reviews
 * and responds with permission_response. The worker blocks until
 * the response arrives or times out.
 *
 * This is the ONLY safe way for workers to get permissions —
 * workers never prompt users directly.
 */

import type { MailboxMessage, PermissionRequestContent, PermissionResponseContent } from '../types.js';
import type { TeammateMailbox } from '../mailbox/TeammateMailbox.js';
import { DelegationTracker } from './DelegationTracker.js';
import { PERMISSION_TIMEOUT_MS } from '../constants.js';

// ════════════════════════════════════════════════════════════════════════════
// PermissionDelegation Class
// ════════════════════════════════════════════════════════════════════════════

export class PermissionDelegation {
  constructor(
    private readonly mailbox: TeammateMailbox,
    private readonly tracker: DelegationTracker,
  ) {}

  /**
   * Worker calls this when needing permission for a tool.
   * Sends request to leader and blocks until response or timeout.
   */
  async requestFromLeader(params: {
    workerAgentId: string;
    leaderAgentId: string;
    toolName: string;
    toolInput: unknown;
    timeoutMs?: number;
  }): Promise<PermissionResponseContent> {
    const timeout = params.timeoutMs ?? PERMISSION_TIMEOUT_MS;

    // Send permission request to leader's inbox
    const requestId = await this.mailbox.send({
      from: params.workerAgentId,
      to: params.leaderAgentId,
      type: 'permission_request',
      content: {
        toolName: params.toolName,
        toolInput: params.toolInput,
        requestedAt: Date.now(),
      } satisfies PermissionRequestContent,
    } as any);

    // Track the pending request
    this.tracker.track(requestId, params.workerAgentId, params.toolName);

    // Wait for leader's response
    const reply = await this.mailbox.waitForReply(
      params.workerAgentId,
      requestId,
      timeout,
    );

    // Untrack regardless of outcome
    this.tracker.untrack(requestId);

    // Timeout
    if (!reply) {
      return {
        granted: false,
        reason: `Leader did not respond within ${timeout}ms timeout`,
      };
    }

    return reply.content as PermissionResponseContent;
  }

  /**
   * Leader calls this to respond to a worker's permission request.
   */
  async respondToWorker(params: {
    leaderAgentId: string;
    workerAgentId: string;
    requestId: string;
    granted: boolean;
    reason?: string;
    updatedInput?: unknown;
  }): Promise<void> {
    await this.mailbox.send({
      from: params.leaderAgentId,
      to: params.workerAgentId,
      type: 'permission_response',
      content: {
        granted: params.granted,
        reason: params.reason,
        updatedInput: params.updatedInput,
      } satisfies PermissionResponseContent,
      replyToId: params.requestId,
    } as any);
  }

  /**
   * Get all pending permission requests for a leader.
   */
  getPendingRequests(leaderAgentId: string): import('../types.js').PendingDelegation[] {
    return this.tracker.getAllForLeader(leaderAgentId);
  }

  /**
   * Check if there are any pending requests.
   */
  hasPendingRequests(): boolean {
    return this.tracker.hasPending();
  }

  /**
   * Clean up expired requests.
   */
  cleanupExpired(): number {
    return this.tracker.cleanupExpired();
  }

  /**
   * Get the delegation tracker.
   */
  getTracker(): DelegationTracker {
    return this.tracker;
  }
}
