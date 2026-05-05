/**
 * CrashRecovery.ts — Detect and recover crashed sessions
 *
 * Based on Claude Code's crashRecovery.ts (~200 lines)
 *
 * Detects crashed sessions by checking if the owning PID is still alive.
 * If the PID is dead, the session is marked as crashed and can be resumed.
 *
 * Features:
 *   - Detect crashed sessions (owner PID dead)
 *   - Mark sessions as crashed in index
 *   - Release stale lockfiles
 *   - Generate recovery report
 *   - Auto-recovery on startup
 *   - Last-write analysis (detect mid-write corruption)
 *   - Statistics tracking
 *   - Recovery strategies
 *   - Crash cause analysis
 *   - Crash frequency tracking
 *   - Session repair
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import type { SessionIndex } from './sessionIndex.js';
import type { SessionMetadata, SessionStatus } from './types.js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface CrashReport {
  sessionId: string;
  ownerPid: number;
  lastMessageAt: number;
  messageCount: number;
  workspaceRoot: string;
  recoverable: boolean;
  reason: string;
}

interface RecoveryResult {
  detected: number;
  recovered: number;
  lockfilesCleared: number;
  errors: string[];
}

/** Available recovery strategies */
type RecoveryStrategy = 'mark-crashed' | 'auto-resume' | 'repair-and-resume' | 'archive';

/** Configuration for recovery behavior */
interface RecoveryConfig {
  /** Default strategy for crashed sessions */
  defaultStrategy: RecoveryStrategy;
  /** Whether to run recovery automatically on startup */
  autoRecoverOnStartup: boolean;
  /** Maximum age of sessions eligible for auto-recovery (ms) */
  maxAutoRecoverAgeMs: number;
  /** Whether to attempt file repair on corruption */
  attemptRepair: boolean;
  /** Maximum number of auto-recovery attempts per session */
  maxRecoveryAttempts: number;
}

/** Crash cause analysis result */
interface CrashCause {
  sessionId: string;
  likelyCause: 'pid-death' | 'corruption' | 'oom' | 'signal' | 'unknown';
  confidence: 'high' | 'medium' | 'low';
  details: string;
  fileIntegrity: { clean: boolean; lastLineValid: boolean; totalLines: number };
  lastActivityAgeMs: number;
}

/** Crash frequency statistics */
interface CrashFrequencyStats {
  totalCrashes: number;
  crashesLast24h: number;
  crashesLast7d: number;
  crashesLast30d: number;
  averageCrashesPerDay: number;
  mostCrashedWorkspace: string | null;
  workspaceCrashCounts: Record<string, number>;
  recentCrashes: Array<{ sessionId: string; at: number; cause: string }>;
}

/** Result of a session file repair */
interface RepairResult {
  sessionId: string;
  success: boolean;
  linesRemoved: number;
  linesRetained: number;
  bytesBeforeRepair: number;
  bytesAfterRepair: number;
  errors: string[];
}

/** Recovery statistics */
interface RecoveryStats {
  totalDetected: number;
  totalRecovered: number;
  totalRepaired: number;
  totalArchived: number;
  totalFailed: number;
  lastRecoveryAt: number;
  recoveryHistory: Array<{ at: number; result: RecoveryResult }>;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_RECOVERY_CONFIG: RecoveryConfig = {
  defaultStrategy: 'mark-crashed',
  autoRecoverOnStartup: true,
  maxAutoRecoverAgeMs: 7 * 24 * 60 * 60 * 1000, // 7 days
  attemptRepair: true,
  maxRecoveryAttempts: 3,
};

const MAX_CRASH_HISTORY = 100;

// ════════════════════════════════════════════════════════════════════════════
// CrashRecovery Class
// ════════════════════════════════════════════════════════════════════════════

export class CrashRecovery {

  // Static recovery stats (shared across all invocations)
  private static stats: RecoveryStats = {
    totalDetected: 0,
    totalRecovered: 0,
    totalRepaired: 0,
    totalArchived: 0,
    totalFailed: 0,
    lastRecoveryAt: 0,
    recoveryHistory: [],
  };

