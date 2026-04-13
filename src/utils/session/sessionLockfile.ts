/**
 * SessionLockfile.ts — Session-level locking with PID verification
 *
 * Based on Claude Code's sessionLockfile.ts (~150 lines)
 *
 * Prevents concurrent access to the same session file.
 * Uses PID-based lock files with stale lock detection and auto-cleanup.
 *
 * Features:
 *   - Exclusive lock via .lock file with PID
 *   - Stale lock detection (dead PID auto-cleared)
 *   - Retry with exponential backoff
 *   - Cleanup on process exit
 *   - Force-unlock capability
 *   - Lock timeout
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_ACQUIRE_ATTEMPTS = 10;
const BASE_BACKOFF_MS = 50;
const LOCK_STALE_MS = 5 * 60 * 1000; // 5 minutes

// ════════════════════════════════════════════════════════════════════════════
// SessionLockfile Class
// ════════════════════════════════════════════════════════════════════════════

export class SessionLockfile {
  /**
   * Acquire an exclusive lock on a session file.
   * Returns a release function.
   * Throws if unable to acquire after MAX_ACQUIRE_ATTEMPTS.
   */
  static async acquire(sessionFile: string): Promise<() => Promise<void>> {
    const lockPath = `${sessionFile}.lock`;

    for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
      try {
        // Try to create lock file exclusively
        await fsp.writeFile(lockPath, JSON.stringify({
          pid: process.pid,
          acquiredAt: Date.now(),
          hostname: os.hostname(),
        }), { flag: 'wx' });

        // Successfully created lock
        const release = async () => {
          try { await fsp.unlink(lockPath); } catch {}
        };

        // Register cleanup on process exit
        const syncCleanup = () => {
          try { fs.unlinkSync(lockPath); } catch {}
        };
        process.on('exit', syncCleanup);
        process.on('SIGINT', syncCleanup);
        process.on('SIGTERM', syncCleanup);

        return release;

      } catch (err: any) {
        if (err.code !== 'EEXIST') throw err;

        // Lock exists — check if stale
        try {
          const content = await fsp.readFile(lockPath, 'utf-8');
          let lockData: { pid: number; acquiredAt?: number };

          try {
            lockData = JSON.parse(content);
          } catch {
            // Old format: just PID as plain text
            lockData = { pid: parseInt(content.trim(), 10) };
          }

          const pid = lockData.pid;

          // Check if owning process is alive
          try {
            process.kill(pid, 0);
            // Process is alive — check for stale timeout
            if (lockData.acquiredAt && Date.now() - lockData.acquiredAt > LOCK_STALE_MS) {
              console.warn(`[SessionLockfile] Stale lock detected (PID ${pid}, age ${Date.now() - lockData.acquiredAt}ms)`);
              await fsp.unlink(lockPath);
              continue;
            }
            throw new Error(`Session locked by active process ${pid}`);
          } catch (killErr: any) {
            if (killErr.code === 'ESRCH') {
              // Process is dead — clear stale lock
              console.warn(`[SessionLockfile] Clearing stale lock for dead PID ${pid}`);
              await fsp.unlink(lockPath);
              continue;
            }
            throw killErr;
          }
        } catch (readErr: any) {
          if (readErr.message?.includes('locked by active')) throw readErr;
          // Can't read lock file — wait and retry
        }

        // Exponential backoff
        const delay = BASE_BACKOFF_MS * Math.pow(2, attempt) + Math.random() * 50;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    throw new Error(`Failed to acquire session lock after ${MAX_ACQUIRE_ATTEMPTS} attempts`);
  }

  /**
   * Force-release a lock (for admin/recovery use).
   */
  static async forceRelease(sessionFile: string): Promise<boolean> {
    const lockPath = `${sessionFile}.lock`;
    try {
      await fsp.unlink(lockPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if a session file is locked.
   */
  static async isLocked(sessionFile: string): Promise<boolean> {
    return fs.existsSync(`${sessionFile}.lock`);
  }

  /**
   * Get lock info for a session file.
   */
  static async getLockInfo(sessionFile: string): Promise<{ pid: number; acquiredAt?: number } | null> {
    const lockPath = `${sessionFile}.lock`;
    if (!fs.existsSync(lockPath)) return null;

    try {
      const content = await fsp.readFile(lockPath, 'utf-8');
      try {
        return JSON.parse(content);
      } catch {
        return { pid: parseInt(content.trim(), 10) };
      }
    } catch {
      return null;
    }
  }
}
