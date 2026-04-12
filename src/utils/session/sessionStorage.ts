/**
 * sessionStorage.ts — Public API for session persistence
 *
 * Orchestrates: JSONLWriter, JSONLReader, SessionIndex, BoundedUUIDSet,
 * TombstoneResolver, SessionLockfile, SessionMigration, CrashRecovery.
 *
 * Backward-compatible exports for existing code (cli.ts, server, etc).
 *
 * Extended features:
 *   - Session resume with validation
 *   - Session fork
 *   - Session archive
 *   - Session export (to JSON)
 *   - Session statistics
 *   - Session search
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { JSONLWriter } from './jsonlWriter.js';
import { JSONLReader } from './jsonlReader.js';
import { SessionIndex } from './sessionIndex.js';
import { BoundedUUIDSet } from './boundedUuidSet.js';
import { TombstoneResolver } from './tombstoneResolver.js';
import { SessionLockfile } from './sessionLockfile.js';
import { SessionMigration } from './sessionMigration.js';
import { hashWorkspace } from './workspaceHash.js';
import { SESSION_SCHEMA_VERSION } from './types.js';
import type {
  JSONLEntry, SessionMetadata, SessionStartEntry, MessageEntry,
  TombstoneEntry, CompactBoundaryEntry, CostRecordEntry, SessionEndEntry,
  SessionCloseReason, ResumeOptions, SessionStatus,
} from './types.js';
import { getSessionId, getCwd } from '../../bootstrap/state.js';

// ─── Singleton state ────────────────────────────────────────────────────────

const CLOW_HOME = path.join(os.homedir(), '.clow');
let _index: SessionIndex | null = null;
let _writers = new Map<string, JSONLWriter>();
let _dedups = new Map<string, BoundedUUIDSet>();
let _initialized = false;

function getIndex(): SessionIndex {
  if (!_index) _index = new SessionIndex(CLOW_HOME);
  return _index;
}

function sessionsDir(): string {
  return path.join(CLOW_HOME, 'sessions');
}

function sessionFilePath(sessionId: string): string {
  return path.join(sessionsDir(), `${sessionId}.jsonl`);
}

function archiveDir(): string {
  return path.join(CLOW_HOME, 'sessions', 'archive');
}

// ─── Types ─────────────────────────────────────────────────────────────────

/** Session statistics summary */
interface SessionStats {
  sessionId: string;
  entryCount: number;
  messageCount: number;
  toolUseCount: number;
  tombstoneCount: number;
  compactCount: number;
  costRecordCount: number;
  fileSizeBytes: number;
  durationMs: number;
  firstEntryAt: number;
  lastEntryAt: number;
  entryTypes: Record<string, number>;
}

/** Options for session export */
interface ExportOptions {
  /** Include full message content (default true) */
  includeContent?: boolean;
  /** Include tool use details (default true) */
  includeToolUse?: boolean;
  /** Include cost records (default true) */
  includeCosts?: boolean;
  /** Include tombstones (default false) */
  includeTombstones?: boolean;
  /** Pretty-print JSON (default true) */
  prettyPrint?: boolean;
}

/** Exported session format */
interface ExportedSession {
  version: number;
  exportedAt: number;
  sessionId: string;
  workspace: string;
  startedAt: number;
  endedAt: number | null;
  status: string;
  entryCount: number;
  entries: any[];
  statistics: SessionStats;
}

/** Session search criteria */
interface SessionSearchCriteria {
  /** Search in message content */
  query?: string;
  /** Filter by workspace path */
  workspace?: string;
  /** Filter by status */
  status?: SessionStatus;
  /** Filter by date range start */
  after?: number;
  /** Filter by date range end */
  before?: number;
  /** Maximum results to return */
  limit?: number;
}

/** Resume validation result */
interface ResumeValidation {
  valid: boolean;
  sessionId: string;
  errors: string[];
  warnings: string[];
  integrityOk: boolean;
  workspaceMatch: boolean;
  ageMs: number;
  entryCount: number;
}

