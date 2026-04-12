/**
 * PlanApproval.ts — Plan approval flow for teammates
 *
 * When a teammate has planModeRequired=true, it must send its plan
 * to the leader for approval before executing. The leader reviews
 * and approves/rejects via mailbox.
 */

import type { PlanApprovalRequestContent, PlanApprovalResponseContent } from '../types.js';
import type { TeammateMailbox } from '../mailbox/TeammateMailbox.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const PLAN_APPROVAL_TIMEOUT_MS = 5 * 60_000; // 5 minutes

// ════════════════════════════════════════════════════════════════════════════
// PlanApproval Class
// ════════════════════════════════════════════════════════════════════════════

export class PlanApproval {
  constructor(private readonly mailbox: TeammateMailbox) {}

  /**
   * Teammate sends plan to leader for approval.
   * Blocks until leader responds or timeout.
   */
  async requestApproval(params: {
    workerAgentId: string;
    leaderAgentId: string;
    plan: string;
    estimatedActions: number;
    timeoutMs?: number;
  }): Promise<{ approved: boolean; feedback?: string }> {
    const timeout = params.timeoutMs ?? PLAN_APPROVAL_TIMEOUT_MS;

    const requestId = await this.mailbox.send({
      from: params.workerAgentId,
      to: params.leaderAgentId,
      type: 'plan_approval_request',
      content: {
        plan: params.plan,
        estimatedActions: params.estimatedActions,
      } satisfies PlanApprovalRequestContent,
    } as any);

    const reply = await this.mailbox.waitForReply(
      params.workerAgentId,
      requestId,
      timeout,
    );

    if (!reply) {
      return { approved: false, feedback: 'Leader did not respond to plan approval request' };
    }

    const response = reply.content as PlanApprovalResponseContent;
    return {
      approved: response.approved,
      feedback: response.feedback,
    };
  }

  /**
   * Leader approves or rejects a teammate's plan.
   */
  async respond(params: {
    leaderAgentId: string;
    workerAgentId: string;
    requestId: string;
    approved: boolean;
    feedback?: string;
  }): Promise<void> {
    await this.mailbox.send({
      from: params.leaderAgentId,
      to: params.workerAgentId,
      type: 'plan_approval_response',
      content: {
        approved: params.approved,
        feedback: params.feedback,
      } satisfies PlanApprovalResponseContent,
      replyToId: params.requestId,
    } as any);
  }
}
