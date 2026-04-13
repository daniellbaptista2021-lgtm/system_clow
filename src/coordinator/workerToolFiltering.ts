/**
 * workerToolFiltering.ts — Restrict tools by coordinator/worker mode
 *
 * The coordinator itself is blocked from using execution tools (Bash, Read, Write).
 * Each worker type has a whitelist of allowed tools.
 * Workers of type 'general' get all tools EXCEPT Agent (recursion prevention).
 */

import type { CoordinatorConfig, CoordinatorWorkerType } from './types.js';

// ════════════════════════════════════════════════════════════════════════════
// Tool Interface (minimal — avoids circular import)
// ════════════════════════════════════════════════════════════════════════════

interface ToolLike {
  name: string;
}

// ════════════════════════════════════════════════════════════════════════════
// WorkerToolFiltering Class
// ════════════════════════════════════════════════════════════════════════════

export class WorkerToolFiltering {
  /**
   * Filter tools for a specific worker type.
   * Returns only tools in the worker's whitelist.
   */
  static filterForWorker(
    allTools: ToolLike[],
    workerType: CoordinatorWorkerType,
    config: CoordinatorConfig,
  ): ToolLike[] {
    const whitelist = config.workerToolWhitelist[workerType];

    if (whitelist.includes('*')) {
      // All tools EXCEPT Agent (prevent infinite recursion)
      return allTools.filter(t => t.name !== 'Agent' && t.name !== 'TaskStop');
    }

    return allTools.filter(t => whitelist.includes(t.name));
  }

  /**
   * Filter tools for the coordinator itself.
   * Removes execution tools — coordinator can only use Agent + task tools.
   */
  static filterForCoordinator(
    allTools: ToolLike[],
    config: CoordinatorConfig,
  ): ToolLike[] {
    return allTools.filter(t => !config.forbidCoordinatorTools.includes(t.name));
  }

  /**
   * Check if a specific tool call is allowed in the current mode.
   */
  static isToolAllowedInMode(
    toolName: string,
    isCoordinator: boolean,
    workerType: CoordinatorWorkerType | undefined,
    config: CoordinatorConfig,
  ): { allowed: boolean; reason?: string } {
    // Coordinator mode: block forbidden tools
    if (isCoordinator && !workerType) {
      if (config.forbidCoordinatorTools.includes(toolName)) {
        return {
          allowed: false,
          reason: `Tool "${toolName}" is not allowed in coordinator mode. Spawn a worker via the Agent tool instead.`,
        };
      }
      return { allowed: true };
    }

    // Worker mode: check whitelist
    if (workerType) {
      const whitelist = config.workerToolWhitelist[workerType];

      if (whitelist.includes('*')) {
        // General workers can use everything except Agent
        if (toolName === 'Agent') {
          return {
            allowed: false,
            reason: 'Workers cannot spawn sub-agents (recursion prevention).',
          };
        }
        return { allowed: true };
      }

      if (!whitelist.includes(toolName)) {
        return {
          allowed: false,
          reason: `Tool "${toolName}" is not in the ${workerType} worker whitelist. Allowed: ${whitelist.join(', ')}`,
        };
      }
    }

    return { allowed: true };
  }

  /**
   * Get a human-readable description of what tools a worker type can use.
   */
  static describeWorkerTools(workerType: CoordinatorWorkerType, config: CoordinatorConfig): string {
    const whitelist = config.workerToolWhitelist[workerType];
    if (whitelist.includes('*')) return 'All tools (except Agent)';
    return whitelist.join(', ');
  }

  /**
   * Get tools that are ONLY available to implementers (write tools).
   */
  static getWriteOnlyTools(config: CoordinatorConfig): string[] {
    const researcherTools = new Set(config.workerToolWhitelist.researcher);
    const implementerTools = config.workerToolWhitelist.implementer;
    return implementerTools.filter(t => !researcherTools.has(t));
  }

  /**
   * Validate that a coordinator config has no contradictions.
   */
  static validateConfig(config: CoordinatorConfig): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // Coordinator must not forbid Agent (it's the only way to do work)
    if (config.forbidCoordinatorTools.includes('Agent')) {
      errors.push('Coordinator cannot forbid Agent tool — it has no other way to do work');
    }

    // Implementer should have write tools
    if (!config.workerToolWhitelist.implementer.includes('Write') &&
        !config.workerToolWhitelist.implementer.includes('Edit')) {
      errors.push('Implementer worker has no write tools — cannot make changes');
    }

    // Verifier should not have write tools
    if (config.workerToolWhitelist.verifier.includes('Write') ||
        config.workerToolWhitelist.verifier.includes('Edit')) {
      errors.push('Verifier worker should not have write tools — verification must be read-only');
    }

    // Max concurrent workers should be positive
    if (config.maxConcurrentWorkers < 1) {
      errors.push('maxConcurrentWorkers must be at least 1');
    }

    return { valid: errors.length === 0, errors };
  }
}
