/**
 * StreamingJSONLReader.ts — Stream-read JSONL without loading entire file
 *
 * Based on Claude Code's streamingReader.ts (~150 lines)
 *
 * For large session files, loads entries one-by-one using readline.
 * Uses AsyncGenerator pattern for memory-efficient processing.
 *
 * Features:
 *   - AsyncGenerator iteration (for await...of)
 *   - Memory-efficient (one line at a time)
 *   - Type-filtered iteration
 *   - Count with predicate
 *   - Find first/last matching entry
 *   - Malformed line skipping
 *   - File existence check
 */

import * as fs from 'fs';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import type { JSONLEntry, JSONLEntryType } from './types.js';

// ════════════════════════════════════════════════════════════════════════════
// StreamingJSONLReader Class
// ════════════════════════════════════════════════════════════════════════════

export class StreamingJSONLReader {
  constructor(private readonly filePath: string) {}

  /**
   * Iterate over all entries in the file.
   * Yields one entry at a time (memory-efficient).
   */
  async *iterate(): AsyncGenerator<JSONLEntry> {
    if (!fs.existsSync(this.filePath)) return;

    const stream = createReadStream(this.filePath, { encoding: 'utf-8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    try {
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          yield JSON.parse(trimmed) as JSONLEntry;
        } catch {
          // Skip malformed lines
        }
      }
    } finally {
      rl.close();
      stream.destroy();
    }
  }

  /**
   * Iterate over entries of specific types only.
   */
  async *iterateByType(types: JSONLEntryType[]): AsyncGenerator<JSONLEntry> {
    const typeSet = new Set(types as string[]);
    for await (const entry of this.iterate()) {
      if (typeSet.has(entry.type)) yield entry;
    }
  }

  /**
   * Count entries matching an optional predicate.
   */
  async count(predicate?: (entry: JSONLEntry) => boolean): Promise<number> {
    let n = 0;
    for await (const entry of this.iterate()) {
      if (!predicate || predicate(entry)) n++;
    }
    return n;
  }

  /**
   * Find the first entry matching a predicate.
   */
  async findFirst(predicate: (entry: JSONLEntry) => boolean): Promise<JSONLEntry | null> {
    for await (const entry of this.iterate()) {
      if (predicate(entry)) return entry;
    }
    return null;
  }

  /**
   * Find the last entry matching a predicate.
   * Note: must read entire file.
   */
  async findLast(predicate: (entry: JSONLEntry) => boolean): Promise<JSONLEntry | null> {
    let last: JSONLEntry | null = null;
    for await (const entry of this.iterate()) {
      if (predicate(entry)) last = entry;
    }
    return last;
  }

  /**
   * Collect all entries into an array (loads full file).
   */
  async collectAll(): Promise<JSONLEntry[]> {
    const entries: JSONLEntry[] = [];
    for await (const entry of this.iterate()) {
      entries.push(entry);
    }
    return entries;
  }

  /**
   * Get the first entry (usually session_start).
   */
  async getFirst(): Promise<JSONLEntry | null> {
    for await (const entry of this.iterate()) {
      return entry;
    }
    return null;
  }

  /**
   * Check if file exists.
   */
  exists(): boolean {
    return fs.existsSync(this.filePath);
  }
}
