/**
 * MailboxPolling.ts — Interval-based inbox poller
 *
 * Polls an agent's inbox at regular intervals and dispatches
 * messages to type-specific handlers. Provides error isolation
 * so a failing handler doesn't crash the poller.
 */

import type {
  MailboxMessage,
  MailboxMessageType,
} from '../types.js';

import { MAILBOX_POLL_INTERVAL_MS } from '../constants.js';
import type { TeammateMailbox } from './TeammateMailbox.js';

// ════════════════════════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════════════════════════

/**
 * Handler function for a specific message type.
 */
export type MessageHandler = (message: MailboxMessage) => void | Promise<void>;

/**
 * Error handler for when a message handler throws.
 */
export type ErrorHandler = (
  error: unknown,
  message: MailboxMessage
) => void;

export interface MailboxPollerOptions {
  /** The mailbox to poll */
  mailbox: TeammateMailbox;
  /** The agent ID to poll for */
  agentId: string;
  /** Poll interval in ms (defaults to MAILBOX_POLL_INTERVAL_MS) */
  intervalMs?: number;
  /** Called when a handler throws */
  onError?: ErrorHandler;
}

// ════════════════════════════════════════════════════════════════════════════
// MailboxPoller
// ════════════════════════════════════════════════════════════════════════════

export class MailboxPoller {
  private readonly mailbox: TeammateMailbox;
  private readonly agentId: string;
  private readonly intervalMs: number;
  private readonly onError: ErrorHandler;

  private handlers: Map<MailboxMessageType, MessageHandler[]> = new Map();
  private catchAllHandlers: MessageHandler[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private running = false;
  private pollCount = 0;
  private messagesProcessed = 0;
  private errorCount = 0;

  /**
   * Supports two calling conventions:
   *   new MailboxPoller(options)
   *   new MailboxPoller(mailbox, agentId, intervalMs?)
   */
  constructor(optionsOrMailbox: MailboxPollerOptions | TeammateMailbox, agentId?: string, intervalMs?: number) {
    if (agentId !== undefined) {
      // Positional form: (mailbox, agentId, intervalMs?)
      this.mailbox = optionsOrMailbox as TeammateMailbox;
      this.agentId = agentId;
      this.intervalMs = intervalMs ?? MAILBOX_POLL_INTERVAL_MS;
      this.onError = defaultErrorHandler;
    } else {
      // Options object form
      const options = optionsOrMailbox as MailboxPollerOptions;
      this.mailbox = options.mailbox;
      this.agentId = options.agentId;
      this.intervalMs = options.intervalMs ?? MAILBOX_POLL_INTERVAL_MS;
      this.onError = options.onError ?? defaultErrorHandler;
    }
  }

  // ─── Handler Registration ──────────────────────────────────────────

  /**
   * Register a handler for a specific message type.
   * Multiple handlers can be registered for the same type.
   */
  on(type: MailboxMessageType, handler: MessageHandler): this {
    const existing = this.handlers.get(type);
    if (existing) {
      existing.push(handler);
    } else {
      this.handlers.set(type, [handler]);
    }
    return this;
  }

  /**
   * Register a catch-all handler that receives every message
   * regardless of type.
   */
  onAny(handler: MessageHandler): this {
    this.catchAllHandlers.push(handler);
    return this;
  }

  /**
   * Remove all handlers for a specific type.
   */
  off(type: MailboxMessageType): this {
    this.handlers.delete(type);
    return this;
  }

  /**
   * Remove all handlers (both typed and catch-all).
   */
  offAll(): this {
    this.handlers.clear();
    this.catchAllHandlers = [];
    return this;
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────

  /**
   * Start polling the mailbox at the configured interval.
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    // Do an immediate poll, then set interval
    void this.poll();

    this.timer = setInterval(() => {
      void this.poll();
    }, this.intervalMs);
  }

  /**
   * Stop polling. Any in-flight poll will complete but no new polls start.
   */
  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Whether the poller is currently running.
   */
  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Manually trigger a single poll.
   */
  async pollOnce(): Promise<number> {
    return this.poll();
  }

  /**
   * Get stats about the poller.
   */
  getStats(): {
    running: boolean;
    pollCount: number;
    messagesProcessed: number;
    errorCount: number;
  } {
    return {
      running: this.running,
      pollCount: this.pollCount,
      messagesProcessed: this.messagesProcessed,
      errorCount: this.errorCount,
    };
  }

  // ─── Polling ───────────────────────────────────────────────────────

  /**
   * Execute a single poll cycle: read + consume + dispatch.
   */
  private async poll(): Promise<number> {
    // Prevent concurrent polls
    if (this.polling) return 0;
    this.polling = true;
    this.pollCount++;

    try {
      const messages = await this.mailbox.readAndConsume(this.agentId);

      for (const message of messages) {
        // Skip expired messages
        if (message.expiresAt && message.expiresAt < Date.now()) {
          continue;
        }

        this.messagesProcessed++;
        await this.dispatch(message);
      }

      return messages.length;
    } catch (err) {
      this.errorCount++;
      // Top-level poll error — don't crash the poller
      this.onError(err, {
        id: '__poll_error__',
        from: '',
        to: this.agentId,
        type: 'direct_message',
        content: null,
        timestamp: Date.now(),
      });
      return 0;
    } finally {
      this.polling = false;
    }
  }

  /**
   * Dispatch a message to its type-specific handlers and catch-all handlers.
   * Each handler is isolated — one failure doesn't prevent others from running.
   */
  private async dispatch(message: MailboxMessage): Promise<void> {
    const typeHandlers = this.handlers.get(message.type) ?? [];
    const allHandlers = [...typeHandlers, ...this.catchAllHandlers];

    for (const handler of allHandlers) {
      try {
        await handler(message);
      } catch (err) {
        this.errorCount++;
        this.onError(err, message);
      }
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Default Error Handler
// ════════════════════════════════════════════════════════════════════════════

function defaultErrorHandler(error: unknown, message: MailboxMessage): void {
  const errMsg = error instanceof Error ? error.message : String(error);
  console.error(
    `[MailboxPoller] Error handling message ${message.id} (type=${message.type}): ${errMsg}`
  );
}
