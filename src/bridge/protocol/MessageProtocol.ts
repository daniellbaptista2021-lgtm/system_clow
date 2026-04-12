import type { OutboundMessage, InboundMessage } from '../types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MessageHandler = (message: InboundMessage) => void | Promise<void>;

export interface ProtocolStatistics {
  outboundCount: number;
  inboundCount: number;
  errorCount: number;
  lastOutboundAt: number | null;
  lastInboundAt: number | null;
}

// ---------------------------------------------------------------------------
// MessageProtocol
// ---------------------------------------------------------------------------

export class MessageProtocol {
  private readonly handlers: Map<string, MessageHandler[]> = new Map();
  private stats: ProtocolStatistics = {
    outboundCount: 0,
    inboundCount: 0,
    errorCount: 0,
    lastOutboundAt: null,
    lastInboundAt: null,
  };

  /** Register a handler for messages of a given type. Use '*' for wildcard. */
  registerHandler(type: string, handler: MessageHandler): void {
    const existing = this.handlers.get(type) ?? [];
    existing.push(handler);
    this.handlers.set(type, existing);
  }

  /** Unregister a previously-registered handler. */
  unregisterHandler(type: string, handler: MessageHandler): void {
    const existing = this.handlers.get(type);
    if (!existing) return;
    const idx = existing.indexOf(handler);
    if (idx >= 0) existing.splice(idx, 1);
  }

  /** Format, validate, and track an outbound message. */
  handleOutbound(message: OutboundMessage): OutboundMessage {
    this.validateOutbound(message);
    if (!message.timestamp) {
      message.timestamp = Date.now();
    }
    this.stats.outboundCount++;
    this.stats.lastOutboundAt = Date.now();
    return message;
  }

  /** Parse, validate, and dispatch an inbound message to handlers. */
  async handleInbound(message: InboundMessage): Promise<void> {
    this.validateInbound(message);
    this.stats.inboundCount++;
    this.stats.lastInboundAt = Date.now();

    const handlers = this.handlers.get(message.type) ?? [];
    const wildcardHandlers = this.handlers.get('*') ?? [];
    const allHandlers = [...handlers, ...wildcardHandlers];

    for (const handler of allHandlers) {
      try {
        await handler(message);
      } catch (err) {
        this.stats.errorCount++;
        console.error(
          '[MessageProtocol] Handler error for type ' + message.type + ':',
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }

  /** Serialize an outbound message to JSON string. */
  serializeOutbound(message: OutboundMessage): string {
    return JSON.stringify(message);
  }

  /** Deserialize a JSON string into an InboundMessage. */
  deserializeInbound(data: string): InboundMessage {
    const parsed = JSON.parse(data) as InboundMessage;
    this.validateInbound(parsed);
    return parsed;
  }

  /** Get protocol statistics. */
  getStatistics(): Readonly<ProtocolStatistics> {
    return { ...this.stats };
  }

  /** Reset statistics. */
  resetStatistics(): void {
    this.stats = {
      outboundCount: 0,
      inboundCount: 0,
      errorCount: 0,
      lastOutboundAt: null,
      lastInboundAt: null,
    };
  }

  // -----------------------------------------------------------------------
  // Validation
  // -----------------------------------------------------------------------

  private validateOutbound(message: OutboundMessage): void {
    if (!message.type) throw new Error('OutboundMessage missing type');
    if (!message.uuid) throw new Error('OutboundMessage missing uuid');
  }

  private validateInbound(message: InboundMessage): void {
    if (!message.type) throw new Error('InboundMessage missing type');
  }
}
