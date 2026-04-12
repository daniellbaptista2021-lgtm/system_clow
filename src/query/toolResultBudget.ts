/**
 * toolResultBudget.ts — Cap aggregate tool output size
 *
 * Based on Claude Code's toolResultBudget.ts (~200 lines)
 *
 * When total tool result text exceeds the budget, truncates
 * oldest tool results first (preserving recent ones).
 * Persists originals to disk for debugging.
 *
 * Features:
 *   - Aggregate size tracking
 *   - Oldest-first truncation
 *   - Disk persistence of originals
 *   - Configurable limits
 *   - Truncation statistics
 *   - Skip protection for recent results
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { Message } from './types.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_AGGREGATE_LIMIT = 50_000; // chars
const RECENT_RESULTS_PROTECTED = 3; // don't truncate the 3 most recent
const PERSIST_DIR = '.clow/tool-results';

// ─── Types ──────────────────────────────────────────────────────────────────

interface TruncationResult {
  truncatedCount: number;
  totalCharsBefore: number;
  totalCharsAfter: number;
  charsSaved: number;
  persistedFiles: string[];
}

// ════════════════════════════════════════════════════════════════════════════
// ToolResultBudget Class
// ════════════════════════════════════════════════════════════════════════════

export class ToolResultBudget {
  /**
   * Walk messages, cap aggregate tool output.
   * Truncates oldest tool results when total exceeds limit.
   * Returns count of truncated results and stats.
   */
  static apply(messages: Message[], limit: number = DEFAULT_AGGREGATE_LIMIT): TruncationResult {
    let totalSize = 0;
    const toolResults: Array<{ msgIdx: number; size: number; toolCallId?: string }> = [];
    const persistedFiles: string[] = [];

    // Pass 1: Measure tool_result sizes
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.type === 'user' && msg.source === 'tool_result' && msg.content) {
        const size = msg.content.length;
        totalSize += size;
        toolResults.push({ msgIdx: i, size, toolCallId: msg.toolCallId });
      }
    }

    const totalCharsBefore = totalSize;

    // Under budget — no truncation needed
    if (totalSize <= limit) {
      return {
        truncatedCount: 0,
        totalCharsBefore,
        totalCharsAfter: totalSize,
        charsSaved: 0,
        persistedFiles: [],
      };
    }

    // Pass 2: Truncate oldest until under limit
    // Protect the N most recent tool results
    const truncatable = toolResults.slice(0, Math.max(0, toolResults.length - RECENT_RESULTS_PROTECTED));
    let truncated = 0;
    let currentSize = totalSize;

    for (const entry of truncatable) {
      if (currentSize <= limit) break;

      const msg = messages[entry.msgIdx];
      if (msg.type !== 'user') continue;

      const original = msg.content;

      // Persist original to disk for debugging
      const persistPath = ToolResultBudget.persistToDisk(
        entry.toolCallId || `idx-${entry.msgIdx}`,
        original,
      );
      if (persistPath) persistedFiles.push(persistPath);

      // Replace with truncation marker
      const marker = `[Tool result truncated. Original: ${entry.size} chars. Saved to disk for debugging.]`;
      (msg as any).content = marker;
      currentSize -= entry.size - marker.length;
      truncated++;
    }

    return {
      truncatedCount: truncated,
      totalCharsBefore,
      totalCharsAfter: Math.max(0, currentSize),
      charsSaved: totalCharsBefore - Math.max(0, currentSize),
      persistedFiles,
    };
  }

  /**
   * Persist original tool result to disk.
   * Returns the file path, or null if persistence failed.
   */
  private static persistToDisk(id: string, content: string): string | null {
    try {
      const dir = path.join(os.homedir(), PERSIST_DIR);
      fs.mkdirSync(dir, { recursive: true });
      const safeId = id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100);
      const file = path.join(dir, `${safeId}_${Date.now()}.txt`);
      fs.writeFileSync(file, content, { mode: 0o600 });
      return file;
    } catch {
      return null;
    }
  }

  /**
   * Clean up old persisted tool results.
   */
  static cleanup(maxAgeDays: number = 7): number {
    const dir = path.join(os.homedir(), PERSIST_DIR);
    if (!fs.existsSync(dir)) return 0;

    const cutoff = Date.now() - maxAgeDays * 86400_000;
    let removed = 0;

    try {
      for (const file of fs.readdirSync(dir)) {
        const fp = path.join(dir, file);
        try {
          const stat = fs.statSync(fp);
          if (stat.mtimeMs < cutoff) {
            fs.unlinkSync(fp);
            removed++;
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }

    return removed;
  }
}