// ─── Init ───────────────────────────────────────────────────────────────────

export async function initSessionStorage(): Promise<void> {
  if (_initialized) return;
  fs.mkdirSync(sessionsDir(), { recursive: true });
  await getIndex().load();
  _initialized = true;
}

// ─── Write: record transcript entries ───────────────────────────────────────

async function getWriter(sessionId: string): Promise<JSONLWriter> {
  let w = _writers.get(sessionId);
  if (!w) {
    w = new JSONLWriter(sessionFilePath(sessionId));
    await w.open();
    _writers.set(sessionId, w);
  }
  return w;
}

function getDedup(sessionId: string): BoundedUUIDSet {
  let d = _dedups.get(sessionId);
  if (!d) { d = new BoundedUUIDSet(2000); _dedups.set(sessionId, d); }
  return d;
}

export async function appendEntry(entry: { type: string; uuid: string; timestamp: number; [k: string]: unknown }): Promise<void> {
  await initSessionStorage();
  const sid = getSessionId();
  const w = await getWriter(sid);
  w.write({ v: SESSION_SCHEMA_VERSION, uuid: entry.uuid, type: entry.type as any, ts: entry.timestamp, data: entry });
}

export async function recordTranscript(role: string, content: string, parentUuid?: string, extra?: Record<string, unknown>): Promise<string> {
  const uuid = crypto.randomUUID();
  await appendEntry({ type: role, uuid, timestamp: Date.now(), role, content, parentUuid, ...extra });
  return uuid;
}

export async function recordToolUse(toolName: string, input: unknown, output: string, parentUuid?: string): Promise<string> {
  const uuid = crypto.randomUUID();
  await appendEntry({ type: 'tool_use', uuid, timestamp: Date.now(), toolName, input, output, parentUuid });
  return uuid;
}

// ─── Flush ──────────────────────────────────────────────────────────────────

export async function flushSession(): Promise<void> {
  for (const w of _writers.values()) await w.flush();
}

// ─── Read ───────────────────────────────────────────────────────────────────

export async function loadTranscriptFile(sessionIdOrPath?: string): Promise<any[]> {
  let fp: string;
  if (sessionIdOrPath?.endsWith('.jsonl')) fp = sessionIdOrPath;
  else if (sessionIdOrPath) fp = sessionFilePath(sessionIdOrPath);
  else fp = sessionFilePath(getSessionId());

  const reader = new JSONLReader(fp);
  const entries = await reader.loadAll();

  // Extract messages with backward compat (old format: entry IS the message)
  return entries.map(e => {
    if (e.data && typeof e.data === 'object') return e.data as any;
    return e;
  });
}

// ─── List ───────────────────────────────────────────────────────────────────

export async function listSessions(limit = 20): Promise<Array<{ sessionId: string; cwd: string; mtime: Date; filePath: string }>> {
  await initSessionStorage();
  const results: Array<{ sessionId: string; cwd: string; mtime: Date; filePath: string }> = [];

  try {
    const files = fs.readdirSync(sessionsDir());
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const fp = path.join(sessionsDir(), f);
      try {
        const st = fs.statSync(fp);
        results.push({ sessionId: f.replace('.jsonl', ''), cwd: getCwd(), mtime: st.mtime, filePath: fp });
      } catch {}
    }
  } catch {}

  results.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return results.slice(0, limit);
}

// ─── Metadata ───────────────────────────────────────────────────────────────

export async function saveSessionMetadata(key: string, value: unknown): Promise<void> {
  await appendEntry({ type: key, uuid: crypto.randomUUID(), timestamp: Date.now(), value });
}

// ─── Lock ───────────────────────────────────────────────────────────────────

export async function acquireSessionLock(sessionId: string): Promise<boolean> {
  try {
    await SessionLockfile.acquire(sessionFilePath(sessionId));
    return true;
  } catch {
    return false;
  }
}

