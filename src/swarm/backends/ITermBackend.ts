/**
 * ITermBackend.ts — PaneBackend implementation for iTerm2
 *
 * Uses iTerm2's `it2` CLI utilities and falls back to AppleScript via
 * `osascript` for operations not covered by the CLI.
 */

import { execSync } from 'child_process';
import * as crypto from 'crypto';
import type {
  PaneBackend,
  BackendType,
  CreatePaneOptions,
  PaneHandle,
} from '../types.js';
import { ITERM_TAB_PREFIX } from '../constants.js';

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function shellEscape(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

function runCmd(cmd: string): string {
  return execSync(cmd, { encoding: 'utf-8', timeout: 10_000, stdio: 'pipe' }).trim();
}

/**
 * Execute an AppleScript snippet targeting iTerm2.
 */
function osascript(script: string): string {
  return runCmd(`osascript -e ${shellEscape(script)}`);
}

// ────────────────────────────────────────────────────────────────────────────
// ITermBackend
// ────────────────────────────────────────────────────────────────────────────

export class ITermBackend implements PaneBackend {
  readonly type: BackendType = 'iterm2';

  /** Track tabs we have created. Maps our internal ID -> tab title. */
  private readonly managedTabs = new Map<string, string>();

  // ── Availability ──────────────────────────────────────────────────────

  async isAvailable(): Promise<boolean> {
    // Must be running inside iTerm2
    if (process.env['TERM_PROGRAM'] !== 'iTerm.app') {
      return false;
    }

    // Check for the it2 CLI (shipped with iTerm2 shell integration)
    try {
      runCmd('which it2');
      return true;
    } catch {
      // it2 is optional; we can fall back to osascript
      try {
        osascript(
          'tell application "iTerm2" to return version',
        );
        return true;
      } catch {
        return false;
      }
    }
  }

  // ── Create ────────────────────────────────────────────────────────────

  async createPane(options: CreatePaneOptions): Promise<PaneHandle> {
    const { title, cwd, command, env, memberName } = options;
    const tabId = `${ITERM_TAB_PREFIX}${crypto.randomUUID().slice(0, 8)}`;

    // Build environment exports
    const envExports = env
      ? Object.entries(env)
          .map(([k, v]) => `export ${k}=${shellEscape(v)}`)
          .join('; ')
      : '';

    const fullCmd = [
      envExports,
      `cd ${shellEscape(cwd)}`,
      command.map(shellEscape).join(' '),
    ]
      .filter(Boolean)
      .join(' && ');

    try {
      // Try the it2 CLI first
      runCmd(`it2 new-tab --command ${shellEscape(fullCmd)}`);
    } catch {
      // Fallback to AppleScript
      const script = [
        'tell application "iTerm2"',
        '  tell current window',
        `    create tab with default profile command ${shellEscape(fullCmd)}`,
        '  end tell',
        'end tell',
      ].join('\n');
      osascript(script);
    }

    this.managedTabs.set(tabId, title);

    // Best-effort title set
    await this.setPaneTitle(tabId, title);

    return {
      id: tabId,
      backend: 'iterm2',
      title,
      isAlive: true,
    };
  }

  // ── Send ──────────────────────────────────────────────────────────────

  async sendToPane(_paneId: string, input: string): Promise<void> {
    try {
      runCmd(`it2 send-text ${shellEscape(input + '\n')}`);
    } catch {
      const script = [
        'tell application "iTerm2"',
        '  tell current session of current window',
        `    write text ${shellEscape(input)}`,
        '  end tell',
        'end tell',
      ].join('\n');
      osascript(script);
    }
  }

  // ── Title ─────────────────────────────────────────────────────────────

  async setPaneTitle(_paneId: string, title: string): Promise<void> {
    try {
      const script = [
        'tell application "iTerm2"',
        '  tell current session of current window',
        `    set name to ${shellEscape(title)}`,
        '  end tell',
        'end tell',
      ].join('\n');
      osascript(script);
    } catch {
      // Non-fatal
    }
  }

  // ── Kill ──────────────────────────────────────────────────────────────

  async killPane(paneId: string): Promise<boolean> {
    try {
      const script = [
        'tell application "iTerm2"',
        '  tell current session of current window',
        '    close',
        '  end tell',
        'end tell',
      ].join('\n');
      osascript(script);
      this.managedTabs.delete(paneId);
      return true;
    } catch {
      this.managedTabs.delete(paneId);
      return false;
    }
  }

  // ── List ──────────────────────────────────────────────────────────────

  async listPanes(): Promise<PaneHandle[]> {
    const handles: PaneHandle[] = [];
    for (const [id, title] of this.managedTabs) {
      handles.push({
        id,
        backend: 'iterm2',
        title,
        isAlive: true, // We can't easily check iTerm tab liveness
      });
    }
    return handles;
  }

  // ── Cleanup ───────────────────────────────────────────────────────────

  async cleanup(): Promise<void> {
    for (const [paneId] of this.managedTabs) {
      try {
        await this.killPane(paneId);
      } catch {
        // best effort
      }
    }
    this.managedTabs.clear();
  }
}
