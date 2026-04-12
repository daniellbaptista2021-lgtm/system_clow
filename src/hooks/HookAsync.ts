/**
 * HookAsync.ts — Async hook registry for background hooks
 *
 * Based on Claude Code's hookAsync.ts (~200 lines)
 *
 * Tracks hooks that run asynchronously (background commands, long-running HTTP).
 * Supports re-wake: when an async hook completes, it can wake the session
 * to process the result.
 *
 * Features:
 *   - Register async hook tasks
 *   - Complete with result
 *   - Cancel individual tasks or entire sessions
 *   - Re-wake handlers (notify session on completion)
 *   - Timeout detection
 *   - Statistics tracking
 *   - Session-scoped listing
 *   - Timeout escalation
 *   - Progress tracking for long-running hooks
 *   - Async hook health checking
 *   - Stale task cleanup scheduling
 *   - Completion callbacks with context
 */

import { randomUUID } from 'crypto';
import type { ConfiguredHook, PendingAsyncHook, AsyncHookCompletion, HookOutput, HookEventName } from './types.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_ASYNC_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const MAX_PENDING_PER_SESSION = 50;
const HEALTH_CHECK_INTERVAL_MS = 30_000; // 30 seconds
const STALE_CHECK_INTERVAL_MS = 60_000; // 1 minute
const PROGRESS_REPORT_INTERVAL_MS = 10_000; // 10 seconds

/** Escalation tiers: after each threshold, increase severity */
const TIMEOUT_ESCALATION_TIERS = [
  { thresholdMs: 60_000, level: 'warning' as const },
  { thresholdMs: 180_000, level: 'critical' as const },
  { thresholdMs: 300_000, level: 'kill' as const },
];

// ─── Types ──────────────────────────────────────────────────────────────────

interface AsyncStats {
  totalRegistered: number;
  totalCompleted: number;
  totalCancelled: number;
  totalTimedOut: number;
  currentPending: number;
  totalEscalations: number;
  avgCompletionMs: number;
  healthCheckCount: number;
}

/** Progress information for a long-running task */
interface TaskProgress {
  taskId: string;
  percent: number;
  message: string;
  updatedAt: number;
}

/** Health status of the async hook system */
interface HealthStatus {
  healthy: boolean;
  pendingCount: number;
  staleTasks: string[];
  oldestTaskAgeMs: number;
  escalatedTasks: string[];
  lastHealthCheck: number;
}

/** Escalation record */
interface EscalationRecord {
  taskId: string;
  level: 'warning' | 'critical' | 'kill';
  at: number;
  ageMs: number;
}

/** Completion callback with context */
type CompletionCallback = (completion: AsyncHookCompletion, context: CompletionContext) => void;

interface CompletionContext {
  sessionId: string;
  event: HookEventName;
  taskAgeMs: number;
  wasEscalated: boolean;
  progressAtCompletion: number;
}

// ════════════════════════════════════════════════════════════════════════════
// AsyncHookRegistry Class
// ════════════════════════════════════════════════════════════════════════════

export class AsyncHookRegistry {
  private pending = new Map<string, PendingAsyncHook>();
  private handlers = new Set<(completion: AsyncHookCompletion) => void>();
  private completionHistory: AsyncHookCompletion[] = [];

  // Progress tracking
  private progressMap = new Map<string, TaskProgress>();

  // Escalation tracking
  private escalationHistory: EscalationRecord[] = [];
  private escalatedTasks = new Set<string>();

  // Health check
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private lastHealthCheck: number = 0;

  // Stale task cleanup
  private staleCleanupTimer: ReturnType<typeof setInterval> | null = null;

  // Completion callbacks with context
  private contextCallbacks = new Set<CompletionCallback>();

  // Completion time tracking for averages
  private completionTimesMs: number[] = [];

  private stats: AsyncStats = {
    totalRegistered: 0,
    totalCompleted: 0,
    totalCancelled: 0,
    totalTimedOut: 0,
    currentPending: 0,
    totalEscalations: 0,
    avgCompletionMs: 0,
    healthCheckCount: 0,
  };

