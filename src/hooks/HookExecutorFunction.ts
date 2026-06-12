/**
 * HookExecutorFunction.ts — Execute in-process function hooks (SDK use)
 *
 * Based on Claude Code's hookFunctionExecutor.ts (~150 lines)
 *
 * Function hooks are registered programmatically via the SDK.
 * They run in the same process, synchronously or asynchronously.
 *
 * Features:
 *   - Direct callback execution
 *   - Output validation via Zod
 *   - Error isolation (try/catch)
 *   - Timeout enforcement
 *   - Null result handling (treated as no-op)
 *   - Execution metrics
 */

import type { FunctionHookConfig, HookInput, HookOutput } from './types.js';
import { HookOutputSchema } from './HookSchemas.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_FUNCTION_TIMEOUT_MS = 10_000;

// ─── Types ──────────────────────────────────────────────────────────────────

interface FunctionExecutionStats {
  totalCalls: number;
  successCount: number;
  errorCount: number;
  nullResultCount: number;
  invalidOutputCount: number;
  totalDurationMs: number;
}

// ════════════════════════════════════════════════════════════════════════════
// HookFunctionExecutor Class
// ════════════════════════════════════════════════════════════════════════════

export class HookFunctionExecutor {
  private stats: FunctionExecutionStats = {
    totalCalls: 0,
    successCount: 0,
    errorCount: 0,
    nullResultCount: 0,
    invalidOutputCount: 0,
    totalDurationMs: 0,
  };

  /**
   * Execute an in-process function hook.
   */
  async execute(config: FunctionHookConfig, input: HookInput): Promise<HookOutput> {
    const startTime = Date.now();
    this.stats.totalCalls++;

    try {
      // Execute with timeout
      const result = await Promise.race([
        config.callback(input),
        this.timeout(DEFAULT_FUNCTION_TIMEOUT_MS),
      ]);

      const durationMs = Date.now() - startTime;
      this.stats.totalDurationMs += durationMs;

      // Null result = no-op
      if (!result) {
        this.stats.nullResultCount++;
        return {};
      }

      // Validate output shape
      const validation = HookOutputSchema.safeParse(result);
      if (!validation.success) {
        this.stats.invalidOutputCount++;
        return {
          systemMessage: `[hook function] Invalid output shape`,
        };
      }

      this.stats.successCount++;
      return validation.data;

    } catch (err: any) {
      this.stats.errorCount++;
      this.stats.totalDurationMs += Date.now() - startTime;

      if (err.message === 'Hook function timeout') {
        return {
          systemMessage: `[hook function timeout] Exceeded ${DEFAULT_FUNCTION_TIMEOUT_MS}ms`,
        };
      }

      return {
        systemMessage: `[hook function error] ${err.message}`,
      };
    }
  }

  /**
   * Get execution statistics.
   */
  getStats(): FunctionExecutionStats {
    return { ...this.stats };
  }

  /**
   * Reset statistics.
   */
  resetStats(): void {
    this.stats = {
      totalCalls: 0,
      successCount: 0,
      errorCount: 0,
      nullResultCount: 0,
      invalidOutputCount: 0,
      totalDurationMs: 0,
    };
  }

  // ─── Batch Execution ──────────────────────────────────────────

  /**
   * Execute multiple function hooks in parallel.
   * Returns results in the same order as inputs.
   */
  async executeBatch(
    configs: Array<{ config: FunctionHookConfig; input: HookInput }>,
  ): Promise<HookOutput[]> {
    return Promise.all(
      configs.map(({ config, input }) => this.execute(config, input)),
    );
  }

  /**
   * Execute with custom timeout override.
   */
  async executeWithTimeout(config: FunctionHookConfig, input: HookInput, timeoutMs: number): Promise<HookOutput> {
    const startTime = Date.now();
    this.stats.totalCalls++;

    try {
      const result = await Promise.race([
        config.callback(input),
        this.timeout(timeoutMs),
      ]);

      this.stats.totalDurationMs += Date.now() - startTime;

      if (!result) {
        this.stats.nullResultCount++;
        return {};
      }

      const validation = HookOutputSchema.safeParse(result);
      if (!validation.success) {
        this.stats.invalidOutputCount++;
        return { systemMessage: '[hook function] Invalid output shape' };
      }

      this.stats.successCount++;
      return validation.data;
    } catch (err: any) {
      this.stats.errorCount++;
      this.stats.totalDurationMs += Date.now() - startTime;
      return { systemMessage: `[hook function error] ${err.message}` };
    }
  }

  /**
   * Get average execution time in ms.
   */
  getAvgDurationMs(): number {
    return this.stats.totalCalls > 0 ? this.stats.totalDurationMs / this.stats.totalCalls : 0;
  }

  /**
   * Get success rate (0-1).
   */
  getSuccessRate(): number {
    return this.stats.totalCalls > 0 ? this.stats.successCount / this.stats.totalCalls : 0;
  }

  // ─── Internal ────────────────────────────────────────────────────

  private timeout(ms: number): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Hook function timeout')), ms);
    });
  }
}