export async function releaseSessionLock(sessionId: string): Promise<void> {
  try { fs.unlinkSync(sessionFilePath(sessionId) + '.lock'); } catch {}
}

// ─── Session Resume with Validation ─────────────────────────────────────────

/**
 * Validate a session for resumption.
 * Checks file integrity, workspace match, age, and status.
 */
export async function validateResume(options: ResumeOptions): Promise<ResumeValidation> {
  await initSessionStorage();

  const result: ResumeValidation = {
    valid: false,
    sessionId: '',
    errors: [],
    warnings: [],
    integrityOk: false,
    workspaceMatch: false,
    ageMs: 0,
    entryCount: 0,
  };

  // Determine which session to validate
  let targetSessionId: string | undefined = options.sessionId;

  if (!targetSessionId && options.continueLastInCwd) {
    const cwdPath = options.cwd ?? getCwd();
    const sessions = await listSessions(10);
    const match = sessions.find(s => s.cwd === cwdPath);
    if (match) targetSessionId = match.sessionId;
  }

  if (!targetSessionId) {
    result.errors.push('No session specified or found for resume');
    return result;
  }

  result.sessionId = targetSessionId;

  // Check file exists
  const fp = sessionFilePath(targetSessionId);
  if (!fs.existsSync(fp)) {
    result.errors.push(`Session file not found: ${fp}`);
    return result;
  }

  // Check file integrity
  try {
    const content = fs.readFileSync(fp, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    result.entryCount = lines.length;

    // Try parsing each line
    let parseErrors = 0;
    for (const line of lines) {
      try { JSON.parse(line); } catch { parseErrors++; }
    }

    result.integrityOk = parseErrors === 0;
    if (parseErrors > 0) {
      result.warnings.push(`${parseErrors} malformed entries found`);
    }
  } catch (err) {
    result.errors.push(`Cannot read session file: ${(err as Error).message}`);
    return result;
  }

  // Check age
  try {
    const stat = fs.statSync(fp);
    result.ageMs = Date.now() - stat.mtimeMs;

    if (options.maxAge && result.ageMs > options.maxAge) {
      result.errors.push(`Session too old: ${Math.round(result.ageMs / 60000)}m (max ${Math.round(options.maxAge / 60000)}m)`);
    }
  } catch { /* ignore */ }

  // Workspace validation
  if (options.validateWorkspace) {
    try {
      const entries = await loadTranscriptFile(targetSessionId);
      const startEntry = entries.find((e: any) => e.type === 'session_start');
      if (startEntry) {
        const sessionCwd = (startEntry as any).cwd || '';
        const currentCwd = options.cwd ?? getCwd();
        result.workspaceMatch = sessionCwd === currentCwd;
        if (!result.workspaceMatch) {
          result.warnings.push(`Workspace mismatch: session was in "${sessionCwd}", current is "${currentCwd}"`);
        }
      }
    } catch { /* ignore */ }
  } else {
    result.workspaceMatch = true;
  }

  result.valid = result.errors.length === 0 && result.integrityOk;
  return result;
}

/**
 * Resume a session after validation.
 */
export async function resumeSession(sessionId: string): Promise<any[]> {
  const validation = await validateResume({ sessionId });
  if (!validation.valid) {
    throw new Error(`Cannot resume session: ${validation.errors.join('; ')}`);
  }
  return loadTranscriptFile(sessionId);
}

// ─── Session Fork ───────────────────────────────────────────────────────────

/**
 * Fork a session: create a new session with entries copied from the source.
 * Useful for branching a conversation while preserving history.
 */
export async function forkSession(
  sourceSessionId: string,
  options?: { maxEntries?: number; label?: string },
): Promise<string> {
  await initSessionStorage();

  const newSessionId = crypto.randomUUID();
  const sourceFp = sessionFilePath(sourceSessionId);
  const newFp = sessionFilePath(newSessionId);

  if (!fs.existsSync(sourceFp)) {
    throw new Error(`Source session not found: ${sourceSessionId}`);
  }

  // Read source entries
  const reader = new JSONLReader(sourceFp);
  const entries = await reader.loadAll();
  const maxEntries = options?.maxEntries ?? entries.length;
  const entriesToCopy = entries.slice(0, maxEntries);

  // Write forked session
  const writer = new JSONLWriter(newFp);
  await writer.open();

  // Write a fork marker entry
  writer.write({
    v: SESSION_SCHEMA_VERSION,
    uuid: crypto.randomUUID(),
    type: 'metadata' as any,
    ts: Date.now(),
    data: {
      type: 'fork',
      sourceSessionId,
      entriesCopied: entriesToCopy.length,
      label: options?.label ?? `Fork of ${sourceSessionId}`,
    },
  });

  // Copy entries with new UUIDs
  for (const entry of entriesToCopy) {
    writer.write({
      ...entry,
      uuid: crypto.randomUUID(),
    });
  }

  await writer.close();

  return newSessionId;
}

// ─── Session Archive ────────────────────────────────────────────────────────

/**
 * Archive a session by moving it to the archive directory.
 * Archived sessions are excluded from normal listing.
 */
export async function archiveSession(sessionId: string): Promise<string> {
  await initSessionStorage();

  const sourceFp = sessionFilePath(sessionId);
  if (!fs.existsSync(sourceFp)) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  fs.mkdirSync(archiveDir(), { recursive: true });
  const destFp = path.join(archiveDir(), `${sessionId}.jsonl`);

  fs.copyFileSync(sourceFp, destFp);
  fs.unlinkSync(sourceFp);

  // Clean up lock file
  try { fs.unlinkSync(sourceFp + '.lock'); } catch { /* ignore */ }

  return destFp;
}

/**
 * Restore an archived session.
 */
export async function restoreSession(sessionId: string): Promise<string> {
  const archiveFp = path.join(archiveDir(), `${sessionId}.jsonl`);
  if (!fs.existsSync(archiveFp)) {
    throw new Error(`Archived session not found: ${sessionId}`);
  }

  const destFp = sessionFilePath(sessionId);
  fs.copyFileSync(archiveFp, destFp);
  fs.unlinkSync(archiveFp);

  return destFp;
}

/**
 * List archived sessions.
 */
export async function listArchivedSessions(): Promise<Array<{ sessionId: string; mtime: Date; filePath: string; sizeBytes: number }>> {
  const dir = archiveDir();
  if (!fs.existsSync(dir)) return [];

  const results: Array<{ sessionId: string; mtime: Date; filePath: string; sizeBytes: number }> = [];

  try {
    const files = fs.readdirSync(dir);
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const fp = path.join(dir, f);
      try {
        const st = fs.statSync(fp);
        results.push({
          sessionId: f.replace('.jsonl', ''),
          mtime: st.mtime,
          filePath: fp,
          sizeBytes: st.size,
        });
      } catch { /* skip */ }
    }
  } catch { /* skip */ }

  results.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return results;
}

