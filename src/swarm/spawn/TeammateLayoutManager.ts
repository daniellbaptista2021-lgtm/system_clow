/**
 * TeammateLayoutManager.ts — Manage pane layout, colors, and titles
 *
 * Provides helpers for:
 *   - Calculating a grid/tiled layout based on member count
 *   - Assigning distinct colours to teammates
 *   - Formatting pane titles
 *   - Generating backend-specific layout commands
 */

import type { BackendType } from '../types.js';
import {
  DEFAULT_MEMBER_COLORS,
  MAX_PANE_TITLE_LENGTH,
} from '../constants.js';

// ────────────────────────────────────────────────────────────────────────────
// Layout
// ────────────────────────────────────────────────────────────────────────────

export interface LayoutDescription {
  rows: number;
  cols: number;
  /** Total cells (may exceed memberCount for the last row). */
  totalCells: number;
}

/**
 * Calculate a simple grid layout for the given number of members.
 *
 *   1     -> 1x1
 *   2     -> 1x2
 *   3-4   -> 2x2
 *   5-6   -> 2x3
 *   7-9   -> 3x3
 *   10    -> 2x5
 */
export function calculateLayout(memberCount: number): LayoutDescription {
  if (memberCount <= 0) {
    return { rows: 1, cols: 1, totalCells: 1 };
  }

  const cols = Math.ceil(Math.sqrt(memberCount));
  const rows = Math.ceil(memberCount / cols);

  return {
    rows,
    cols,
    totalCells: rows * cols,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Colors
// ────────────────────────────────────────────────────────────────────────────

/**
 * Assign a unique colour from the palette to each member.
 * Cycles through the palette if there are more members than colours.
 */
export function assignColors(
  memberNames: string[],
): Map<string, string> {
  const colorMap = new Map<string, string>();
  for (let i = 0; i < memberNames.length; i++) {
    const name = memberNames[i]!;
    const color = DEFAULT_MEMBER_COLORS[i % DEFAULT_MEMBER_COLORS.length]!;
    colorMap.set(name, color);
  }
  return colorMap;
}

// ────────────────────────────────────────────────────────────────────────────
// Pane titles
// ────────────────────────────────────────────────────────────────────────────

/**
 * Format a human-readable pane title. Truncates to MAX_PANE_TITLE_LENGTH.
 */
export function formatPaneTitle(
  memberName: string,
  teamName: string,
): string {
  const raw = `[${teamName}] ${memberName}`;
  if (raw.length <= MAX_PANE_TITLE_LENGTH) {
    return raw;
  }
  return raw.slice(0, MAX_PANE_TITLE_LENGTH - 1) + '\u2026';
}

// ────────────────────────────────────────────────────────────────────────────
// Backend-specific layout commands
// ────────────────────────────────────────────────────────────────────────────

/**
 * Generate a backend-specific command string to tile/arrange panes.
 *
 * - tmux:  `select-layout tiled`
 * - iterm2 / in-process: no layout command (empty string)
 */
export function getLayoutCommand(
  memberCount: number,
  backend: BackendType,
): string {
  if (backend === 'tmux' && memberCount > 1) {
    return 'select-layout tiled';
  }
  // iTerm2 and in-process don't have programmatic layout commands
  return '';
}
