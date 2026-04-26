/**
 * bridgeMain.ts — Standalone bridge mode (poll-dispatch loop)
 *
 * Runs as a standalone process that:
 *   1. Registers an environment with the bridge API
 *   2. Polls for work (remote sessions)
 *   3. Spawns child clow processes to handle work
 *   4. Streams results back via transport
 *   5. Handles shutdown, crash recovery, token refresh
 *
 * This is the main entry point for `clow bridge` command.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import type {
  BridgeConfig, BridgeEnvironment, WorkResponse, Transport,
  OutboundMessage, InboundMessage, BridgePointer,
} from './types.js';
import { DEFAULT_POLL_CONFIG, DEFAULT_BACKOFF } from './types.js';
import { BridgeUI } from './ui/bridgeUI.js';
import { displayPairingInfo } from './ui/QRCodeDisplay.js';
import { BridgeCrashRecovery } from './recovery/CrashRecovery.js';
import { EnvironmentReconnect } from './recovery/EnvironmentReconnect.js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface BridgeApiLike {
  registerEnvironment(params: { capacity: number; reuseEnvironmentId?: string }): Promise<BridgeEnvironment>;
  pollForWork(envId: string, secret: string): Promise<WorkResponse | null>;
  heartbeat(envId: string, secret: string, payload: { activeSessionCount: number; capacity: number; status: string }): Promise<void>;
  ackWork(envId: string, secret: string, payload: { workId: string; sessionId: string }): Promise<void>;
  stopWork(envId: string, secret: string, payload: { workId: string; sessionId: string; reason: string }): Promise<void>;
  deregisterEnvironment(envId: string, secret: string): Promise<void>;
}

interface SessionRunnerLike {
  spawnForWork(work: WorkResponse, transport: Transport): Promise<{ workId: string }>;
  sendToSession(workId: string, input: unknown): Promise<void>;
  killSession(workId: string): Promise<void>;
  getActiveCount(): number;
  getActiveSessions(): Array<{ workId: string; sessionId: string; startedAt: number }>;
}

// ════════════════════════════════════════════════════════════════════════════
// BridgeStandalone
// ════════════════════════════════════════════════════════════════════════════

export class BridgeStandalone {
  private environment?: BridgeEnvironment;
  private shuttingDown = false;
  private startedAt = 0;
  private ui = new BridgeUI();
  private crashRecovery: BridgeCrashRecovery;
  private reconnect = new EnvironmentReconnect();

  // Stats
  private pollCount = 0;
  private workHandled = 0;
  private errors = 0;

  constructor(
    private readonly config: BridgeConfig,
    private readonly api: BridgeApiLike,
    private readonly sessionRunner: SessionRunnerLike,
  ) {
    this.crashRecovery = new BridgeCrashRecovery();
  }

  /**
   * Start the standalone bridge.
   * This is the main blocking loop.
   */
  async start(): Promise<void> {
    this.startedAt = Date.now();

    // 1. Attempt crash recovery
    const recovery = await this.crashRecovery.attemptRecovery();

    // 2. Register or reconnect environment
    this.environment = await this.registerOrReconnect(recovery.environmentId);

    // 3. Save recovery pointer
    await this.crashRecovery.saveState(this.environment, 'standalone');

    // 4. Display pairing info
    console.log(displayPairingInfo({
      endpointUrl: this.config.endpointUrl,
      environmentId: this.environment.environmentId,
    }));

    // 5. Setup signal handlers
    process.on('SIGINT', () => this.shutdown('SIGINT'));
    process.on('SIGTERM', () => this.shutdown('SIGTERM'));

    // 6. Main poll loop
    this.ui.update({
      mode: 'standalone',
      transportVersion: this.config.transportVersion,
      connected: true,
      capacity: this.config.capacity ?? 1,
      environmentId: this.environment.environmentId,
    });

    await this.pollLoop();
  }

  /**
   * Graceful shutdown.
   */
  async shutdown(reason: string): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    console.log(`\n[Bridge] Shutting down: ${reason}`);

    // Kill active sessions
    const active = this.sessionRunner.getActiveSessions();
    for (const session of active) {
      await this.sessionRunner.killSession(session.workId).catch(() => {});
    }

    // Deregister environment
    if (this.environment) {
      try {
        await this.api.deregisterEnvironment(this.environment.environmentId, this.environment.secret);
      } catch {}
    }

    // Clear recovery pointer
    await this.crashRecovery.clearState();

    process.exit(0);
  }

  // ─── Poll Loop ───────────────────────────────────────────────────

  private async pollLoop(): Promise<void> {
    const pollConfig = { ...DEFAULT_POLL_CONFIG, ...(this.config.pollConfig ?? {}) };
    const backoffConfig = { ...DEFAULT_BACKOFF, ...(this.config.backoff ?? {}) };
    let backoffMs = backoffConfig.initialDelayMs;
    let errStartedAt = 0;
    const giveUpMs = backoffConfig.maxDelayMs * 20;

    while (!this.shuttingDown) {
      try {
        const capacity = this.config.capacity ?? 1;
        const active = this.sessionRunner.getActiveCount();

        this.ui.update({
          activeSessions: active,
          uptime: Date.now() - this.startedAt,
          lastPollAt: Date.now(),
        });

        if (active >= capacity) {
          await this.heartbeat();
          await this.sleep(pollConfig.maxIntervalMs);
          continue;
        }

        this.pollCount++;
        const work = await this.api.pollForWork(
          this.environment!.environmentId,
          this.environment!.secret,
        );

        backoffMs = backoffConfig.initialDelayMs;
        errStartedAt = 0;

        if (!work) {
          await this.sleep(pollConfig.intervalMs);
          continue;
        }

        this.handleWork(work).catch(err => {
          this.errors++;
          console.error('[Bridge] Work error:', err);
        });

      } catch (err) {
        this.errors++;
        this.ui.update({ errors: this.errors });

        if (errStartedAt === 0) errStartedAt = Date.now();
        if (Date.now() - errStartedAt > giveUpMs) {
          console.error('[Bridge] Too many errors, giving up');
          await this.shutdown('too_many_errors');
          return;
        }

        await this.sleep(backoffMs);
        backoffMs = Math.min(backoffMs * backoffConfig.multiplier, backoffConfig.maxDelayMs);
      }
    }
  }

  // ─── Work Handling ───────────────────────────────────────────────

  private async handleWork(work: WorkResponse): Promise<void> {
    this.workHandled++;

    // ACK
    await this.api.ackWork(this.environment!.environmentId, this.environment!.secret, {
      workId: work.workId,
      sessionId: work.sessionId,
    });

    // Create a simple transport wrapper
    const transport: Transport = {
      version: this.config.transportVersion,
      connect: async () => {},
      disconnect: async () => {},
      send: async (msg: OutboundMessage) => {
        const response = await fetch(`${work.sdkUrl}/events`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(work.workerJwt ? { Authorization: `Bearer ${work.workerJwt}` } : {}),
          },
          body: JSON.stringify(msg),
        });

        if (!response.ok) {
          const body = await response.text().catch(() => '');
          throw new Error(`Bridge event post failed: ${response.status} ${body}`.trim());
        }
      },
      onMessage: (handler) => {
        // Register handler for inbound
        return () => {};
      },
      reportState: async () => {},
      reportDelivery: async () => {},
      isConnected: () => true,
    };

    // Spawn session
    await this.sessionRunner.spawnForWork(work, transport);
  }

  // ─── Heartbeat ───────────────────────────────────────────────────

  private async heartbeat(): Promise<void> {
    if (!this.environment) return;
    try {
      await this.api.heartbeat(this.environment.environmentId, this.environment.secret, {
        activeSessionCount: this.sessionRunner.getActiveCount(),
        capacity: this.config.capacity ?? 1,
        status: this.shuttingDown ? 'draining' : 'active',
      });
      this.ui.update({ lastHeartbeatAt: Date.now() });
    } catch {}
  }

  // ─── Registration ────────────────────────────────────────────────

  private async registerOrReconnect(reuseEnvId?: string): Promise<BridgeEnvironment> {
    const result = await this.reconnect.reconnect({
      registerFn: (reuseId) => this.api.registerEnvironment({
        capacity: this.config.capacity ?? 1,
        reuseEnvironmentId: reuseId,
      }),
      existingEnvironmentId: reuseEnvId,
    });

    if (!result.success || !result.environment) {
      throw new Error(`Failed to register environment: ${result.error}`);
    }

    this.reconnect.resetAttempts();
    return result.environment;
  }

  // ─── Helpers ─────────────────────────────────────────────────────

  private sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
  }

  getStats() {
    return {
      pollCount: this.pollCount,
      workHandled: this.workHandled,
      errors: this.errors,
      uptime: Date.now() - this.startedAt,
      activeSessions: this.sessionRunner.getActiveCount(),
      environmentId: this.environment?.environmentId,
    };
  }
}
