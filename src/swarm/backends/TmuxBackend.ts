/**
 * TmuxBackend.ts — PaneBackend implementation for tmux
 *
 * Uses a dedicated tmux socket per process to avoid conflicts.
 * When running inside an existing tmux session ($TMUX set) we split
 * the current window; otherwise we create a new detached session.
 */

import { execSync } from 'child_process';
import * as crypto from 'crypto';
import type {
  PaneBackend,
  BackendType,
  CreatePaneOptions,
  PaneHandle,
} from '../types.js';
import { TMUX_SOCKET_PREFIX } from '../constants.js';

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * Shell-escape a single argument to prevent injection.
 */
function shellEscape(arg: string): string {
  // Wrap in single quotes; escape existing single quotes
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Run a tmux command on our dedicated socket and return stdout trimmed.
 */
function tmux(socket: string, args: string): string {
  const cmd = `tmux -L ${shellEscape(socket)} ${args}`;
  return execSync(cmd, { encoding: 'utf-8', timeout: 10_000 }).trim();
}

// ────────────────────────────────────────────────────────────────────────────
// TmuxBackend
// ────────────────────────────────────────────────────────────────────────────

export class TmuxBackend implements PaneBackend {
  readonly type: BackendType = 'tmux';

  /** Dedicated socket name for this process. */
  private readonly socket: string;

  /** Track pane IDs we have created so we can clean them up. */
  private readonly managedPanes = new Set<string>();

  /** Whether we created the server (vs reusing an existing session). */
  private ownsServer = false;

  constructor() {
    this.socket = `${TMUX_SOCKET_PREFIX}-${process.pid}`;
  }

  // ── Availability ──────────────────────────────────────────────────────

  async isAvailable(): Promise<boolean> {
    try {
      execSync('tmux -V', { encoding: 'utf-8', timeout: 5_000, stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  // ── Create ────────────────────────────────────────────────────────────

  async createPane(options: CreatePaneOptions): Promise<PaneHandle> {
    const { title, cwd, command, env, memberName } = options;

    // Build environment exports
    const envExports = env
      ? Object.entries(env)
          .map(([k, v]) => `export ${k}=${shellEscape(v)};`)
          .join(' ')
      : '';

    const fullCmd = `${envExports} cd ${shellEscape(cwd)} && ${command.map(shellEscape).join(' ')}`;

    let paneId: string;

    if (process.env['TMUX']) {
      // Inside tmux -- split the current window
      const raw = tmux(
        this.socket,
        `split-window -h -d -P -F "#{pane_id}" -c ${shellEscape(cwd)} ${shellEscape(fullCmd)}`,
      );
      paneId = raw.startsWith('%') ? raw : `%${raw}`;
    } else {
      // No tmux session -- start a new detached session
      const sessionName = `clow-${crypto.randomUUID().slice(0, 8)}`;
      try {
        tmux(
          this.socket,
          `new-session -d -s ${shellEscape(sessionName)} -c ${shellEscape(cwd)} ${shellEscape(fullCmd)}`,
        );
        this.ownsServer = true;
      } catch {
        // Server may already exist from a prior run on the same PID
        tmux(
          this.socket,
          `new-window -d -P -F "#{pane_id}" -c ${shellEscape(cwd)} ${shellEscape(fullCmd)}`,
        );
      }

      // Grab the pane id of the just-created pane
      const raw = tmux(
        this.socket,
        'display-message -p "#{pane_id}"',
      );
      paneId = raw.startsWith('%') ? raw : `%${raw}`;
    }

    this.managedPanes.add(paneId);

    // Set a human-readable title on the pane
    await this.setPaneTitle(paneId, title);

    return {
      id: paneId,
      backend: 'tmux',
      title,
      isAlive: true,
      pid: this.getPanePid(paneId),
    };
  }

  // ── Send ──────────────────────────────────────────────────────────────

  async sendToPane(paneId: string, input: string): Promise<void> {
    tmux(
      this.socket,
      `send-keys -t ${shellEscape(paneId)} ${shellEscape(input)} Enter`,
    );
  }

  // ── Title ─────────────────────────────────────────────────────────────

  async setPaneTitle(paneId: string, title: string): Promise<void> {
    try {
      tmux(
        this.socket,
        `select-pane -t ${shellEscape(paneId)} -T ${shellEscape(title)}`,
      );
    } catch {
      // Non-fatal: older tmux versions may not support -T
    }
  }

  // ── Kill ──────────────────────────────────────────────────────────────

  async killPane(paneId: string): Promise<boolean> {
    try {
      tmux(this.socket, `kill-pane -t ${shellEscape(paneId)}`);
      this.managedPanes.delete(paneId);
      return true;
    } catch {
      this.managedPanes.delete(paneId);
      return false;
    }
  }

  // ── List ──────────────────────────────────────────────────────────────

  async listPanes(): Promise<PaneHandle[]> {
    try {
      const raw = tmux(
        this.socket,
        'list-panes -a -F "#{pane_id}|#{pane_title}|#{pane_pid}|#{pane_dead}"',
      );
      if (!raw) return [];

      return raw.split('\n').map((line) => {
        const [id = '', title = '', pidStr = '', dead = ''] = line.split('|');
        const pid = parseInt(pidStr, 10);
        return {
          id,
          backend: 'tmux' as BackendType,
          title,
          pid: Number.isNaN(pid) ? undefined : pid,
          isAlive: dead !== '1',
        };
      });
    } catch {
      return [];
    }
  }

  // ── Cleanup ───────────────────────────────────────────────────────────

  async cleanup(): Promise<void> {
    // Kill individual panes we created
    for (const paneId of this.managedPanes) {
      try {
        tmux(this.socket, `kill-pane -t ${shellEscape(paneId)}`);
      } catch {
        // pane already dead
      }
    }
    this.managedPanes.clear();

    // If we own the server, kill it entirely
    if (this.ownsServer) {
      try {
        tmux(this.socket, 'kill-server');
      } catch {
        // server already gone
      }
      this.ownsServer = false;
    }
  }

  // ── Internal helpers ──────────────────────────────────────────────────

  /**
   * Attempt to retrieve the PID running in a tmux pane.
   */
  private getPanePid(paneId: string): number | undefined {
    try {
      const raw = tmux(
        this.socket,
        `display-message -t ${shellEscape(paneId)} -p "#{pane_pid}"`,
      );
      const pid = parseInt(raw, 10);
      return Number.isNaN(pid) ? undefined : pid;
    } catch {
      return undefined;
    }
  }
}
