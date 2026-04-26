/**
 * InProcessBackend.ts — Fallback PaneBackend that spawns child processes
 *
 * Used when no terminal multiplexer (tmux / iTerm2) is available.
 * Each "pane" is a spawned child process whose stdout/stderr is
 * prefixed with the member name for readability.
 */

import { spawn, type ChildProcess } from 'child_process';
import type {
  PaneBackend,
  BackendType,
  CreatePaneOptions,
  PaneHandle,
} from '../types.js';

// ────────────────────────────────────────────────────────────────────────────
// Tracked process entry
// ────────────────────────────────────────────────────────────────────────────

interface TrackedProcess {
  id: string;
  title: string;
  memberName: string;
  proc: ChildProcess;
  isAlive: boolean;
}

// ────────────────────────────────────────────────────────────────────────────
// InProcessBackend
// ────────────────────────────────────────────────────────────────────────────

export class InProcessBackend implements PaneBackend {
  readonly type: BackendType = 'in-process';

  private readonly tracked = new Map<string, TrackedProcess>();
  private nextId = 0;

  // ── Availability ──────────────────────────────────────────────────────

  async isAvailable(): Promise<boolean> {
    return true; // always available
  }

  // ── Create ────────────────────────────────────────────────────────────

  async createPane(options: CreatePaneOptions): Promise<PaneHandle> {
    const { title, cwd, command, env, memberName } = options;

    const id = `in-proc-${this.nextId++}`;

    const [cmd, ...args] = command;
    if (!cmd) {
      throw new Error('createPane requires at least one command element');
    }

    const proc = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
    });

    const entry: TrackedProcess = {
      id,
      title,
      memberName,
      proc,
      isAlive: true,
    };

    // Forward stdout with prefix
    proc.stdout?.on('data', (chunk: Buffer) => {
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        if (line.length > 0) {
          process.stdout.write(`[${memberName}] ${line}\n`);
        }
      }
    });

    // Forward stderr with prefix
    proc.stderr?.on('data', (chunk: Buffer) => {
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        if (line.length > 0) {
          process.stderr.write(`[${memberName}] ${line}\n`);
        }
      }
    });

    proc.on('exit', (_code, _signal) => {
      entry.isAlive = false;
    });

    proc.on('error', () => {
      entry.isAlive = false;
    });

    this.tracked.set(id, entry);

    return {
      id,
      backend: 'in-process',
      pid: proc.pid,
      title,
      isAlive: true,
    };
  }

  // ── Send ──────────────────────────────────────────────────────────────

  async sendToPane(paneId: string, input: string): Promise<void> {
    const entry = this.tracked.get(paneId);
    if (!entry || !entry.isAlive) {
      throw new Error(`Pane ${paneId} is not alive`);
    }
    entry.proc.stdin?.write(input + '\n');
  }

  // ── Title ─────────────────────────────────────────────────────────────

  async setPaneTitle(paneId: string, title: string): Promise<void> {
    const entry = this.tracked.get(paneId);
    if (entry) {
      entry.title = title;
    }
  }

  // ── Kill ──────────────────────────────────────────────────────────────

  async killPane(paneId: string): Promise<boolean> {
    const entry = this.tracked.get(paneId);
    if (!entry) return false;

    if (!entry.isAlive) {
      this.tracked.delete(paneId);
      return true;
    }

    return new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        // Force kill after 2 seconds
        try {
          entry.proc.kill('SIGKILL');
        } catch {
          // already dead
        }
        entry.isAlive = false;
        this.tracked.delete(paneId);
        resolve(true);
      }, 2_000);

      entry.proc.once('exit', () => {
        clearTimeout(timeout);
        entry.isAlive = false;
        this.tracked.delete(paneId);
        resolve(true);
      });

      // Graceful SIGTERM first
      try {
        entry.proc.kill('SIGTERM');
      } catch {
        clearTimeout(timeout);
        entry.isAlive = false;
        this.tracked.delete(paneId);
        resolve(true);
      }
    });
  }

  // ── List ──────────────────────────────────────────────────────────────

  async listPanes(): Promise<PaneHandle[]> {
    const handles: PaneHandle[] = [];
    for (const entry of this.tracked.values()) {
      handles.push({
        id: entry.id,
        backend: 'in-process',
        pid: entry.proc.pid,
        title: entry.title,
        isAlive: entry.isAlive,
      });
    }
    return handles;
  }

  // ── Cleanup ───────────────────────────────────────────────────────────

  async cleanup(): Promise<void> {
    const ids = Array.from(this.tracked.keys());
    await Promise.all(ids.map((id) => this.killPane(id)));
    this.tracked.clear();
  }
}
