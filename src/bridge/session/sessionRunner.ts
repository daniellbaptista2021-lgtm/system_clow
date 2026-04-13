import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import type {
  WorkResponse,
  Transport,
  OutboundMessage,
  SpawnMode,
  WorktreeConfig,
  BridgeSessionStatus,
} from '../types.js';
import { SystemCommandType } from '../types.js';

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface RunningSession {
  workId: string;
  sessionId: string;
  child: ChildProcess;
  cwd: string;
  startedAt: number;
  transport: Transport;
  stdoutBuffer: string;
  stderrBuffer: string;
  rawStdout: string;
  rawStderr: string;
  status: BridgeSessionStatus;
}

export interface SessionRunnerOptions {
  env?: Record<string, string>;
  extraArgs?: string[];
  killTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// SessionRunner
// ---------------------------------------------------------------------------

export class SessionRunner {
  private readonly clowBinaryPath: string;
  private readonly mode: SpawnMode;
  private readonly worktreeConfig: WorktreeConfig | undefined;
  private readonly sessions: Map<string, RunningSession> = new Map();
  private readonly killTimeoutMs: number;
  private readonly extraEnv: Record<string, string>;
  private readonly extraArgs: string[];

  constructor(
    clowBinaryPath: string,
    mode: SpawnMode,
    worktreeConfig?: WorktreeConfig,
    options?: SessionRunnerOptions,
  ) {
    this.clowBinaryPath = clowBinaryPath;
    this.mode = mode;
    this.worktreeConfig = worktreeConfig;
    this.killTimeoutMs = options?.killTimeoutMs ?? 5000;
    this.extraEnv = options?.env ?? {};
    this.extraArgs = options?.extraArgs ?? [];
  }

