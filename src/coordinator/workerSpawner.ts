/**
 * workerSpawner.ts — Spawn worker sub-agents via AgentTool
 *
 * Manages the lifecycle of worker agents:
 *   - Single spawn (await completion)
 *   - Parallel spawn (concurrent workers)
 *   - Sequential spawn (one at a time, stop on failure)
 *   - Max concurrent enforcement
 *   - Worker tracking and kill
 *   - Statistics collection
 */

import * as crypto from 'crypto';
import type {
  CoordinatorConfig, CoordinatorWorkerType, WorkerSpawnRequest,
  WorkerSpawnResult, AgentToolExecutor, CoordinatorStats,
} from './types.js';
import type { ScratchpadManager } from './scratchpadManager.js';
import { buildWorkerPreamble } from './coordinatorPrompt.js';

// ════════════════════════════════════════════════════════════════════════════
// WorkerSpawner Class
// ════════════════════════════════════════════════════════════════════════════

export class WorkerSpawner {
  private activeWorkers = new Map<string, WorkerSpawnResult>();
  private completedWorkers: WorkerSpawnResult[] = [];

  // Stats
  private totalSpawned = 0;
  private totalCompleted = 0;
  private totalFailed = 0;
  private totalCostUsd = 0;
  private totalTokensUsed = 0;
  private totalDurationMs = 0;
  private byType: Record<CoordinatorWorkerType, number> = {
    researcher: 0, implementer: 0, verifier: 0, general: 0,
  };

  constructor(
    private readonly config: CoordinatorConfig,
    private readonly agentToolExecutor: AgentToolExecutor,
    private readonly scratchpad: ScratchpadManager,
  ) {}

  // ─── Single Spawn ────────────────────────────────────────────────

  /**
   * Spawn a single worker and wait for completion.
   * Enforces max concurrent workers limit.
   */
  async spawn(request: WorkerSpawnRequest): Promise<WorkerSpawnResult> {
    // Enforce concurrency limit
    if (this.activeWorkers.size >= this.config.maxConcurrentWorkers) {
      throw new Error(`Max concurrent workers (${this.config.maxConcurrentWorkers}) reached. Wait for active workers to complete.`);
    }

    const workerId = `worker_${crypto.randomUUID().slice(0, 8)}`;
    const startedAt = Date.now();

    const result: WorkerSpawnResult = {
      workerId,
      startedAt,
      status: 'running',
      workerType: request.workerType,
    };

    this.activeWorkers.set(workerId, result);
    this.totalSpawned++;
    this.byType[request.workerType]++;

    try {
      // Build the full worker prompt with preamble and scratchpad info
      const fullPrompt = this.buildWorkerPrompt(request);

      // Get allowed tools for this worker type
      const allowedTools = this.getAllowedTools(request.workerType);

      // Spawn via AgentTool executor
      const agentResult = await this.agentToolExecutor.execute({
        description: request.description,
        prompt: fullPrompt,
        subagent_type: this.mapWorkerTypeToSubagentType(request.workerType),
        budgetUsd: request.budgetUsd ?? this.config.defaultWorkerBudgetUsd,
        maxTurns: request.maxTurns ?? this.config.defaultWorkerMaxTurns,
        allowedTools,
      });

      result.status = agentResult.success ? 'completed' : 'failed';
      result.result = agentResult.result;
      result.tokensUsed = agentResult.tokensUsed;
      result.costUsd = agentResult.costUsd;
      result.durationMs = Date.now() - startedAt;
      result.toolUseCount = agentResult.toolUseCount;

      // Update stats
      if (result.status === 'completed') this.totalCompleted++;
      else this.totalFailed++;
      this.totalCostUsd += result.costUsd ?? 0;
      this.totalTokensUsed += result.tokensUsed ?? 0;
      this.totalDurationMs += result.durationMs;

      return result;
    } catch (err) {
      result.status = 'failed';
      result.result = `Worker error: ${(err as Error).message}`;
      result.durationMs = Date.now() - startedAt;
      this.totalFailed++;
      return result;
    } finally {
      this.activeWorkers.delete(workerId);
      this.completedWorkers.push(result);
      if (this.completedWorkers.length > 100) {
        this.completedWorkers = this.completedWorkers.slice(-50);
      }
    }
  }

  // ─── Parallel Spawn ──────────────────────────────────────────────

