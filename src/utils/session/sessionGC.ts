/**
 * SessionGC.ts — Garbage collect old sessions
 *
 * Based on Claude Code's sessionGC.ts (~200 lines)
 *
 * Features:
 *   - Remove sessions older than N days
 *   - Keep minimum N most recent sessions
 *   - Only collect closed/archived sessions (skip active)
 *   - File size tracking (bytes freed)
 *   - Dry-run mode
 *   - Statistics
 *   - Background execution
 *   - GC scheduling
 *   - Size-based triggers
 *   - Per-workspace GC policies
 *   - GC reporting
 *   - Incremental GC
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import type { SessionIndex } from './sessionIndex.js';
import { SESSION_GC_MAX_AGE_MS, SESSION_GC_MAX_SESSIONS } from './types.js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface GCResult {
  removed: number;
  freedBytes: number;
  skipped: number;
  errors: number;
  durationMs: number;
}

interface GCOptions {
  /** Max age in days (default 30) */
  olderThanDays?: number;
  /** Minimum sessions to keep regardless of age (default 50) */
  keepMin?: number;
  /** Only collect closed sessions (skip active/crashed) */
  onlyClosed?: boolean;
  /** Dry run — count but don't delete */
  dryRun?: boolean;
  /** Maximum number of sessions to remove per GC run */
  maxRemove?: number;
}

/** Per-workspace GC policy override */
interface WorkspaceGCPolicy {
  workspaceRoot: string;
  olderThanDays: number;
  keepMin: number;
  maxTotalSizeBytes: number;
  enabled: boolean;
}

/** Full GC report including per-run details and history */
interface GCReport {
  lastRun: GCResult | null;
  runHistory: Array<GCResult & { runAt: number }>;
  totalRemoved: number;
  totalFreedBytes: number;
  totalRuns: number;
  averageDurationMs: number;
  scheduledIntervalMs: number | null;
  workspacePolicies: WorkspaceGCPolicy[];
  diskUsage: { totalBytes: number; fileCount: number } | null;
}

/** Configuration for size-based GC triggers */
interface SizeTriggerConfig {
  /** Maximum total size in bytes before triggering GC */
  maxTotalSizeBytes: number;
  /** Check interval in ms */
  checkIntervalMs: number;
  /** Whether the trigger is active */
  enabled: boolean;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_SCHEDULE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_SIZE_TRIGGER: SizeTriggerConfig = {
  maxTotalSizeBytes: 500 * 1024 * 1024, // 500MB
  checkIntervalMs: 5 * 60 * 1000, // 5 minutes
  enabled: false,
};
const MAX_HISTORY_ENTRIES = 50;
const DEFAULT_INCREMENTAL_BATCH = 20;

// ════════════════════════════════════════════════════════════════════════════
// SessionGC Class
// ════════════════════════════════════════════════════════════════════════════

export class SessionGC {
  private lastResult: GCResult | null = null;
  private running = false;

  // Scheduling
  private scheduleTimer: ReturnType<typeof setInterval> | null = null;
  private scheduledOpts: GCOptions | null = null;

  // Size trigger
  private sizeTrigger: SizeTriggerConfig = { ...DEFAULT_SIZE_TRIGGER };
  private sizeTriggerTimer: ReturnType<typeof setInterval> | null = null;

  // History and reporting
  private runHistory: Array<GCResult & { runAt: number }> = [];
  private totalRemoved = 0;
  private totalFreedBytes = 0;
  private totalRuns = 0;

  // Per-workspace policies
  private workspacePolicies = new Map<string, WorkspaceGCPolicy>();

  // Incremental GC state
  private incrementalCursor = 0;

  constructor(
    private readonly clowHome: string,
    private readonly index: SessionIndex,
  ) {}

