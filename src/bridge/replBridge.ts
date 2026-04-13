/**
 * replBridge.ts ? In-REPL bridge mode (/remote-control command)
 *
 * Starts a server-backed bridge session for the current CLI session.
 * Outbound events are posted to the bridge server and inbound events
 * are polled back from the session event stream.
 */

import type { BridgeConfig, InboundMessage, OutboundMessage } from './types.js';
import { BridgeUI } from './ui/bridgeUI.js';
import { displayPairingInfo } from './ui/QRCodeDisplay.js';
import { BridgeApiClient } from './api/bridgeApi.js';

interface ReplBridgeOptions {
  config: BridgeConfig;
  sessionId: string;
  onInboundMessage: (msg: InboundMessage) => void;
  onDisconnect?: () => void;
}

interface ReplSessionBinding {
  bridgeSessionId: string;
  sdkUrl: string;
  workerJwt: string;
}

export class ReplBridge {
  private running = false;
  private ui = new BridgeUI();
  private startedAt = 0;
  private messagesSent = 0;
  private messagesReceived = 0;
  private api: BridgeApiClient;
  private session?: ReplSessionBinding;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private seenEventIds = new Set<string>();
  private sentEventIds = new Set<string>();

  constructor(private readonly options: ReplBridgeOptions) {
    this.api = new BridgeApiClient(options.config);
  }

  async start(): Promise<{ pairingInfo: string }> {
    if (this.running) throw new Error('Bridge already running');
    if (!this.options.config.apiKey) throw new Error('REPL bridge requires apiKey in config');

    const created = await this.api.createSessionEnvLess({
      source: this.options.sessionId,
      metadata: { mode: 'repl' },
    });

    this.session = {
      bridgeSessionId: created.sessionId,
      sdkUrl: created.sdkUrl,
      workerJwt: created.workerJwt,
    };

    this.running = true;
    this.startedAt = Date.now();

    const pairingInfo = displayPairingInfo({
      endpointUrl: this.options.config.endpointUrl,
      environmentId: this.session.bridgeSessionId,
      showQR: true,
    });

    this.ui.update({
      mode: 'repl',
      transportVersion: this.options.config.transportVersion,
      connected: true,
      activeSessions: 1,
      capacity: 1,
    });

    this.startPolling();
    return { pairingInfo };
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    this.session = undefined;
    this.options.onDisconnect?.();
  }

  async send(message: OutboundMessage): Promise<void> {
    if (!this.running || !this.session) return;
    this.messagesSent++;
    this.ui.update({ messagesSent: this.messagesSent });
    this.sentEventIds.add(message.uuid);

    const response = await fetch(`${this.session.sdkUrl}/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.session.workerJwt}`,
      },
      body: JSON.stringify(message),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Failed to send REPL bridge event: ${response.status} ${body}`.trim());
    }
  }

  private startPolling(): void {
    void this.pollInbound();
    this.pollTimer = setInterval(() => {
      void this.pollInbound();
    }, 1000);
  }

  private async pollInbound(): Promise<void> {
    if (!this.running || !this.session) return;

    const response = await fetch(`${this.session.sdkUrl}/events`);
    if (!response.ok) return;

    const payload = await response.json().catch(() => ({ events: [] as unknown[] })) as { events?: unknown[] };
    const events = Array.isArray(payload.events) ? payload.events as InboundMessage[] : [];

    for (const event of events) {
      if (!event?.uuid || this.seenEventIds.has(event.uuid)) continue;
      this.seenEventIds.add(event.uuid);
      if (this.sentEventIds.has(event.uuid)) continue;
      if (!event.type || !event.payload) continue;
      this.messagesReceived++;
      this.ui.update({ messagesReceived: this.messagesReceived });
      this.options.onInboundMessage(event);
    }
  }

  getStatus(): string {
    this.ui.update({ uptime: Date.now() - this.startedAt });
    return this.ui.formatStatusLine();
  }

  getDetailedStatus(): string {
    this.ui.update({ uptime: Date.now() - this.startedAt });
    return this.ui.formatDetailedStatus();
  }

  getBridgeSessionId(): string | undefined {
    return this.session?.bridgeSessionId;
  }

  isRunning(): boolean { return this.running; }
}
