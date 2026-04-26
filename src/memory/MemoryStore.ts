/**
 * MemoryStore.ts — CRUD operations for persistent memory
 *
 * All operations are synchronous (better-sqlite3).
 * Deduplication via SHA256 content hash with 30-second window.
 */

import { createHash } from 'crypto';
import { getMemoryDb, getDbSize } from './MemoryDatabase.js';
import { hasFts5 } from './MemorySchema.js';

// ════════════════════════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════════════════════════

export interface MemorySession {
  id: number;
  session_id: string;
  tenant_id: string;
  cwd: string | null;
  started_at: string;
  started_at_epoch: number;
  ended_at: string | null;
  ended_at_epoch: number | null;
  status: string;
}

export interface Observation {
  id: number;
  session_id: string;
  tenant_id: string;
  tool_name: string | null;
  type: string;
  title: string | null;
  narrative: string | null;
  files_touched: string | null;
  content_hash: string | null;
  created_at_epoch: number;
}

export interface SessionSummary {
  id: number;
  session_id: string;
  tenant_id: string;
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  files_touched: string | null;
  created_at_epoch: number;
}

export interface SearchResult {
  type: 'observation' | 'summary';
  id: number;
  session_id: string;
  title: string;
  content: string;
  created_at_epoch: number;
}

export interface MemoryStats {
  sessionCount: number;
  observationCount: number;
  summaryCount: number;
  dbSizeBytes: number;
}

// ════════════════════════════════════════════════════════════════════════════
// MemoryStore Class
// ════════════════════════════════════════════════════════════════════════════

export class MemoryStore {
  constructor(private readonly tenantId: string = 'default') {}

  private get db() {
    return getMemoryDb(this.tenantId);
  }

  // ─── Sessions ───────────────────────────────────────────────────

  recordSession(sessionId: string, cwd?: string): void {
    const now = Date.now();
    this.db.prepare(`
      INSERT OR IGNORE INTO memory_sessions (session_id, tenant_id, cwd, started_at, started_at_epoch)
      VALUES (?, ?, ?, datetime('now'), ?)
    `).run(sessionId, this.tenantId, cwd || null, now);
  }

  endSession(sessionId: string, status: string = 'completed'): void {
    this.db.prepare(`
      UPDATE memory_sessions SET ended_at = datetime('now'), ended_at_epoch = ?, status = ?
      WHERE session_id = ? AND tenant_id = ?
    `).run(Date.now(), status, sessionId, this.tenantId);
  }

  getRecentSessions(limit: number = 5): MemorySession[] {
    return this.db.prepare(`
      SELECT * FROM memory_sessions
      WHERE tenant_id = ? AND status = 'completed'
      ORDER BY started_at_epoch DESC LIMIT ?
    `).all(this.tenantId, limit) as MemorySession[];
  }

  // ─── Observations ──────────────────────────────────────────────

