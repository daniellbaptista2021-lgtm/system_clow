/**
 * MemorySchema.ts — SQLite schema and migrations for persistent memory
 *
 * 3 tables: memory_sessions, observations, session_summaries
 * 2 FTS5 virtual tables for full-text search
 * Version-based up-only migrations
 */

import type Database from 'better-sqlite3';

// ════════════════════════════════════════════════════════════════════════════
// Migration Definitions
// ════════════════════════════════════════════════════════════════════════════

interface Migration {
  version: number;
  description: string;
  up: string[];
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'Initial schema: sessions, observations, summaries',
    up: [
      // Schema version tracking
      `CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,

      // Core session tracking
      `CREATE TABLE IF NOT EXISTS memory_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT UNIQUE NOT NULL,
        tenant_id TEXT NOT NULL DEFAULT 'default',
        cwd TEXT,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        started_at_epoch INTEGER NOT NULL,
        ended_at TEXT,
        ended_at_epoch INTEGER,
        status TEXT NOT NULL DEFAULT 'active'
      )`,
      `CREATE INDEX IF NOT EXISTS idx_ms_tenant ON memory_sessions(tenant_id)`,
      `CREATE INDEX IF NOT EXISTS idx_ms_tenant_time ON memory_sessions(tenant_id, started_at_epoch DESC)`,

      // Tool use observations
      `CREATE TABLE IF NOT EXISTS observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL DEFAULT 'default',
        tool_name TEXT,
        type TEXT NOT NULL DEFAULT 'tool_use',
        title TEXT,
        narrative TEXT,
        files_touched TEXT,
        content_hash TEXT,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES memory_sessions(session_id) ON DELETE CASCADE
      )`,
      `CREATE INDEX IF NOT EXISTS idx_obs_session ON observations(session_id)`,
      `CREATE INDEX IF NOT EXISTS idx_obs_tenant ON observations(tenant_id)`,
      `CREATE INDEX IF NOT EXISTS idx_obs_tenant_time ON observations(tenant_id, created_at_epoch DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_obs_hash ON observations(content_hash)`,

      // Session summaries (one per session)
      `CREATE TABLE IF NOT EXISTS session_summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT UNIQUE NOT NULL,
        tenant_id TEXT NOT NULL DEFAULT 'default',
        request TEXT,
        investigated TEXT,
        learned TEXT,
        completed TEXT,
        next_steps TEXT,
        files_touched TEXT,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES memory_sessions(session_id) ON DELETE CASCADE
      )`,
      `CREATE INDEX IF NOT EXISTS idx_sum_tenant ON session_summaries(tenant_id)`,
      `CREATE INDEX IF NOT EXISTS idx_sum_tenant_time ON session_summaries(tenant_id, created_at_epoch DESC)`,
    ],
  },
  {
    version: 2,
    description: 'FTS5 full-text search indexes',
    up: [
      // FTS5 for observations
      `CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
        title, narrative, tool_name,
        content=observations, content_rowid=id
      )`,
      // Sync trigger for observations
      `CREATE TRIGGER IF NOT EXISTS obs_fts_insert AFTER INSERT ON observations BEGIN
        INSERT INTO observations_fts(rowid, title, narrative, tool_name)
        VALUES (NEW.id, NEW.title, NEW.narrative, NEW.tool_name);
      END`,

      // FTS5 for summaries
      `CREATE VIRTUAL TABLE IF NOT EXISTS summaries_fts USING fts5(
        request, investigated, learned, completed,
        content=session_summaries, content_rowid=id
      )`,
      // Sync trigger for summaries
      `CREATE TRIGGER IF NOT EXISTS sum_fts_insert AFTER INSERT ON session_summaries BEGIN
        INSERT INTO summaries_fts(rowid, request, investigated, learned, completed)
        VALUES (NEW.id, NEW.request, NEW.investigated, NEW.learned, NEW.completed);
      END`,
    ],
  },
];

// ════════════════════════════════════════════════════════════════════════════
// Migration Runner
// ════════════════════════════════════════════════════════════════════════════

export function runMigrations(db: Database.Database): void {
  // Ensure schema_version table exists
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  const currentVersion = getCurrentVersion(db);

  for (const migration of MIGRATIONS) {
    if (migration.version <= currentVersion) continue;

    const applyMigration = db.transaction(() => {
      for (const sql of migration.up) {
        try {
          db.exec(sql);
        } catch (err) {
          // FTS5 might not be available — skip silently
          if (String(err).includes('fts5') || String(err).includes('virtual table')) {
            console.warn(`[Memory] FTS5 not available, skipping: ${migration.description}`);
            return;
          }
          throw err;
        }
      }
      db.prepare('INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (?, datetime(\'now\'))').run(migration.version);
    });

    applyMigration();
  }
}

function getCurrentVersion(db: Database.Database): number {
  try {
    const row = db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number | null } | undefined;
    return row?.v ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Check if FTS5 is available.
 */
export function hasFts5(db: Database.Database): boolean {
  try {
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS _fts5_test USING fts5(x)");
    db.exec("DROP TABLE IF EXISTS _fts5_test");
    return true;
  } catch {
    return false;
  }
}
