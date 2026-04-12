/**
 * preservedSegmentChain.ts — Archive original messages after compaction for debugging
 *
 * Preserved segments store the original uncompacted messages so they can be
 * inspected later for debugging or audit purposes.
 *
 * Features:
 *   - Save segments with metadata
 *   - Load individual segments
 *   - Walk the chain of segments
 *   - Garbage collect old segments
 *   - Segment metadata querying
 *   - Segment merge
 *   - Segment statistics
 *   - Segment validation
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { JSONLWriter } from './jsonlWriter.js';
import { JSONLReader } from './jsonlReader.js';
import { SESSION_SCHEMA_VERSION, type MessageEntry, type PreservedSegmentEntry } from './types.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Metadata about a preserved segment */
interface SegmentMetadata {
  uuid: string;
  sessionId: string;
  startUuid: string;
  endUuid: string;
  messageCount: number;
  tokenCount: number;
  storedAt: string;
  previousSegmentUuid?: string;
  createdAt: number;
  fileSizeBytes: number;
}

/** Statistics for the segment chain of a session */
interface SegmentChainStats {
  sessionId: string;
  totalSegments: number;
  totalMessages: number;
  totalSizeBytes: number;
  oldestSegmentAt: number;
  newestSegmentAt: number;
  chainDepth: number;
  averageMessagesPerSegment: number;
}

/** Statistics across all sessions */
interface GlobalSegmentStats {
  totalSessions: number;
  totalSegments: number;
  totalSizeBytes: number;
  sessionsWithSegments: string[];
}

/** Result of a segment validation check */
interface SegmentValidation {
  segmentUuid: string;
  valid: boolean;
  errors: string[];
  warnings: string[];
  messageCount: number;
  hasMetadata: boolean;
  chainIntact: boolean;
}

// ════════════════════════════════════════════════════════════════════════════
// PreservedSegmentChain Class
// ════════════════════════════════════════════════════════════════════════════

export class PreservedSegmentChain {
  constructor(private readonly dir: string) {}

  // ─── Core Operations ────────────────────────────────────────────

  async save(sessionId: string, messages: any[], meta: { startUuid: string; endUuid: string; previousUuid?: string }): Promise<string> {
    const uuid = crypto.randomUUID();
    const sessionDir = path.join(this.dir, sessionId);
    await fsp.mkdir(sessionDir, { recursive: true });
    const file = path.join(sessionDir, `${uuid}.jsonl`);

    const w = new JSONLWriter(file);
    await w.open();
    w.write({ v: SESSION_SCHEMA_VERSION, uuid: crypto.randomUUID(), type: 'preserved_segment', ts: Date.now(), data: { uuid, startUuid: meta.startUuid, endUuid: meta.endUuid, messageCount: messages.length, tokenCount: 0, storedAt: file, previousSegmentUuid: meta.previousUuid } as any });
    for (const m of messages) w.write({ v: SESSION_SCHEMA_VERSION, uuid: crypto.randomUUID(), type: 'message', ts: Date.now(), data: { message: m } });
    await w.close();
    return uuid;
  }

  async load(sessionId: string, segmentUuid: string): Promise<{ metadata: any; messages: any[]; previousUuid?: string } | null> {
    const file = path.join(this.dir, sessionId, `${segmentUuid}.jsonl`);
    if (!fs.existsSync(file)) return null;
    const entries = await new JSONLReader(file).loadAll();
    let meta: any = null;
    const msgs: any[] = [];
    for (const e of entries) {
      if (e.type === 'preserved_segment') meta = e.data;
      else if (e.type === 'message') msgs.push((e.data as MessageEntry).message);
    }
    return meta ? { metadata: meta, messages: msgs, previousUuid: meta.previousSegmentUuid } : null;
  }

  async walkChain(sessionId: string, latestUuid: string): Promise<any[]> {
    const all: any[][] = [];
    let current: string | undefined = latestUuid;
    while (current) {
      const seg = await this.load(sessionId, current);
      if (!seg) break;
      all.unshift(seg.messages);
      current = seg.previousUuid;
    }
    return all.flat();
  }

