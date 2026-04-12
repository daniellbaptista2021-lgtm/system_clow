/**
 * CoordinatorMode.ts — Main orchestrator for coordinator mode
 *
 * This is the top-level class that ties together all coordinator components.
 * When coordinator mode is active, this class:
 *   - Builds the coordinator system prompt (replacing normal prompt)
 *   - Filters tools (coordinator can only use Agent + task management)
 *   - Spawns workers via WorkerSpawner
 *   - Manages the scratchpad for cross-worker data
 *   - Builds task notifications for worker results
 *   - Provides synthesis helpers for coordinator reasoning
 *   - Tracks coordinator statistics
 *
 * Integration points:
 *   - QueryEngine uses this to override system prompt and tools
 *   - Permission pipeline uses CoordinatorContext for Stage 0
 *   - AgentTool uses WorkerSpawner for actual spawning
 */

import type {
  CoordinatorConfig, CoordinatorWorkerType, WorkerSpawnRequest,
  WorkerSpawnResult, AgentToolExecutor, SynthesisInput,
  CoordinatorStats, CoordinatorContextInjection,
} from './types.js';
import { DEFAULT_COORDINATOR_CONFIG } from './types.js';
import { buildCoordinatorSystemPrompt, buildWorkerPreamble } from './coordinatorPrompt.js';
import { WorkerSpawner } from './workerSpawner.js';
import { WorkerToolFiltering } from './workerToolFiltering.js';
import { TaskNotificationParser } from './taskNotificationParser.js';
import { SynthesisHelpers } from './synthesisHelpers.js';
import { ScratchpadManager } from './scratchpadManager.js';
import { CoordinatorContext } from './coordinatorContext.js';
import { isCoordinatorModeEnabled } from './modeDetection.js';

// ─── Types ──────────────────────────────────────────────────────────────────

type CoordinatorPhase = 'idle' | 'research' | 'synthesis' | 'implementation' | 'verification' | 'complete';

interface ToolLike {
  name: string;
}

// ════════════════════════════════════════════════════════════════════════════
// CoordinatorMode Class
// ════════════════════════════════════════════════════════════════════════════

export class CoordinatorMode {
  private spawner: WorkerSpawner;
  private scratchpad?: ScratchpadManager;
  private currentPhase: CoordinatorPhase = 'idle';
  private phaseHistory: Array<{ phase: CoordinatorPhase; startedAt: number; endedAt?: number }> = [];
  private initialized = false;

  constructor(
    private readonly config: CoordinatorConfig = DEFAULT_COORDINATOR_CONFIG,
    agentToolExecutor: AgentToolExecutor,
  ) {
    if (config.scratchpadDir) {
      this.scratchpad = new ScratchpadManager(config.scratchpadDir);
    }

    this.spawner = new WorkerSpawner(
      config,
      agentToolExecutor,
      this.scratchpad ?? new ScratchpadManager('/tmp/clow-scratchpad-noop'),
    );
  }

  // ─── Initialization ──────────────────────────────────────────────

  /**
   * Initialize coordinator mode.
   * Creates scratchpad directory if configured.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    if (this.scratchpad) {
      await this.scratchpad.initialize();
    }

    // Validate config
    const validation = WorkerToolFiltering.validateConfig(this.config);
    if (!validation.valid) {
      console.warn(`[CoordinatorMode] Config warnings: ${validation.errors.join(', ')}`);
    }

    this.initialized = true;
    this.setPhase('idle');
  }

  // ─── System Prompt ───────────────────────────────────────────────

  /**
   * Build the coordinator system prompt.
   * This REPLACES the normal system prompt when coordinator mode is active.
   */
  buildSystemPrompt(params: {
    workspaceRoot: string;
    mcpServerNames: string[];
  }): string {
    const workerToolDescriptions: Record<CoordinatorWorkerType, string> = {
      researcher: WorkerToolFiltering.describeWorkerTools('researcher', this.config),
      implementer: WorkerToolFiltering.describeWorkerTools('implementer', this.config),
      verifier: WorkerToolFiltering.describeWorkerTools('verifier', this.config),
      general: WorkerToolFiltering.describeWorkerTools('general', this.config),
    };

    return buildCoordinatorSystemPrompt({
      scratchpadDir: this.config.scratchpadDir,
      workspaceRoot: params.workspaceRoot,
      workerToolDescriptions,
      mcpServerNames: params.mcpServerNames,
    });
  }

  // ─── Tool Filtering ──────────────────────────────────────────────

  /**
   * Filter tools for the coordinator (remove execution tools).
   * Coordinator can only use Agent, Task management, Plan mode.
   */
  filterCoordinatorTools(allTools: ToolLike[]): ToolLike[] {
    return WorkerToolFiltering.filterForCoordinator(allTools, this.config);
  }

  /**
   * Filter tools for a specific worker type.
   */
  filterWorkerTools(allTools: ToolLike[], workerType: CoordinatorWorkerType): ToolLike[] {
    return WorkerToolFiltering.filterForWorker(allTools, workerType, this.config);
  }

  // ─── Worker Spawning ─────────────────────────────────────────────

  /**
   * Spawn a single worker and wait for completion.
   */
  async spawnWorker(request: WorkerSpawnRequest): Promise<WorkerSpawnResult> {
    return this.spawner.spawn(request);
  }

