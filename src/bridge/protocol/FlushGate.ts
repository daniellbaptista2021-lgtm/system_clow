import type { OutboundMessage } from '../types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FlushSender = (message: OutboundMessage) => Promise<void>;

// ---------------------------------------------------------------------------
// FlushGate
// ---------------------------------------------------------------------------

/**
 * Queue messages during history flush. When the gate is closed, messages
 * are buffered.  When the gate opens (flush), all queued messages are sent.
 */
export class FlushGate {
  private gateOpen = true;
  private readonly queue: OutboundMessage[] = [];
  private sender: FlushSender | null = null;

  constructor(sender?: FlushSender) {
    this.sender = sender ?? null;
  }

  /** Set or replace the sender callback. */
  setSender(sender: FlushSender): void {
    this.sender = sender;
  }

  /** Open the gate (allow messages to pass through). */
  open(): void {
    this.gateOpen = true;
  }

  /** Close the gate (start queuing messages). */
  close(): void {
    this.gateOpen = false;
  }

  /**
   * Enqueue a message if the gate is closed.
   * Returns true if the message was queued, false if the gate is open.
   */
  enqueue(message: OutboundMessage): boolean {
    if (this.gateOpen) return false;
    this.queue.push(message);
    return true;
  }

  /**
   * Send all queued messages and open the gate.
   * Returns the number of messages successfully sent.
   */
  async flush(): Promise<number> {
    this.gateOpen = true;
    let sent = 0;
    while (this.queue.length > 0) {
      const message = this.queue.shift()!;
      if (this.sender) {
        try {
          await this.sender(message);
          sent++;
        } catch (err) {
          console.error(
            '[FlushGate] Failed to flush message:',
            err instanceof Error ? err.message : String(err),
          );
          this.queue.unshift(message);
          break;
        }
      } else {
        sent++;
      }
    }
    return sent;
  }

  /** Whether the gate is currently open. */
  isOpen(): boolean {
    return this.gateOpen;
  }

  /** Number of messages currently queued. */
  queueSize(): number {
    return this.queue.length;
  }

  /** Discard all queued messages. */
  clear(): void {
    this.queue.length = 0;
  }
}
