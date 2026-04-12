/**
 * TeammateIdleTool.ts — Notify leader that teammate is idle
 *
 * Teammates call this when they finish their assigned work,
 * encounter a blocker, or need more instructions.
 */

import type { IdleNotificationContent } from '../types.js';
import type { TeammateMailbox } from '../mailbox/TeammateMailbox.js';

export interface TeammateIdleInput {
  reason: 'done' | 'blocked' | 'failed' | 'waiting';
  summary?: string;
  cost?: number;
  turnCount?: number;
}

export interface TeammateIdleOutput {
  notified: boolean;
  messageId: string;
}

export class TeammateIdleTool {
  static readonly name = 'TeammateIdle';
  static readonly description = 'Notify the team leader that you are idle and available for new work.';

  static async execute(
    input: TeammateIdleInput,
    context: {
      agentId: string;
      leaderAgentId: string;
      mailbox: TeammateMailbox;
    },
  ): Promise<TeammateIdleOutput> {
    const content: IdleNotificationContent = {
      reason: input.reason,
      summary: input.summary,
      cost: input.cost,
      turnCount: input.turnCount,
    };

    const messageId = await context.mailbox.send({
      from: context.agentId,
      to: context.leaderAgentId,
      type: 'idle_notification',
      content,
    } as any);

    return { notified: true, messageId };
  }

  static renderToolUseMessage(input: TeammateIdleInput): string {
    const emoji = input.reason === 'done' ? '✅' : input.reason === 'blocked' ? '🚫' : input.reason === 'failed' ? '❌' : '⏳';
    return `${emoji} Teammate idle: ${input.reason}${input.summary ? ` — ${input.summary}` : ''}`;
  }
}
