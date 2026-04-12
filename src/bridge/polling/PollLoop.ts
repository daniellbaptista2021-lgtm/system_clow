import type {
  BridgeEnvironment,
  PollConfig,
  BackoffConfig,
  WorkResponse,
} from '../types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CapacityStatus = 'not_at_capacity' | 'partial_capacity' | 'at_capacity';
export type WorkHandler = (work: WorkResponse) => Promise<void>;
export type CapacityChecker = () => { current: number; max: number };

export interface PollApi {
  poll(environment: BridgeEnvironment): Promise<WorkResponse | null>;
}

interface BackoffState {
  connBackoffMs: number;
  generalBackoffMs: number;
  connStartedAt: number | null;
  generalStartedAt: number | null;
}

// ---------------------------------------------------------------------------
// PollLoop
// ---------------------------------------------------------------------------

export class PollLoop {
  private readonly api: PollApi;
  private readonly environment: BridgeEnvironment;
  private readonly config: PollConfig;
  private readonly backoffConfig: BackoffConfig;
  private readonly workHandler: WorkHandler;
  private readonly capacityChecker: CapacityChecker;
  private running = false;
  private backoff: BackoffState;
  private capacityWakeResolve: (() => void) | null = null;
  private loopPromise: Promise<void> | null = null;

  constructor(
    api: PollApi,
    environment: BridgeEnvironment,
    config: PollConfig,
    backoffConfig: BackoffConfig,
    workHandler: WorkHandler,
    capacityChecker: CapacityChecker,
  ) {
    this.api = api;
    this.environment = environment;
    this.config = config;
    this.backoffConfig = backoffConfig;
    this.workHandler = workHandler;
    this.capacityChecker = capacityChecker;
    this.backoff = this.createResetBackoff();
  }

  /** Start the poll-dispatch loop. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.loopPromise = this.mainLoop();
  }

  /** Stop the poll-dispatch loop. */
  stop(): void {
    this.running = false;
    this.notifyCapacityAvailable();
  }

  /** Wake the loop from capacity wait. */
  notifyCapacityAvailable(): void {
    if (this.capacityWakeResolve) {
      this.capacityWakeResolve();
      this.capacityWakeResolve = null;
    }
  }

  /** Check current capacity status. */
  getCapacityStatus(): CapacityStatus {
    const { current, max } = this.capacityChecker();
    if (current >= max) return 'at_capacity';
    if (current > 0) return 'partial_capacity';
    return 'not_at_capacity';
  }

  /** Get the appropriate poll interval based on capacity status. */
  getPollInterval(): number {
    const status = this.getCapacityStatus();
    switch (status) {
      case 'at_capacity':
        return this.config.atCapacityMs;
      case 'partial_capacity':
        return this.config.partialCapacityMs;
      case 'not_at_capacity':
        return this.config.notAtCapacityMs;
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  // -----------------------------------------------------------------------
  // Main loop
  // -----------------------------------------------------------------------

  private async mainLoop(): Promise<void> {
    while (this.running) {
      const status = this.getCapacityStatus();

      if (status === 'at_capacity') {
        await this.waitForCapacity();
        if (!this.running) break;
        continue;
      }

      try {
        const work = await this.api.poll(this.environment);
        if (work) {
          this.resetBackoffState();
          this.workHandler(work).catch((err) => {
            console.error(
              '[PollLoop] Work handler error:',
              err instanceof Error ? err.message : String(err),
            );
          });
        }
      } catch (err) {
        this.handlePollError(err);
      }

      const interval = this.getPollInterval();
      const effectiveInterval = Math.max(
        interval,
        this.backoff.connBackoffMs,
        this.backoff.generalBackoffMs,
      );
      await this.sleep(effectiveInterval);
    }
  }

  // -----------------------------------------------------------------------
  // Error handling
  // -----------------------------------------------------------------------

  private handlePollError(err: unknown): void {
    const isConn = this.isConnectionError(err);

    if (isConn) {
      if (this.backoff.connStartedAt === null) {
        this.backoff.connStartedAt = Date.now();
      }
      this.backoff.connBackoffMs = Math.min(
        (this.backoff.connBackoffMs || this.backoffConfig.initialDelayMs) *
          this.backoffConfig.multiplier,
        this.backoffConfig.maxDelayMs,
      );
      if (this.shouldGiveUp(this.backoff.connStartedAt, this.backoffConfig.generalGiveUpMs)) {
        console.error('[PollLoop] Connection backoff exhausted, stopping');
        this.running = false;
      }
    } else {
      if (this.backoff.generalStartedAt === null) {
        this.backoff.generalStartedAt = Date.now();
      }
      this.backoff.generalBackoffMs = Math.min(
        (this.backoff.generalBackoffMs || this.backoffConfig.generalInitialMs) *
          this.backoffConfig.multiplier,
        this.backoffConfig.generalCapMs,
      );
      if (this.shouldGiveUp(this.backoff.generalStartedAt, this.backoffConfig.generalGiveUpMs)) {
        console.error('[PollLoop] General backoff exhausted, stopping');
        this.running = false;
      }
    }
  }

  private resetBackoffState(): void {
    this.backoff = this.createResetBackoff();
  }

  private createResetBackoff(): BackoffState {
    return {
      connBackoffMs: 0,
      generalBackoffMs: 0,
      connStartedAt: null,
      generalStartedAt: null,
    };
  }

  private isConnectionError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    const msg = err.message.toLowerCase();
    return (
      msg.includes('econnrefused') ||
      msg.includes('econnreset') ||
      msg.includes('etimedout') ||
      msg.includes('enetunreach') ||
      msg.includes('fetch failed') ||
      msg.includes('socket hang up')
    );
  }

  private shouldGiveUp(startedAt: number | null, giveUpMs: number): boolean {
    if (startedAt === null) return false;
    return Date.now() - startedAt >= giveUpMs;
  }

  private waitForCapacity(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.capacityWakeResolve = resolve;
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
