/**
 * pathGuard.ts — Workspace filesystem isolation
 *
 * Every file tool must call validatePath() before any operation.
 * Prevents path traversal attacks (../../etc/passwd) and access
 * outside the tenant's workspace root.
 *
 * If you forget this in ONE tool, a tenant can read the server's .env.
 */

import * as path from 'path';

/**
 * Validates that a requested path stays within the workspace root.
 * Returns the normalized absolute path if safe.
 * Throws if the path escapes the workspace.
 */
export function validatePath(requestedPath: string, workspaceRoot: string): string {
  // Resolve to absolute
  const absolute = path.isAbsolute(requestedPath)
    ? requestedPath
    : path.resolve(workspaceRoot, requestedPath);

  const normalized = path.normalize(absolute);
  const workspaceNormalized = path.normalize(workspaceRoot);

  // Check if normalized path is within workspace
  const relative = path.relative(workspaceNormalized, normalized);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new PathEscapeError(requestedPath, workspaceRoot);
  }

  // Extra check: the normalized path must start with workspace root
  // (handles edge cases on Windows with different drive letters)
  if (!normalized.toLowerCase().startsWith(workspaceNormalized.toLowerCase())) {
    throw new PathEscapeError(requestedPath, workspaceRoot);
  }

  return normalized;
}

/**
 * Check if a path is within workspace without throwing.
 */
export function isPathSafe(requestedPath: string, workspaceRoot: string): boolean {
  try {
    validatePath(requestedPath, workspaceRoot);
    return true;
  } catch {
    return false;
  }
}

/**
 * Specific error class for path escape attempts.
 */
export class PathEscapeError extends Error {
  readonly requestedPath: string;
  readonly workspaceRoot: string;

  constructor(requestedPath: string, workspaceRoot: string) {
    super(`Path escape detected: "${requestedPath}" is outside workspace "${workspaceRoot}"`);
    this.name = 'PathEscapeError';
    this.requestedPath = requestedPath;
    this.workspaceRoot = workspaceRoot;
  }
}
