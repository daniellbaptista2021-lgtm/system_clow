import * as path from 'path';
import type { ToolUseContext } from './Tool.js';
import { PathEscapeError, validatePath } from '../tenancy/pathGuard.js';

function getWorkspaceRoot(context: ToolUseContext): string {
  return context.workspaceRoot || context.cwd;
}

export function resolvePathFromContext(requestedPath: string, context: ToolUseContext): string {
  const workspaceRoot = getWorkspaceRoot(context);
  const resolvedPath = path.isAbsolute(requestedPath)
    ? requestedPath
    : path.resolve(context.cwd, requestedPath);

  return validatePath(resolvedPath, workspaceRoot);
}

export function resolveSearchPathFromContext(
  requestedPath: string | undefined,
  context: ToolUseContext,
): string {
  if (!requestedPath) {
    return getWorkspaceRoot(context);
  }

  return resolvePathFromContext(requestedPath, context);
}

export function formatPathAccessError(error: unknown, fallbackMessage: string): string {
  if (error instanceof PathEscapeError) {
    return `Error: Access denied. Path "${error.requestedPath}" is outside the workspace root.`;
  }

  if (error instanceof Error) {
    return `Error: ${error.message}`;
  }

  return fallbackMessage;
}