  /**
   * Run garbage collection.
   */
  async gc(opts: GCOptions = {}): Promise<GCResult> {
    if (this.running) {
      return { removed: 0, freedBytes: 0, skipped: 0, errors: 0, durationMs: 0 };
    }

    this.running = true;
    const startTime = Date.now();
    const olderThanDays = opts.olderThanDays ?? 30;
    const keepMin = opts.keepMin ?? 50;
    const maxRemove = opts.maxRemove ?? 500;
    const cutoff = Date.now() - olderThanDays * 86400_000;

    let removed = 0;
    let freedBytes = 0;
    let skipped = 0;
    let errors = 0;

    try {
      const all = await this.index.listAll();

      // Skip the first keepMin sessions (they're sorted newest-first)
      for (let i = keepMin; i < all.length && removed < maxRemove; i++) {
        const session = all[i];

        // Age check
        if (session.lastMessageAt > cutoff) {
          skipped++;
          continue;
        }

        // Status check
        if (opts.onlyClosed && session.status === 'active') {
          skipped++;
          continue;
        }

        // Skip active sessions by default
        if (session.status === 'active') {
          skipped++;
          continue;
        }

        // Check per-workspace policy
        const policy = this.getWorkspacePolicy(session.workspaceRoot);
        if (policy && !policy.enabled) {
          skipped++;
          continue;
        }

        if (policy) {
          const policyCutoff = Date.now() - policy.olderThanDays * 86400_000;
          if (session.lastMessageAt > policyCutoff) {
            skipped++;
            continue;
          }
        }

        if (opts.dryRun) {
          removed++;
          continue;
        }

        // Delete JSONL file
        const filePath = path.join(this.clowHome, 'sessions', `${session.id}.jsonl`);
        try {
          const stat = await fsp.stat(filePath);
          freedBytes += stat.size;
          await fsp.unlink(filePath);
        } catch (err: any) {
          if (err.code !== 'ENOENT') errors++;
        }

        // Delete lock file if exists
        try { await fsp.unlink(filePath + '.lock'); } catch {}

        // Remove from index
        await this.index.removeSession(session.id);
        removed++;
      }
    } catch (err) {
      errors++;
    } finally {
      this.running = false;
    }

    this.lastResult = {
      removed,
      freedBytes,
      skipped,
      errors,
      durationMs: Date.now() - startTime,
    };

    // Update history and totals
    this.runHistory.push({ ...this.lastResult, runAt: Date.now() });
    if (this.runHistory.length > MAX_HISTORY_ENTRIES) {
      this.runHistory = this.runHistory.slice(-MAX_HISTORY_ENTRIES);
    }
    this.totalRemoved += removed;
    this.totalFreedBytes += freedBytes;
    this.totalRuns++;

    if (removed > 0) {
      console.log(`[SessionGC] Removed ${removed} sessions, freed ${formatBytes(freedBytes)}`);
    }

    return this.lastResult;
  }

  /**
   * Run GC in background (fire-and-forget).
   */
  gcBackground(opts?: GCOptions): void {
    this.gc(opts).catch(err => {
      console.warn(`[SessionGC] Background GC failed: ${(err as Error).message}`);
    });
  }

  // ─── GC Scheduling ──────────────────────────────────────────────

  /**
   * Start scheduled GC at a regular interval.
   */
  startSchedule(intervalMs: number = DEFAULT_SCHEDULE_INTERVAL_MS, opts?: GCOptions): void {
    this.stopSchedule();
    this.scheduledOpts = opts ?? {};

    this.scheduleTimer = setInterval(() => {
      this.gcBackground(this.scheduledOpts ?? undefined);
    }, intervalMs);
  }

  /**
   * Stop scheduled GC.
   */
  stopSchedule(): void {
    if (this.scheduleTimer) {
      clearInterval(this.scheduleTimer);
      this.scheduleTimer = null;
    }
    this.scheduledOpts = null;
  }

  /**
   * Check if GC is scheduled.
   */
  isScheduled(): boolean {
    return this.scheduleTimer !== null;
  }

  // ─── Size-Based Triggers ────────────────────────────────────────

  /**
   * Configure and start size-based GC trigger.
   * When total session storage exceeds the threshold, GC runs automatically.
   */
  startSizeTrigger(config?: Partial<SizeTriggerConfig>): void {
    this.stopSizeTrigger();
    this.sizeTrigger = { ...DEFAULT_SIZE_TRIGGER, ...config, enabled: true };

    this.sizeTriggerTimer = setInterval(async () => {
      try {
        const usage = await this.getDiskUsage();
        if (usage.totalBytes > this.sizeTrigger.maxTotalSizeBytes) {
          console.log(`[SessionGC] Size trigger: ${formatBytes(usage.totalBytes)} exceeds ${formatBytes(this.sizeTrigger.maxTotalSizeBytes)}`);
          this.gcBackground();
        }
      } catch { /* ignore */ }
    }, this.sizeTrigger.checkIntervalMs);
  }

  /**
   * Stop size-based GC trigger.
   */
  stopSizeTrigger(): void {
    if (this.sizeTriggerTimer) {
      clearInterval(this.sizeTriggerTimer);
      this.sizeTriggerTimer = null;
    }
    this.sizeTrigger.enabled = false;
  }

