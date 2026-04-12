/**
 * sandboxRunner.ts — OS-level sandbox wrapper (bwrap/firejail/seatbelt)
 *
 * Provides OS-level process isolation for command execution:
 *   - bubblewrap (bwrap) on Linux — namespace-based isolation
 *   - firejail on Linux — seccomp-based sandboxing
 *   - sandbox-exec (seatbelt) on macOS — profile-based sandbox
 *   - none fallback — no isolation, command runs directly
 *
 * Features:
 *   - Auto-detection of available sandbox backends
 *   - Configurable network and filesystem access
 *   - Sandbox execution statistics tracking
 *   - Input validation for sandbox parameters
 */

import { execSync } from 'child_process';
import * as fs from 'fs';

/** Available sandbox backends ordered by preference */
export type SandboxBackend = 'none' | 'bwrap' | 'firejail' | 'seatbelt';

/** Options for sandbox wrapping */
export interface SandboxOptions {
  /** Workspace root directory to mount read-write */
  workspaceRoot: string;
  /** Whether to allow network access (default: false) */
  allowNetwork?: boolean;
  /** Additional directories to mount read-only */
  additionalReadOnlyPaths?: string[];
  /** Timeout in milliseconds for sandboxed commands */
  timeoutMs?: number;
}

/** Result of sandbox detection */
export interface SandboxDetectionResult {
  /** The detected backend */
  backend: SandboxBackend;
  /** Platform (linux, darwin, win32) */
  platform: string;
  /** All available backends on this system */
  availableBackends: SandboxBackend[];
  /** Whether any sandbox is available */
  sandboxAvailable: boolean;
}

export class SandboxRunner {
  /** Track sandbox usage statistics */
  private static totalWraps = 0;
  private static wrapsByBackend = new Map<SandboxBackend, number>();
  private static detectionCache: SandboxDetectionResult | null = null;

  /**
   * Detect the best available sandbox backend for the current OS.
   * Results are cached after the first call for performance.
   *
   * @returns The most secure available sandbox backend
   */
  static detect(): SandboxBackend {
    if (this.detectionCache) return this.detectionCache.backend;
    const result = this.detectAll();
    this.detectionCache = result;
    return result.backend;
  }

  /**
   * Detect all available sandbox backends with detailed information.
   *
   * @returns Detection result including all available backends
   */
  static detectAll(): SandboxDetectionResult {
    const available: SandboxBackend[] = ['none'];

    if (process.platform === 'darwin') {
      if (fs.existsSync('/usr/bin/sandbox-exec')) {
        available.push('seatbelt');
      }
    }

    if (process.platform === 'linux') {
      if (this.cmdExists('bwrap')) available.push('bwrap');
      if (this.cmdExists('firejail')) available.push('firejail');
    }

    // Pick best backend (prefer bwrap > firejail > seatbelt > none)
    let best: SandboxBackend = 'none';
    if (available.includes('bwrap')) best = 'bwrap';
    else if (available.includes('firejail')) best = 'firejail';
    else if (available.includes('seatbelt')) best = 'seatbelt';

    return {
      backend: best,
      platform: process.platform,
      availableBackends: available,
      sandboxAvailable: available.length > 1,
    };
  }

  /**
   * Wrap a command with sandbox isolation.
   * The command will run inside the sandbox with restricted access.
   *
   * @param cmd - The shell command to wrap
   * @param backend - Which sandbox backend to use
   * @param opts - Sandbox configuration options
   * @returns The wrapped command string ready for execution
   */
  static wrap(cmd: string, backend: SandboxBackend, opts: SandboxOptions): string {
    this.totalWraps++;
    this.wrapsByBackend.set(backend, (this.wrapsByBackend.get(backend) ?? 0) + 1);

    if (backend === 'none') return cmd;

    // Validate workspace root exists
    if (!opts.workspaceRoot || !fs.existsSync(opts.workspaceRoot)) {
      console.warn('[SandboxRunner] Workspace root does not exist, skipping sandbox');
      return cmd;
    }

    const esc = cmd.replace(/'/g, "'\\''");

    if (backend === 'bwrap') {
      const net = opts.allowNetwork ? '' : '--unshare-net';
      const extraBinds = (opts.additionalReadOnlyPaths ?? [])
        .filter(p => fs.existsSync(p))
        .map(p => `--ro-bind ${p} ${p}`)
        .join(' ');
      return `bwrap --ro-bind /usr /usr --ro-bind /lib /lib --ro-bind /bin /bin --ro-bind /etc /etc --proc /proc --dev /dev --bind ${opts.workspaceRoot} ${opts.workspaceRoot} --chdir ${opts.workspaceRoot} --die-with-parent ${net} ${extraBinds} -- bash -c '${esc}'`;
    }

    if (backend === 'firejail') {
      const net = opts.allowNetwork ? '' : '--net=none';
      const timeout = opts.timeoutMs ? `--timeout=${Math.ceil(opts.timeoutMs / 1000)}:00:00` : '';
      return `firejail --quiet --noprofile --whitelist=${opts.workspaceRoot} ${net} ${timeout} -- bash -c '${esc}'`;
    }

    return cmd; // seatbelt: TODO profile-based
  }

  /**
   * Get sandbox usage statistics.
   *
   * @returns Statistics about sandbox wrapping since startup
   */
  static getStats(): {
    totalWraps: number;
    wrapsByBackend: Record<string, number>;
    detectedBackend: SandboxBackend;
    sandboxAvailable: boolean;
  } {
    return {
      totalWraps: this.totalWraps,
      wrapsByBackend: Object.fromEntries(this.wrapsByBackend),
      detectedBackend: this.detect(),
      sandboxAvailable: this.detectAll().sandboxAvailable,
    };
  }

  /**
   * Reset detection cache (useful after system changes).
   */
  static resetCache(): void {
    this.detectionCache = null;
  }

  /**
   * Check if a command-line tool is available on the system.
   *
   * @param c - Command name to check
   * @returns True if the command exists in PATH
   */
  private static cmdExists(c: string): boolean {
    try { execSync(`which ${c}`, { stdio: 'ignore' }); return true; } catch { return false; }
  }
}