// ─── Session Export ─────────────────────────────────────────────────────────

/**
 * Export a session to a JSON object suitable for serialization.
 */
export async function exportSession(
  sessionId: string,
  options: ExportOptions = {},
): Promise<ExportedSession> {
  await initSessionStorage();

  const fp = sessionFilePath(sessionId);
  if (!fs.existsSync(fp)) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  const includeContent = options.includeContent ?? true;
  const includeToolUse = options.includeToolUse ?? true;
  const includeCosts = options.includeCosts ?? true;
  const includeTombstones = options.includeTombstones ?? false;

  // Load all entries
  const reader = new JSONLReader(fp);
  const allEntries = await reader.loadAll();

  // Filter entries based on options
  const filtered = allEntries.filter(entry => {
    if (entry.type === 'tombstone' && !includeTombstones) return false;
    if (entry.type === 'tool_use' && !includeToolUse) return false;
    if (entry.type === 'cost_record' && !includeCosts) return false;
    return true;
  });

  // Strip content if not requested
  const entries = filtered.map(entry => {
    if (!includeContent && entry.type === 'message') {
      return { ...entry, data: { type: 'message', role: (entry.data as any)?.role, contentOmitted: true } };
    }
    return entry;
  });

  // Compute statistics
  const stats = await computeSessionStats(sessionId, allEntries);

  const stat = fs.statSync(fp);

  return {
    version: SESSION_SCHEMA_VERSION,
    exportedAt: Date.now(),
    sessionId,
    workspace: getCwd(),
    startedAt: allEntries.length > 0 ? allEntries[0].ts : 0,
    endedAt: allEntries.length > 0 ? allEntries[allEntries.length - 1].ts : null,
    status: 'exported',
    entryCount: entries.length,
    entries,
    statistics: stats,
  };
}

