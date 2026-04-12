import type { InboundMessage, Transport } from '../types.js';
import { ControlRequestType } from '../types.js';
import * as crypto from 'crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ControlHandler = (message: InboundMessage) => Promise<void> | void;

export interface ControlHandlerContext {
  transport: Transport;
  getModel: () => string | undefined;
  setModel: (model: string) => void;
  getPermissionMode: () => string | undefined;
  setPermissionMode: (mode: string) => void;
  getMaxThinkingTokens: () => number | undefined;
  setMaxThinkingTokens: (tokens: number) => void;
  onApiKeyInterrupt: () => Promise<void>;
  onReconnect: () => Promise<void>;
  onGracefulShutdown: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// ControlRequestHandler
// ---------------------------------------------------------------------------

export class ControlRequestHandler {
  private readonly handlers: Map<string, ControlHandler> = new Map();
  private readonly context: ControlHandlerContext;

  constructor(context: ControlHandlerContext) {
    this.context = context;
    this.registerDefaultHandlers();
  }

  /** Register a handler for a specific control request type. */
  registerHandler(type: string, handler: ControlHandler): void {
    this.handlers.set(type, handler);
  }

  /** Dispatch an inbound control request message. */
  async handleInbound(msg: InboundMessage): Promise<void> {
    const payload = msg.payload as Record<string, unknown> | undefined;
    const controlType = (payload?.['controlType'] as string) ?? msg.type;

    const handler = this.handlers.get(controlType);
    if (!handler) {
      console.warn('[ControlRequestHandler] No handler for: ' + controlType);
      await this.replyError(msg, 'Unknown control type: ' + controlType);
      return;
    }

    try {
      await handler(msg);
      await this.replySuccess(msg);
    } catch (err) {
      await this.replyError(
        msg,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // -----------------------------------------------------------------------
  // Default handlers
  // -----------------------------------------------------------------------

  private registerDefaultHandlers(): void {
    this.handlers.set(ControlRequestType.Reconfigure, (msg) => {
      const payload = msg.payload as Record<string, unknown> | undefined;
      const model = payload?.['model'] as string | undefined;
      if (model) this.context.setModel(model);

      const mode = payload?.['permissionMode'] as string | undefined;
      if (mode) this.context.setPermissionMode(mode);

      const tokens = payload?.['maxThinkingTokens'] as number | undefined;
      if (tokens !== undefined) this.context.setMaxThinkingTokens(tokens);
    });

    this.handlers.set(ControlRequestType.Cancel, async () => {
      await this.context.onApiKeyInterrupt();
    });

    this.handlers.set(ControlRequestType.Ping, () => {
      // Ping is a no-op; the reply is automatic.
    });

    this.handlers.set(ControlRequestType.Pause, async () => {
      await this.context.onGracefulShutdown();
    });

    this.handlers.set(ControlRequestType.Resume, async () => {
      await this.context.onReconnect();
    });
  }

  // -----------------------------------------------------------------------
  // Reply helpers
  // -----------------------------------------------------------------------

  private async replySuccess(original: InboundMessage): Promise<void> {
    await this.context.transport.send({
      type: 'control_response',
      payload: { success: true, requestUuid: original.uuid },
      uuid: crypto.randomUUID(),
      timestamp: Date.now(),
    });
  }

  private async replyError(original: InboundMessage, error: string): Promise<void> {
    await this.context.transport.send({
      type: 'control_response',
      payload: { success: false, error, requestUuid: original.uuid },
      uuid: crypto.randomUUID(),
      timestamp: Date.now(),
    });
  }
}