  /**
   * Register a new async hook task.
   * Returns the task ID for tracking.
   */
  register(hook: ConfiguredHook, sessionId: string): string {
    const id = `async_${randomUUID().slice(0, 12)}`;

    // Check per-session limit
    const sessionCount = this.listForSession(sessionId).length;
    if (sessionCount >= MAX_PENDING_PER_SESSION) {
      throw new Error(`Too many pending async hooks for session ${sessionId} (max ${MAX_PENDING_PER_SESSION})`);
    }

    this.pending.set(id, {
      id,
      hookId: hook.id,
      sessionId,
      event: hook.event,
      startedAt: Date.now(),
      rewake: false,
    });

    // Initialize progress for the new task
    this.progressMap.set(id, {
      taskId: id,
      percent: 0,
      message: 'Started',
      updatedAt: Date.now(),
    });

    this.stats.totalRegistered++;
    this.stats.currentPending = this.pending.size;

    return id;
  }

  /**
   * Set whether a task should re-wake the session on completion.
   */
  setRewake(taskId: string, rewake: boolean): void {
    const p = this.pending.get(taskId);
    if (p) p.rewake = rewake;
  }

  /**
   * Complete an async hook task with a result.
   */
  complete(taskId: string, result: HookOutput): void {
    const p = this.pending.get(taskId);
    if (!p) return;

    const durationMs = Date.now() - p.startedAt;

    const completion: AsyncHookCompletion = {
      hookId: p.hookId,
      result,
      durationMs,
    };

    // Track completion time for averages
    this.completionTimesMs.push(durationMs);
    if (this.completionTimesMs.length > 200) {
      this.completionTimesMs = this.completionTimesMs.slice(-100);
    }
    this.stats.avgCompletionMs = this.completionTimesMs.reduce((a, b) => a + b, 0) / this.completionTimesMs.length;

    // Store in history
    this.completionHistory.push(completion);
    if (this.completionHistory.length > 100) {
      this.completionHistory = this.completionHistory.slice(-50);
    }

    // Build context for contextual callbacks
    const progress = this.progressMap.get(taskId);
    const context: CompletionContext = {
      sessionId: p.sessionId,
      event: p.event,
      taskAgeMs: durationMs,
      wasEscalated: this.escalatedTasks.has(taskId),
      progressAtCompletion: progress?.percent ?? 100,
    };

    // Notify context callbacks
    for (const cb of this.contextCallbacks) {
      try { cb(completion, context); } catch { /* ignore */ }
    }

    // Notify handlers if rewake is enabled
    if (p.rewake) {
      for (const handler of this.handlers) {
        try { handler(completion); } catch {}
      }
    }

    // Clean up tracking data
    this.pending.delete(taskId);
    this.progressMap.delete(taskId);
    this.escalatedTasks.delete(taskId);

    this.stats.totalCompleted++;
    this.stats.currentPending = this.pending.size;
  }

  /**
   * Cancel an async hook task.
   */
  cancel(taskId: string): boolean {
    const p = this.pending.get(taskId);
    if (!p) return false;

    // Kill process if it has one
    if (p.processHandle) {
      try { p.processHandle.kill('SIGTERM'); } catch {}
    }

    this.pending.delete(taskId);
    this.progressMap.delete(taskId);
    this.escalatedTasks.delete(taskId);

    this.stats.totalCancelled++;
    this.stats.currentPending = this.pending.size;
    return true;
  }

  /**
   * Cancel all async hooks for a session.
   */
  cancelSession(sessionId: string): number {
    let count = 0;
    for (const [id, p] of this.pending) {
      if (p.sessionId === sessionId) {
        if (this.cancel(id)) count++;
      }
    }
    return count;
  }

  /**
   * Check for and clean up timed-out tasks.
   */
  cleanupTimedOut(timeoutMs: number = DEFAULT_ASYNC_TIMEOUT_MS): number {
    const cutoff = Date.now() - timeoutMs;
    let cleaned = 0;

    for (const [id, p] of this.pending) {
      if (p.startedAt < cutoff) {
        this.cancel(id);
        this.stats.totalTimedOut++;
        cleaned++;
      }
    }

    return cleaned;
  }

  // ─── Timeout Escalation ─────────────────────────────────────────