/**
 * Export a session to a JSON file.
 */
export async function exportSessionToFile(
  sessionId: string,
  outputPath: string,
  options: ExportOptions = {},
): Promise<void> {
  const exported = await exportSession(sessionId, options);
  const prettyPrint = options.prettyPrint ?? true;
  const json = prettyPrint ? JSON.stringify(exported, null, 2) : JSON.stringify(exported);
  fs.writeFileSync(outputPath, json);
}

// ─── Session Statistics ─────────────────────────────────────────────────────

/**
 * Compute statistics for a session.
 */
export async function getSessionStats(sessionId: string): Promise<SessionStats> {
  const fp = sessionFilePath(sessionId);
  if (!fs.existsSync(fp)) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  const reader = new JSONLReader(fp);
  const entries = await reader.loadAll();
  return computeSessionStats(sessionId, entries);
}

function computeSessionStats(sessionId: string, entries: JSONLEntry[]): SessionStats {
  const entryTypes: Record<string, number> = {};
  let messageCount = 0;
  let toolUseCount = 0;
  let tombstoneCount = 0;
  let compactCount = 0;
  let costRecordCount = 0;
  let firstEntryAt = Infinity;
  let lastEntryAt = 0;

  for (const entry of entries) {
    const typeName = entry.type;
    entryTypes[typeName] = (entryTypes[typeName] ?? 0) + 1;

    if (entry.ts < firstEntryAt) firstEntryAt = entry.ts;
    if (entry.ts > lastEntryAt) lastEntryAt = entry.ts;

    switch (typeName) {
      case 'message': messageCount++; break;
      case 'tool_use': toolUseCount++; break;
      case 'tombstone': tombstoneCount++; break;
      case 'compact_boundary': compactCount++; break;
      case 'cost_record': costRecordCount++; break;
    }
  }

  if (firstEntryAt === Infinity) firstEntryAt = 0;

  // Get file size
  let fileSizeBytes = 0;
  try {
    const fp = sessionFilePath(sessionId);
    const stat = fs.statSync(fp);
    fileSizeBytes = stat.size;
  } catch { /* ignore */ }

  return {
    sessionId,
    entryCount: entries.length,
    messageCount,
    toolUseCount,
    tombstoneCount,
    compactCount,
    costRecordCount,
    fileSizeBytes,
    durationMs: lastEntryAt - firstEntryAt,
    firstEntryAt,
    lastEntryAt,
    entryTypes,
  };
}

/**
 * Get aggregate statistics across all sessions.
 */
