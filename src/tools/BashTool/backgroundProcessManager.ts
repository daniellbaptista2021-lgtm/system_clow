/**
 * backgroundProcessManager.ts — Run long commands without blocking
 * Detached processes with file-based stdout/stderr capture.
 */

import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export interface BackgroundProcess {
  id: string;
  pid: number;
  command: string;
  startedAt: number;
  status: 'running' | 'exited' | 'killed' | 'failed';
  exitCode?: number;
  stdoutFile: string;
  stderrFile: string;
}

export class BackgroundProcessManager {
  private processes = new Map<string, BackgroundProcess & { proc?: ChildProcess }>();
  private logsDir: string;

  constructor(workspaceRoot: string) {
    this.logsDir = path.join(workspaceRoot, '.clow', 'bg-logs');
    try { fs.mkdirSync(this.logsDir, { recursive: true }); } catch {}
  }

  start(command: string, opts: { cwd?: string } = {}): BackgroundProcess {
    const id = `bg_${crypto.randomUUID().slice(0, 8)}`;
    const stdoutFile = path.join(this.logsDir, `${id}.stdout.log`).replace(/\\/g, '/');
    const stderrFile = path.join(this.logsDir, `${id}.stderr.log`).replace(/\\/g, '/');

    // Use command-level redirect (works cross-platform, including Windows+detached)
    const wrappedCmd = `${command} > "${stdoutFile}" 2> "${stderrFile}"`;

    const proc = spawn('bash', ['-c', wrappedCmd], {
      cwd: opts.cwd,
      stdio: 'ignore',
      detached: true,
    });
    proc.unref();

    const entry: BackgroundProcess & { proc?: ChildProcess } = {
      id, pid: proc.pid!, command, startedAt: Date.now(),
      status: 'running', stdoutFile, stderrFile, proc,
    };

    proc.on('exit', (code) => {
      entry.status = code === 0 ? 'exited' : 'failed';
      entry.exitCode = code ?? -1;
    });
    proc.on('error', () => { entry.status = 'failed'; });

    this.processes.set(id, entry);
    return this.pub(entry);
  }

  status(id: string): BackgroundProcess | null {
    const p = this.processes.get(id);
    if (!p) return null;
    if (p.status === 'running' && !this.pidAlive(p.pid)) { p.status = 'exited'; p.exitCode = -1; }
    return this.pub(p);
  }

  read(id: string, opts: { tail?: number } = {}): { stdout: string; stderr: string } {
    const p = this.processes.get(id);
    if (!p) throw new Error(`bg ${id} not found`);
    const tail = opts.tail ?? 100;
    return {
      stdout: this.tailFile(p.stdoutFile, tail),
      stderr: this.tailFile(p.stderrFile, tail),
    };
  }

  kill(id: string): boolean {
    const p = this.processes.get(id);
    if (!p || p.status !== 'running') return false;
    try { process.kill(p.pid, 'SIGTERM'); p.status = 'killed'; return true; } catch { return false; }
  }

  list(): BackgroundProcess[] { return Array.from(this.processes.values()).map(p => this.pub(p)); }

  cleanup(maxAgeMs = 24 * 60 * 60_000): number {
    const now = Date.now(); let n = 0;
    for (const [id, p] of this.processes) {
      if (p.status === 'running' || now - p.startedAt < maxAgeMs) continue;
      try { fs.unlinkSync(p.stdoutFile); } catch {}
      try { fs.unlinkSync(p.stderrFile); } catch {}
      this.processes.delete(id); n++;
    }
    return n;
  }

  private tailFile(f: string, n: number): string {
    try { return fs.readFileSync(f, 'utf-8').split('\n').slice(-n).join('\n'); } catch { return ''; }
  }
  private pidAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
  private pub(p: BackgroundProcess & { proc?: ChildProcess }): BackgroundProcess {
    const { proc, ...pub } = p; return pub;
  }
}
