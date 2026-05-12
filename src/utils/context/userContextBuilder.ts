/** Build dynamic user context (git, env, platform). Cached 5s. */

import { execSync } from 'child_process';
import type { UserContextBlock } from './types.js';

export class UserContextBuilder {
  private cache = new Map<string, { value: string | undefined; at: number }>();
  private readonly TTL = 5_000;

  async build(opts: {
    cwd: string; workspaceRoot: string; additionalWorkingDirectories?: string[];
    tenantTier?: string; tenantId?: string; permissionMode: string; agentDepth: number;
  }): Promise<UserContextBlock> {
    const [isGit, branch, status] = this.gitInfo(opts.cwd);
    const recent = isGit ? this.recentFiles(opts.cwd) : undefined;

    return {
      cwd: opts.cwd, workspaceRoot: opts.workspaceRoot,
      platform: process.platform, shell: process.env.SHELL ?? '/bin/sh',
      nodeVersion: process.version, date: new Date().toISOString(),
      isGitRepo: isGit, gitBranch: branch, gitStatus: status,
      recentlyModifiedFiles: recent,
      additionalWorkingDirectories: opts.additionalWorkingDirectories,
      tenantTier: opts.tenantTier, tenantId: opts.tenantId,
      permissionMode: opts.permissionMode, agentDepth: opts.agentDepth,
    };
  }

  private gitInfo(cwd: string): [boolean, string | undefined, string | undefined] {
    const cached = this.cache.get(cwd);
    if (cached && Date.now() - cached.at < this.TTL) {
      const isRepo = cached.value !== undefined;
      return [isRepo, isRepo ? this.exec('git rev-parse --abbrev-ref HEAD', cwd) : undefined, cached.value];
    }

    const isRepo = this.exec('git rev-parse --git-dir', cwd) !== undefined;
    if (!isRepo) { this.cache.set(cwd, { value: undefined, at: Date.now() }); return [false, undefined, undefined]; }

    const branch = this.exec('git rev-parse --abbrev-ref HEAD', cwd);
    const raw = this.exec('git status --porcelain', cwd) ?? '';
    const lines = raw.split('\n').filter(l => l.length > 0);

    let status: string;
    if (lines.length === 0) { status = 'clean'; }
    else {
      let m = 0, a = 0, d = 0, u = 0;
      for (const l of lines) { const s = l.slice(0, 2); if (s.includes('M')) m++; else if (s.includes('A')) a++; else if (s.includes('D')) d++; else if (s.includes('?')) u++; }
      const parts: string[] = [];
      if (m) parts.push(`${m} modified`); if (a) parts.push(`${a} added`);
      if (d) parts.push(`${d} deleted`); if (u) parts.push(`${u} untracked`);
      status = parts.join(', ');
    }

    this.cache.set(cwd, { value: status, at: Date.now() });
    return [true, branch, status];
  }

  private recentFiles(cwd: string): string[] | undefined {
    const raw = this.exec('git log -5 --name-only --pretty=format:', cwd);
    if (!raw) return undefined;
    return [...new Set(raw.split('\n').filter(l => l.length > 0))].slice(0, 10);
  }

  private exec(cmd: string, cwd: string): string | undefined {
    try { return execSync(cmd, { cwd, encoding: 'utf-8', timeout: 2000, stdio: ['pipe', 'pipe', 'pipe'] }).trim(); }
    catch { return undefined; }
  }

  invalidateCache(cwd?: string): void { cwd ? this.cache.delete(cwd) : this.cache.clear(); }
}