  async gc(olderThanMs: number): Promise<{ removed: number; freedBytes: number }> {
    let removed = 0, freedBytes = 0;
    if (!fs.existsSync(this.dir)) return { removed, freedBytes };
    for (const sid of await fsp.readdir(this.dir)) {
      const sd = path.join(this.dir, sid);
      if (!(await fsp.stat(sd)).isDirectory()) continue;
      for (const f of await fsp.readdir(sd)) {
        const fp = path.join(sd, f);
        const st = await fsp.stat(fp);
        if (Date.now() - st.mtimeMs > olderThanMs) {
          freedBytes += st.size; await fsp.unlink(fp); removed++;
        }
      }
    }
    return { removed, freedBytes };
  }

  // ─── Segment Metadata Querying ──────────────────────────────────

  /**
   * List all segment UUIDs for a given session.
   */
  async listSegments(sessionId: string): Promise<string[]> {
    const sessionDir = path.join(this.dir, sessionId);
    if (!fs.existsSync(sessionDir)) return [];

    try {
      const files = await fsp.readdir(sessionDir);
      return files
        .filter(f => f.endsWith('.jsonl'))
        .map(f => f.replace('.jsonl', ''));
    } catch {
      return [];
    }
  }

  /**
   * Get metadata for a specific segment without loading all messages.
   */
  async getSegmentMetadata(sessionId: string, segmentUuid: string): Promise<SegmentMetadata | null> {
    const file = path.join(this.dir, sessionId, `${segmentUuid}.jsonl`);
    if (!fs.existsSync(file)) return null;

    try {
      const stat = await fsp.stat(file);
      const entries = await new JSONLReader(file).loadAll();

      const metaEntry = entries.find(e => e.type === 'preserved_segment');
      if (!metaEntry || !metaEntry.data) return null;

      const data = metaEntry.data as any;
      return {
        uuid: data.uuid ?? segmentUuid,
        sessionId,
        startUuid: data.startUuid ?? '',
        endUuid: data.endUuid ?? '',
        messageCount: data.messageCount ?? entries.filter(e => e.type === 'message').length,
        tokenCount: data.tokenCount ?? 0,
        storedAt: data.storedAt ?? file,
        previousSegmentUuid: data.previousSegmentUuid,
        createdAt: metaEntry.ts,
        fileSizeBytes: stat.size,
      };
    } catch {
      return null;
    }
  }

  /**
   * Get metadata for all segments in a session, sorted by creation time.
   */
  async getAllSegmentMetadata(sessionId: string): Promise<SegmentMetadata[]> {
    const uuids = await this.listSegments(sessionId);
    const metadata: SegmentMetadata[] = [];

    for (const uuid of uuids) {
      const meta = await this.getSegmentMetadata(sessionId, uuid);
      if (meta) metadata.push(meta);
    }

    return metadata.sort((a, b) => a.createdAt - b.createdAt);
  }

  /**
   * Find segments that contain a specific message UUID.
   */
  async findSegmentByMessageUuid(sessionId: string, messageUuid: string): Promise<SegmentMetadata | null> {
    const uuids = await this.listSegments(sessionId);

    for (const uuid of uuids) {
      const meta = await this.getSegmentMetadata(sessionId, uuid);
      if (!meta) continue;

      // Check if the message UUID falls within this segment's range
      if (meta.startUuid === messageUuid || meta.endUuid === messageUuid) {
        return meta;
      }
    }

    return null;
  }

  /**
   * Get the latest (most recent) segment for a session.
   */
  async getLatestSegment(sessionId: string): Promise<SegmentMetadata | null> {
    const all = await this.getAllSegmentMetadata(sessionId);
    return all.length > 0 ? all[all.length - 1] : null;
  }

  // ─── Segment Merge ──────────────────────────────────────────────

