/**
 * SendMessageTool.ts — Send messages between team members
 *
 * Supports:
 *   - Direct messages (DM to specific agent)
 *   - Broadcasts (to all team members)
 *   - Shutdown requests
 *   - Permission responses
 *   - Plan approval responses
 *   - Optional waitForReply (blocks until response)
 */

import type { MailboxMessageType, MailboxMessage } from '../types.js';
import type { TeammateMailbox } from '../mailbox/TeammateMailbox.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SendMessageInput {
  /** Recipient agent ID or '*' for broadcast */
  to: string;
  /** Message type */
  messageType?: MailboxMessageType;
  /** Message content (string for DM, object for structured) */
  content: string | Record<string, unknown>;
  /** Whether to wait for a reply */
  waitForReply?: boolean;
  /** Timeout for waiting (ms) */
  replyTimeoutMs?: number;
  /** If responding to a specific message */
  replyToId?: string;
}

export interface SendMessageOutput {
  messageId: string;
  delivered: boolean;
  reply?: unknown;
  error?: string;
}

// ════════════════════════════════════════════════════════════════════════════
// SendMessageTool Implementation
// ════════════════════════════════════════════════════════════════════════════

export class SendMessageTool {
  static readonly name = 'SendMessage';
  static readonly description = 'Send a message to a teammate, broadcast to all, or request shutdown.';

  static async execute(
    input: SendMessageInput,
    context: {
      agentId: string;
      mailbox: TeammateMailbox;
    },
  ): Promise<SendMessageOutput> {
    const mailbox = context.mailbox;
    const fromId = context.agentId;

    const messageType = (input.messageType ?? 'direct_message') as MailboxMessageType;

    // Build content
    const content = typeof input.content === 'string'
      ? { text: input.content }
      : input.content;

    try {
      // Send message
      const messageId = await mailbox.send({
        from: fromId,
        to: input.to,
        type: messageType,
        content,
        replyToId: input.replyToId,
      } as any);

      // Wait for reply if requested
      if (input.waitForReply) {
        const timeout = input.replyTimeoutMs ?? 60_000;
        const reply = await mailbox.waitForReply(fromId, messageId, timeout);

        return {
          messageId,
          delivered: true,
          reply: reply?.content ?? null,
        };
      }

      return { messageId, delivered: true };
    } catch (err) {
      return {
        messageId: '',
        delivered: false,
        error: (err as Error).message,
      };
    }
  }

  static renderToolUseMessage(input: SendMessageInput): string {
    if (input.to === '*') return '📢 Broadcasting to team';
    const type = input.messageType ?? 'direct_message';
    return `💬 Sending ${type} to ${input.to}`;
  }
}
