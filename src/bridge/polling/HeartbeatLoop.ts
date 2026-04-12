// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HeartbeatApi {
  sendHeartbeat(payload: HeartbeatPayload): Promise<void>;
}

export interface HeartbeatPayload {
  activeSessions: number;
  capacity: { current: number; max: number };
  timestamp: number;
}

// ---------------------------------------------------------------------------
// HeartbeatLoop
// ---------------------------------------------------------------------------

export class HeartbeatLoop {
  private readonly api: HeartbeatApi;
  private readonly getSessionCount: () => number;
  private readonly getCapacity: () => { current: number; max: number };
  private timer: ReturnType<typeof setInterval> | null = null;
  private consecutiveFailures = 0;
  private readonly maxConsecutiveFailures: number;
  private lastHeartbeatAt: number | null = null;

  constructor(
    api: HeartbeatApi,
    getSessionCount: () => number,
    getCapacity: () => { current: number; max: number },
    maxConsecutiveFailures: number = 5,
  ) {
    this.api = api;
    this.getSessionCount = getSessionCount;
    this.getCapacity = getCapacity;
    this.maxConsecutiveFailures = maxConsecutiveFailures;
  }

  /** Start sending heartbeats at the given interval. */
  start(intervalMs: number): void {
    this.stop();
    this.timer = setInterval(() => {
      this.sendHeartbeat().catch(() => {});
    }, intervalMs);
    // Send one immediately
    this.sendHeartbeat().catch(() => {});
  }

  /** Stop sending heartbeats. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Send a single heartbeat. */
  async sendHeartbeat(): Promise<void> {
    const payload: HeartbeatPayload = {
      activeSessions: this.getSessionCount(),
      capacity: this.getCapacity(),
      timestamp: Date.now(),
    };

    try {
      await this.api.sendHeartbeat(payload);
      this.consecutiveFailures = 0;
      this.lastHeartbeatAt = Date.now();
    } catch (err) {
      this.consecutiveFailures++;
      console.error(
        '[HeartbeatLoop] Failed (' + this.consecutiveFailures + '):',
        err instanceof Error ? err.message : String(err),
      );
      if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
        console.error('[HeartbeatLoop] Too many failures, stopping');
        this.stop();
      }
    }
  }

  getLastHeartbeatAt(): number | null {
    return this.lastHeartbeatAt;
  }

  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  isRunning(): boolean {
    return this.timer !== null;
  }
}
