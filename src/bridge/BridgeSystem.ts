/**
 * BridgeSystem.ts — Top-level orchestrator for the Bridge System
 *
 * Entry point that ties together all bridge components.
 * Supports 3 modes:
 *   - standalone: separate process, poll-dispatch loop
 *   - repl: in-REPL /remote-control command
 *   - env-less: direct JWT connection (v3)
 *
 * This is the LAST module of the System Clow v1.0.
 * With this, paridade arquitetural com Claude Code está completa.
 */

import * as path from 'path';
import * as os from 'os';
import type {
  BridgeConfig, BridgeMode, BridgeTransportVersion,
  BridgeEnvironment, BridgeSession, Transport,
  OutboundMessage, InboundMessage, WorkResponse,
} from './types.js';
import { DEFAULT_POLL_CONFIG, DEFAULT_BACKOFF } from './types.js';
import { BridgeStandalone } from './bridgeMain.js';
import { ReplBridge } from './replBridge.js';
import { RemoteBridgeCore } from './remoteBridgeCore.js';
import { BridgeCrashRecovery } from './recovery/CrashRecovery.js';
import { BridgeUI } from './ui/bridgeUI.js';

// ════════════════════════════════════════════════════════════════════════════
// BridgeSystem
// ════════════════════════════════════════════════════════════════════════════

export class BridgeSystem {
  private config: BridgeConfig;
  private standalone?: BridgeStandalone;
  private replBridge?: ReplBridge;
  private remoteBridge?: RemoteBridgeCore;
  private initialized = false;
  private mode: BridgeMode;
  private ui = new BridgeUI();

  constructor(config: Partial<BridgeConfig> & { endpointUrl: string }) {
    this.config = {
      mode: config.mode ?? 'standalone',
      transportVersion: config.transportVersion ?? 'v2',
      endpointUrl: config.endpointUrl,
      apiKey: config.apiKey,
      spawnMode: config.spawnMode ?? 'single-session',
      capacity: config.capacity ?? 1,
      enableCrashRecovery: config.enableCrashRecovery ?? true,
      pollConfig: config.pollConfig ?? DEFAULT_POLL_CONFIG,
      backoff: config.backoff ?? DEFAULT_BACKOFF,
      worktree: config.worktree,
    };
    this.mode = this.config.mode;
  }

  /**
   * Initialize the bridge system.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    this.ui.update({
      mode: this.mode,
      transportVersion: this.config.transportVersion,
    });
  }

  /**
   * Start the bridge in the configured mode.
   */
  async start(options?: {
    sessionId?: string;
    onInboundMessage?: (msg: InboundMessage) => void;
    api?: any;
    sessionRunner?: any;
  }): Promise<void> {
    await this.initialize();

    switch (this.mode) {
      case 'standalone':
        if (!options?.api || !options?.sessionRunner) {
          throw new Error('Standalone mode requires api and sessionRunner');
        }
        this.standalone = new BridgeStandalone(this.config, options.api, options.sessionRunner);
        await this.standalone.start();
        break;

      case 'repl':
        if (!options?.sessionId || !options?.onInboundMessage) {
          throw new Error('REPL mode requires sessionId and onInboundMessage');
        }
        this.replBridge = new ReplBridge({
          config: this.config,
          sessionId: options.sessionId,
          onInboundMessage: options.onInboundMessage,
        });
        const { pairingInfo } = await this.replBridge.start();
        console.log(pairingInfo);
        break;

      case 'env-less':
        this.remoteBridge = new RemoteBridgeCore(this.config);
        break;
    }
  }

  /**
   * Stop the bridge.
   */
  async stop(): Promise<void> {
    if (this.standalone) {
      await this.standalone.shutdown('manual');
      this.standalone = undefined;
    }
    if (this.replBridge) {
      await this.replBridge.stop();
      this.replBridge = undefined;
    }
    if (this.remoteBridge) {
      this.remoteBridge = undefined;
    }
  }

  /**
   * Send a message through the bridge.
   */
  async send(message: OutboundMessage): Promise<void> {
    if (this.replBridge) {
      await this.replBridge.send(message);
    }
  }

  /**
   * Get the current status.
   */
  getStatus(): string {
    if (this.replBridge) return this.replBridge.getStatus();
    if (this.standalone) {
      const stats = this.standalone.getStats();
      return `[standalone] ${stats.activeSessions} sessions | ${stats.workHandled} work | ${stats.errors} errors`;
    }
    return `[${this.mode}] idle`;
  }

  /**
   * Get detailed status.
   */
  getDetailedStatus(): string {
    if (this.replBridge) return this.replBridge.getDetailedStatus();
    return this.ui.formatDetailedStatus();
  }

  isInitialized(): boolean { return this.initialized; }
  getMode(): BridgeMode { return this.mode; }
  getConfig(): Readonly<BridgeConfig> { return { ...this.config }; }
}

// ════════════════════════════════════════════════════════════════════════════
// Re-exports
// ════════════════════════════════════════════════════════════════════════════

export { BridgeStandalone } from './bridgeMain.js';
export { ReplBridge } from './replBridge.js';
export { RemoteBridgeCore } from './remoteBridgeCore.js';
export { BridgeCrashRecovery } from './recovery/CrashRecovery.js';
export { EnvironmentReconnect } from './recovery/EnvironmentReconnect.js';
export { BridgePointerManager } from './recovery/BridgePointer.js';
export { BridgeUI } from './ui/bridgeUI.js';
export { displayPairingQR, buildPairingUrl, generatePairingCode } from './ui/QRCodeDisplay.js';
export type {
  BridgeConfig, BridgeMode, BridgeTransportVersion,
  BridgeEnvironment, BridgeSession, Transport,
  OutboundMessage, InboundMessage, WorkResponse,
  PollConfig, BackoffConfig, BridgePointer,
} from './types.js';