  private static crashLog: Array<{ sessionId: string; at: number; cause: string; workspace: string }> = [];
  private static config: RecoveryConfig = { ...DEFAULT_RECOVERY_CONFIG };

  // ─── Configuration ──────────────────────────────────────────────

  /**
   * Set recovery configuration.
   */
  static setConfig(config: Partial<RecoveryConfig>): void {
    CrashRecovery.config = { ...CrashRecovery.config, ...config };
  }

  /**
   * Get current recovery configuration.
   */
  static getConfig(): Readonly<RecoveryConfig> {
    return { ...CrashRecovery.config };
  }

  // ─── Detection ──────────────────────────────────────────────────

  /**
   * Detect sessions that are marked active but whose owner PID is dead.
   */
  static async detectCrashed(index: SessionIndex): Promise<SessionMetadata[]> {
    const active = await index.findActive();
    const crashed: SessionMetadata[] = [];

    for (const session of active) {
      if (!session.ownerPid) continue;

      if (!CrashRecovery.isPidAlive(session.ownerPid)) {
        crashed.push(session);
      }
    }

    CrashRecovery.stats.totalDetected += crashed.length;
    return crashed;
  }

  /**
   * Generate crash reports for detected crashed sessions.
   */
  static async generateReports(index: SessionIndex): Promise<CrashReport[]> {
    const crashed = await CrashRecovery.detectCrashed(index);
    return crashed.map(session => ({
      sessionId: session.id,
      ownerPid: session.ownerPid!,
      lastMessageAt: session.lastMessageAt,
      messageCount: session.messageCount,
      workspaceRoot: session.workspaceRoot,
      recoverable: true,
      reason: `Owner PID ${session.ownerPid} is no longer running`,
    }));
  }

  // ─── Cleanup ────────────────────────────────────────────────────

  /**
   * Clean up a crashed session: mark as crashed, release lock.
   */
  static async cleanup(index: SessionIndex, sessionId: string): Promise<void> {
    await index.updateSession(sessionId, {
      status: 'crashed',
      closedAt: Date.now(),
      closedReason: 'crash',
    });
  }

  /**
   * Full recovery: detect all crashed sessions, mark them, clear locks.
   */
  static async recover(
    index: SessionIndex,
    sessionsDir: string,
  ): Promise<RecoveryResult> {
    const result: RecoveryResult = {
      detected: 0,
      recovered: 0,
      lockfilesCleared: 0,
      errors: [],
    };

    try {
      // Detect crashed sessions
      const crashed = await CrashRecovery.detectCrashed(index);
      result.detected = crashed.length;

      // Mark each as crashed
      for (const session of crashed) {
        try {
          await CrashRecovery.cleanup(index, session.id);
          result.recovered++;

          // Log the crash
          CrashRecovery.logCrash(session.id, 'pid-death', session.workspaceRoot);
        } catch (err) {
          result.errors.push(`Failed to recover ${session.id}: ${(err as Error).message}`);
          CrashRecovery.stats.totalFailed++;
        }
      }

      // Clear stale lockfiles
      result.lockfilesCleared = await CrashRecovery.clearStaleLocks(sessionsDir);

    } catch (err) {
      result.errors.push(`Recovery failed: ${(err as Error).message}`);
    }

    // Update stats
    CrashRecovery.stats.totalRecovered += result.recovered;
    CrashRecovery.stats.lastRecoveryAt = Date.now();
    CrashRecovery.stats.recoveryHistory.push({ at: Date.now(), result: { ...result } });
    if (CrashRecovery.stats.recoveryHistory.length > MAX_CRASH_HISTORY) {
      CrashRecovery.stats.recoveryHistory = CrashRecovery.stats.recoveryHistory.slice(-MAX_CRASH_HISTORY);
    }

    return result;
  }

  // ─── Recovery Strategies ────────────────────────────────────────

