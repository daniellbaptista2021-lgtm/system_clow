/**
 * CCR Client (v2 write path)
 *
 * Handles outbound communication for the v2 transport by POSTing events to
 * the /worker/events endpoint via a {@link SerialBatchEventUploader}.
 * Also manages worker registration (PUT /worker), heartbeat intervals,
 * state reporting, delivery acknowledgement, and epoch conflict detection.
 */

import type {
  BridgeConfig,
  BridgeSession,
  CCREvent,
  WorkResponse,
  WorkerRegistration,
} from '../types.js';
import { EpochConflictError } from '../types.js';
import { SerialBatchEventUploader } from './SerialBatchEventUploader.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateUuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ---------------------------------------------------------------------------
// CCRClient
// ---------------------------------------------------------------------------

export class CCRClient {
  private readonly baseUrl: string;
  private readonly authHeaders: Record<string, string>;
  private readonly uploader: SerialBatchEventUploader;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly heartbeatIntervalMs = 15_000;
  private epoch: number;
  private running = false;

  constructor(
    private readonly config: BridgeConfig,
    private readonly session: BridgeSession,
    private readonly workResponse: WorkResponse,
  ) {
    this.baseUrl = config.endpointUrl.replace(/\/+$/, '');
    this.epoch = session.epoch ?? 0;

    this.authHeaders = {
      'Content-Type': 'application/json',
    };
    if (config.apiKey) {
      this.authHeaders['Authorization'] = `Bearer ${config.apiKey}`;
    }
    if (workResponse.workSecret) {
      this.authHeaders['X-Work-Secret'] = workResponse.workSecret;
    }

    this.uploader = new SerialBatchEventUploader(
      `${this.baseUrl}/worker/events`,
      this.authHeaders,
      this.epoch,
    );
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Register the worker with the server.
    await this.registerWorker();

    // Begin heartbeat loop.
    this.startHeartbeat();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.stopHeartbeat();
    await this.uploader.flush();
  }

  // -----------------------------------------------------------------------
  // Event posting
  // -----------------------------------------------------------------------

  async postEvent(event: CCREvent): Promise<void> {
    this.uploader.enqueue(event);
  }

  // -----------------------------------------------------------------------
  // State / delivery reporting
  // -----------------------------------------------------------------------

  async reportState(state: Record<string, unknown>): Promise<void> {
    const event: CCREvent = {
      eventType: 'state_report',
      payload: state,
      timestamp: Date.now(),
      uuid: generateUuid(),
    };
    this.uploader.enqueue(event);
  }

  async reportDelivery(uuid: string): Promise<void> {
    const event: CCREvent = {
      eventType: 'delivery_ack',
      payload: { uuid },
      timestamp: Date.now(),
      uuid: generateUuid(),
    };
    this.uploader.enqueue(event);
  }

  // -----------------------------------------------------------------------
  // Worker registration (PUT /worker)
  // -----------------------------------------------------------------------

  private async registerWorker(): Promise<void> {
    const registration: WorkerRegistration = {
      workerId: this.workResponse.workId,
      sessionId: this.session.sessionId,
      capabilities: ['tools', 'mcp'],
      epoch: this.epoch,
    };

    const url = `${this.baseUrl}/worker`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: this.authHeaders,
      body: JSON.stringify(registration),
    });

    if (res.status === 409) {
      const body = await res.text();
      let serverEpoch = this.epoch;
      try {
        const parsed = JSON.parse(body) as { epoch?: number };
        if (typeof parsed.epoch === 'number') {
          serverEpoch = parsed.epoch;
        }
      } catch {
        // Ignore parse failure.
      }
      throw new EpochConflictError(
        'Epoch conflict during worker registration',
        this.epoch,
        serverEpoch,
      );
    }

    if (!res.ok) {
      throw new Error(
        `Worker registration failed: ${res.status} ${res.statusText}`,
      );
    }

    // Update epoch from server response if provided.
    try {
      const body = (await res.json()) as { epoch?: number };
      if (typeof body.epoch === 'number') {
        this.epoch = body.epoch;
        this.uploader.setEpoch(this.epoch);
      }
    } catch {
      // Response may be empty; that's fine.
    }
  }

  // -----------------------------------------------------------------------
  // Heartbeat
  // -----------------------------------------------------------------------

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.running) return;
      void this.sendHeartbeat().catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[CCRClient] Heartbeat failed', err);
      });
    }, this.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private async sendHeartbeat(): Promise<void> {
    const url = `${this.baseUrl}/worker/heartbeat`;
    const res = await fetch(url, {
      method: 'POST',
      headers: this.authHeaders,
      body: JSON.stringify({
        workerId: this.workResponse.workId,
        sessionId: this.session.sessionId,
        epoch: this.epoch,
        timestamp: Date.now(),
      }),
    });

    if (res.status === 409) {
      const body = await res.text();
      let serverEpoch = this.epoch;
      try {
        const parsed = JSON.parse(body) as { epoch?: number };
        if (typeof parsed.epoch === 'number') {
          serverEpoch = parsed.epoch;
        }
      } catch {
        // Ignore.
      }
      throw new EpochConflictError(
        'Epoch conflict during heartbeat',
        this.epoch,
        serverEpoch,
      );
    }

    if (!res.ok) {
      throw new Error(`Heartbeat failed: ${res.status}`);
    }
  }
}
