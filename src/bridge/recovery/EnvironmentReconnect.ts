/**
 * EnvironmentReconnect.ts — Handle environment reconnection
 *
 * When the bridge loses connection (network issue, server restart),
 * this module handles reconnection with the same or new environment.
 */

import type { BridgeEnvironment } from '../types.js';
import { MAX_ENVIRONMENT_RECREATIONS } from '../types.js';

export interface ReconnectResult {
  success: boolean;
  environment?: BridgeEnvironment;
  isNewEnvironment: boolean;
  attempt: number;
  error?: string;
}

export class EnvironmentReconnect {
  private attempts = 0;
  private lastAttemptAt = 0;
  private readonly minRetryIntervalMs = 5_000;

  /**
   * Attempt to reconnect to an existing environment.
   */
  async reconnect(params: {
    registerFn: (reuseId?: string) => Promise<BridgeEnvironment>;
    existingEnvironmentId?: string;
    maxAttempts?: number;
  }): Promise<ReconnectResult> {
    const maxAttempts = params.maxAttempts ?? MAX_ENVIRONMENT_RECREATIONS;

    // Rate limit
    const now = Date.now();
    if (now - this.lastAttemptAt < this.minRetryIntervalMs) {
      await new Promise(r => setTimeout(r, this.minRetryIntervalMs - (now - this.lastAttemptAt)));
    }
    this.lastAttemptAt = Date.now();
    this.attempts++;

    if (this.attempts > maxAttempts) {
      return { success: false, isNewEnvironment: false, attempt: this.attempts, error: 'Max reconnect attempts exceeded' };
    }

    // Try reuse existing environment
    if (params.existingEnvironmentId) {
      try {
        const env = await params.registerFn(params.existingEnvironmentId);
        return { success: true, environment: env, isNewEnvironment: false, attempt: this.attempts };
      } catch {
        // Reuse failed — try fresh registration
      }
    }

    // Fresh registration
    try {
      const env = await params.registerFn();
      return { success: true, environment: env, isNewEnvironment: true, attempt: this.attempts };
    } catch (err) {
      return { success: false, isNewEnvironment: false, attempt: this.attempts, error: (err as Error).message };
    }
  }

  /**
   * Reset attempt counter (after successful reconnection).
   */
  resetAttempts(): void {
    this.attempts = 0;
  }

  getAttemptCount(): number {
    return this.attempts;
  }
}