export async function getGlobalStats(): Promise<{
  totalSessions: number;
  totalSizeBytes: number;
  totalEntries: number;
  oldestSessionAt: number;
  newestSessionAt: number;
  avgSessionSizeBytes: number;
}> {
  await initSessionStorage();

  let totalSessions = 0;
  let totalSizeBytes = 0;
  let totalEntries = 0;
  let oldestSessionAt = Infinity;
  let newestSessionAt = 0;

  try {
    const files = fs.readdirSync(sessionsDir());
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const fp = path.join(sessionsDir(), f);
      try {
        const stat = fs.statSync(fp);
        totalSessions++;
        totalSizeBytes += stat.size;
        if (stat.mtimeMs < oldestSessionAt) oldestSessionAt = stat.mtimeMs;
        if (stat.mtimeMs > newestSessionAt) newestSessionAt = stat.mtimeMs;

        // Estimate entry count from file size (avg ~200 bytes per entry)
        totalEntries += Math.round(stat.size / 200);
      } catch { /* skip */ }
    }
  } catch { /* skip */ }

  if (oldestSessionAt === Infinity) oldestSessionAt = 0;

  return {
    totalSessions,
    totalSizeBytes,
    totalEntries,
    oldestSessionAt,
    newestSessionAt,
    avgSessionSizeBytes: totalSessions > 0 ? Math.round(totalSizeBytes / totalSessions) : 0,
  };
}

// ─── Session Search ─────────────────────────────────────────────────────────

/**
 * Search sessions by various criteria.
 */
export async function searchSessions(criteria: SessionSearchCriteria): Promise<Array<{
  sessionId: string;
  filePath: string;
  mtime: Date;
  sizeBytes: number;
  matchedEntries: number;
}>> {
  await initSessionStorage();

  const limit = criteria.limit ?? 20;
  const results: Array<{
    sessionId: string;
    filePath: string;
    mtime: Date;
    sizeBytes: number;
    matchedEntries: number;
  }> = [];

  try {
    const files = fs.readdirSync(sessionsDir());

    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      if (results.length >= limit) break;

      const fp = path.join(sessionsDir(), f);
      const sessionId = f.replace('.jsonl', '');

      try {
        const stat = fs.statSync(fp);

        // Date range filter
        if (criteria.after && stat.mtimeMs < criteria.after) continue;
        if (criteria.before && stat.mtimeMs > criteria.before) continue;

        let matchedEntries = 0;

        // Content search (only if query is provided)
        if (criteria.query) {
          const content = fs.readFileSync(fp, 'utf-8');
          const lowerQuery = criteria.query.toLowerCase();
          const lines = content.split('\n');

          for (const line of lines) {
            if (line.toLowerCase().includes(lowerQuery)) {
              matchedEntries++;
            }
          }

          if (matchedEntries === 0) continue;
        }

        results.push({
          sessionId,
          filePath: fp,
          mtime: stat.mtime,
          sizeBytes: stat.size,
          matchedEntries,
        });
      } catch { /* skip */ }
    }
  } catch { /* skip */ }

  results.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return results.slice(0, limit);
}

// ─── Exported path helper ───────────────────────────────────────────────────

export function getSessionFilePath(sessionId?: string): string {
  return sessionFilePath(sessionId || getSessionId());
}

// ─── Re-exports for direct access ───────────────────────────────────────────

export { SessionIndex } from './sessionIndex.js';
export { JSONLWriter } from './jsonlWriter.js';
export { JSONLReader } from './jsonlReader.js';
export { StreamingJSONLReader } from './streamingReader.js';
export { BoundedUUIDSet } from './boundedUuidSet.js';
export { TombstoneResolver } from './tombstoneResolver.js';
export { SessionLockfile } from './sessionLockfile.js';
export { SessionMigration } from './sessionMigration.js';
export { CrashRecovery } from './crashRecovery.js';
export { SessionGC } from './sessionGC.js';
export { FileStateCache } from './fileStateCache.js';
export { PreservedSegmentChain } from './preservedSegmentChain.js';
export { hashWorkspace, isSameWorkspace } from './workspaceHash.js';
export type { SessionMetadata, JSONLEntry, ResumeOptions } from './types.js';
