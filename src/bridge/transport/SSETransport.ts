/**
 * SSE Transport (v2)
 *
 * Reads inbound messages via Server-Sent Events and writes outbound
 * messages through a companion {@link CCRClient}.  Includes automatic
 * reconnection, connection state tracking, and event-type filtering.
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
import { CCRClient } from './CCRClient.js';

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
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ---------------------------------------------------------------------------
// SSETransport
// ---------------------------------------------------------------------------

export class SSETransport implements Transport {
  readonly version: BridgeTransportVersion = 'v2';

  private handlers: TransportMessageHandler[] = [];
  private connected = false;
  private shouldReconnect = true;
  private reconnectAttempt = 0;
  private readonly backoff: BackoffConfig;
  private abortController: AbortController | null = null;

  private readonly sseUrl: string;
  private readonly ccrClient: CCRClient;
  private readonly authHeaders: Record<string, string>;

  /** Last SSE event id received (for resume). */
  private lastEventId: string | null = null;

  constructor(
    config: BridgeConfig,
    private readonly session: BridgeSession,
    private readonly workResponse: WorkResponse,
  ) {
    this.backoff = { ...DEFAULT_BACKOFF, ...config.backoff };

    const base = config.endpointUrl.replace(/\/+$/, '');
    this.sseUrl = `${base}/transport/v2/events/${encodeURIComponent(workResponse.workId)}`;

    this.authHeaders = {};
    if (config.apiKey) {
      this.authHeaders['Authorization'] = `Bearer ${config.apiKey}`;
    }
    if (workResponse.workSecret) {
      this.authHeaders['X-Work-Secret'] = workResponse.workSecret;
    }

    this.ccrClient = new CCRClient(config, session, workResponse);
  }

  // -----------------------------------------------------------------------
  // Transport interface
  // -----------------------------------------------------------------------

  async connect(): Promise<void> {
    this.shouldReconnect = true;
    await this.ccrClient.start();
    await this.openSSE();
  }

  async disconnect(): Promise<void> {
    this.shouldReconnect = false;
    this.abortController?.abort();
    this.abortController = null;
    this.connected = false;
    await this.ccrClient.stop();
  }

  async send(message: OutboundMessage): Promise<void> {
    if (!this.connected) {
      throw new TransportDisconnectedError();
    }
    await this.ccrClient.postEvent({
      eventType: message.type,
      payload: message.payload,
      timestamp: message.timestamp,
      uuid: message.uuid,
    });
  }

  onMessage(handler: TransportMessageHandler): void {
    this.handlers.push(handler);
  }

  async reportState(state: Record<string, unknown>): Promise<void> {
    await this.ccrClient.reportState(state);
  }

  async reportDelivery(uuid: string): Promise<void> {
    await this.ccrClient.reportDelivery(uuid);
  }

  isConnected(): boolean {
    return this.connected;
  }

  // -----------------------------------------------------------------------
  // SSE connection (fetch-based)
  // -----------------------------------------------------------------------

  private async openSSE(): Promise<void> {
    this.abortController = new AbortController();
    const headers: Record<string, string> = {
      Accept: 'text/event-stream',
      'Cache-Control': 'no-cache',
      ...this.authHeaders,
    };
    if (this.lastEventId) {
      headers['Last-Event-ID'] = this.lastEventId;
    }

    try {
      const response = await fetch(this.sseUrl, {
        headers,
        signal: this.abortController.signal,
      });

      if (!response.ok) {
        throw new TransportDisconnectedError(
          `SSE connect failed: ${response.status}`,
        );
      }

      if (!response.body) {
        throw new TransportDisconnectedError('SSE response has no body');
      }

      this.connected = true;
      this.reconnectAttempt = 0;

      // Start reading the stream in the background.
      void this.readStream(response.body);
    } catch (err) {
      this.connected = false;
      if (this.shouldReconnect) {
        void this.reconnect();
      } else {
        throw err;
      }
    }
  }

  private async readStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process complete SSE events separated by double newlines.
        const events = buffer.split('\n\n');
        // The last element may be incomplete — keep it in the buffer.
        buffer = events.pop() ?? '';

        for (const rawEvent of events) {
          if (!rawEvent.trim()) continue;
          this.processSSEEvent(rawEvent);
        }
      }
    } catch (err) {
      // AbortError is expected when we disconnect.
      if (err instanceof DOMException && err.name === 'AbortError') {
        return;
      }
      // eslint-disable-next-line no-console
      console.error('[SSETransport] Stream read error', err);
    } finally {
      reader.releaseLock();
      this.connected = false;
      if (this.shouldReconnect) {
        void this.reconnect();
      }
    }
  }

  // -----------------------------------------------------------------------
  // SSE event parsing
  // -----------------------------------------------------------------------

  private processSSEEvent(raw: string): void {
    let eventType = 'message';
    let data = '';
    let id: string | null = null;

    for (const line of raw.split('\n')) {
      if (line.startsWith('event:')) {
        eventType = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        data += (data ? '\n' : '') + line.slice(5).trim();
      } else if (line.startsWith('id:')) {
        id = line.slice(3).trim();
      }
      // Lines starting with ':' are comments (used for keep-alive).
    }

    if (id) {
      this.lastEventId = id;
    }

    // Filter: only dispatch 'message' events that carry data.
    if (eventType === 'heartbeat') {
      // Keep-alive from the server; nothing to dispatch.
      return;
    }

    if (eventType === 'error') {
      // eslint-disable-next-line no-console
      console.error('[SSETransport] Server-sent error event:', data);
      return;
    }

    if (!data) return;

    let parsed: InboundMessage;
    try {
      parsed = JSON.parse(data) as InboundMessage;
    } catch {
      // eslint-disable-next-line no-console
      console.error('[SSETransport] Failed to parse SSE data');
      return;
    }

    for (const handler of this.handlers) {
      try {
        handler(parsed);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[SSETransport] Handler threw', err);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Reconnection
  // -----------------------------------------------------------------------

  private async reconnect(): Promise<void> {
    while (this.shouldReconnect && !this.connected) {
      const delayMs = computeBackoff(this.reconnectAttempt, this.backoff);
      this.reconnectAttempt++;
      await sleep(delayMs);
      if (!this.shouldReconnect) return;

      try {
        await this.openSSE();
        return;
      } catch {
        // Will loop and retry.
      }
    }
  }
}