  /**
   * Spawn a new child clow process for the given work item and wire its
   * stdio to the provided transport.
   */
  async spawnForWork(work: WorkResponse, transport: Transport): Promise<RunningSession> {
    const sessionId = work.sessionId ?? crypto.randomUUID();
    const cwd = this.determineCwd(work);

    if (!fs.existsSync(cwd)) {
      fs.mkdirSync(cwd, { recursive: true });
    }

    const args = this.buildArgs(work);
    const env = this.buildEnv(work);

    const child = spawn(this.clowBinaryPath, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const session: RunningSession = {
      workId: work.workId,
      sessionId,
      child,
      cwd,
      startedAt: Date.now(),
      transport,
      stdoutBuffer: '',
      stderrBuffer: '',
      rawStdout: '',
      rawStderr: '',
      status: 'creating',
    };

    this.sessions.set(work.workId, session);
    this.setupChildHandlers(session);

    child.on('spawn', () => {
      session.status = 'running';
    });

    child.on('error', (err) => {
      session.status = 'failed';
      this.handleChildError(session, err);
    });

    child.on('exit', (code, signal) => {
      session.status = 'completed';
      this.handleChildExit(session, code, signal);
    });

    return session;
  }

  /**
   * Send an inbound JSON message to a running session's stdin.
   */
  sendToSession(workId: string, input: Record<string, unknown>): boolean {
    const session = this.sessions.get(workId);
    if (!session || !session.child.stdin || session.child.stdin.destroyed) return false;
    try {
      const line = JSON.stringify(input) + '\n';
      return session.child.stdin.write(line);
    } catch {
      return false;
    }
  }

  /**
   * Send a rotate_token system command to refresh the session token.
   */
  refreshToken(workId: string, newToken: string): boolean {
    return this.sendToSession(workId, {
      type: SystemCommandType.RotateToken,
      env: { SESSION_TOKEN: newToken },
    });
  }

  /**
   * Gracefully kill a session — SIGTERM + timeout + SIGKILL.
   */
  async killSession(workId: string): Promise<void> {
    const session = this.sessions.get(workId);
    if (!session) return;

    session.status = 'killed';
    const child = session.child;

    if (child.exitCode !== null) {
      this.sessions.delete(workId);
      return;
    }

    return new Promise<void>((resolve) => {
      const forceKillTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // already dead
        }
      }, this.killTimeoutMs);

      child.once('exit', () => {
        clearTimeout(forceKillTimer);
        this.sessions.delete(workId);
        resolve();
      });

      try {
        child.kill('SIGTERM');
      } catch {
        clearTimeout(forceKillTimer);
        this.sessions.delete(workId);
        resolve();
      }
    });
  }

  /** Return a snapshot of all active sessions. */
  getActiveSessions(): ReadonlyMap<string, RunningSession> {
    return this.sessions;
  }

  /** Number of currently-active sessions. */
  getActiveCount(): number {
    return this.sessions.size;
  }

  // -----------------------------------------------------------------------
  // Child I/O handlers
  // -----------------------------------------------------------------------

  private setupChildHandlers(session: RunningSession): void {
    const { child } = session;

    child.stdout?.on('data', (chunk: Buffer) => {
      session.stdoutBuffer += chunk.toString('utf-8');
      this.processStdoutBuffer(session);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      session.stderrBuffer += chunk.toString('utf-8');
      this.processStderrBuffer(session);
    });
  }

  /**
   * Line-buffer NDJSON from stdout. Each complete line is parsed and
   * forwarded through the transport as an OutboundMessage.
   */
  processStdoutBuffer(session: RunningSession): void {
    const lines = session.stdoutBuffer.split('\n');
    session.stdoutBuffer = lines.pop() ?? '';

    for (const raw of lines) {
      session.rawStdout += `${raw}\n`;
      session.rawStderr += `${raw}\n`;
      const line = raw.trim();
      if (line.length === 0) continue;

      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        const message: OutboundMessage = {
          type: (parsed['type'] as string) ?? 'unknown',
          payload: parsed,
          uuid: (parsed['uuid'] as string) ?? crypto.randomUUID(),
          timestamp: Date.now(),
        };
        session.transport.send(message).catch((err) => {
          this.logError(session, 'Failed to send outbound', err);
        });
      } catch {
        this.handleNonJsonOutput(session, line);
      }
    }
  }

  /** Process stderr buffer for logging. */
  private processStderrBuffer(session: RunningSession): void {
    const lines = session.stderrBuffer.split('\n');
    session.stderrBuffer = lines.pop() ?? '';

    for (const raw of lines) {
      const line = raw.trim();
      if (line.length === 0) continue;
      this.handleStderrLine(session, line);
    }
  }

  // -----------------------------------------------------------------------
  // Lifecycle helpers
  // -----------------------------------------------------------------------

  private handleChildError(session: RunningSession, err: Error): void {
    const msg: OutboundMessage = {
      type: 'session_error',
      payload: {
        workId: session.workId,
        sessionId: session.sessionId,
        error: err.message,
        code: (err as NodeJS.ErrnoException).code,
      },
      uuid: crypto.randomUUID(),
      timestamp: Date.now(),
    };
    session.transport.send(msg).catch(() => {});
  }

  private handleChildExit(
    session: RunningSession,
    code: number | null,
    signal: string | null,
  ): void {
    // Flush remaining stdout
    if (session.stdoutBuffer.trim().length > 0) {
      session.stdoutBuffer += '\n';
      this.processStdoutBuffer(session);
    }

    if (session.rawStdout.trim().length > 0) {
      const resultMsg: OutboundMessage = {
        type: 'session_result',
        payload: {
          workId: session.workId,
          sessionId: session.sessionId,
          content: session.rawStdout.trim(),
          stderr: session.rawStderr.trim() || undefined,
        },
        uuid: crypto.randomUUID(),
        timestamp: Date.now(),
      };
      session.transport.send(resultMsg).catch(() => {});
    }

    const msg: OutboundMessage = {
      type: 'session_exit',
      payload: {
        workId: session.workId,
        sessionId: session.sessionId,
        exitCode: code,
        signal,
      },
      uuid: crypto.randomUUID(),
      timestamp: Date.now(),
    };
    session.transport.send(msg).catch(() => {});
    this.sessions.delete(session.workId);
  }

  private handleNonJsonOutput(session: RunningSession, line: string): void {
    const msg: OutboundMessage = {
      type: 'session_log',
      payload: { text: line, stream: 'stdout', workId: session.workId },
      uuid: crypto.randomUUID(),
      timestamp: Date.now(),
    };
    session.transport.send(msg).catch(() => {});
  }

  private handleStderrLine(session: RunningSession, line: string): void {
    const msg: OutboundMessage = {
      type: 'session_log',
      payload: { text: line, stream: 'stderr', workId: session.workId },
      uuid: crypto.randomUUID(),
      timestamp: Date.now(),
    };
    session.transport.send(msg).catch(() => {});
  }

  // -----------------------------------------------------------------------
  // Argument / env building
  // -----------------------------------------------------------------------

  private buildArgs(work: WorkResponse): string[] {
    const args: string[] = [
      ...this.extraArgs,
      '--print',
    ];
    if (work.cwd) {
      args.push('--cwd', work.cwd);
    }
    args.push(work.prompt || `Bridge work ${work.workId}`);
    return args;
  }

  private buildEnv(work: WorkResponse): NodeJS.ProcessEnv {
    const base: Record<string, string | undefined> = { ...process.env };
    base['WORK_SECRET'] = work.workSecret;
    base['WORK_ID'] = work.workId;
    base['SESSION_ID'] = work.sessionId;
    base['CLOW_QUIET_BOOTSTRAP'] = '1';
    base['NODE_NO_WARNINGS'] = '1';
    for (const [key, value] of Object.entries(this.extraEnv)) {
      base[key] = value;
    }
    return base;
  }

  /**
   * Determine the working directory based on SpawnMode.
   */
  private determineCwd(work: WorkResponse): string {
    switch (this.mode) {
      case 'same-dir':
        return process.cwd();
      case 'single-session':
        return path.join(os.tmpdir(), 'clow-sessions', work.workId);
      case 'worktree': {
        if (!this.worktreeConfig) throw new Error('worktreeConfig required for worktree spawn mode');
        return path.join(this.worktreeConfig.baseDir, work.workId);
      }
      default: {
        const _exhaustive: never = this.mode;
        throw new Error('Unknown spawn mode: ' + String(_exhaustive));
      }
    }
  }

  private logError(session: RunningSession, message: string, err: unknown): void {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error('[SessionRunner] [' + session.workId + '] ' + message + ': ' + errMsg);
  }
}