  /**
   * Get the current size trigger configuration.
   */
  getSizeTriggerConfig(): Readonly<SizeTriggerConfig> {
    return { ...this.sizeTrigger };
  }

  // ─── Per-Workspace GC Policies ──────────────────────────────────

  /**
   * Set a GC policy for a specific workspace.
   */
  setWorkspacePolicy(policy: WorkspaceGCPolicy): void {
    this.workspacePolicies.set(policy.workspaceRoot, policy);
  }

  /**
   * Remove a workspace-specific GC policy.
   */
  removeWorkspacePolicy(workspaceRoot: string): void {
    this.workspacePolicies.delete(workspaceRoot);
  }

  /**
   * Get the GC policy for a workspace (returns null if using defaults).
   */
  getWorkspacePolicy(workspaceRoot: string): WorkspaceGCPolicy | null {
    return this.workspacePolicies.get(workspaceRoot) ?? null;
  }

  /**
   * List all configured workspace policies.
   */
  listWorkspacePolicies(): WorkspaceGCPolicy[] {
    return [...this.workspacePolicies.values()];
  }

  /**
   * Run GC for a specific workspace only.
   */
  async gcWorkspace(workspaceRoot: string, opts?: GCOptions): Promise<GCResult> {
    if (this.running) {
      return { removed: 0, freedBytes: 0, skipped: 0, errors: 0, durationMs: 0 };
    }

    this.running = true;
    const startTime = Date.now();
    const policy = this.getWorkspacePolicy(workspaceRoot);
    const olderThanDays = opts?.olderThanDays ?? policy?.olderThanDays ?? 30;
    const keepMin = opts?.keepMin ?? policy?.keepMin ?? 5;
    const cutoff = Date.now() - olderThanDays * 86400_000;

    let removed = 0;
    let freedBytes = 0;
    let skipped = 0;
    let errors = 0;

    try {
      const all = await this.index.listAll();
      const workspaceSessions = all.filter(s => s.workspaceRoot === workspaceRoot);

      for (let i = keepMin; i < workspaceSessions.length; i++) {
        const session = workspaceSessions[i];

        if (session.lastMessageAt > cutoff) { skipped++; continue; }
        if (session.status === 'active') { skipped++; continue; }

        if (opts?.dryRun) { removed++; continue; }

        const filePath = path.join(this.clowHome, 'sessions', `${session.id}.jsonl`);
        try {
          const stat = await fsp.stat(filePath);
          freedBytes += stat.size;
          await fsp.unlink(filePath);
        } catch (err: any) {
          if (err.code !== 'ENOENT') errors++;
        }

        try { await fsp.unlink(filePath + '.lock'); } catch {}
        await this.index.removeSession(session.id);
        removed++;
      }
    } catch {
      errors++;
    } finally {
      this.running = false;
    }

    const result = { removed, freedBytes, skipped, errors, durationMs: Date.now() - startTime };
    this.runHistory.push({ ...result, runAt: Date.now() });
    this.totalRemoved += removed;
    this.totalFreedBytes += freedBytes;
    return result;
  }

  // ─── GC Reporting ───────────────────────────────────────────────

  /**
   * Generate a full GC report.
   */
  async generateReport(): Promise<GCReport> {
    const diskUsage = await this.getDiskUsage().catch(() => null);

    const durations = this.runHistory.map(r => r.durationMs);
    const avgDuration = durations.length > 0
      ? durations.reduce((a, b) => a + b, 0) / durations.length
      : 0;

    return {
      lastRun: this.lastResult,
      runHistory: [...this.runHistory],
      totalRemoved: this.totalRemoved,
      totalFreedBytes: this.totalFreedBytes,
      totalRuns: this.totalRuns,
      averageDurationMs: avgDuration,
      scheduledIntervalMs: this.scheduleTimer ? DEFAULT_SCHEDULE_INTERVAL_MS : null,
      workspacePolicies: this.listWorkspacePolicies(),
      diskUsage,
    };
  }

  /**
   * Get a summary string of the last GC run.
   */
  getLastRunSummary(): string {
    if (!this.lastResult) return 'No GC runs yet';

    const { removed, freedBytes, skipped, errors, durationMs } = this.lastResult;
    return `Removed ${removed}, freed ${formatBytes(freedBytes)}, skipped ${skipped}, errors ${errors}, took ${durationMs}ms`;
  }

