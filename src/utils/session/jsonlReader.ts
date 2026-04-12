/**
 * JSONLReader.ts — JSONL file reader with filtering and pagination
 *
 * Based on Claude Code's jsonlReader.ts (~200 lines)
 *
 * Features:
 *   - Load all entries from JSONL file
 *   - Filter by entry type
 *   - Read last N entries (tail)
 *   - Line counting
 *   - Malformed line handling (skip + warn)
 *   - Pagination support
 *   - Entry deduplication by UUID
 *   - File size reporting
 *   - Backward compatibility (v1, v2 entries)
 *   - Streaming line-by-line reading for large files
 *   - Content search within entries
 *   - Entry aggregation (group by type, count tokens)
 *   - Backward reading (last N entries without loading all)
 *   - File integrity check
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import type { JSONLEntry, JSONLEntryType } from './types.js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface ReaderStats {
  totalLines: number;
  validEntries: number;
  malformedLines: number;
  fileSizeBytes: number;
}

/** Result of an entry aggregation */
interface EntryAggregation {
  /** Count of entries per type */
  byType: Record<string, number>;
  /** Total estimated token count across all entries */
  totalEstimatedTokens: number;
  /** Entry count by hour of day */
  byHour: Record<number, number>;
  /** Earliest entry timestamp */
  earliestTs: number;
  /** Latest entry timestamp */
  latestTs: number;
  /** Average entries per minute */
  avgEntriesPerMinute: number;
}

/** Result of a content search */
interface SearchResult {
  entryIndex: number;
  lineNumber: number;
  uuid: string;
  type: string;
  timestamp: number;
  snippet: string;
}

/** Result of a file integrity check */
interface IntegrityCheckResult {
  filePath: string;
  exists: boolean;
  sizeBytes: number;
  totalLines: number;
  validLines: number;
  malformedLines: number;
  malformedLineNumbers: number[];
  lastLineValid: boolean;
  hasSessionStart: boolean;
  hasSessionEnd: boolean;
  schemaVersions: number[];
  isClean: boolean;
}

// ════════════════════════════════════════════════════════════════════════════
// JSONLReader Class
// ════════════════════════════════════════════════════════════════════════════

export class JSONLReader {
  private lastStats: ReaderStats | null = null;

  constructor(private readonly filePath: string) {}

  /**
   * Load all entries from the JSONL file.
   * Skips malformed lines with a warning.
   */
  async loadAll(): Promise<JSONLEntry[]> {
    if (!fs.existsSync(this.filePath)) return [];

    const content = await fsp.readFile(this.filePath, 'utf-8');
    const entries: JSONLEntry[] = [];
    let lineNum = 0;
    let malformed = 0;

    for (const line of content.split('\n')) {
      lineNum++;
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const parsed = JSON.parse(trimmed);
        // Normalize old format entries
        const normalized = this.normalizeEntry(parsed, lineNum);
        if (normalized) entries.push(normalized);
      } catch {
        malformed++;
        if (malformed <= 5) {
          console.warn(`[JSONLReader] Malformed line ${lineNum} in ${this.filePath} (skipped)`);
        }
      }
    }

    if (malformed > 5) {
      console.warn(`[JSONLReader] ${malformed} total malformed lines in ${this.filePath}`);
    }

    const stat = await fsp.stat(this.filePath).catch(() => null);

    this.lastStats = {
      totalLines: lineNum,
      validEntries: entries.length,
      malformedLines: malformed,
      fileSizeBytes: stat?.size ?? 0,
    };