  /**
   * Check all pending tasks for timeout escalation.
   * Returns escalation records for tasks that have crossed tier thresholds.
   */
  checkEscalations(): EscalationRecord[] {
    const now = Date.now();
    const newEscalations: EscalationRecord[] = [];

    for (const [id, p] of this.pending) {
      const ageMs = now - p.startedAt;

      // Find the highest applicable tier
      let applicableTier: typeof TIMEOUT_ESCALATION_TIERS[number] | null = null;
      for (const tier of TIMEOUT_ESCALATION_TIERS) {
        if (ageMs >= tier.thresholdMs) {
          applicableTier = tier;
        }
      }

      if (!applicableTier) continue;

      // Check if we already escalated to this level
      const existingEscalation = this.escalationHistory.find(
        e => e.taskId === id && e.level === applicableTier!.level
      );
      if (existingEscalation) continue;

      const record: EscalationRecord = {
        taskId: id,
        level: applicableTier.level,
        at: now,
        ageMs,
      };

      this.escalationHistory.push(record);
      this.escalatedTasks.add(id);
      newEscalations.push(record);
      this.stats.totalEscalations++;

      // Kill-level escalation: force cancel the task
      if (applicableTier.level === 'kill') {
        if (p.processHandle) {
          try { p.processHandle.kill('SIGKILL'); } catch { /* ignore */ }
        }
        this.cancel(id);
        this.stats.totalTimedOut++;
      }
    }

    // Trim escalation history
    if (this.escalationHistory.length > 500) {
      this.escalationHistory = this.escalationHistory.slice(-250);
    }

    return newEscalations;
  }

  /**
   * Get escalation history for a task.
   */
  getEscalationHistory(taskId?: string): EscalationRecord[] {
    if (taskId) {
      return this.escalationHistory.filter(e => e.taskId === taskId);
    }
    return [...this.escalationHistory];
  }

  // ─── Progress Tracking ──────────────────────────────────────────

  /**
   * Update progress for a long-running task.
   */
  updateProgress(taskId: string, percent: number, message: string): void {
    if (!this.pending.has(taskId)) return;

    this.progressMap.set(taskId, {
      taskId,
      percent: Math.max(0, Math.min(100, percent)),
      message,
      updatedAt: Date.now(),
    });
  }

  /**
   * Get progress for a specific task.
   */
  getProgress(taskId: string): TaskProgress | null {
    return this.progressMap.get(taskId) ?? null;
  }

  /**
   * Get progress for all pending tasks.
   */
  getAllProgress(): TaskProgress[] {
    return [...this.progressMap.values()];
  }

  /**
   * Get progress for all tasks in a session.
   */
  getSessionProgress(sessionId: string): TaskProgress[] {
    const sessionTasks = this.listForSession(sessionId);
    return sessionTasks
      .map(t => this.progressMap.get(t.id))
      .filter((p): p is TaskProgress => p !== undefined);
  }

  /**
   * Check for tasks with stale progress (not updated recently).
   */
  getStaleProgressTasks(staleThresholdMs: number = PROGRESS_REPORT_INTERVAL_MS * 3): string[] {
    const now = Date.now();
    const stale: string[] = [];

    for (const [taskId, progress] of this.progressMap) {
      if (now - progress.updatedAt > staleThresholdMs && progress.percent < 100) {
        stale.push(taskId);
      }
    }

    return stale;
  }

  // ─── Health Checking ────────────────────────────────────────────

  /**
   * Start periodic health checks.
   */
  startHealthChecks(intervalMs: number = HEALTH_CHECK_INTERVAL_MS): void {
    this.stopHealthChecks();
    this.healthCheckTimer = setInterval(() => {
      this.runHealthCheck();
    }, intervalMs);
  }

