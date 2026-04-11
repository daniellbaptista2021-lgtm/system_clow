/**
 * sessionStorage.ts — Session Persistence (JSONL)
 *
 * Based on Claude Code's sessionStorage.ts (5,106 lines)
 * Append-only JSONL format: crash-safe, no locks needed, streaming writes
 *
 * Storage: ~/.clow/sessions/{sanitized-cwd}/{session-id}.jsonl
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { getSessionId, getCwd } from '../../bootstrap/state.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TranscriptEntry {
  type: string;
  uuid: string;
  parentUuid?: string;
  timestamp: number;
  content?: unknown;
  role?: string;
  toolName?: string;
  [key: string]: unknown;
}

// ─── Path Management ────────────────────────────────────────────────────────

const CLOW_DIR = path.join(os.homedir(), '.clow');
const SESSIONS_DIR = path.join(CLOW_DIR, 'sessions');

function sanitizePath(p: string): string {
  let sanitized = p.replace(/[^a-zA-Z0-9]/g, '-');
  if (sanitized.length > 200) {
    // Hash suffix for uniqueness
    let hash = 0;
    for (let i = 0; i < p.length; i++) {
      hash = ((hash << 5) - hash + p.charCodeAt(i)) | 0;
    }
    sanitized = sanitized.slice(0, 180) + '-' + Math.abs(hash).toString(36);
  }
  return sanitized;
}

function getSessionDir(): string {
  const cwdHash = sanitizePath(getCwd());
  return path.join(SESSIONS_DIR, cwdHash);
}

function getSessionFilePath(sessionId?: string): string {
  return path.join(getSessionDir(), `${sessionId || getSessionId()}.jsonl`);
}

// ─── Initialization ─────────────────────────────────────────────────────────

let initialized = false;
let sessionFileMaterialized = false;

export async function initSessionStorage(): Promise<void> {
  if (initialized) return;
  await fsp.mkdir(getSessionDir(), { recursive: true });
  initialized = true;
}

// ─── Write Path (Append-Only) ───────────────────────────────────────────────

const writeQueue: TranscriptEntry[] = [];
let drainTimer: ReturnType<typeof setTimeout> | null = null;
const DRAIN_INTERVAL_MS = 100; // 100ms coalescing

export async function appendEntry(entry: TranscriptEntry): Promise<void> {
  await initSessionStorage();
  writeQueue.push(entry);
  scheduleDrain();
}

function scheduleDrain(): void {
  if (drainTimer) return;
  drainTimer = setTimeout(async () => {
    drainTimer = null;
    await drainWriteQueue();
  }, DRAIN_INTERVAL_MS);
}

async function drainWriteQueue(): Promise<void> {
  if (writeQueue.length === 0) return;
  const entries = writeQueue.splice(0);
  const filePath = getSessionFilePath();

  // Materialize file on first write (lazy materialization)
  if (!sessionFileMaterialized) {
    sessionFileMaterialized = true;
  }

  const data = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';

  try {
    await fsp.appendFile(filePath, data, { encoding: 'utf-8', mode: 0o600 });
  } catch (err: any) {
    // If directory doesn't exist, create and retry
    if (err.code === 'ENOENT') {
      await fsp.mkdir(path.dirname(filePath), { recursive: true });
      await fsp.appendFile(filePath, data, { encoding: 'utf-8', mode: 0o600 });
    }
  }
}

// ─── Flush (for shutdown) ───────────────────────────────────────────────────

export async function flushSession(): Promise<void> {
  if (drainTimer) {
    clearTimeout(drainTimer);
    drainTimer = null;
  }
  await drainWriteQueue();
}

// ─── Sync Write (for exit handlers) ─────────────────────────────────────────

export function appendEntrySync(entry: TranscriptEntry): void {
  try {
    const dir = getSessionDir();
    fs.mkdirSync(dir, { recursive: true });
    const filePath = getSessionFilePath();
    fs.appendFileSync(filePath, JSON.stringify(entry) + '\n', { encoding: 'utf-8', mode: 0o600 });
  } catch {
    // Best effort on exit
  }
}

// ─── Record Transcript Messages ─────────────────────────────────────────────

export async function recordTranscript(
  role: string,
  content: string,
  parentUuid?: string,
  extra?: Record<string, unknown>,
): Promise<string> {
  const uuid = randomUUID();
  await appendEntry({
    type: role,
    uuid,
    parentUuid,
    timestamp: Date.now(),
    role,
    content,
    ...extra,
  });
  return uuid;
}

export async function recordToolUse(
  toolName: string,
  input: unknown,
  output: string,
  parentUuid?: string,
): Promise<string> {
  const uuid = randomUUID();
  await appendEntry({
    type: 'tool_use',
    uuid,
    parentUuid,
    timestamp: Date.now(),
    toolName,
    input,
    output,
  });
  return uuid;
}

// ─── Read Path (for resume) ─────────────────────────────────────────────────

export async function loadTranscriptFile(
  filePath?: string,
): Promise<TranscriptEntry[]> {
  const fp = filePath || getSessionFilePath();
  try {
    const content = await fsp.readFile(fp, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    return lines.map((line) => {
      try {
        return JSON.parse(line) as TranscriptEntry;
      } catch {
        return null;
      }
    }).filter((e): e is TranscriptEntry => e !== null);
  } catch {
    return [];
  }
}

// ─── List Sessions ──────────────────────────────────────────────────────────

export async function listSessions(limit = 20): Promise<Array<{
  sessionId: string;
  cwd: string;
  mtime: Date;
  filePath: string;
}>> {
  const results: Array<{
    sessionId: string;
    cwd: string;
    mtime: Date;
    filePath: string;
  }> = [];

  try {
    const cwdDirs = await fsp.readdir(SESSIONS_DIR);
    for (const cwdDir of cwdDirs) {
      const dirPath = path.join(SESSIONS_DIR, cwdDir);
      const stat = await fsp.stat(dirPath);
      if (!stat.isDirectory()) continue;

      const files = await fsp.readdir(dirPath);
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        const filePath = path.join(dirPath, file);
        const fileStat = await fsp.stat(filePath);
        results.push({
          sessionId: file.replace('.jsonl', ''),
          cwd: cwdDir,
          mtime: fileStat.mtime,
          filePath,
        });
      }
    }
  } catch {
    // No sessions directory yet
  }

  // Sort by mtime descending
  results.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return results.slice(0, limit);
}

// ─── Metadata ───────────────────────────────────────────────────────────────

export async function saveSessionMetadata(key: string, value: unknown): Promise<void> {
  await appendEntry({
    type: key,
    uuid: randomUUID(),
    timestamp: Date.now(),
    value,
  });
}
