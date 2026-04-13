/**
 * types.ts — Coordinator Mode type vocabulary
 *
 * Defines all types for the coordinator/worker orchestration system.
 * The coordinator dispatches workers (sub-agents) to perform tasks,
 * synthesizes results, and manages the overall workflow.
 *
 * Worker types:
 *   - researcher: read-only investigation (explore, search, gather context)
 *   - implementer: write-capable (edit files, run builds, create tests)
 *   - verifier: independent verification (run tests, check builds)
 *   - general: mixed work (all tools except Agent to prevent recursion)
 */

// ════════════════════════════════════════════════════════════════════════════
// Worker Types
// ════════════════════════════════════════════════════════════════════════════

export type CoordinatorWorkerType = 'researcher' | 'implementer' | 'verifier' | 'general';

// ════════════════════════════════════════════════════════════════════════════
// Configuration
// ════════════════════════════════════════════════════════════════════════════

export interface CoordinatorConfig {
  /** Whether coordinator mode is active */
  enabled: boolean;
  /** Directory for cross-worker shared data */
  scratchpadDir?: string;
  /** Maximum number of concurrent workers */
  maxConcurrentWorkers: number;
  /** Default USD budget per worker */
  defaultWorkerBudgetUsd: number;
  /** Default max turns per worker */
  defaultWorkerMaxTurns: number;
  /** Tools the coordinator itself is forbidden from using */
  forbidCoordinatorTools: string[];
  /** Per-worker-type tool whitelists */
  workerToolWhitelist: Record<CoordinatorWorkerType, string[]>;
}

export const DEFAULT_COORDINATOR_CONFIG: CoordinatorConfig = {
  enabled: false,
  maxConcurrentWorkers: 5,
  defaultWorkerBudgetUsd: 1.0,
  defaultWorkerMaxTurns: 30,
  forbidCoordinatorTools: [
    'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
    'WebFetch', 'WebSearch',
  ],
  workerToolWhitelist: {
    researcher: ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Bash', 'TodoWrite'],
    implementer: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'TodoWrite', 'WebFetch'],
    verifier: ['Read', 'Glob', 'Grep', 'Bash', 'TodoWrite'],
    general: ['*'],  // all except Agent (prevent recursion)
  },
};

// ════════════════════════════════════════════════════════════════════════════
// Worker Spawn
// ════════════════════════════════════════════════════════════════════════════

export interface WorkerSpawnRequest {
  /** Short label for UI display */
  description: string;
  /** Self-contained instruction for the worker */
  prompt: string;
  /** Type of worker to spawn */
  workerType: CoordinatorWorkerType;
  /** Parent session ID (for tracking) */
  parentSessionId: string;
  /** Workspace root for the worker */
  workspaceRoot: string;
  /** Override default budget for this worker */
  budgetUsd?: number;
  /** Override default max turns for this worker */
  maxTurns?: number;
  /** Whether worker should have access to the scratchpad */
  inheritScratchpad?: boolean;
}

export interface WorkerSpawnResult {
  /** Unique worker ID */
  workerId: string;
  /** When the worker was started */
  startedAt: number;
  /** Current status */
  status: 'running' | 'completed' | 'failed' | 'killed';
  /** Worker's final output */
  result?: string;
  /** Total tokens consumed */
  tokensUsed?: number;
  /** Cost in USD */
  costUsd?: number;
  /** Total duration in ms */
  durationMs?: number;
  /** Number of tool calls made */
  toolUseCount?: number;
  /** Worker type (for notification formatting) */
  workerType?: CoordinatorWorkerType;
}

// ════════════════════════════════════════════════════════════════════════════
// Task Notification (XML-based worker→coordinator communication)
// ════════════════════════════════════════════════════════════════════════════

export interface TaskNotification {
  /** Unique task/worker ID */
  taskId: string;
  /** Completion status */
  status: 'completed' | 'failed' | 'killed' | 'in_progress';
  /** Brief summary of what happened */
  summary: string;
  /** Full result text */
  result: string;
  /** Resource usage */
  usage: {
    totalTokens: number;
    toolUses: number;
    durationMs: number;
  };
  /** Type of worker that produced this */
  workerType: CoordinatorWorkerType;
}

// ════════════════════════════════════════════════════════════════════════════
// Synthesis (coordinator-only reasoning about worker outputs)
// ════════════════════════════════════════════════════════════════════════════

export interface SynthesisInput {
  /** All worker results to synthesize */
  workers: WorkerSpawnResult[];
  /** The original user request being fulfilled */
  originalUserRequest: string;
  /** Current workflow phase */
  phase: 'research' | 'implementation' | 'verification';
}

export interface SynthesisOutput {
  /** Synthesized summary */
  summary: string;
  /** Key findings extracted from workers */
  keyFindings: string[];
  /** Recommended next steps */
  nextSteps: string[];
  /** Issues blocking progress */
  blockers: string[];
}

// ════════════════════════════════════════════════════════════════════════════
// Scratchpad (cross-worker shared data)
// ════════════════════════════════════════════════════════════════════════════

export interface ScratchpadEntry {
  /** Entry key (sanitized for filesystem) */
  key: string;
  /** Entry value */
  value: string;
  /** ID of the worker that wrote this */
  writtenBy: string;
  /** Timestamp when written */
  writtenAt: number;
  /** Content type hint */
  contentType: 'text' | 'json' | 'markdown';
}

// ════════════════════════════════════════════════════════════════════════════
// Coordinator Context (propagated to workers)
// ════════════════════════════════════════════════════════════════════════════

export interface CoordinatorContextInjection {
  /** Whether we're in coordinator mode */
  isCoordinatorMode: boolean;
  /** If this is a worker, what type */
  workerType?: CoordinatorWorkerType;
  /** Shared scratchpad directory path */
  scratchpadDir?: string;
  /** Parent coordinator's session ID */
  parentCoordinatorSessionId?: string;
}

// ════════════════════════════════════════════════════════════════════════════
// Agent Tool Executor Interface (dependency injection)
// ════════════════════════════════════════════════════════════════════════════

export interface AgentToolExecutor {
  execute(params: {
    description: string;
    prompt: string;
    subagent_type: string;
    budgetUsd: number;
    maxTurns: number;
    allowedTools: string[];
  }): Promise<{
    success: boolean;
    result: string;
    tokensUsed: number;
    costUsd: number;
    toolUseCount: number;
  }>;
}

// ════════════════════════════════════════════════════════════════════════════
// Coordinator Stats
// ════════════════════════════════════════════════════════════════════════════

export interface CoordinatorStats {
  /** Total workers spawned */
  totalWorkersSpawned: number;
  /** Workers currently running */
  activeWorkers: number;
  /** Successfully completed workers */
  completedWorkers: number;
  /** Failed workers */
  failedWorkers: number;
  /** Total cost across all workers */
  totalCostUsd: number;
  /** Total tokens across all workers */
  totalTokensUsed: number;
  /** Average worker duration in ms */
  avgWorkerDurationMs: number;
  /** Workers by type */
  byType: Record<CoordinatorWorkerType, number>;
  /** Current phase */
  currentPhase: string;
}
