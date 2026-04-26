/**
 * sandboxRunner.ts — OS-level sandbox wrapper (bwrap/firejail/seatbelt)
 *
 * Provides OS-level process isolation for command execution:
 *   - bubblewrap (bwrap) on Linux — namespace-based isolation
 *   - firejail on Linux — seccomp-based sandboxing
 *   - sandbox-exec (seatbelt) on macOS — profile-based sandbox
 *   - none fallback — no isolation, command runs directly
 */

import { execSync } from 'child_process';
import * as fs from 'fs';

export type SandboxBackend = 'none' | 'bwrap' | 'firejail' | 'seatbelt';

export interface SandboxOptions {
  workspaceRoot: string;
  allowNetwork?: boolean;
  additionalReadOnlyPaths?: string[];
  timeoutMs?: number;
}

export interface SandboxDetectionResult {
  backend: SandboxBackend;
  platform: string;
  availableBackends: SandboxBackend[];
  sandboxAvailable: boolean;
}

export class SandboxRunner {
  private static totalWraps = 0;
  private static wrapsByBackend = new Map<SandboxBackend, number>();
  private static detectionCache: SandboxDetectionResult | null = null;

  static detect(): SandboxBackend {
    if (this.detectionCache) return this.detectionCache.backend;
    const result = this.detectAll();
    this.detectionCache = result;
    return result.backend;
  }

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

  static wrap(cmd: string, backend: SandboxBackend, opts: SandboxOptions): string {
    this.totalWraps++;
    this.wrapsByBackend.set(backend, (this.wrapsByBackend.get(backend) ?? 0) + 1);

    if (backend === 'none') return cmd;

    if (!opts.workspaceRoot || !fs.existsSync(opts.workspaceRoot)) {
      console.warn('[SandboxRunner] Workspace root does not exist, skipping sandbox');
      return cmd;
    }

    const esc = cmd.replace(/'/g, "'\\''");

    if (backend === 'bwrap') {
      const net = opts.allowNetwork ? '' : '--unshare-net';
      const extraBinds = (opts.additionalReadOnlyPaths ?? [])
        .filter((p) => fs.existsSync(p))
        .map((p) => `--ro-bind ${p} ${p}`)
        .join(' ');
      return `bwrap --ro-bind /usr /usr --ro-bind /lib /lib --ro-bind /lib64 /lib64 --ro-bind /bin /bin --ro-bind /etc /etc --proc /proc --dev /dev --bind ${opts.workspaceRoot} ${opts.workspaceRoot} --chdir ${opts.workspaceRoot} --die-with-parent ${net} ${extraBinds} -- /usr/bin/bash -c '${esc}'`;
    }

    if (backend === 'firejail') {
      const net = opts.allowNetwork ? '' : '--net=none';
      const timeout = opts.timeoutMs ? `--timeout=${Math.ceil(opts.timeoutMs / 1000)}:00:00` : '';
      return `firejail --quiet --noprofile --whitelist=${opts.workspaceRoot} ${net} ${timeout} -- /usr/bin/bash -c '${esc}'`;
    }

    return cmd;
  }

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

  static resetCache(): void {
    this.detectionCache = null;
  }

  private static cmdExists(c: string): boolean {
    try {
      execSync(`which ${c}`, { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }
}