  /**
   * Merge multiple segments into a single segment.
   * Useful for consolidating many small segments into fewer large ones.
   */
  async mergeSegments(
    sessionId: string,
    segmentUuids: string[],
    options?: { deleteOriginals?: boolean },
  ): Promise<string | null> {
    if (segmentUuids.length < 2) return null;

    // Load all segments in order
    const allMessages: any[] = [];
    let firstStartUuid: string | undefined;
    let lastEndUuid: string | undefined;
    let firstPreviousUuid: string | undefined;

    for (let i = 0; i < segmentUuids.length; i++) {
      const seg = await this.load(sessionId, segmentUuids[i]);
      if (!seg) continue;

      allMessages.push(...seg.messages);

      if (i === 0) {
        firstStartUuid = seg.metadata?.startUuid;
        firstPreviousUuid = seg.previousUuid;
      }
      if (i === segmentUuids.length - 1) {
        lastEndUuid = seg.metadata?.endUuid;
      }
    }

    if (allMessages.length === 0) return null;

    // Save the merged segment
    const mergedUuid = await this.save(sessionId, allMessages, {
      startUuid: firstStartUuid ?? '',
      endUuid: lastEndUuid ?? '',
      previousUuid: firstPreviousUuid,
    });

    // Optionally delete originals
    if (options?.deleteOriginals) {
      for (const uuid of segmentUuids) {
        const file = path.join(this.dir, sessionId, `${uuid}.jsonl`);
        try { await fsp.unlink(file); } catch { /* ignore */ }
      }
    }

    return mergedUuid;
  }

  // ─── Segment Statistics ─────────────────────────────────────────

  /**
   * Get statistics for the segment chain of a specific session.
   */
  async getChainStats(sessionId: string): Promise<SegmentChainStats> {
    const metadata = await this.getAllSegmentMetadata(sessionId);

    let totalMessages = 0;
    let totalSizeBytes = 0;
    let oldestSegmentAt = Infinity;
    let newestSegmentAt = 0;

    for (const meta of metadata) {
      totalMessages += meta.messageCount;
      totalSizeBytes += meta.fileSizeBytes;
      if (meta.createdAt < oldestSegmentAt) oldestSegmentAt = meta.createdAt;
      if (meta.createdAt > newestSegmentAt) newestSegmentAt = meta.createdAt;
    }

    if (oldestSegmentAt === Infinity) oldestSegmentAt = 0;

    // Calculate chain depth by walking the linked list
    let chainDepth = 0;
    const latest = await this.getLatestSegment(sessionId);
    if (latest) {
      let current: string | undefined = latest.uuid;
      while (current) {
        chainDepth++;
        const seg = await this.load(sessionId, current);
        if (!seg) break;
        current = seg.previousUuid;
      }
    }

    return {
      sessionId,
      totalSegments: metadata.length,
      totalMessages,
      totalSizeBytes,
      oldestSegmentAt,
      newestSegmentAt,
      chainDepth,
      averageMessagesPerSegment: metadata.length > 0 ? totalMessages / metadata.length : 0,
    };
  }