  recordObservation(params: {
    sessionId: string;
    toolName: string;
    type?: string;
    title: string;
    narrative?: string;
    filesTouched?: string[];
  }): number | null {
    const now = Date.now();

    // Deduplication: SHA256 content hash, 30s window
    const hashInput = `${params.sessionId}|${params.title}|${params.narrative || ''}`;
    const contentHash = createHash('sha256').update(hashInput).digest('hex').slice(0, 16);

    const thirtySecsAgo = now - 30_000;
    const existing = this.db.prepare(`
      SELECT id FROM observations
      WHERE content_hash = ? AND created_at_epoch > ?
    `).get(contentHash, thirtySecsAgo) as { id: number } | undefined;

    if (existing) return existing.id;

    const result = this.db.prepare(`
      INSERT INTO observations (session_id, tenant_id, tool_name, type, title, narrative, files_touched, content_hash, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      params.sessionId,
      this.tenantId,
      params.toolName,
      params.type || 'tool_use',
      params.title,
      params.narrative || null,
      params.filesTouched ? JSON.stringify(params.filesTouched) : null,
      contentHash,
      now,
    );

    return result.lastInsertRowid as number;
  }

  getSessionObservations(sessionId: string): Observation[] {
    return this.db.prepare(`
      SELECT * FROM observations
      WHERE session_id = ? AND tenant_id = ?
      ORDER BY created_at_epoch ASC
    `).all(sessionId, this.tenantId) as Observation[];
  }

  getRecentObservations(limit: number = 20): Observation[] {
    return this.db.prepare(`
      SELECT * FROM observations
      WHERE tenant_id = ?
      ORDER BY created_at_epoch DESC LIMIT ?
    `).all(this.tenantId, limit) as Observation[];
  }

  // ─── Summaries ─────────────────────────────────────────────────

  recordSummary(params: {
    sessionId: string;
    request?: string;
    investigated?: string;
    learned?: string;
    completed?: string;
    nextSteps?: string;
    filesTouched?: string[];
  }): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO session_summaries
      (session_id, tenant_id, request, investigated, learned, completed, next_steps, files_touched, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      params.sessionId,
      this.tenantId,
      params.request || null,
      params.investigated || null,
      params.learned || null,
      params.completed || null,
      params.nextSteps || null,
      params.filesTouched ? JSON.stringify(params.filesTouched) : null,
      Date.now(),
    );
  }

  getRecentSummaries(limit: number = 5): SessionSummary[] {
    return this.db.prepare(`
      SELECT * FROM session_summaries
      WHERE tenant_id = ?
      ORDER BY created_at_epoch DESC LIMIT ?
    `).all(this.tenantId, limit) as SessionSummary[];
  }

  getSummary(sessionId: string): SessionSummary | null {
    return (this.db.prepare(`
      SELECT * FROM session_summaries
      WHERE session_id = ? AND tenant_id = ?
    `).get(sessionId, this.tenantId) as SessionSummary) || null;
  }

  // ─── Search ────────────────────────────────────────────────────

  search(query: string, opts: { type?: string; limit?: number } = {}): SearchResult[] {
    const limit = opts.limit || 10;
    const results: SearchResult[] = [];

    if (hasFts5(this.db)) {
      // FTS5 search
      const obsResults = this.db.prepare(`
        SELECT o.id, o.session_id, o.title, o.narrative as content, o.created_at_epoch
        FROM observations_fts f
        JOIN observations o ON o.id = f.rowid
        WHERE observations_fts MATCH ? AND o.tenant_id = ?
        ORDER BY rank LIMIT ?
      `).all(query, this.tenantId, limit) as any[];

      for (const r of obsResults) {
        results.push({ type: 'observation', id: r.id, session_id: r.session_id, title: r.title || '', content: r.content || '', created_at_epoch: r.created_at_epoch });
      }

      if (!opts.type || opts.type === 'summary') {
        const sumResults = this.db.prepare(`
          SELECT s.id, s.session_id, s.request as title, s.completed as content, s.created_at_epoch
          FROM summaries_fts f
          JOIN session_summaries s ON s.id = f.rowid
          WHERE summaries_fts MATCH ? AND s.tenant_id = ?
          ORDER BY rank LIMIT ?
        `).all(query, this.tenantId, limit) as any[];

        for (const r of sumResults) {
          results.push({ type: 'summary', id: r.id, session_id: r.session_id, title: r.title || '', content: r.content || '', created_at_epoch: r.created_at_epoch });
        }
      }
    } else {
      // Fallback: LIKE search
      const likeQuery = `%${query}%`;
      const obsResults = this.db.prepare(`
        SELECT id, session_id, title, narrative as content, created_at_epoch
        FROM observations
        WHERE tenant_id = ? AND (title LIKE ? OR narrative LIKE ?)
        ORDER BY created_at_epoch DESC LIMIT ?
      `).all(this.tenantId, likeQuery, likeQuery, limit) as any[];

      for (const r of obsResults) {
        results.push({ type: 'observation', id: r.id, session_id: r.session_id, title: r.title || '', content: r.content || '', created_at_epoch: r.created_at_epoch });
      }
    }

    // Sort by time (most recent first)
    results.sort((a, b) => b.created_at_epoch - a.created_at_epoch);
    return results.slice(0, limit);
  }

  // ─── Delete (GDPR) ─────────────────────────────────────────────

  deleteSession(sessionId: string): boolean {
    // CASCADE deletes observations and summaries
    const result = this.db.prepare(`
      DELETE FROM memory_sessions WHERE session_id = ? AND tenant_id = ?
    `).run(sessionId, this.tenantId);
    return result.changes > 0;
  }

  // ─── Stats ─────────────────────────────────────────────────────

  getStats(): MemoryStats {
    const sessions = this.db.prepare('SELECT COUNT(*) as c FROM memory_sessions WHERE tenant_id = ?').get(this.tenantId) as { c: number };
    const observations = this.db.prepare('SELECT COUNT(*) as c FROM observations WHERE tenant_id = ?').get(this.tenantId) as { c: number };
    const summaries = this.db.prepare('SELECT COUNT(*) as c FROM session_summaries WHERE tenant_id = ?').get(this.tenantId) as { c: number };

    return {
      sessionCount: sessions.c,
      observationCount: observations.c,
      summaryCount: summaries.c,
      dbSizeBytes: getDbSize(this.tenantId),
    };
  }
}
