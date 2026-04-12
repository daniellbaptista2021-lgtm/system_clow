/**
 * persistentShell.ts — Single bash process alive for entire session
 * cd, export, alias all persist between calls.
 * Commands via stdin, output via stdout, delimiter-based completion detection.
 */

import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import { COMMAND_DELIMITER } from './constants.js';

export interface ShellCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
}

interface PendingCommand {
  command: string;
  startedAt: number;
  timeoutMs: number;
  timer?: ReturnType<typeof setTimeout>;
  onStdout?: (chunk: string) => void;
  resolve: (r: ShellCommandResult) => void;
  reject: (e: Error) => void;
}

export class PersistentShell {
  private proc: ChildProcess | null = null;
  private buffer = '';
  private stderrBuf = '';
  private current: PendingCommand | null = null;
  private queue: PendingCommand[] = [];
  private alive = false;
  private _cwd: string;

  constructor(private opts: { cwd?: string; env?: Record<string, string> } = {}) {
    this._cwd = opts.cwd ?? process.cwd();
  }

  async start(): Promise<void> {
    if (this.proc && this.alive) return;
    const shell = this.findShell();
    // On Windows, spawn shell directly (no shell:true which wraps in cmd.exe)
    this.proc = spawn(shell, ['-i'], {
      cwd: this._cwd,
      env: { ...process.env, ...this.opts.env } as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.stdout!.on('data', (c: Buffer) => this.onStdout(c));
    this.proc.stderr!.on('data', (c: Buffer) => { this.stderrBuf += c.toString(); });
    this.proc.on('exit', () => { this.alive = false; });
    this.proc.on('error', (err) => { this.alive = false; });
    this.alive = true;

    // Wait a beat for shell to initialize
    await new Promise(r => setTimeout(r, 200));
    if (!this.alive) throw new Error(`Shell process exited immediately`);

    // Init: suppress history, set clean state
    try {
      await this.exec('set +o history 2>/dev/null; export PS1="" 2>/dev/null; true', { timeoutMs: 5000 });
    } catch {
      // Init failed but shell may still be alive — continue
    }
  }

  private findShell(): string {
    if (process.platform === 'win32') {
      const git = 'C:\\Program Files\\Git\\bin\\bash.exe';
      if (fs.existsSync(git)) return git;
      return 'bash';
    }
    for (const s of ['/bin/bash', '/usr/bin/bash', '/bin/zsh', '/usr/bin/zsh'])
      if (fs.existsSync(s)) return s;
    return '/bin/sh';
  }

  async exec(command: string, opts: {
    timeoutMs?: number;
    onStdout?: (chunk: string) => void;
  } = {}): Promise<ShellCommandResult> {
    if (!this.proc || !this.alive) throw new Error('Shell not started');
    return new Promise((resolve, reject) => {
      const p: PendingCommand = {
        command, startedAt: Date.now(),
        timeoutMs: opts.timeoutMs ?? 30 * 60_000,
        onStdout: opts.onStdout, resolve, reject,
      };
      this.queue.push(p);
      this.drain();
    });
  }

  private drain(): void {
    if (this.current || this.queue.length === 0) return;
    const cmd = this.queue.shift()!;
    this.current = cmd;
    this.buffer = '';
    this.stderrBuf = '';

    cmd.timer = setTimeout(() => this.onTimeout(cmd), cmd.timeoutMs);
    // Wrap: run command, then echo delimiter with exit code
    const wrapped = `${cmd.command}\necho "${COMMAND_DELIMITER}$?"`;
    this.proc!.stdin!.write(wrapped + '\n');
  }

  private onStdout(chunk: Buffer): void {
    const text = chunk.toString('utf-8');
    this.buffer += text;
    this.current?.onStdout?.(text);

    const idx = this.buffer.indexOf(COMMAND_DELIMITER);
    if (idx !== -1) this.complete(idx);
  }

  private complete(delimIdx: number): void {
    if (!this.current) return;
    const after = this.buffer.slice(delimIdx + COMMAND_DELIMITER.length);
    const exitMatch = after.match(/^(\d+)/);
    const exitCode = exitMatch ? parseInt(exitMatch[1]) : 1;
    const stdout = this.buffer.slice(0, delimIdx).replace(/\n$/, '');
    this.buffer = after.replace(/^\d+\n?/, '');

    const cmd = this.current;
    this.current = null;
    if (cmd.timer) clearTimeout(cmd.timer);

    cmd.resolve({ stdout, stderr: this.stderrBuf, exitCode, durationMs: Date.now() - cmd.startedAt, timedOut: false });
    this.stderrBuf = '';
    setImmediate(() => this.drain());
  }

  private onTimeout(cmd: PendingCommand): void {
    if (this.current !== cmd) return;
    try { this.proc!.kill('SIGINT'); } catch {}
    cmd.resolve({ stdout: this.buffer, stderr: this.stderrBuf + '\n[timed out]', exitCode: 124, durationMs: Date.now() - cmd.startedAt, timedOut: true });
    this.current = null;
    this.buffer = '';
    this.stderrBuf = '';
    this.restart().catch(() => {});
  }

  async getCwd(): Promise<string> {
    const r = await this.exec('pwd -P', { timeoutMs: 2000 });
    this._cwd = r.stdout.trim() || this._cwd;
    return this._cwd;
  }

  async restart(): Promise<void> {
    // Ask shell for current directory (both virtual and real) BEFORE stopping
    let virtualCwd: string | undefined;
    let realCwd: string | undefined;
    if (this.alive) {
      try {
        virtualCwd = (await this.exec('pwd', { timeoutMs: 2000 })).stdout.trim();
        realCwd = (await this.exec('pwd -W 2>/dev/null || pwd -P', { timeoutMs: 2000 })).stdout.trim();
      } catch {}
    }

    await this.stop();

    // Start with real OS path as spawn cwd
    if (realCwd) this.opts.cwd = realCwd;
    await this.start();

    // cd back to the virtual path inside the new shell
    if (virtualCwd) {
      try {
        await this.exec(`cd "${virtualCwd}" 2>/dev/null || true`, { timeoutMs: 2000 });
        this._cwd = virtualCwd;
      } catch {}
    }
  }

  async stop(): Promise<void> {
    this.alive = false;
    // Resolve (not reject) pending commands with error — prevents unhandled rejections
    if (this.current) {
      if (this.current.timer) clearTimeout(this.current.timer);
      this.current.resolve({ stdout: '', stderr: 'Shell stopped', exitCode: 130, durationMs: Date.now() - this.current.startedAt, timedOut: false });
      this.current = null;
    }
    for (const c of this.queue) {
      c.resolve({ stdout: '', stderr: 'Shell stopped', exitCode: 130, durationMs: 0, timedOut: false });
    }
    this.queue = [];
    if (this.proc) {
      try { this.proc.stdin!.write('exit\n'); } catch {}
      const p = this.proc;
      this.proc = null;
      await new Promise<void>(resolve => {
        setTimeout(() => { try { p.kill('SIGKILL'); } catch {} resolve(); }, 500);
      });
    }
  }

  isAlive(): boolean { return this.alive && this.proc !== null && !this.proc.killed; }
}