  /**
   * Apply a specific recovery strategy to a crashed session.
   */
  static async applyStrategy(
    index: SessionIndex,
    sessionsDir: string,
    sessionId: string,
    strategy: RecoveryStrategy,
  ): Promise<{ success: boolean; message: string }> {
    switch (strategy) {
      case 'mark-crashed':
        await CrashRecovery.cleanup(index, sessionId);
        return { success: true, message: `Session ${sessionId} marked as crashed` };

      case 'auto-resume':
        // Mark as crashed first, then flag for auto-resume
        await index.updateSession(sessionId, {
          status: 'crashed',
          closedAt: Date.now(),
          closedReason: 'crash',
        });
        return { success: true, message: `Session ${sessionId} prepared for auto-resume` };

      case 'repair-and-resume': {
        const repairResult = await CrashRecovery.repairSession(sessionsDir, sessionId);
        if (repairResult.success) {
          await index.updateSession(sessionId, {
            status: 'crashed',
            closedAt: Date.now(),
            closedReason: 'crash',
          });
          CrashRecovery.stats.totalRepaired++;
          return { success: true, message: `Session ${sessionId} repaired (${repairResult.linesRemoved} bad lines removed)` };
        }
        return { success: false, message: `Session ${sessionId} repair failed: ${repairResult.errors.join('; ')}` };
      }

      case 'archive': {
        const filePath = path.join(sessionsDir, `${sessionId}.jsonl`);
        const archiveDir = path.join(sessionsDir, 'archive');
        try {
          await fsp.mkdir(archiveDir, { recursive: true });
          const archivePath = path.join(archiveDir, `${sessionId}.jsonl`);
          await fsp.copyFile(filePath, archivePath);
          await fsp.unlink(filePath);
          await index.removeSession(sessionId);
          CrashRecovery.stats.totalArchived++;
          return { success: true, message: `Session ${sessionId} archived` };
        } catch (err) {
          return { success: false, message: `Archive failed: ${(err as Error).message}` };
        }
      }

      default:
        return { success: false, message: `Unknown strategy: ${strategy}` };
    }
  }

  // ─── Auto-Recovery on Startup ───────────────────────────────────

  /**
   * Run auto-recovery. Intended to be called once at startup.
   * Uses the configured default strategy for each crashed session.
   */
  static async autoRecover(
    index: SessionIndex,
    sessionsDir: string,
  ): Promise<RecoveryResult> {
    if (!CrashRecovery.config.autoRecoverOnStartup) {
      return { detected: 0, recovered: 0, lockfilesCleared: 0, errors: [] };
    }

    const maxAge = CrashRecovery.config.maxAutoRecoverAgeMs;
    const strategy = CrashRecovery.config.defaultStrategy;
    const cutoff = Date.now() - maxAge;

    const result: RecoveryResult = {
      detected: 0,
      recovered: 0,
      lockfilesCleared: 0,
      errors: [],
    };

    try {
      const crashed = await CrashRecovery.detectCrashed(index);
      result.detected = crashed.length;

      for (const session of crashed) {
        // Skip sessions that are too old
        if (session.lastMessageAt < cutoff) continue;

        try {
          const stratResult = await CrashRecovery.applyStrategy(index, sessionsDir, session.id, strategy);
          if (stratResult.success) {
            result.recovered++;
          } else {
            result.errors.push(stratResult.message);
          }
        } catch (err) {
          result.errors.push(`Auto-recover ${session.id}: ${(err as Error).message}`);
        }
      }

      result.lockfilesCleared = await CrashRecovery.clearStaleLocks(sessionsDir);
    } catch (err) {
      result.errors.push(`Auto-recovery failed: ${(err as Error).message}`);
    }

    return result;
  }

  // ─── Crash Cause Analysis ───────────────────────────────────────