  /**
   * Get run history.
   */
  getRunHistory(): Array<GCResult & { runAt: number }> {
    return [...this.runHistory];
  }

  // ─── Incremental GC ─────────────────────────────────────────────

  /**
   * Run incremental GC: processes a small batch of sessions per call.
   * Returns true if there are more sessions to process, false if complete.
   * Call this repeatedly (e.g. on idle) for gradual cleanup.
   */
  async gcIncremental(opts: GCOptions = {}, batchSize: number = DEFAULT_INCREMENTAL_BATCH): Promise<{
    result: GCResult;
    moreWork: boolean;
  }> {
    if (this.running) {
      return { result: { removed: 0, freedBytes: 0, skipped: 0, errors: 0, durationMs: 0 }, moreWork: false };
    }

    this.running = true;
    const startTime = Date.now();
    const olderThanDays = opts.olderThanDays ?? 30;
    const keepMin = opts.keepMin ?? 50;
    const cutoff = Date.now() - olderThanDays * 86400_000;

    let removed = 0;
    let freedBytes = 0;
    let skipped = 0;
    let errors = 0;
    let moreWork = false;

    try {
      const all = await this.index.listAll();
      const startIdx = Math.max(keepMin, this.incrementalCursor);
      const endIdx = Math.min(all.length, startIdx + batchSize);

      for (let i = startIdx; i < endIdx; i++) {
        const session = all[i];

        if (session.lastMessageAt > cutoff) { skipped++; continue; }
        if (session.status === 'active') { skipped++; continue; }

        if (opts.dryRun) { removed++; continue; }

        const filePath = path.join(this.clowHome, 'sessions', `${session.id}.jsonl`);
        try {
          const stat = await fsp.stat(filePath);
          freedBytes += stat.size;
          await fsp.unlink(filePath);
        } catch (err: any) {
          if (err.code !== 'ENOENT') errors++;
        }

        try { await fsp.unlink(filePath + '.lock'); } catch {}
        await this.index.removeSession(session.id);
        removed++;
      }

      this.incrementalCursor = endIdx;
      moreWork = endIdx < all.length;

      // Reset cursor when done
      if (!moreWork) this.incrementalCursor = 0;
    } catch {
      errors++;
    } finally {
      this.running = false;
    }

    const result: GCResult = { removed, freedBytes, skipped, errors, durationMs: Date.now() - startTime };
    this.totalRemoved += removed;
    this.totalFreedBytes += freedBytes;

    return { result, moreWork };
  }

  /**
   * Reset the incremental GC cursor.
   */
  resetIncrementalCursor(): void {
    this.incrementalCursor = 0;
  }

  // ─── Disk Usage ─────────────────────────────────────────────────

  /**
   * Get disk usage of all session files.
   */
  async getDiskUsage(): Promise<{ totalBytes: number; fileCount: number }> {
    const sessionsDirPath = path.join(this.clowHome, 'sessions');
    if (!fs.existsSync(sessionsDirPath)) return { totalBytes: 0, fileCount: 0 };

    let totalBytes = 0;
    let fileCount = 0;

    try {
      const files = await fsp.readdir(sessionsDirPath);
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        try {
          const stat = await fsp.stat(path.join(sessionsDirPath, file));
          totalBytes += stat.size;
          fileCount++;
        } catch {}
      }
    } catch {}

    return { totalBytes, fileCount };
  }

  /**
   * Get disk usage per workspace.
   */
  async getDiskUsageByWorkspace(): Promise<Map<string, { totalBytes: number; fileCount: number }>> {
    const usage = new Map<string, { totalBytes: number; fileCount: number }>();

    try {
      const all = await this.index.listAll();
      for (const session of all) {
        const ws = session.workspaceRoot;
        const existing = usage.get(ws) ?? { totalBytes: 0, fileCount: 0 };

        const filePath = path.join(this.clowHome, 'sessions', `${session.id}.jsonl`);
        try {
          const stat = await fsp.stat(filePath);
          existing.totalBytes += stat.size;
          existing.fileCount++;
        } catch { /* skip */ }

        usage.set(ws, existing);
      }
    } catch { /* skip */ }

    return usage;
  }

  // ─── Lifecycle ──────────────────────────────────────────────────

  getLastResult(): GCResult | null {
    return this.lastResult;
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * Shutdown: stop all timers and scheduled operations.
   */
  shutdown(): void {
    this.stopSchedule();
    this.stopSizeTrigger();
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
