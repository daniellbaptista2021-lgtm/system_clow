/**
 * PaneBackend.ts — Re-exports and helpers for PaneBackend interface
 */

export type {
  PaneBackend,
  CreatePaneOptions,
  PaneHandle,
  BackendType,
} from '../types.js';

import type { PaneHandle } from '../types.js';

/**
 * Check whether a pane handle represents a live pane.
 */
export function isPaneAlive(handle: PaneHandle): boolean {
  return handle.isAlive;
}

/**
 * Format pane information into a human-readable string.
 */
export function formatPaneInfo(handle: PaneHandle): string {
  const status = handle.isAlive ? 'alive' : 'dead';
  const pid = handle.pid != null ? ` pid=${handle.pid}` : '';
  return `[${handle.backend}] ${handle.title} (${handle.id}) ${status}${pid}`;
}

/**
 * Return a compact label for a pane handle (used in logs).
 */
export function paneLabel(handle: PaneHandle): string {
  return `${handle.backend}:${handle.id}`;
}