  /**
   * Spawn multiple workers in parallel.
   */
  async spawnParallelWorkers(requests: WorkerSpawnRequest[]): Promise<WorkerSpawnResult[]> {
    return this.spawner.spawnParallel(requests);
  }

  /**
   * Spawn workers sequentially (stop on first failure).
   */
  async spawnSequentialWorkers(
    requests: WorkerSpawnRequest[],
    continueOnFailure?: boolean,
  ): Promise<WorkerSpawnResult[]> {
    return this.spawner.spawnSequential(requests, continueOnFailure);
  }

  /**
   * Kill a specific worker.
   */
  killWorker(workerId: string): boolean {
    return this.spawner.killWorker(workerId);
  }

  /**
   * Kill all active workers.
   */
  killAllWorkers(): number {
    return this.spawner.killAll();
  }

  // ─── Task Notifications ──────────────────────────────────────────

  /**
   * Build a task notification from a worker result.
   * This XML message is injected into the coordinator's conversation.
   */
  buildTaskNotification(result: WorkerSpawnResult): string {
    return TaskNotificationParser.buildNotification(result);
  }

  /**
   * Build batch notification for multiple parallel workers.
   */
  buildBatchNotification(results: WorkerSpawnResult[]): string {
    return TaskNotificationParser.buildBatchSummary(results);
  }

  /**
   * Parse task notifications from a message.
   */
  parseNotifications(content: string) {
    return TaskNotificationParser.findAllInMessage(content);
  }

  // ─── Synthesis ───────────────────────────────────────────────────

  /**
   * Format synthesis context for coordinator reasoning.
   */
  formatSynthesis(input: SynthesisInput): string {
    return SynthesisHelpers.formatSynthesisContext(input);
  }

  /**
   * Generate structured synthesis output.
   */
  synthesize(input: SynthesisInput) {
    return SynthesisHelpers.synthesize(input);
  }

  // ─── Scratchpad ──────────────────────────────────────────────────

  /**
   * Get the scratchpad manager (if configured).
   */
  getScratchpad(): ScratchpadManager | undefined {
    return this.scratchpad;
  }

  // ─── Context ─────────────────────────────────────────────────────

  /**
   * Build context injection for a worker spawn.
   */
  buildWorkerContext(
    workerType: CoordinatorWorkerType,
    parentSessionId: string,
  ): CoordinatorContextInjection {
    return CoordinatorContext.buildInjection(this.config, workerType, parentSessionId);
  }

  // ─── Phase Management ────────────────────────────────────────────

  /**
   * Set the current coordinator phase.
   */
  setPhase(phase: CoordinatorPhase): void {
    // Close previous phase
    const current = this.phaseHistory[this.phaseHistory.length - 1];
    if (current && !current.endedAt) {
      current.endedAt = Date.now();
    }

    this.currentPhase = phase;
    this.phaseHistory.push({ phase, startedAt: Date.now() });
  }

  getPhase(): CoordinatorPhase {
    return this.currentPhase;
  }

  getPhaseHistory() {
    return [...this.phaseHistory];
  }

  // ─── Status ──────────────────────────────────────────────────────

  isEnabled(): boolean {
    return this.config.enabled && isCoordinatorModeEnabled();
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  getConfig(): Readonly<CoordinatorConfig> {
    return { ...this.config };
  }

  getActiveWorkers(): WorkerSpawnResult[] {
    return this.spawner.getActiveWorkers();
  }

  getCompletedWorkers(): WorkerSpawnResult[] {
    return this.spawner.getCompletedWorkers();
  }

  /**
   * Get comprehensive coordinator statistics.
   */
  getStats(): CoordinatorStats {
    const stats = this.spawner.getStats();
    stats.currentPhase = this.currentPhase;
    return stats;
  }

  /**
   * Format a status line for display.
   */
  formatStatusLine(): string {
    const stats = this.getStats();
    const parts: string[] = [];
    parts.push(`[Coordinator: ${this.currentPhase}]`);
    parts.push(`Workers: ${stats.activeWorkers} active, ${stats.completedWorkers} done`);
    if (stats.totalCostUsd > 0) parts.push(`$${stats.totalCostUsd.toFixed(4)}`);
    return parts.join(' | ');
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Re-exports for convenience
// ════════════════════════════════════════════════════════════════════════════

export { WorkerSpawner } from './workerSpawner.js';
export { WorkerToolFiltering } from './workerToolFiltering.js';
export { TaskNotificationParser } from './taskNotificationParser.js';
export { SynthesisHelpers } from './synthesisHelpers.js';
export { ScratchpadManager } from './scratchpadManager.js';
export { CoordinatorContext } from './coordinatorContext.js';
export { buildCoordinatorSystemPrompt, buildWorkerPreamble } from './coordinatorPrompt.js';
export { isCoordinatorModeEnabled, setCoordinatorMode, matchSessionMode } from './modeDetection.js';
export type {
  CoordinatorConfig, CoordinatorWorkerType, WorkerSpawnRequest,
  WorkerSpawnResult, TaskNotification, SynthesisInput, SynthesisOutput,
  ScratchpadEntry, CoordinatorContextInjection, AgentToolExecutor,
  CoordinatorStats,
} from './types.js';
export { DEFAULT_COORDINATOR_CONFIG } from './types.js';