  /**
   * Analyze the likely cause of a session crash.
   */
  static async analyzeCrashCause(
    sessionsDir: string,
    session: SessionMetadata,
  ): Promise<CrashCause> {
    const filePath = path.join(sessionsDir, `${session.id}.jsonl`);
    const integrity = await CrashRecovery.checkFileIntegrity(filePath);
    const lastActivityAgeMs = Date.now() - session.lastMessageAt;

    let likelyCause: CrashCause['likelyCause'] = 'unknown';
    let confidence: CrashCause['confidence'] = 'low';
    let details = '';

    // File corruption suggests mid-write crash (OOM or signal)
    if (!integrity.lastLineValid) {
      likelyCause = 'corruption';
      confidence = 'high';
      details = 'Last line in JSONL file is malformed, indicating a mid-write crash';
    }
    // Process died cleanly (last line valid, PID dead)
    else if (integrity.lastLineValid && session.ownerPid && !CrashRecovery.isPidAlive(session.ownerPid)) {
      likelyCause = 'pid-death';
      confidence = 'high';
      details = `Owner PID ${session.ownerPid} is dead. Process likely received a signal or was killed.`;

      // Check if it looks like OOM (very large file, many lines)
      if (integrity.totalLines > 10000) {
        likelyCause = 'oom';
        confidence = 'medium';
        details += ` Large session (${integrity.totalLines} lines) suggests possible OOM.`;
      }
    }
    // Very old session that was never closed
    else if (lastActivityAgeMs > 24 * 60 * 60 * 1000) {
      likelyCause = 'signal';
      confidence = 'medium';
      details = 'Session has been inactive for over 24 hours without proper closure';
    }

    return {
      sessionId: session.id,
      likelyCause,
      confidence,
      details,
      fileIntegrity: integrity,
      lastActivityAgeMs,
    };
  }

  // ─── Crash Frequency Tracking ───────────────────────────────────

  /**
   * Get crash frequency statistics.
   */
  static getCrashFrequencyStats(): CrashFrequencyStats {
    const now = Date.now();
    const last24h = now - 24 * 60 * 60 * 1000;
    const last7d = now - 7 * 24 * 60 * 60 * 1000;
    const last30d = now - 30 * 24 * 60 * 60 * 1000;

    const crashes24h = CrashRecovery.crashLog.filter(c => c.at >= last24h).length;
    const crashes7d = CrashRecovery.crashLog.filter(c => c.at >= last7d).length;
    const crashes30d = CrashRecovery.crashLog.filter(c => c.at >= last30d).length;

    // Count crashes per workspace
    const workspaceCounts: Record<string, number> = {};
    for (const crash of CrashRecovery.crashLog) {
      workspaceCounts[crash.workspace] = (workspaceCounts[crash.workspace] ?? 0) + 1;
    }

    // Find most crashed workspace
    let mostCrashedWorkspace: string | null = null;
    let maxCrashes = 0;
    for (const [ws, count] of Object.entries(workspaceCounts)) {
      if (count > maxCrashes) {
        maxCrashes = count;
        mostCrashedWorkspace = ws;
      }
    }

    // Calculate average crashes per day over the tracking period
    const oldestCrash = CrashRecovery.crashLog.length > 0
      ? Math.min(...CrashRecovery.crashLog.map(c => c.at))
      : now;
    const trackingDays = Math.max(1, (now - oldestCrash) / (24 * 60 * 60 * 1000));

    return {
      totalCrashes: CrashRecovery.crashLog.length,
      crashesLast24h: crashes24h,
      crashesLast7d: crashes7d,
      crashesLast30d: crashes30d,
      averageCrashesPerDay: CrashRecovery.crashLog.length / trackingDays,
      mostCrashedWorkspace,
      workspaceCrashCounts: workspaceCounts,
      recentCrashes: CrashRecovery.crashLog.slice(-20).map(c => ({
        sessionId: c.sessionId,
        at: c.at,
        cause: c.cause,
      })),
    };
  }

  /**
   * Clear crash frequency tracking data.
   */
  static clearCrashLog(): void {
    CrashRecovery.crashLog = [];
  }

  private static logCrash(sessionId: string, cause: string, workspace: string): void {
    CrashRecovery.crashLog.push({ sessionId, at: Date.now(), cause, workspace });
    if (CrashRecovery.crashLog.length > MAX_CRASH_HISTORY) {
      CrashRecovery.crashLog = CrashRecovery.crashLog.slice(-MAX_CRASH_HISTORY);
    }
  }

  // ─── Session Repair ─────────────────────────────────────────────

