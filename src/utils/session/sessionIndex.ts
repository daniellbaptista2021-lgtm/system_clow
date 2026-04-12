/**
 * SessionIndex.ts — Fast session metadata index
 *
 * Based on Claude Code's sessionIndex.ts (~300 lines)
 *
 * Maintains an in-memory index of all sessions for fast lookup.
 * Backed by an index.json file on disk for persistence.
 *
 * Features:
 *   - Add/get/update/remove sessions
 *   - Lookup by workspace hash (for resume)
 *   - Lookup by status (active/closed/crashed)
 *   - Sorted by last activity (newest first)
 *   - Partial session ID resolution
 *   - Automatic index persistence (atomic write)
 *   - Prune old entries
 *   - Statistics
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { hashWorkspace } from './workspaceHash.js';
import type { SessionMetadata, SessionStatus } from './types.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_INDEX_ENTRIES = 5000;

// ─── Types ──────────────────────────────────────────────────────────────────

interface IndexStats {
  totalSessions: number;
  activeSessions: number;
  closedSessions: number;
  crashedSessions: number;
  archivedSessions: number;
  oldestSessionAt: number;
  newestSessionAt: number;
}

// ════════════════════════════════════════════════════════════════════════════
// SessionIndex Class
// ════════════════════════════════════════════════════════════════════════════

export class SessionIndex {
  private meta = new Map<string, SessionMetadata>();
  private loaded = false;
  private dirty = false;

  constructor(private readonly clowHome: string) {}

  // ─── Load/Save ───────────────────────────────────────────────────

  /**
   * Load index from disk.
   */
  async load(): Promise<void> {
    if (this.loaded) return;

    const indexPath = this.indexPath();
    try {
      if (fs.existsSync(indexPath)) {
        const content = await fsp.readFile(indexPath, 'utf-8');
        const data = JSON.parse(content);
        for (const session of data.sessions ?? []) {
          this.meta.set(session.id, session);
        }
      }
    } catch (err) {
      console.warn(`[SessionIndex] Failed to load: ${(err as Error).message}`);
    }

    this.loaded = true;
  }

  /**
   * Save index to disk (atomic write: tmp → rename).
   */
  async save(): Promise<void> {
    if (!this.dirty) return;

    const indexPath = this.indexPath();
    const tmpPath = indexPath + `.tmp.${Date.now()}`;

    try {
      await fsp.mkdir(path.dirname(indexPath), { recursive: true });
      const data = {
        version: 3,
        savedAt: Date.now(),
        sessions: [...this.meta.values()],
      };
      await fsp.writeFile(tmpPath, JSON.stringify(data, null, 2));
      await fsp.rename(tmpPath, indexPath);
      this.dirty = false;
    } catch (err) {
      try { await fsp.unlink(tmpPath); } catch {}
      throw err;
    }
  }

  // ─── CRUD ────────────────────────────────────────────────────────

  async addSession(metadata: SessionMetadata): Promise<void> {
    await this.load();
    this.meta.set(metadata.id, metadata);
    this.dirty = true;

    // Auto-prune if over limit
    if (this.meta.size > MAX_INDEX_ENTRIES) {
      this.pruneOldest(Math.floor(MAX_INDEX_ENTRIES * 0.1));
    }

    await this.persist();
  }

  async updateSession(id: string, updates: Partial<SessionMetadata>): Promise<void> {
    await this.load();
    const existing = this.meta.get(id);
    if (!existing) return;
    this.meta.set(id, { ...existing, ...updates });
    this.dirty = true;
    await this.persist();
  }

  async getSession(id: string): Promise<SessionMetadata | null> {
    await this.load();
    return this.meta.get(id) ?? null;
  }

  async removeSession(id: string): Promise<void> {
    await this.load();
    this.meta.delete(id);
    this.dirty = true;
    await this.persist();
  }

  // ─── Queries ─────────────────────────────────────────────────────

  async listAll(limit?: number): Promise<SessionMetadata[]> {
    await this.load();
    const sorted = [...this.meta.values()]
      .sort((a, b) => b.lastMessageAt - a.lastMessageAt);
    return limit ? sorted.slice(0, limit) : sorted;
  }

  async findByCwd(cwd: string): Promise<SessionMetadata[]> {
    const h = hashWorkspace(cwd);
    return (await this.listAll()).filter(m => m.workspaceHash === h);
  }

  async findByWorkspaceHash(hash: string): Promise<SessionMetadata[]> {
    return (await this.listAll()).filter(m => m.workspaceHash === hash);
  }

  async findActive(): Promise<SessionMetadata[]> {
    return (await this.listAll()).filter(m => m.status === 'active');
  }

  async findByStatus(status: SessionStatus): Promise<SessionMetadata[]> {
    return (await this.listAll()).filter(m => m.status === status);
  }

  async findLatestForWorkspace(workspaceHash: string): Promise<SessionMetadata | null> {
    const sessions = await this.findByWorkspaceHash(workspaceHash);
    return sessions.length > 0 ? sessions[0] : null;
  }

  /**
   * Resolve a partial session ID to a full ID.
   * Throws if ambiguous (matches multiple sessions).
   */
  async resolvePartialId(partial: string): Promise<string | null> {
    await this.load();
    const matches = [...this.meta.keys()].filter(id => id.startsWith(partial));
    if (matches.length === 0) return null;
    if (matches.length === 1) return matches[0];
    throw new Error(`Ambiguous session ID "${partial}": matches ${matches.length} sessions`);
  }

  // ─── Maintenance ─────────────────────────────────────────────────

  /**
   * Prune the oldest N sessions from the index.
   */
  pruneOldest(count: number): number {
    const sorted = [...this.meta.values()]
      .sort((a, b) => a.lastMessageAt - b.lastMessageAt);

    let pruned = 0;
    for (const session of sorted.slice(0, count)) {
      this.meta.delete(session.id);
      pruned++;
    }

    if (pruned > 0) this.dirty = true;
    return pruned;
  }

  /**
   * Prune sessions older than maxAgeMs.
   */
  pruneOlderThan(maxAgeMs: number): number {
    const cutoff = Date.now() - maxAgeMs;
    let pruned = 0;

    for (const [id, session] of this.meta) {
      if (session.lastMessageAt < cutoff) {
        this.meta.delete(id);
        pruned++;
      }
    }

    if (pruned > 0) this.dirty = true;
    return pruned;
  }

  /**
   * Mark a session as crashed.
   */
  async markCrashed(sessionId: string): Promise<void> {
    await this.updateSession(sessionId, { status: 'crashed' });
  }

  /**
   * Touch session (update lastMessageAt).
   */
  async touch(sessionId: string): Promise<void> {
    await this.updateSession(sessionId, { lastMessageAt: Date.now() });
  }

  // ─── Statistics ──────────────────────────────────────────────────

  async getStats(): Promise<IndexStats> {
    await this.load();
    const sessions = [...this.meta.values()];

    const byStatus = (s: SessionStatus) => sessions.filter(m => m.status === s).length;

    return {
      totalSessions: sessions.length,
      activeSessions: byStatus('active'),
      closedSessions: byStatus('closed'),
      crashedSessions: byStatus('crashed'),
      archivedSessions: byStatus('archived'),
      oldestSessionAt: sessions.length > 0 ? Math.min(...sessions.map(s => s.startedAt)) : 0,
      newestSessionAt: sessions.length > 0 ? Math.max(...sessions.map(s => s.startedAt)) : 0,
    };
  }

  get size(): number {
    return this.meta.size;
  }

  clear(): void {
    this.meta.clear();
    this.dirty = true;
  }

  // ─── Internal ────────────────────────────────────────────────────

  private async persist(): Promise<void> {
    await this.save();
  }

  private indexPath(): string {
    return path.join(this.clowHome, 'sessions', 'index.json');
  }
}
