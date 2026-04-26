/**
 * taskNotificationParser.ts — Parse/build XML task notifications
 *
 * When a worker completes, the coordinator receives a <task-notification>
 * XML block as a user-role message. This module builds and parses those.
 *
 * Format:
 *   <task-notification>
 *     <task-id>worker_abc123</task-id>
 *     <status>completed</status>
 *     <worker-type>researcher</worker-type>
 *     <summary>Worker completed successfully</summary>
 *     <result>Full output text...</result>
 *     <usage>
 *       <total_tokens>1234</total_tokens>
 *       <tool_uses>5</tool_uses>
 *       <duration_ms>3456</duration_ms>
 *       <cost_usd>0.001234</cost_usd>
 *     </usage>
 *   </task-notification>
 */

import type { WorkerSpawnResult, TaskNotification, CoordinatorWorkerType } from './types.js';

// ════════════════════════════════════════════════════════════════════════════
// TaskNotificationParser Class
// ════════════════════════════════════════════════════════════════════════════

export class TaskNotificationParser {
  /**
   * Build an XML notification from a worker result.
   * This becomes a user-role message in the coordinator's conversation.
   */
  static buildNotification(result: WorkerSpawnResult): string {
    const xml = [
      '<task-notification>',
      `  <task-id>${TaskNotificationParser.escape(result.workerId)}</task-id>`,
      `  <status>${result.status}</status>`,
      `  <worker-type>${TaskNotificationParser.escape(result.workerType ?? 'general')}</worker-type>`,
      `  <summary>${TaskNotificationParser.escape(TaskNotificationParser.summarize(result))}</summary>`,
      `  <result>${TaskNotificationParser.escape(result.result ?? '(no output)')}</result>`,
      `  <usage>`,
      `    <total_tokens>${result.tokensUsed ?? 0}</total_tokens>`,
      `    <tool_uses>${result.toolUseCount ?? 0}</tool_uses>`,
      `    <duration_ms>${result.durationMs ?? 0}</duration_ms>`,
      `    <cost_usd>${(result.costUsd ?? 0).toFixed(6)}</cost_usd>`,
      `  </usage>`,
      '</task-notification>',
    ];

    return xml.join('\n');
  }

  /**
   * Parse a task notification from XML content.
   * Returns null if the content doesn't contain a valid notification.
   */
  static parseNotification(content: string): TaskNotification | null {
    if (!content.includes('<task-notification>')) return null;

    const taskId = TaskNotificationParser.extractTag(content, 'task-id');
    const status = TaskNotificationParser.extractTag(content, 'status');
    const summary = TaskNotificationParser.extractTag(content, 'summary');
    const result = TaskNotificationParser.extractTag(content, 'result');
    const totalTokens = parseInt(TaskNotificationParser.extractTag(content, 'total_tokens') ?? '0', 10);
    const toolUses = parseInt(TaskNotificationParser.extractTag(content, 'tool_uses') ?? '0', 10);
    const durationMs = parseInt(TaskNotificationParser.extractTag(content, 'duration_ms') ?? '0', 10);
    const workerType = (TaskNotificationParser.extractTag(content, 'worker-type') ?? 'general') as CoordinatorWorkerType;

    if (!taskId || !status) return null;

    return {
      taskId,
      status: status as TaskNotification['status'],
      summary: summary ?? '',
      result: result ?? '',
      usage: { totalTokens, toolUses, durationMs },
      workerType,
    };
  }

  /**
   * Detect and parse all task notifications in a message body.
   * A single message can contain multiple notifications (parallel workers).
   */
  static findAllInMessage(content: string): TaskNotification[] {
    const notifications: TaskNotification[] = [];
    const regex = /<task-notification>[\s\S]*?<\/task-notification>/g;

    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      const parsed = TaskNotificationParser.parseNotification(match[0]);
      if (parsed) notifications.push(parsed);
    }

    return notifications;
  }

  /**
   * Check if a message contains any task notifications.
   */
  static hasNotification(content: string): boolean {
    return content.includes('<task-notification>');
  }

  /**
   * Build a summary notification for multiple workers completing at once.
   */
  static buildBatchSummary(results: WorkerSpawnResult[]): string {
    const completed = results.filter(r => r.status === 'completed').length;
    const failed = results.filter(r => r.status === 'failed').length;
    const totalCost = results.reduce((s, r) => s + (r.costUsd ?? 0), 0);
    const totalTokens = results.reduce((s, r) => s + (r.tokensUsed ?? 0), 0);

    const lines: string[] = [];
    lines.push(`<batch-notification>`);
    lines.push(`  <worker-count>${results.length}</worker-count>`);
    lines.push(`  <completed>${completed}</completed>`);
    lines.push(`  <failed>${failed}</failed>`);
    lines.push(`  <total-cost-usd>${totalCost.toFixed(6)}</total-cost-usd>`);
    lines.push(`  <total-tokens>${totalTokens}</total-tokens>`);
    lines.push(`</batch-notification>`);

    // Also include individual notifications
    for (const result of results) {
      lines.push('');
      lines.push(TaskNotificationParser.buildNotification(result));
    }

    return lines.join('\n');
  }

  // ─── Internal Helpers ────────────────────────────────────────────

  private static summarize(result: WorkerSpawnResult): string {
    const type = result.workerType ?? 'worker';
    if (result.status === 'completed') {
      return `${type} ${result.workerId} completed (${result.durationMs ?? 0}ms, ${result.toolUseCount ?? 0} tool calls)`;
    }
    if (result.status === 'failed') {
      return `${type} ${result.workerId} failed: ${(result.result ?? 'unknown error').slice(0, 200)}`;
    }
    if (result.status === 'killed') {
      return `${type} ${result.workerId} was killed`;
    }
    return `${type} ${result.workerId} status: ${result.status}`;
  }

  private static extractTag(content: string, tag: string): string | undefined {
    const regex = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`);
    const match = content.match(regex);
    return match?.[1]?.trim();
  }

  private static escape(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
}