  /**
   * Get global statistics across all sessions.
   */
  async getGlobalStats(): Promise<GlobalSegmentStats> {
    if (!fs.existsSync(this.dir)) {
      return { totalSessions: 0, totalSegments: 0, totalSizeBytes: 0, sessionsWithSegments: [] };
    }

    let totalSessions = 0;
    let totalSegments = 0;
    let totalSizeBytes = 0;
    const sessionsWithSegments: string[] = [];

    try {
      const sessionDirs = await fsp.readdir(this.dir);

      for (const sid of sessionDirs) {
        const sd = path.join(this.dir, sid);
        try {
          const stat = await fsp.stat(sd);
          if (!stat.isDirectory()) continue;

          totalSessions++;
          const files = await fsp.readdir(sd);
          const segmentFiles = files.filter(f => f.endsWith('.jsonl'));

          if (segmentFiles.length > 0) {
            sessionsWithSegments.push(sid);
            totalSegments += segmentFiles.length;

            for (const f of segmentFiles) {
              try {
                const fileStat = await fsp.stat(path.join(sd, f));
                totalSizeBytes += fileStat.size;
              } catch { /* skip */ }
            }
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }

    return { totalSessions, totalSegments, totalSizeBytes, sessionsWithSegments };
  }

  // ─── Segment Validation ─────────────────────────────────────────

  /**
   * Validate a specific segment for integrity.
   */
  async validateSegment(sessionId: string, segmentUuid: string): Promise<SegmentValidation> {
    const result: SegmentValidation = {
      segmentUuid,
      valid: false,
      errors: [],
      warnings: [],
      messageCount: 0,
      hasMetadata: false,
      chainIntact: true,
    };

    const file = path.join(this.dir, sessionId, `${segmentUuid}.jsonl`);
    if (!fs.existsSync(file)) {
      result.errors.push('Segment file does not exist');
      return result;
    }

    try {
      // Read and parse all entries
      const content = await fsp.readFile(file, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());

      for (let i = 0; i < lines.length; i++) {
        try {
          const entry = JSON.parse(lines[i]);

          if (entry.type === 'preserved_segment') {
            result.hasMetadata = true;
            const data = entry.data;

            // Validate metadata fields
            if (!data.startUuid) result.warnings.push('Missing startUuid in metadata');
            if (!data.endUuid) result.warnings.push('Missing endUuid in metadata');
            if (typeof data.messageCount !== 'number') result.warnings.push('Missing messageCount in metadata');

            // Check chain link
            if (data.previousSegmentUuid) {
              const prevFile = path.join(this.dir, sessionId, `${data.previousSegmentUuid}.jsonl`);
              if (!fs.existsSync(prevFile)) {
                result.chainIntact = false;
                result.warnings.push(`Previous segment ${data.previousSegmentUuid} not found (chain broken)`);
              }
            }
          } else if (entry.type === 'message') {
            result.messageCount++;
          }
        } catch {
          result.errors.push(`Malformed JSON at line ${i + 1}`);
        }
      }

      if (!result.hasMetadata) {
        result.errors.push('No preserved_segment metadata entry found');
      }

      if (result.messageCount === 0) {
        result.warnings.push('Segment contains no messages');
      }

      result.valid = result.errors.length === 0;
    } catch (err) {
      result.errors.push(`Read error: ${(err as Error).message}`);
    }

    return result;
  }

  /**
   * Validate all segments for a session.
   */
  async validateAllSegments(sessionId: string): Promise<SegmentValidation[]> {
    const uuids = await this.listSegments(sessionId);
    const results: SegmentValidation[] = [];

    for (const uuid of uuids) {
      results.push(await this.validateSegment(sessionId, uuid));
    }

    return results;
  }

  /**
   * Validate the entire chain integrity for a session.
   * Walks from the latest segment backwards and checks all links.
   */
  async validateChain(sessionId: string): Promise<{
    intact: boolean;
    segmentsInChain: number;
    orphanedSegments: string[];
    brokenLinks: string[];
  }> {
    const allUuids = new Set(await this.listSegments(sessionId));
    const inChain = new Set<string>();
    const brokenLinks: string[] = [];

    // Find the latest segment and walk backwards
    const latest = await this.getLatestSegment(sessionId);
    if (!latest) {
      return { intact: true, segmentsInChain: 0, orphanedSegments: [...allUuids], brokenLinks: [] };
    }

    let current: string | undefined = latest.uuid;
    while (current) {
      inChain.add(current);
      const seg = await this.load(sessionId, current);
      if (!seg) {
        brokenLinks.push(current);
        break;
      }
      current = seg.previousUuid;
    }

    const orphanedSegments = [...allUuids].filter(u => !inChain.has(u));

    return {
      intact: brokenLinks.length === 0,
      segmentsInChain: inChain.size,
      orphanedSegments,
      brokenLinks,
    };
  }
}