  /**
   * Spawn multiple workers in parallel.
   * All workers run concurrently up to maxConcurrentWorkers.
   */
  async spawnParallel(requests: WorkerSpawnRequest[]): Promise<WorkerSpawnResult[]> {
    if (requests.length + this.activeWorkers.size > this.config.maxConcurrentWorkers) {
      throw new Error(
        `Cannot spawn ${requests.length} workers (${this.activeWorkers.size} active, max ${this.config.maxConcurrentWorkers})`
      );
    }

    return Promise.all(requests.map(r => this.spawn(r)));
  }

  // ─── Sequential Spawn ────────────────────────────────────────────

  /**
   * Spawn workers one at a time, in order.
   * Stops on first failure unless continueOnFailure is true.
   */
  async spawnSequential(
    requests: WorkerSpawnRequest[],
    continueOnFailure: boolean = false,
  ): Promise<WorkerSpawnResult[]> {
    const results: WorkerSpawnResult[] = [];

    for (const request of requests) {
      const result = await this.spawn(request);
      results.push(result);

      if (result.status === 'failed' && !continueOnFailure) {
        break;
      }
    }

    return results;
  }

  // ─── Worker Management ───────────────────────────────────────────

  /**
   * Get currently active workers.
   */
  getActiveWorkers(): WorkerSpawnResult[] {
    return Array.from(this.activeWorkers.values());
  }

  /**
   * Get recently completed workers.
   */
  getCompletedWorkers(): WorkerSpawnResult[] {
    return [...this.completedWorkers];
  }

  /**
   * Kill a running worker.
   */
  killWorker(workerId: string): boolean {
    const worker = this.activeWorkers.get(workerId);
    if (!worker) return false;

    worker.status = 'killed';
    worker.durationMs = Date.now() - worker.startedAt;
    this.activeWorkers.delete(workerId);
    this.completedWorkers.push(worker);
    return true;
  }

  /**
   * Kill all active workers.
   */
  killAll(): number {
    let killed = 0;
    for (const [id] of this.activeWorkers) {
      if (this.killWorker(id)) killed++;
    }
    return killed;
  }

  // ─── Statistics ──────────────────────────────────────────────────

  /**
   * Get coordinator statistics.
   */
  getStats(): CoordinatorStats {
    return {
      totalWorkersSpawned: this.totalSpawned,
      activeWorkers: this.activeWorkers.size,
      completedWorkers: this.totalCompleted,
      failedWorkers: this.totalFailed,
      totalCostUsd: this.totalCostUsd,
      totalTokensUsed: this.totalTokensUsed,
      avgWorkerDurationMs: this.totalSpawned > 0 ? this.totalDurationMs / this.totalSpawned : 0,
      byType: { ...this.byType },
      currentPhase: 'idle',
    };
  }

  // ─── Internal ────────────────────────────────────────────────────

  /**
   * Build the full worker prompt with preamble and scratchpad info.
   */
  private buildWorkerPrompt(request: WorkerSpawnRequest): string {
    const parts: string[] = [];

    // Worker preamble (sets role and constraints)
    parts.push(buildWorkerPreamble({
      workerType: request.workerType,
      workspaceRoot: request.workspaceRoot,
      scratchpadDir: request.inheritScratchpad ? this.config.scratchpadDir : undefined,
    }));

    // Main prompt from coordinator
    parts.push(request.prompt);

    // Scratchpad instructions if applicable
    if (request.inheritScratchpad && this.config.scratchpadDir) {
      parts.push('');
      parts.push('---');
      parts.push(`Shared scratchpad available at: ${this.config.scratchpadDir}`);
      parts.push('You can read existing entries and write new findings here.');
    }

    return parts.join('\n');
  }

  /**
   * Get allowed tools for a worker type.
   */
  private getAllowedTools(workerType: CoordinatorWorkerType): string[] {
    return this.config.workerToolWhitelist[workerType] ?? [];
  }

  /**
   * Map worker type to AgentTool subagent_type parameter.
   */
  private mapWorkerTypeToSubagentType(type: CoordinatorWorkerType): string {
    switch (type) {
      case 'researcher': return 'researcher';
      case 'implementer': return 'implementer';
      case 'verifier': return 'verifier';
      case 'general': return 'general';
    }
  }
}
