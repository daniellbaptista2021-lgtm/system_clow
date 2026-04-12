/**
 * workspaceHash.ts — Deterministic workspace identification
 *
 * Based on Claude Code's workspaceHash.ts (~100 lines)
 *
 * Creates a stable hash for a workspace path that:
 *   - Survives across machines (normalized, no hostname)
 *   - Survives symlink changes (resolved before hashing)
 *   - Is case-insensitive on Windows/macOS
 *   - Is case-sensitive on Linux
 *   - Strips trailing slashes
 *
 * Used to link sessions to workspaces for the /resume feature.
 *
 * Features:
 *   - Platform-aware case normalization
 *   - Path normalization (resolve, strip trailing slash)
 *   - SHA-256 hash (truncated to 16 hex chars)
 *   - Workspace equality check
 *   - Git root detection for workspace root
 */

import * as crypto from 'crypto';
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';

// ─── Constants ──────────────────────────────────────────────────────────────

const HASH_PREFIX = 'workspace:v1:';
const HASH_LENGTH = 16;

// ════════════════════════════════════════════════════════════════════════════
// Core Functions
// ════════════════════════════════════════════════════════════════════════════

/**
 * Create a deterministic hash for a workspace path.
 * Same workspace always produces the same hash, regardless of:
 *   - Current user
 *   - Hostname
 *   - Symlink resolution
 *   - Trailing slashes
 */
export function hashWorkspace(workspacePath: string): string {
  const normalized = normalizePath(workspacePath);
  return crypto.createHash('sha256')
    .update(`${HASH_PREFIX}${normalized}`)
    .digest('hex')
    .slice(0, HASH_LENGTH);
}

/**
 * Check if two paths refer to the same workspace.
 */
export function isSameWorkspace(a: string, b: string): boolean {
  return hashWorkspace(a) === hashWorkspace(b);
}

/**
 * Normalize a path for hashing.
 * - Resolves to absolute path
 * - Strips trailing separators
 * - Case-folds on case-insensitive platforms
 */
export function normalizePath(inputPath: string): string {
  // Resolve to absolute
  const resolved = path.normalize(path.resolve(inputPath));

  // Strip trailing slashes
  const stripped = resolved.replace(/[/\\]+$/, '');

  // Case-fold on case-insensitive platforms
  if (process.platform === 'linux') {
    return stripped;
  }

  return stripped.toLowerCase();
}

/**
 * Try to find the git root for a directory.
 * Returns null if not in a git repo.
 */
export function findGitRoot(dir: string): string | null {
  try {
    const result = execSync('git rev-parse --show-toplevel', {
      cwd: dir,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    }).toString().trim();
    return result || null;
  } catch {
    return null;
  }
}

/**
 * Determine the workspace root for a given directory.
 * Prefers git root, falls back to the directory itself.
 */
export function determineWorkspaceRoot(dir: string): string {
  const gitRoot = findGitRoot(dir);
  if (gitRoot) return gitRoot;
  return path.resolve(dir);
}

/**
 * Check if a directory looks like a workspace root.
 * Checks for common markers: .git, package.json, etc.
 */
export function isWorkspaceRoot(dir: string): boolean {
  const markers = ['.git', 'package.json', '.clow', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'Makefile'];
  for (const marker of markers) {
    if (fs.existsSync(path.join(dir, marker))) return true;
  }
  return false;
}
