import { spawn, ChildProcess, SpawnOptions } from 'child_process';

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface SpawnResult {
  child: ChildProcess;
  pid: number | undefined;
  startedAt: number;
}

export interface ProcessInfo {
  pid: number;
  alive: boolean;
  memoryUsage?: number;
  uptimeMs: number;
  startedAt: number;
}

export interface ManagerStatistics {
  totalSpawned: number;
  totalExited: number;
  totalKilled: number;
  totalErrors: number;
  activeCount: number;
}

interface TrackedProcess {
  child: ChildProcess;
  pid: number | undefined;
  startedAt: number;
  stdoutBuffer: string;
  stderrBuffer: string;
  exitCode: number | null;
  signal: string | null;
  exited: boolean;
}

// ---------------------------------------------------------------------------
// ChildProcessManager
// ---------------------------------------------------------------------------

export class ChildProcessManager {
  private readonly tracked: Map<number, TrackedProcess> = new Map();
  private readonly stats: ManagerStatistics = {
    totalSpawned: 0,
    totalExited: 0,
    totalKilled: 0,
    totalErrors: 0,
    activeCount: 0,
  };

  /**
   * Spawn a child process with optional timeout and error capture.
   */
  spawnProcess(
    command: string,
    args: string[] = [],
    options?: SpawnOptions & { timeoutMs?: number },
  ): SpawnResult {
    const timeoutMs = options?.timeoutMs;
    const spawnOpts: SpawnOptions = { ...options };
    delete (spawnOpts as Record<string, unknown>)['timeoutMs'];

    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      ...spawnOpts,
    });

    const startedAt = Date.now();
    this.stats.totalSpawned++;
    this.stats.activeCount++;

    const tracked: TrackedProcess = {
      child,
      pid: child.pid,
      startedAt,
      stdoutBuffer: '',
      stderrBuffer: '',
      exitCode: null,
      signal: null,
      exited: false,
    };

    if (child.pid !== undefined) {
      this.tracked.set(child.pid, tracked);
    }

    this.captureStdio(child, tracked);
    this.attachExitHandler(child, tracked);

    if (timeoutMs !== undefined && timeoutMs > 0) {
      const timer = setTimeout(() => {
        if (!tracked.exited) {
          this.gracefulKill(child).catch(() => {});
        }
      }, timeoutMs);
      child.once('exit', () => clearTimeout(timer));
    }

    return { child, pid: child.pid, startedAt };
  }

  /**
   * Check if a process is still alive by sending signal 0.
   */
  monitorHealth(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Buffer and parse stdout/stderr from a child.
   */
  captureStdio(child: ChildProcess, tracked?: TrackedProcess): void {
    const t = tracked ?? this.getTracked(child.pid);

    child.stdout?.on('data', (chunk: Buffer) => {
      if (t) {
        t.stdoutBuffer += chunk.toString('utf-8');
        if (t.stdoutBuffer.length > 1_000_000) {
          t.stdoutBuffer = t.stdoutBuffer.slice(-500_000);
        }
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      if (t) {
        t.stderrBuffer += chunk.toString('utf-8');
        if (t.stderrBuffer.length > 1_000_000) {
          t.stderrBuffer = t.stderrBuffer.slice(-500_000);
        }
      }
    });
  }

  /**
   * Gracefully kill a child — SIGTERM then SIGKILL after timeout.
   */
  async gracefulKill(child: ChildProcess, timeoutMs: number = 5000): Promise<void> {
    if (child.exitCode !== null) return;

    return new Promise<void>((resolve) => {
      const forceTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // already dead
        }
      }, timeoutMs);

      child.once('exit', () => {
        clearTimeout(forceTimer);
        resolve();
      });

      try {
        child.kill('SIGTERM');
      } catch {
        clearTimeout(forceTimer);
        resolve();
      }

      this.stats.totalKilled++;
    });
  }

  /**
   * Get information about a tracked process.
   */
  getProcessInfo(pid: number): ProcessInfo | undefined {
    const tracked = this.tracked.get(pid);
    if (!tracked) return undefined;
    const alive = !tracked.exited && this.monitorHealth(pid);
    return {
      pid,
      alive,
      uptimeMs: Date.now() - tracked.startedAt,
      startedAt: tracked.startedAt,
    };
  }

  getStdout(pid: number): string | undefined {
    return this.tracked.get(pid)?.stdoutBuffer;
  }

  getStderr(pid: number): string | undefined {
    return this.tracked.get(pid)?.stderrBuffer;
  }

  getStatistics(): Readonly<ManagerStatistics> {
    return { ...this.stats };
  }

  /** Clean up state for exited processes. */
  cleanup(): void {
    for (const [pid, tracked] of this.tracked) {
      if (tracked.exited) this.tracked.delete(pid);
    }
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private attachExitHandler(child: ChildProcess, tracked: TrackedProcess): void {
    child.on('exit', (code, signal) => {
      tracked.exited = true;
      tracked.exitCode = code;
      tracked.signal = signal;
      this.stats.totalExited++;
      this.stats.activeCount = Math.max(0, this.stats.activeCount - 1);
    });

    child.on('error', () => {
      this.stats.totalErrors++;
      tracked.exited = true;
      this.stats.activeCount = Math.max(0, this.stats.activeCount - 1);
    });
  }

  private getTracked(pid: number | undefined): TrackedProcess | undefined {
    if (pid === undefined) return undefined;
    return this.tracked.get(pid);
  }
}
