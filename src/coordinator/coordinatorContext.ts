/**
 * coordinatorContext.ts — Context propagation between coordinator and workers
 *
 * When the coordinator spawns a worker, it needs to propagate:
 *   - Whether we're in coordinator mode
 *   - The worker type (for tool filtering)
 *   - Scratchpad directory
 *   - Parent session ID
 *
 * This module handles building and checking that context.
 */

import type { CoordinatorConfig, CoordinatorWorkerType, CoordinatorContextInjection } from './types.js';
import { WorkerToolFiltering } from './workerToolFiltering.js';

// ════════════════════════════════════════════════════════════════════════════
// CoordinatorContext Class
// ════════════════════════════════════════════════════════════════════════════

export class CoordinatorContext {
  /**
   * Build context injection for a worker.
   * This is passed to the child QueryEngine when spawning.
   */
  static buildInjection(
    config: CoordinatorConfig,
    workerType?: CoordinatorWorkerType,
    parentSessionId?: string,
  ): CoordinatorContextInjection {
    return {
      isCoordinatorMode: config.enabled,
      workerType,
      scratchpadDir: config.scratchpadDir,
      parentCoordinatorSessionId: parentSessionId,
    };
  }

  /**
   * Check if a tool call is allowed given the current coordinator context.
   * This is called by the permission pipeline (Stage 0).
   */
  static checkToolAllowed(
    toolName: string,
    injection: CoordinatorContextInjection,
    config: CoordinatorConfig,
  ): { allowed: boolean; reason?: string } {
    // If not in coordinator mode, everything is allowed
    if (!injection.isCoordinatorMode) return { allowed: true };

    return WorkerToolFiltering.isToolAllowedInMode(
      toolName,
      injection.isCoordinatorMode && !injection.workerType, // true if coordinator (not worker)
      injection.workerType,
      config,
    );
  }

  /**
   * Determine if the current context is the coordinator or a worker.
   */
  static isCoordinator(injection: CoordinatorContextInjection): boolean {
    return injection.isCoordinatorMode && !injection.workerType;
  }

  /**
   * Determine if the current context is a worker.
   */
  static isWorker(injection: CoordinatorContextInjection): boolean {
    return injection.isCoordinatorMode && !!injection.workerType;
  }

  /**
   * Get a label for the current context (for logging/UI).
   */
  static getContextLabel(injection: CoordinatorContextInjection): string {
    if (!injection.isCoordinatorMode) return 'normal';
    if (!injection.workerType) return 'coordinator';
    return `worker:${injection.workerType}`;
  }

  /**
   * Build environment variables to propagate coordinator context.
   * Used when spawning worker processes.
   */
  static buildEnvVars(injection: CoordinatorContextInjection): Record<string, string> {
    const env: Record<string, string> = {};

    if (injection.isCoordinatorMode) {
      env.CLOW_COORDINATOR_MODE = '1';
    }
    if (injection.workerType) {
      env.CLOW_WORKER_TYPE = injection.workerType;
    }
    if (injection.scratchpadDir) {
      env.CLOW_SCRATCHPAD_DIR = injection.scratchpadDir;
    }
    if (injection.parentCoordinatorSessionId) {
      env.CLOW_PARENT_SESSION = injection.parentCoordinatorSessionId;
    }

    return env;
  }

  /**
   * Parse coordinator context from environment variables.
   * Used by workers to understand their context on startup.
   */
  static fromEnv(): CoordinatorContextInjection {
    return {
      isCoordinatorMode: process.env.CLOW_COORDINATOR_MODE === '1',
      workerType: process.env.CLOW_WORKER_TYPE as CoordinatorWorkerType | undefined,
      scratchpadDir: process.env.CLOW_SCRATCHPAD_DIR,
      parentCoordinatorSessionId: process.env.CLOW_PARENT_SESSION,
    };
  }
}
