/**
 * replBridge.ts — In-REPL bridge mode (/remote-control command)
 *
 * When the user types /remote-control in the REPL, this module
 * starts a bridge that allows remote control of the current session.
 * Unlike standalone mode, this runs alongside the REPL.
 */

import * as crypto from 'crypto';
import type { BridgeConfig, BridgeSession, Transport, InboundMessage, OutboundMessage } from './types.js';
import { BridgeUI } from './ui/bridgeUI.js';
import { displayPairingInfo } from './ui/QRCodeDisplay.js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface ReplBridgeOptions {
  config: BridgeConfig;
  sessionId: string;
  onInboundMessage: (msg: InboundMessage) => void;
  onDisconnect?: () => void;
}

// ════════════════════════════════════════════════════════════════════════════
// ReplBridge
// ════════════════════════════════════════════════════════════════════════════

export class ReplBridge {
  private running = false;
  private transport?: Transport;
  private ui = new BridgeUI();
  private startedAt = 0;
  private messagesSent = 0;
  private messagesReceived = 0;

  constructor(private readonly options: ReplBridgeOptions) {}

  /**
   * Start the bridge (non-blocking).
   * Returns pairing info for the user.
   */
  async start(): Promise<{ pairingInfo: string }> {
    if (this.running) throw new Error('Bridge already running');

    this.running = true;
    this.startedAt = Date.now();

    // Display pairing info
    const pairingInfo = displayPairingInfo({
      endpointUrl: this.options.config.endpointUrl,
      environmentId: this.options.sessionId,
      showQR: true,
    });

    this.ui.update({
      mode: 'repl',
      transportVersion: this.options.config.transportVersion,
      connected: true,
      activeSessions: 1,
      capacity: 1,
    });

    return { pairingInfo };
  }

  /**
   * Stop the bridge.
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.transport) {
      await this.transport.disconnect();
      this.transport = undefined;
    }

    this.options.onDisconnect?.();
  }

  /**
   * Send a message to the remote client.
   */
  async send(message: OutboundMessage): Promise<void> {
    if (!this.running) return;
    this.messagesSent++;
    this.ui.update({ messagesSent: this.messagesSent });

    if (this.transport) {
      await this.transport.send(message);
    }
  }

  /**
   * Handle an inbound message from remote.
   */
  private handleInbound(msg: InboundMessage): void {
    this.messagesReceived++;
    this.ui.update({ messagesReceived: this.messagesReceived });
    this.options.onInboundMessage(msg);
  }

  /**
   * Get status info.
   */
  getStatus(): string {
    this.ui.update({ uptime: Date.now() - this.startedAt });
    return this.ui.formatStatusLine();
  }

  getDetailedStatus(): string {
    this.ui.update({ uptime: Date.now() - this.startedAt });
    return this.ui.formatDetailedStatus();
  }

  isRunning(): boolean { return this.running; }
}
