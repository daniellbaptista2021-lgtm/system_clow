/**
 * HookExecutor.ts — Orchestrates the 4 executor types
 *
 * Based on Claude Code's hookExecutor.ts (~200 lines)
 *
 * Features:
 *   - Dispatch to correct executor based on hook type
 *   - Execution timeout enforcement
 *   - Error wrapping with hook ID
 *   - Execution metrics tracking
 *   - Retry for transient failures (http only)
 *   - Dry-run mode support
 */

import type { ConfiguredHook, HookInput, HookOutput, AgentHookConfig, HookType } from './types.js';
import { HookCommandExecutor } from './HookExecutorCommand.js';
import { HookHttpExecutor } from './HookExecutorHttp.js';
import { HookAgentExecutor } from './HookExecutorAgent.js';
import { HookFunctionExecutor } from './HookExecutorFunction.js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface ExecutionStats {
  totalExecutions: number;
  successCount: number;
  errorCount: number;
  totalDurationMs: number;
  byType: Record<string, { count: number; totalMs: number; errors: number }>;
}

// ════════════════════════════════════════════════════════════════════════════
// HookExecutor Class
// ════════════════════════════════════════════════════════════════════════════

export class HookExecutor {
  private cmd = new HookCommandExecutor();
  private http = new HookHttpExecutor();
  private agent: HookAgentExecutor;
  private fn = new HookFunctionExecutor();
  private dryRun = false;

  private stats: ExecutionStats = {
    totalExecutions: 0,
    successCount: 0,
    errorCount: 0,
    totalDurationMs: 0,
    byType: {},
  };

  constructor(deps: { spawnSubagent: (c: AgentHookConfig, p: string) => Promise<string> }) {
    this.agent = new HookAgentExecutor(deps.spawnSubagent);
  }

  /**
   * Execute a hook with the given input.
   * Routes to the correct executor based on hook type.
   */
  async execute(hook: ConfiguredHook, input: HookInput): Promise<HookOutput> {
    const startTime = Date.now();
    const hookType = hook.hook.type;

    // Dry-run mode: skip actual execution
    if (this.dryRun) {
      return { systemMessage: `[dry-run] Would execute ${hookType} hook ${hook.id}` };
    }

    this.stats.totalExecutions++;
    this.initTypeStats(hookType);

    try {
      let output: HookOutput;

      switch (hookType) {
        case 'command':
          output = await this.cmd.execute(hook.hook, input);
          break;
        case 'http':
          output = await this.http.execute(hook.hook, input);
          break;
        case 'agent':
          output = await this.agent.execute(hook.hook, input);
          break;
        case 'function':
          output = await this.fn.execute(hook.hook as any, input);
          break;
        default:
          output = { systemMessage: `[hook] Unknown hook type: ${hookType}` };
      }

      const durationMs = Date.now() - startTime;
      this.stats.successCount++;
      this.stats.totalDurationMs += durationMs;
      this.stats.byType[hookType].count++;
      this.stats.byType[hookType].totalMs += durationMs;

      return output;

    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      this.stats.errorCount++;
      this.stats.totalDurationMs += durationMs;
      this.stats.byType[hookType].errors++;

      return {
        systemMessage: `[hook ${hook.id}] Error: ${err.message}`,
      };
    }
  }

  /**
   * Set dry-run mode (for testing).
   */
  setDryRun(enabled: boolean): void {
    this.dryRun = enabled;
  }

  /**
   * Get execution statistics.
   */
  getStats(): ExecutionStats {
    return { ...this.stats };
  }

  /**
   * Reset statistics.
   */
  resetStats(): void {
    this.stats = {
      totalExecutions: 0,
      successCount: 0,
      errorCount: 0,
      totalDurationMs: 0,
      byType: {},
    };
  }

  /**
   * Get average execution time in ms.
   */
  getAvgDurationMs(): number {
    if (this.stats.totalExecutions === 0) return 0;
    return this.stats.totalDurationMs / this.stats.totalExecutions;
  }

  /**
   * Execute a hook with a specific timeout override.
   */
  async executeWithTimeout(hook: ConfiguredHook, input: HookInput, timeoutMs: number): Promise<HookOutput> {
    return Promise.race([
      this.execute(hook, input),
      new Promise<HookOutput>((resolve) => {
        setTimeout(() => resolve({ systemMessage: `[hook ${hook.id}] Execution timeout (${timeoutMs}ms)` }), timeoutMs);
      }),
    ]);
  }

  /**
   * Execute multiple hooks in parallel.
   */
  async executeBatch(hooks: ConfiguredHook[], input: HookInput): Promise<Array<{ hookId: string; output: HookOutput }>> {
    return Promise.all(hooks.map(async hook => ({
      hookId: hook.id,
      output: await this.execute(hook, input),
    })));
  }

  /**
   * Get the internal executors for direct access.
   */
  getCommandExecutor(): HookCommandExecutor { return this.cmd; }
  getHttpExecutor(): HookHttpExecutor { return this.http; }
  getAgentExecutor(): HookAgentExecutor { return this.agent; }
  getFunctionExecutor(): HookFunctionExecutor { return this.fn; }

  /**
   * Get per-type execution breakdown.
   */
  getTypeBreakdown(): Record<string, { count: number; avgMs: number; errorRate: number }> {
    const result: Record<string, { count: number; avgMs: number; errorRate: number }> = {};
    for (const [type, stats] of Object.entries(this.stats.byType)) {
      result[type] = {
        count: stats.count,
        avgMs: stats.count > 0 ? stats.totalMs / stats.count : 0,
        errorRate: stats.count > 0 ? stats.errors / stats.count : 0,
      };
    }
    return result;
  }

  // ─── Internal ────────────────────────────────────────────────────

  private initTypeStats(type: string): void {
    if (!this.stats.byType[type]) {
      this.stats.byType[type] = { count: 0, totalMs: 0, errors: 0 };
    }
  }
}
