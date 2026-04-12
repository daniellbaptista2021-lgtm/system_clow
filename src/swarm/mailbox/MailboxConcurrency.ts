/**
 * MailboxConcurrency.ts — Simple file-based locking
 *
 * Provides mutual exclusion for inbox file operations using .lock files
 * with PID-based stale lock detection and exponential backoff retry.
 */

import * as fs from 'fs';

import {
  MAILBOX_LOCK_RETRIES,
  MAILBOX_LOCK_MIN_TIMEOUT_MS,
  MAILBOX_LOCK_MAX_TIMEOUT_MS,
  MAILBOX_STALE_LOCK_MS,
} from '../constants.js';

// ════════════════════════════════════════════════════════════════════════════
// Lock Acquisition
// ════════════════════════════════════════════════════════════════════════════

/**
 * Acquire a file-based lock. Returns a release function.
 *
 * The lock file contains the current PID and a timestamp.
 * Stale locks (PID dead or too old) are automatically cleared.
 *
 * @param filePath - The file to lock (lock will be at filePath + '.lock')
 * @returns A function that releases the lock when called
 * @throws Error if the lock cannot be acquired after all retries
 */
export async function acquireLock(
  filePath: string
): Promise<() => void> {
  const lockPath = filePath + '.lock';
  const lockContent = `${process.pid}\n${Date.now()}`;

  for (let attempt = 0; attempt < MAILBOX_LOCK_RETRIES; attempt++) {
    // Try to clear stale locks first
    if (attempt > 0) {
      clearStaleLock(lockPath);
    }

    try {
      // Attempt to create the lock file exclusively
      fs.writeFileSync(lockPath, lockContent, { flag: 'wx' });

      // Lock acquired — return release function
      return () => {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // Lock file may have been cleaned up already
        }
      };
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        // Unexpected error
        throw err;
      }
    }

    // Lock exists; wait with exponential backoff before retrying
    const delay = Math.min(
      MAILBOX_LOCK_MIN_TIMEOUT_MS * Math.pow(2, attempt),
      MAILBOX_LOCK_MAX_TIMEOUT_MS
    );
    await sleep(delay);
  }

  // Final attempt: try to clear stale and grab
  clearStaleLock(lockPath);
  try {
    fs.writeFileSync(lockPath, lockContent, { flag: 'wx' });
    return () => {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // Ignore
      }
    };
  } catch {
    throw new Error(
      `Failed to acquire lock on "${filePath}" after ${MAILBOX_LOCK_RETRIES} retries`
    );
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Stale Lock Detection
// ════════════════════════════════════════════════════════════════════════════

/**
 * Check if a lock file is stale and remove it if so.
 *
 * A lock is stale if:
 * - The PID in the lock file is no longer alive, OR
 * - The lock is older than MAILBOX_STALE_LOCK_MS
 */
function clearStaleLock(lockPath: string): void {
  try {
    if (!fs.existsSync(lockPath)) return;

    const content = fs.readFileSync(lockPath, 'utf-8').trim();
    const lines = content.split('\n');
    const lockPid = parseInt(lines[0] ?? '', 10);
    const lockTime = parseInt(lines[1] ?? '', 10);

    let isStale = false;

    // Check if PID is dead
    if (!isNaN(lockPid)) {
      if (!isProcessAlive(lockPid)) {
        isStale = true;
      }
    }

    // Check if lock is too old
    if (!isNaN(lockTime)) {
      if (Date.now() - lockTime > MAILBOX_STALE_LOCK_MS) {
        isStale = true;
      }
    }

    // If content is empty or malformed, treat as stale
    if (content.length === 0 || isNaN(lockPid)) {
      isStale = true;
    }

    if (isStale) {
      fs.unlinkSync(lockPath);
    }
  } catch {
    // If we can't read/delete the lock file, leave it for the next attempt
  }
}

/**
 * Check if a process is alive by sending signal 0.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Utilities
// ════════════════════════════════════════════════════════════════════════════

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
