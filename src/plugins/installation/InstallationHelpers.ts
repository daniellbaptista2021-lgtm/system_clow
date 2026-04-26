/**
 * InstallationHelpers.ts — Shell helpers and utilities for plugin installation
 *
 * Based on Claude Code's installHelpers.ts (~300 lines)
 *
 * Features:
 *   - Git clone with depth, branch, timeout
 *   - npm install with production flag
 *   - Directory copy (recursive)
 *   - Safe directory creation
 *   - Temporary directory management
 *   - File hash computation
 *   - Directory size calculation
 *   - Cleanup helpers
 *   - Platform-aware commands
 *   - Retry with backoff for network operations
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

// ─── Constants ──────────────────────────────────────────────────────────────

const GIT_TIMEOUT_MS = 120_000;
const NPM_TIMEOUT_MS = 180_000;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1_000;

// ─── Git Operations ─────────────────────────────────────────────────────────

/**
 * Clone a git repository.
 * @param url - Repository URL
 * @param dest - Destination directory
 * @param ref - Optional branch/tag/commit
 * @param depth - Clone depth (default 1 for shallow)
 */
export function gitClone(url: string, dest: string, ref?: string, depth: number = 1): void {
  const depthArg = depth > 0 ? `--depth ${depth}` : '';
  const refArg = ref ? `--branch ${ref}` : '';
  const cmd = `git clone ${depthArg} ${refArg} "${url}" "${dest}"`.replace(/\s+/g, ' ');

  try {
    execSync(cmd, {
      stdio: 'pipe',
      timeout: GIT_TIMEOUT_MS,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
  } catch (err: any) {
    const stderr = err.stderr?.toString() ?? '';
    throw new Error(`Git clone failed: ${stderr || err.message}`);
  }
}

/**
 * Pull latest changes in an existing repo.
 */
export function gitPull(dir: string, ref?: string): void {
  try {
    if (ref) {
      execSync(`git fetch origin ${ref} && git checkout ${ref}`, {
        cwd: dir, stdio: 'pipe', timeout: GIT_TIMEOUT_MS,
      });
    } else {
      execSync('git pull --ff-only', {
        cwd: dir, stdio: 'pipe', timeout: GIT_TIMEOUT_MS,
      });
    }
  } catch (err: any) {
    throw new Error(`Git pull failed: ${err.message}`);
  }
}

/**
 * Get the current commit hash of a git repo.
 */
export function gitGetHash(dir: string): string | null {
  try {
    return execSync('git rev-parse HEAD', { cwd: dir, stdio: 'pipe', timeout: 5_000 })
      .toString().trim();
  } catch {
    return null;
  }
}

/**
 * Check if a directory is a git repository.
 */
export function isGitRepo(dir: string): boolean {
  return fs.existsSync(path.join(dir, '.git'));
}

// ─── NPM Operations ────────────────────────────────────────────────────────

/**
 * Run npm install in a directory.
 * Only runs if package.json exists.
 */
export function npmInstall(dir: string, production: boolean = true): void {
  if (!fs.existsSync(path.join(dir, 'package.json'))) return;

  const flags = production ? '--production --no-optional' : '--no-optional';
  try {
    execSync(`npm install ${flags}`, {
      cwd: dir,
      stdio: 'pipe',
      timeout: NPM_TIMEOUT_MS,
      env: { ...process.env, NODE_ENV: production ? 'production' : 'development' },
    });
  } catch (err: any) {
    const stderr = err.stderr?.toString() ?? '';
    throw new Error(`npm install failed: ${stderr || err.message}`);
  }
}

/**
 * Check if node_modules exists and is populated.
 */
export function hasNodeModules(dir: string): boolean {
  const nm = path.join(dir, 'node_modules');
  if (!fs.existsSync(nm)) return false;
  try {
    return fs.readdirSync(nm).length > 0;
  } catch {
    return false;
  }
}

// ─── Directory Operations ───────────────────────────────────────────────────

/**
 * Copy directory recursively.
 */
export function copyDir(src: string, dest: string): void {
  fs.cpSync(src, dest, { recursive: true });
}

/**
 * Create a temporary directory for plugin operations.
 */
export function createTempDir(prefix: string = 'clow-plugin-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Safely remove a directory (catch errors silently).
 */
export async function safeRemoveDir(dir: string): Promise<boolean> {
  try {
    await fsp.rm(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure a directory exists.
 */
export async function ensureDir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
}

/**
 * Move a directory (rename, or copy+delete if cross-device).
 */
export async function moveDir(src: string, dest: string): Promise<void> {
  try {
    await fsp.rename(src, dest);
  } catch {
    // Cross-device move — copy then delete
    copyDir(src, dest);
    await safeRemoveDir(src);
  }
}

// ─── Hash Operations ────────────────────────────────────────────────────────

/**
 * Compute SHA-256 hash of a file.
 */
export async function hashFile(filePath: string): Promise<string> {
  const content = await fsp.readFile(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Compute SHA-256 hash of a directory (all files, sorted).
 */
export async function hashDirectory(dir: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  const files = await collectFiles(dir);
  files.sort();

  for (const file of files) {
    const relativePath = path.relative(dir, file);
    const content = await fsp.readFile(file);
    hash.update(relativePath);
    hash.update(content);
  }

  return hash.digest('hex');
}

/**
 * Collect all files in a directory recursively.
 */
async function collectFiles(dir: string): Promise<string[]> {
  const results: string[] = [];

  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...await collectFiles(fullPath));
      } else if (entry.isFile()) {
        results.push(fullPath);
      }
    }
  } catch { /* skip */ }

  return results;
}

// ─── Size Operations ────────────────────────────────────────────────────────

/**
 * Get total size of a directory in bytes.
 */
export async function getDirectorySize(dir: string): Promise<number> {
  let total = 0;

  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        total += await getDirectorySize(fullPath);
      } else if (entry.isFile()) {
        const stat = await fsp.stat(fullPath);
        total += stat.size;
      }
    }
  } catch { /* skip */ }

  return total;
}

/**
 * Format bytes to human-readable string.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// ─── Retry Logic ────────────────────────────────────────────────────────────

/**
 * Retry an async operation with exponential backoff.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = MAX_RETRIES,
  baseDelayMs: number = RETRY_BASE_MS,
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err as Error;
      if (attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 500;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}
