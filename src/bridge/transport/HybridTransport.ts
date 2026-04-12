/**
 * Hybrid Transport (v1)
 *
 * Reads inbound messages over a WebSocket connection and writes outbound
 * messages via HTTP POST.  Includes reconnection logic with exponential
 * back-off, message queuing while disconnected, and WebSocket ping/pong
 * for keep-alive.
 */

import type {
  BackoffConfig,
  BridgeConfig,
  BridgeSession,
  BridgeTransportVersion,
  InboundMessage,
  OutboundMessage,
  Transport,
  TransportMessageHandler,
  WorkResponse,
} from '../types.js';
import {
  DEFAULT_BACKOFF,
  TransportDisconnectedError,
} from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeBackoff(attempt: number, cfg: BackoffConfig): number {
  const base = cfg.initialDelayMs * Math.pow(cfg.multiplier, attempt);
  const clamped = Math.min(base, cfg.maxDelayMs);
  const jitter = 1 + (Math.random() * 2 - 1) * cfg.jitter;
  return Math.round(clamped * jitter);
}

function generateUuid(): string {
  // Simple v4-ish uuid without crypto dependency.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ---------------------------------------------------------------------------
// HybridTransport
// ---------------------------------------------------------------------------

export class HybridTransport implements Transport {
  readonly version: BridgeTransportVersion = 'v1';

  private ws: WebSocket | null = null;
  private handlers: TransportMessageHandler[] = [];
  private connected = false;
  private shouldReconnect = true;
  private reconnectAttempt = 0;
  private readonly backoff: BackoffConfig;
  private readonly queue: OutboundMessage[] = [];
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private readonly keepAliveIntervalMs = 30_000;

  private readonly wsUrl: string;
  private readonly postUrl: string;
  private readonly authHeaders: Record<string, string>;

  constructor(
    config: BridgeConfig,
    private readonly session: BridgeSession,
    private readonly workResponse: WorkResponse,
  ) {
    this.backoff = { ...DEFAULT_BACKOFF, ...config.backoff };

    // Derive URLs from the endpoint.
    const base = config.endpointUrl.replace(/\/+$/, '');
    const wsBase = base.replace(/^http/, 'ws');
    this.wsUrl = `${wsBase}/transport/v1/ws/${encodeURIComponent(workResponse.workId)}`;
    this.postUrl = `${base}/transport/v1/messages/${encodeURIComponent(workResponse.workId)}`;

    this.authHeaders = {
      'Content-Type': 'application/json',
    };
    if (config.apiKey) {
      this.authHeaders['Authorization'] = `Bearer ${config.apiKey}`;
    }
    if (workResponse.workSecret) {
      this.authHeaders['X-Work-Secret'] = workResponse.workSecret;
    }
  }

  // -----------------------------------------------------------------------
  // Transport interface
  // -----------------------------------------------------------------------

  async connect(): Promise<void> {
    this.shouldReconnect = true;
    await this.openWebSocket();
    this.startKeepAlive();
  }

  async disconnect(): Promise<void> {
    this.shouldReconnect = false;
    this.stopKeepAlive();
    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }
    this.connected = false;
  }

  async send(message: OutboundMessage): Promise<void> {
    if (!this.connected) {
      this.queue.push(message);
      return;
    }
    await this.postMessage(message);
  }

  onMessage(handler: TransportMessageHandler): void {
    this.handlers.push(handler);
  }

  async reportState(state: Record<string, unknown>): Promise<void> {
    const msg: OutboundMessage = {
      type: 'state_report',
      payload: state,
      uuid: generateUuid(),
      timestamp: Date.now(),
    };
    await this.send(msg);
  }

  async reportDelivery(uuid: string): Promise<void> {
    const msg: OutboundMessage = {
      type: 'delivery_ack',
      payload: { uuid },
      uuid: generateUuid(),
      timestamp: Date.now(),
    };
    await this.send(msg);
  }

  isConnected(): boolean {
    return this.connected;
  }

  // -----------------------------------------------------------------------
  // WebSocket management
  // -----------------------------------------------------------------------

  private openWebSocket(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      try {
        const ws = new WebSocket(this.wsUrl);

        ws.addEventListener('open', () => {
          this.ws = ws;
          this.connected = true;
          this.reconnectAttempt = 0;
          this.drainQueue();
          resolve();
        });

        ws.addEventListener('message', (evt) => {
          this.handleWsMessage(evt);
        });

        ws.addEventListener('close', (evt) => {
          this.connected = false;
          this.ws = null;
          if (this.shouldReconnect && !evt.wasClean) {
            void this.reconnect();
          }
        });

        ws.addEventListener('error', () => {
          // `error` is always followed by `close`, so we handle reconnect
          // there.  On the initial connect we reject.
          if (!this.connected) {
            reject(new TransportDisconnectedError('WebSocket failed to connect'));
          }
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  private handleWsMessage(evt: MessageEvent): void {
    let parsed: InboundMessage;
    try {
      const data = typeof evt.data === 'string' ? evt.data : String(evt.data);
      parsed = JSON.parse(data) as InboundMessage;
    } catch {
      // eslint-disable-next-line no-console
      console.error('[HybridTransport] Failed to parse inbound message');
      return;
    }

    for (const handler of this.handlers) {
      try {
        handler(parsed);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[HybridTransport] Handler threw', err);
      }
    }
  }

  private async reconnect(): Promise<void> {
    while (this.shouldReconnect && !this.connected) {
      const delayMs = computeBackoff(this.reconnectAttempt, this.backoff);
      this.reconnectAttempt++;
      await sleep(delayMs);
      if (!this.shouldReconnect) return;

      try {
        await this.openWebSocket();
        return;
      } catch {
        // Will retry.
      }
    }
  }

  // -----------------------------------------------------------------------
  // HTTP POST for outbound
  // -----------------------------------------------------------------------

  private async postMessage(message: OutboundMessage): Promise<void> {
    const res = await fetch(this.postUrl, {
      method: 'POST',
      headers: this.authHeaders,
      body: JSON.stringify(message),
    });

    if (!res.ok) {
      throw new TransportDisconnectedError(
        `POST failed with status ${res.status}`,
      );
    }
  }

  private drainQueue(): void {
    while (this.queue.length > 0) {
      const msg = this.queue.shift()!;
      void this.postMessage(msg).catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[HybridTransport] Failed to drain queued message', err);
      });
    }
  }

  // -----------------------------------------------------------------------
  // Keep-alive
  // -----------------------------------------------------------------------

  private startKeepAlive(): void {
    this.stopKeepAlive();
    this.keepAliveTimer = setInterval(() => {
      if (this.ws && this.connected) {
        // Send a lightweight ping frame via the application protocol.
        const ping: OutboundMessage = {
          type: 'ping',
          payload: {},
          uuid: generateUuid(),
          timestamp: Date.now(),
        };
        void this.postMessage(ping).catch(() => {
          /* swallow — reconnect handles it */
        });
      }
    }, this.keepAliveIntervalMs);
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }
}