  /**
   * Attempt to repair a corrupted session file.
   * Removes malformed lines while preserving valid entries.
   */
  static async repairSession(sessionsDir: string, sessionId: string): Promise<RepairResult> {
    const filePath = path.join(sessionsDir, `${sessionId}.jsonl`);

    const result: RepairResult = {
      sessionId,
      success: false,
      linesRemoved: 0,
      linesRetained: 0,
      bytesBeforeRepair: 0,
      bytesAfterRepair: 0,
      errors: [],
    };

    if (!fs.existsSync(filePath)) {
      result.errors.push('Session file does not exist');
      return result;
    }

    try {
      const content = await fsp.readFile(filePath, 'utf-8');
      result.bytesBeforeRepair = Buffer.byteLength(content, 'utf-8');

      const lines = content.split('\n');
      const validLines: string[] = [];
      let removedCount = 0;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue; // Skip empty lines

        try {
          JSON.parse(trimmed);
          validLines.push(trimmed);
        } catch {
          removedCount++;
        }
      }

      result.linesRemoved = removedCount;
      result.linesRetained = validLines.length;

      if (removedCount === 0) {
        // File is already clean
        result.success = true;
        result.bytesAfterRepair = result.bytesBeforeRepair;
        return result;
      }

      // Create backup before repair
      const backupPath = filePath + '.backup';
      await fsp.copyFile(filePath, backupPath);

      // Write repaired content
      const repairedContent = validLines.join('\n') + '\n';
      await fsp.writeFile(filePath, repairedContent);
      result.bytesAfterRepair = Buffer.byteLength(repairedContent, 'utf-8');

      result.success = true;
    } catch (err) {
      result.errors.push(`Repair failed: ${(err as Error).message}`);
    }

    return result;
  }

  /**
   * Check if a session file needs repair.
   */
  static async needsRepair(sessionsDir: string, sessionId: string): Promise<boolean> {
    const filePath = path.join(sessionsDir, `${sessionId}.jsonl`);
    const integrity = await CrashRecovery.checkFileIntegrity(filePath);
    return !integrity.clean;
  }

  // ─── Lockfile Management ────────────────────────────────────────

  /**
   * Clear stale lockfiles (lock files whose owning PID is dead).
   */
  static async clearStaleLocks(sessionsDir: string): Promise<number> {
    if (!fs.existsSync(sessionsDir)) return 0;
    let cleared = 0;

    try {
      const files = await fsp.readdir(sessionsDir);

      for (const file of files) {
        if (!file.endsWith('.lock')) continue;

        const lockPath = path.join(sessionsDir, file);
        try {
          const content = await fsp.readFile(lockPath, 'utf-8');
          const pid = parseInt(content.trim(), 10);

          if (isNaN(pid) || !CrashRecovery.isPidAlive(pid)) {
            await fsp.unlink(lockPath);
            cleared++;
          }
        } catch {
          // If we can't read the lock, try to remove it
          try { await fsp.unlink(lockPath); cleared++; } catch {}
        }
      }
    } catch {}

    return cleared;
  }

  // ─── File Integrity ─────────────────────────────────────────────

  /**
   * Check if a JSONL file has a clean last line (no mid-write corruption).
   */
  static async checkFileIntegrity(filePath: string): Promise<{ clean: boolean; lastLineValid: boolean; totalLines: number }> {
    if (!fs.existsSync(filePath)) return { clean: true, lastLineValid: true, totalLines: 0 };

    try {
      const content = await fsp.readFile(filePath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());
      let lastLineValid = true;

      if (lines.length > 0) {
        try {
          JSON.parse(lines[lines.length - 1]);
        } catch {
          lastLineValid = false;
        }
      }

      return { clean: lastLineValid, lastLineValid, totalLines: lines.length };
    } catch {
      return { clean: false, lastLineValid: false, totalLines: 0 };
    }
  }

  // ─── Statistics ─────────────────────────────────────────────────

  /**
   * Get recovery statistics.
   */
  static getStats(): Readonly<RecoveryStats> {
    return { ...CrashRecovery.stats };
  }

  /**
   * Reset recovery statistics.
   */
  static resetStats(): void {
    CrashRecovery.stats = {
      totalDetected: 0,
      totalRecovered: 0,
      totalRepaired: 0,
      totalArchived: 0,
      totalFailed: 0,
      lastRecoveryAt: 0,
      recoveryHistory: [],
    };
  }

  // ─── PID Check ───────────────────────────────────────────────────

  /**
   * Check if a process ID is still alive.
   */
  private static isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}
