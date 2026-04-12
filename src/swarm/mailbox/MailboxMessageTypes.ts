/**
 * MailboxMessageTypes.ts — Helper functions for creating typed mailbox messages
 *
 * Factory functions that produce correctly-typed MailboxMessage objects
 * with appropriate content payloads.
 */

import * as crypto from 'crypto';

import type {
  MailboxMessage,
  MailboxMessageType,
  DirectMessageContent,
  IdleNotificationContent,
  PermissionRequestContent,
  PermissionResponseContent,
  ShutdownRequestContent,
  TaskAssignmentContent,
  TaskResultContent,
  StatusUpdateContent,
} from '../types.js';

// ════════════════════════════════════════════════════════════════════════════
// ID Generation
// ════════════════════════════════════════════════════════════════════════════

function generateId(): string {
  return `msg-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

function baseMessage(
  from: string,
  to: string,
  type: MailboxMessageType,
  content: unknown,
  replyToId?: string
): MailboxMessage {
  return {
    id: generateId(),
    from,
    to,
    type,
    content,
    timestamp: Date.now(),
    replyToId,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Direct Message
// ════════════════════════════════════════════════════════════════════════════

/**
 * Create a direct text message between two agents.
 */
export function createDirectMessage(
  from: string,
  to: string,
  text: string
): MailboxMessage {
  const content: DirectMessageContent = { text };
  return baseMessage(from, to, 'direct_message', content);
}

// ════════════════════════════════════════════════════════════════════════════
// Broadcast
// ════════════════════════════════════════════════════════════════════════════

/**
 * Create a broadcast message (to='*') from an agent.
 */
export function createBroadcast(
  from: string,
  text: string
): MailboxMessage {
  const content: DirectMessageContent = { text };
  return baseMessage(from, '*', 'broadcast', content);
}

// ════════════════════════════════════════════════════════════════════════════
// Idle Notification
// ════════════════════════════════════════════════════════════════════════════

/**
 * Create an idle notification from a member to another (typically the leader).
 */
export function createIdleNotification(
  from: string,
  to: string,
  reason: IdleNotificationContent['reason'],
  summary?: string
): MailboxMessage {
  const content: IdleNotificationContent = { reason, summary };
  return baseMessage(from, to, 'idle_notification', content);
}

// ════════════════════════════════════════════════════════════════════════════
// Permission Request / Response
// ════════════════════════════════════════════════════════════════════════════

/**
 * Create a permission request from a member to the leader.
 */
export function createPermissionRequest(
  from: string,
  to: string,
  toolName: string,
  toolInput: unknown
): MailboxMessage {
  const content: PermissionRequestContent = {
    toolName,
    toolInput,
    requestedAt: Date.now(),
  };
  return baseMessage(from, to, 'permission_request', content);
}

/**
 * Create a permission response from the leader to a member.
 */
export function createPermissionResponse(
  from: string,
  to: string,
  granted: boolean,
  replyToId: string,
  reason?: string
): MailboxMessage {
  const content: PermissionResponseContent = { granted, reason };
  return baseMessage(from, to, 'permission_response', content, replyToId);
}

// ════════════════════════════════════════════════════════════════════════════
// Shutdown
// ════════════════════════════════════════════════════════════════════════════

/**
 * Create a shutdown request from the leader to a member.
 */
export function createShutdownRequest(
  from: string,
  to: string,
  reason: string,
  graceful: boolean
): MailboxMessage {
  const content: ShutdownRequestContent = { reason, graceful };
  return baseMessage(from, to, 'shutdown_request', content);
}

// ════════════════════════════════════════════════════════════════════════════
// Task Assignment / Result
// ════════════════════════════════════════════════════════════════════════════

/**
 * Create a task assignment from the leader to a member.
 */
export function createTaskAssignment(
  from: string,
  to: string,
  taskId: string,
  description: string,
  prompt: string
): MailboxMessage {
  const content: TaskAssignmentContent = { taskId, description, prompt };
  return baseMessage(from, to, 'task_assignment', content);
}

/**
 * Create a task result from a member back to the leader.
 */
export function createTaskResult(
  from: string,
  to: string,
  taskId: string,
  success: boolean,
  result: string
): MailboxMessage {
  const content: TaskResultContent = { taskId, success, result };
  return baseMessage(from, to, 'task_result', content);
}

// ════════════════════════════════════════════════════════════════════════════
// Status Update
// ════════════════════════════════════════════════════════════════════════════

/**
 * Create a status update message from a member.
 */
export function createStatusUpdate(
  from: string,
  to: string,
  phase: string,
  progress?: number,
  message?: string
): MailboxMessage {
  const content: StatusUpdateContent = { phase, progress, message };
  return baseMessage(from, to, 'status_update', content);
}