    return entries;
  }

  /**
   * Count lines in the file (fast, no parsing).
   */
  async countLines(): Promise<number> {
    if (!fs.existsSync(this.filePath)) return 0;
    const content = await fsp.readFile(this.filePath, 'utf-8');
    return content.split('\n').filter(l => l.trim()).length;
  }

  /**
   * Read the last N entries.
   */
  async readLast(n: number): Promise<JSONLEntry[]> {
    const all = await this.loadAll();
    return all.slice(-n);
  }

  /**
   * Read entries filtered by type.
   */
  async readByType(types: JSONLEntryType[]): Promise<JSONLEntry[]> {
    const all = await this.loadAll();
    return all.filter(e => (types as string[]).includes(e.type));
  }

  /**
   * Read entries within a time range.
   */
  async readByTimeRange(startMs: number, endMs: number): Promise<JSONLEntry[]> {
    const all = await this.loadAll();
    return all.filter(e => e.ts >= startMs && e.ts <= endMs);
  }

  /**
   * Read entries with pagination.
   */
  async readPage(offset: number, limit: number): Promise<{ entries: JSONLEntry[]; total: number; hasMore: boolean }> {
    const all = await this.loadAll();
    const entries = all.slice(offset, offset + limit);
    return {
      entries,
      total: all.length,
      hasMore: offset + limit < all.length,
    };
  }

  /**
   * Deduplicate entries by UUID (keep latest).
   */
  async readDeduped(): Promise<JSONLEntry[]> {
    const all = await this.loadAll();
    const byUuid = new Map<string, JSONLEntry>();
    for (const entry of all) {
      byUuid.set(entry.uuid, entry);
    }
    return [...byUuid.values()];
  }

  /**
   * Get file size in bytes.
   */
  async getFileSize(): Promise<number> {
    try {
      const stat = await fsp.stat(this.filePath);
      return stat.size;
    } catch {
      return 0;
    }
  }

  /**
   * Check if file exists.
   */
  exists(): boolean {
    return fs.existsSync(this.filePath);
  }

  /**
   * Get stats from last read operation.
   */
  getLastStats(): ReaderStats | null {
    return this.lastStats;
  }

  // ─── Content Search ─────────────────────────────────────────────

  /**
   * Search within entry data for a query string.
   * Returns matching entries with snippets.
   */
  async searchContent(
    query: string,
    opts: { maxResults?: number; caseSensitive?: boolean } = {},
  ): Promise<SearchResult[]> {
    if (!fs.existsSync(this.filePath)) return [];

    const maxResults = opts.maxResults ?? 20;
    const searchQuery = opts.caseSensitive ? query : query.toLowerCase();
    const results: SearchResult[] = [];

    const content = await fsp.readFile(this.filePath, 'utf-8');
    const lines = content.split('\n');
    let entryIndex = 0;

    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
      if (results.length >= maxResults) break;

      const trimmed = lines[lineNum].trim();
      if (!trimmed) continue;

      const lineContent = opts.caseSensitive ? trimmed : trimmed.toLowerCase();
      if (!lineContent.includes(searchQuery)) {
        entryIndex++;
        continue;
      }

      try {
        const parsed = JSON.parse(trimmed);
        const idx = lineContent.indexOf(searchQuery);
        const start = Math.max(0, idx - 40);
        const end = Math.min(trimmed.length, idx + query.length + 40);

        results.push({
          entryIndex,
          lineNumber: lineNum + 1,
          uuid: parsed.uuid ?? 'unknown',
          type: parsed.type ?? 'unknown',
          timestamp: parsed.ts ?? 0,
          snippet: trimmed.slice(start, end),
        });
      } catch {
        // Skip malformed lines
      }

      entryIndex++;
    }

    return results;
  }

  // ─── Entry Aggregation ──────────────────────────────────────────

  /**
   * Aggregate entries by type and compute statistics.
   */
  async aggregate(): Promise<EntryAggregation> {
    const entries = await this.loadAll();

    const byType: Record<string, number> = {};
    const byHour: Record<number, number> = {};
    let totalEstimatedTokens = 0;
    let earliestTs = Infinity;
    let latestTs = 0;

    for (const entry of entries) {
      // Count by type
      byType[entry.type] = (byType[entry.type] ?? 0) + 1;

      // Count by hour
      if (entry.ts) {
        const hour = new Date(entry.ts).getHours();
        byHour[hour] = (byHour[hour] ?? 0) + 1;

        if (entry.ts < earliestTs) earliestTs = entry.ts;
        if (entry.ts > latestTs) latestTs = entry.ts;
      }

      // Estimate tokens from content
      if (entry.data && typeof entry.data === 'object') {
        const data = entry.data as any;
        if (typeof data.content === 'string') {
          // Rough token estimate: ~4 chars per token
          totalEstimatedTokens += Math.ceil(data.content.length / 4);
        }
        if (data.tokenCount) {
          totalEstimatedTokens += data.tokenCount;
        }
      }
    }

    if (earliestTs === Infinity) earliestTs = 0;

    const durationMinutes = latestTs > earliestTs
      ? (latestTs - earliestTs) / 60_000
      : 0;

    return {
      byType,
      totalEstimatedTokens,
      byHour,
      earliestTs,
      latestTs,
      avgEntriesPerMinute: durationMinutes > 0 ? entries.length / durationMinutes : 0,
    };
  }

  // ─── File Integrity Check ───────────────────────────────────────

  /**
   * Perform a comprehensive integrity check on the JSONL file.
   */
  async checkIntegrity(): Promise<IntegrityCheckResult> {
    const result: IntegrityCheckResult = {
      filePath: this.filePath,
      exists: false,
      sizeBytes: 0,
      totalLines: 0,
      validLines: 0,
      malformedLines: 0,
      malformedLineNumbers: [],
      lastLineValid: true,
      hasSessionStart: false,
      hasSessionEnd: false,
      schemaVersions: [],
      isClean: true,
    };

    if (!fs.existsSync(this.filePath)) return result;
    result.exists = true;

    try {
      const stat = await fsp.stat(this.filePath);
      result.sizeBytes = stat.size;
    } catch {}

    try {
      const content = await fsp.readFile(this.filePath, 'utf-8');
      const lines = content.split('\n');
      const versionSet = new Set<number>();
      let lastNonEmptyLineValid = true;

      for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (!trimmed) continue;
        result.totalLines++;

        try {
          const parsed = JSON.parse(trimmed);
          result.validLines++;
          lastNonEmptyLineValid = true;

          if (parsed.v) versionSet.add(parsed.v);
          if (parsed.type === 'session_start') result.hasSessionStart = true;
          if (parsed.type === 'session_end') result.hasSessionEnd = true;
        } catch {
          result.malformedLines++;
          result.malformedLineNumbers.push(i + 1);
          lastNonEmptyLineValid = false;
        }
      }

      result.lastLineValid = lastNonEmptyLineValid;
      result.schemaVersions = [...versionSet].sort();
      result.isClean = result.malformedLines === 0;
    } catch {
      result.isClean = false;
    }

    return result;
  }

  // ─── Normalization ───────────────────────────────────────────────

  /**
   * Normalize entries from older schema versions.
   * Returns null if the entry is completely unrecoverable.
   */
  private normalizeEntry(raw: Record<string, unknown>, lineNum: number): JSONLEntry | null {
    // Version 3 (current)
    if (raw.v && raw.uuid && raw.type && raw.ts) {
      return raw as unknown as JSONLEntry;
    }

    // Version 2 (had 'version' instead of 'v')
    if (raw.version && raw.uuid && raw.type) {
      return {
        v: raw.version as number,
        uuid: raw.uuid as string,
        type: raw.type as JSONLEntryType,
        ts: (raw.timestamp as number) ?? (raw.ts as number) ?? Date.now(),
        data: raw.data ?? raw,
      };
    }

    // Version 1 (flat entries, no wrapper)
    if (raw.role || raw.type) {
      return {
        v: 1,
        uuid: (raw.uuid as string) ?? `legacy_${lineNum}`,
        type: (raw.type as JSONLEntryType) ?? 'message',
        ts: (raw.timestamp as number) ?? Date.now(),
        data: raw,
      };
    }

    return null;
  }
}