  /**
   * Stop periodic health checks.
   */
  stopHealthChecks(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  /**
   * Run a single health check and return status.
   */
  runHealthCheck(): HealthStatus {
    const now = Date.now();
    this.lastHealthCheck = now;
    this.stats.healthCheckCount++;

    // Check for tasks with dead processes
    const staleTasks: string[] = [];
    let oldestAge = 0;

    for (const [id, p] of this.pending) {
      const ageMs = now - p.startedAt;
      if (ageMs > oldestAge) oldestAge = ageMs;

      // Check if process is still alive
      if (p.processHandle) {
        try {
          // Sending signal 0 checks if process exists without killing it
          p.processHandle.kill(0);
        } catch {
          staleTasks.push(id);
        }
      }
    }

    // Run escalation checks
    this.checkEscalations();

    const healthy = staleTasks.length === 0 &&
      this.pending.size < MAX_PENDING_PER_SESSION * 0.8 &&
      oldestAge < TIMEOUT_ESCALATION_TIERS[TIMEOUT_ESCALATION_TIERS.length - 1].thresholdMs;

    return {
      healthy,
      pendingCount: this.pending.size,
      staleTasks,
      oldestTaskAgeMs: oldestAge,
      escalatedTasks: [...this.escalatedTasks],
      lastHealthCheck: now,
    };
  }

  /**
   * Get the last health check timestamp.
   */
  getLastHealthCheckTime(): number {
    return this.lastHealthCheck;
  }

  // ─── Stale Task Cleanup Scheduling ──────────────────────────────

  /**
   * Start periodic stale task cleanup.
   */
  startStaleCleanup(intervalMs: number = STALE_CHECK_INTERVAL_MS, timeoutMs: number = DEFAULT_ASYNC_TIMEOUT_MS): void {
    this.stopStaleCleanup();
    this.staleCleanupTimer = setInterval(() => {
      this.cleanupTimedOut(timeoutMs);
    }, intervalMs);
  }

  /**
   * Stop periodic stale task cleanup.
   */
  stopStaleCleanup(): void {
    if (this.staleCleanupTimer) {
      clearInterval(this.staleCleanupTimer);
      this.staleCleanupTimer = null;
    }
  }

  /**
   * Cleanup tasks with dead processes immediately.
   */
  cleanupDeadProcessTasks(): number {
    let cleaned = 0;

    for (const [id, p] of this.pending) {
      if (!p.processHandle) continue;

      try {
        p.processHandle.kill(0);
      } catch {
        // Process is dead, clean up the task
        this.cancel(id);
        cleaned++;
      }
    }

    return cleaned;
  }

  /**
   * Shutdown: stop all scheduled operations and cancel pending tasks.
   */
  shutdown(): void {
    this.stopHealthChecks();
    this.stopStaleCleanup();

    // Cancel all pending tasks
    for (const [id] of this.pending) {
      this.cancel(id);
    }

    this.progressMap.clear();
    this.escalatedTasks.clear();
    this.contextCallbacks.clear();
    this.handlers.clear();
  }

  // ─── Completion Callbacks with Context ──────────────────────────

  /**
   * Register a completion callback that receives context about the task.
   */
  onCompletionWithContext(callback: CompletionCallback): () => void {
    this.contextCallbacks.add(callback);
    return () => { this.contextCallbacks.delete(callback); };
  }

  // ─── Queries ─────────────────────────────────────────────────────

  list(): PendingAsyncHook[] {
    return [...this.pending.values()];
  }

  listForSession(sessionId: string): PendingAsyncHook[] {
    return this.list().filter(p => p.sessionId === sessionId);
  }

  get(taskId: string): PendingAsyncHook | null {
    return this.pending.get(taskId) ?? null;
  }

  hasPending(sessionId: string): boolean {
    return this.listForSession(sessionId).length > 0;
  }

  /**
   * Get pending tasks grouped by session.
   */
  listBySession(): Map<string, PendingAsyncHook[]> {
    const grouped = new Map<string, PendingAsyncHook[]>();
    for (const p of this.pending.values()) {
      const list = grouped.get(p.sessionId) ?? [];
      list.push(p);
      grouped.set(p.sessionId, list);
    }
    return grouped;
  }

  /**
   * Get pending tasks grouped by event type.
   */
  listByEvent(): Map<HookEventName, PendingAsyncHook[]> {
    const grouped = new Map<HookEventName, PendingAsyncHook[]>();
    for (const p of this.pending.values()) {
      const list = grouped.get(p.event) ?? [];
      list.push(p);
      grouped.set(p.event, list);
    }
    return grouped;
  }

  // ─── Events ──────────────────────────────────────────────────────

  onCompletion(handler: (completion: AsyncHookCompletion) => void): () => void {
    this.handlers.add(handler);
    return () => { this.handlers.delete(handler); };
  }

  // ─── Statistics ──────────────────────────────────────────────────

  getStats(): AsyncStats {
    return { ...this.stats, currentPending: this.pending.size };
  }

  getCompletionHistory(): AsyncHookCompletion[] {
    return [...this.completionHistory];
  }
}
