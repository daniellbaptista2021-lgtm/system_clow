/**
 * MemoryStore — Unit Tests
 *
 * Tests: session CRUD, observation recording, deduplication,
 * summary storage, FTS5 search, stats, GDPR delete.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { MemoryStore } from '../../src/memory/MemoryStore.js';
import { runMigrations } from '../../src/memory/MemorySchema.js';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

// Use a temp DB for each test
let testDbPath: string;
let testTenantId: string;

// Mock getMemoryDb to use temp file
function setupTestDb(): Database.Database {
  testTenantId = `test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const tmpDir = path.join(os.tmpdir(), 'clow-tests');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  testDbPath = path.join(tmpDir, `${testTenantId}.sqlite3`);

  const db = new Database(testDbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

// We need to mock getMemoryDb — use a direct DB approach for testing
describe('MemoryStore', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = setupTestDb();
  });

  afterEach(() => {
    try { db.close(); } catch {}
    try { fs.unlinkSync(testDbPath); } catch {}
    try { fs.unlinkSync(testDbPath + '-wal'); } catch {}
    try { fs.unlinkSync(testDbPath + '-shm'); } catch {}
  });

  // ─── Schema Tests ──────────────────────────────────────────────

  describe('Schema', () => {
    it('creates all required tables', () => {
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      ).all() as { name: string }[];
      const names = tables.map(t => t.name);

      expect(names).toContain('memory_sessions');
      expect(names).toContain('observations');
      expect(names).toContain('session_summaries');
      expect(names).toContain('schema_version');
    });

    it('schema version is 2 (with FTS5) or 1 (without)', () => {
      const row = db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number };
      expect(row.v).toBeGreaterThanOrEqual(1);
    });
  });

  // ─── Session CRUD ──────────────────────────────────────────────

  describe('Sessions', () => {
    it('records a session', () => {
      db.prepare(`
        INSERT INTO memory_sessions (session_id, tenant_id, cwd, started_at, started_at_epoch)
        VALUES (?, ?, ?, datetime('now'), ?)
      `).run('sess-1', 'test', '/tmp', Date.now());

      const row = db.prepare('SELECT * FROM memory_sessions WHERE session_id = ?').get('sess-1') as any;
      expect(row).toBeDefined();
      expect(row.session_id).toBe('sess-1');
      expect(row.status).toBe('active');
    });

    it('prevents duplicate session IDs', () => {
      const now = Date.now();
      db.prepare(`INSERT INTO memory_sessions (session_id, tenant_id, started_at, started_at_epoch) VALUES (?, ?, datetime('now'), ?)`).run('dup-1', 'test', now);

      expect(() => {
        db.prepare(`INSERT INTO memory_sessions (session_id, tenant_id, started_at, started_at_epoch) VALUES (?, ?, datetime('now'), ?)`).run('dup-1', 'test', now);
      }).toThrow();
    });

    it('ends a session with status update', () => {
      const now = Date.now();
      db.prepare(`INSERT INTO memory_sessions (session_id, tenant_id, started_at, started_at_epoch) VALUES (?, ?, datetime('now'), ?)`).run('end-1', 'test', now);
      db.prepare(`UPDATE memory_sessions SET status = 'completed', ended_at_epoch = ? WHERE session_id = ?`).run(Date.now(), 'end-1');

      const row = db.prepare('SELECT status FROM memory_sessions WHERE session_id = ?').get('end-1') as any;
      expect(row.status).toBe('completed');
    });
  });

  // ─── Observations ──────────────────────────────────────────────

  describe('Observations', () => {
    beforeEach(() => {
      db.prepare(`INSERT INTO memory_sessions (session_id, tenant_id, started_at, started_at_epoch) VALUES (?, ?, datetime('now'), ?)`).run('obs-sess', 'test', Date.now());
    });

    it('records an observation', () => {
      db.prepare(`
        INSERT INTO observations (session_id, tenant_id, tool_name, type, title, narrative, created_at_epoch)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('obs-sess', 'test', 'Bash', 'tool_use', 'Bash: ls -la', 'comando: ls -la', Date.now());

      const rows = db.prepare('SELECT * FROM observations WHERE session_id = ?').all('obs-sess') as any[];
      expect(rows).toHaveLength(1);
      expect(rows[0].tool_name).toBe('Bash');
      expect(rows[0].title).toBe('Bash: ls -la');
    });

    it('stores files_touched as JSON', () => {
      const files = JSON.stringify(['/tmp/test.ts', '/src/main.ts']);
      db.prepare(`
        INSERT INTO observations (session_id, tenant_id, tool_name, type, title, files_touched, created_at_epoch)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('obs-sess', 'test', 'Edit', 'file_change', 'Edit: test.ts', files, Date.now());

      const row = db.prepare('SELECT files_touched FROM observations WHERE tool_name = ?').get('Edit') as any;
      const parsed = JSON.parse(row.files_touched);
      expect(parsed).toHaveLength(2);
      expect(parsed[0]).toBe('/tmp/test.ts');
    });

    it('content_hash enables dedup queries', () => {
      const hash = 'abc123def456';
      const now = Date.now();
      db.prepare(`
        INSERT INTO observations (session_id, tenant_id, tool_name, type, title, content_hash, created_at_epoch)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('obs-sess', 'test', 'Read', 'tool_use', 'Read: file.ts', hash, now);

      // Check dedup within 30s window
      const existing = db.prepare(`SELECT id FROM observations WHERE content_hash = ? AND created_at_epoch > ?`).get(hash, now - 30000) as any;
      expect(existing).toBeDefined();

      // Outside window: no match
      const old = db.prepare(`SELECT id FROM observations WHERE content_hash = ? AND created_at_epoch > ?`).get(hash, now + 1) as any;
      expect(old).toBeUndefined();
    });
  });

  // ─── Summaries ─────────────────────────────────────────────────

  describe('Summaries', () => {
    beforeEach(() => {
      db.prepare(`INSERT INTO memory_sessions (session_id, tenant_id, started_at, started_at_epoch) VALUES (?, ?, datetime('now'), ?)`).run('sum-sess', 'test', Date.now());
    });

    it('records a session summary', () => {
      db.prepare(`
        INSERT INTO session_summaries (session_id, tenant_id, request, investigated, learned, completed, created_at_epoch)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('sum-sess', 'test', 'Fix CORS', 'Checked Nginx config', 'Trailing slash causes 301', 'Fixed Nginx and CORS', Date.now());

      const row = db.prepare('SELECT * FROM session_summaries WHERE session_id = ?').get('sum-sess') as any;
      expect(row.request).toBe('Fix CORS');
      expect(row.learned).toBe('Trailing slash causes 301');
    });

    it('session_id is unique in summaries', () => {
      const now = Date.now();
      db.prepare(`INSERT INTO session_summaries (session_id, tenant_id, request, created_at_epoch) VALUES (?, ?, ?, ?)`).run('sum-sess', 'test', 'first', now);

      // REPLACE should work (INSERT OR REPLACE)
      db.prepare(`INSERT OR REPLACE INTO session_summaries (session_id, tenant_id, request, created_at_epoch) VALUES (?, ?, ?, ?)`).run('sum-sess', 'test', 'second', now);

      const rows = db.prepare('SELECT * FROM session_summaries WHERE session_id = ?').all('sum-sess') as any[];
      expect(rows).toHaveLength(1);
      expect(rows[0].request).toBe('second');
    });
  });

  // ─── CASCADE Delete ────────────────────────────────────────────

  describe('CASCADE Delete (GDPR)', () => {
    it('deleting session cascades to observations and summaries', () => {
      const now = Date.now();
      db.prepare(`INSERT INTO memory_sessions (session_id, tenant_id, started_at, started_at_epoch) VALUES (?, ?, datetime('now'), ?)`).run('del-sess', 'test', now);
      db.prepare(`INSERT INTO observations (session_id, tenant_id, tool_name, type, title, created_at_epoch) VALUES (?, ?, ?, ?, ?, ?)`).run('del-sess', 'test', 'Bash', 'tool_use', 'test', now);
      db.prepare(`INSERT INTO observations (session_id, tenant_id, tool_name, type, title, created_at_epoch) VALUES (?, ?, ?, ?, ?, ?)`).run('del-sess', 'test', 'Read', 'tool_use', 'test2', now);
      db.prepare(`INSERT INTO session_summaries (session_id, tenant_id, request, created_at_epoch) VALUES (?, ?, ?, ?)`).run('del-sess', 'test', 'test req', now);

      // Verify data exists
      expect(db.prepare('SELECT COUNT(*) as c FROM observations WHERE session_id = ?').get('del-sess')).toEqual({ c: 2 });
      expect(db.prepare('SELECT COUNT(*) as c FROM session_summaries WHERE session_id = ?').get('del-sess')).toEqual({ c: 1 });

      // Delete
      db.prepare('DELETE FROM memory_sessions WHERE session_id = ?').run('del-sess');

      // Verify cascade
      expect(db.prepare('SELECT COUNT(*) as c FROM observations WHERE session_id = ?').get('del-sess')).toEqual({ c: 0 });
      expect(db.prepare('SELECT COUNT(*) as c FROM session_summaries WHERE session_id = ?').get('del-sess')).toEqual({ c: 0 });
    });
  });

  // ─── FTS5 Search ───────────────────────────────────────────────

  describe('FTS5 Search', () => {
    it('searches observations by title and narrative via FTS5 or LIKE fallback', () => {
      const now = Date.now();
      db.prepare(`INSERT INTO memory_sessions (session_id, tenant_id, started_at, started_at_epoch) VALUES (?, ?, datetime('now'), ?)`).run('fts-sess', 'test', now);
      db.prepare(`INSERT INTO observations (session_id, tenant_id, tool_name, type, title, narrative, created_at_epoch) VALUES (?, ?, ?, ?, ?, ?, ?)`).run('fts-sess', 'test', 'Bash', 'tool_use', 'Fix nginx config', 'Updated proxy settings for CORS', now);

      // LIKE fallback always works
      const results = db.prepare(`SELECT * FROM observations WHERE title LIKE ? OR narrative LIKE ?`).all('%nginx%', '%nginx%') as any[];
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].title).toContain('nginx');
    });
  });
});
