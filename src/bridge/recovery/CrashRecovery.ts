/**
 * CrashRecovery.ts — Bridge crash recovery
 *
 * On startup, checks for a pointer file from a previous crash.
 * If found, attempts to reconnect to the same environment
 * instead of creating a new one.
 */

import { BridgePointerManager } from './BridgePointer.js';
import type { BridgeEnvironment, BridgePointer } from '../types.js';
import { MAX_ENVIRONMENT_RECREATIONS } from '../types.js';

export interface RecoveryResult {
  recovered: boolean;
  pointer: BridgePointer | null;
  environmentId?: string;
  recreationCount: number;
  error?: string;
}

export class BridgeCrashRecovery {
  private recreationCount = 0;
  private pointerManager: BridgePointerManager;

  constructor(clowHome?: string) {
    this.pointerManager = new BridgePointerManager(clowHome);
  }

  /**
   * Attempt to recover from a crash.
   * Returns the pointer if recovery is possible.
   */
  async attemptRecovery(): Promise<RecoveryResult> {
    const pointer = await this.pointerManager.load();

    if (!pointer) {
      return { recovered: false, pointer: null, recreationCount: 0 };
    }

    // Check if pointer is stale
    if (await this.pointerManager.isStale()) {
      await this.pointerManager.clear();
      return { recovered: false, pointer: null, recreationCount: 0, error: 'Pointer is stale' };
    }

    // Check if previous process is still running
    if (pointer.lastPid) {
      try {
        process.kill(pointer.lastPid, 0);
        // Process is alive — don't recover (another instance is running)
        return { recovered: false, pointer, recreationCount: 0, error: 'Previous instance still running' };
      } catch {
        // Process dead — safe to recover
      }
    }

    // Check recreation limit
    if (this.recreationCount >= MAX_ENVIRONMENT_RECREATIONS) {
      await this.pointerManager.clear();
      return { recovered: false, pointer, recreationCount: this.recreationCount, error: 'Max recreations exceeded' };
    }

    this.recreationCount++;

    return {
      recovered: true,
      pointer,
      environmentId: pointer.environmentId,
      recreationCount: this.recreationCount,
    };
  }

  /**
   * Save recovery state after successful (re)connection.
   */
  async saveState(env: BridgeEnvironment, source: 'standalone' | 'repl'): Promise<void> {
    await this.pointerManager.save({
      sessionId: env.environmentId,
      environmentId: env.environmentId,
      source,
      createdAt: Date.now(),
      lastPid: process.pid,
    });
  }

  /**
   * Clear recovery state (clean shutdown).
   */
  async clearState(): Promise<void> {
    await this.pointerManager.clear();
  }

  getRecreationCount(): number {
    return this.recreationCount;
  }
}
