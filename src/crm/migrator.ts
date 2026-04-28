/**
 * CRM migration runner — synchronous, idempotent, transaction-wrapped.
 *
 * Conventions:
 *   • Each migration lives in src/crm/migrations/NNN_<slug>.ts and exports
 *     `{ version: number, description?: string, up(db), down(db) }`.
 *   • `version` is a positive integer; ascending. No two migrations share
 *     a version (the runner fails fast if they do).
 *   • Adding a new migration: create the file AND register it in the
 *     ALL_MIGRATIONS array below. Static registration keeps boot-time
 *     migration runs synchronous (no dynamic ESM import).
 *   • `up()` MUST be idempotent on tables it owns — production runs over
 *     existing schema where applicable. Use CREATE … IF NOT EXISTS, ALTER
 *     TABLE ADD COLUMN guarded with a column-exists check, etc.
 *   • `down()` is invoked by `db:rollback` and the test suite.
 *
 * State table: `schema_migrations(version PK, applied_at)`. Created on
 * first run.
 *
 * Legacy bridge: the previous monolithic schema bootstrap maintained a
 * `crm_migrations` table whose row count > 0 implies the prod schema is
 * already at the state of 001's up(). When we see that, we mark version 1
 * as applied without re-running it, so a 1163-line CREATE block doesn't
 * execute against a fully-migrated DB on every server start.
 */
import type { Database } from 'better-sqlite3';

import * as m001 from './migrations/001_initial_schema.js';
import * as m002 from './migrations/002_subscriptions_last_paid_at.js';
import * as m003 from './migrations/003_channel_ai_agent.js';

export interface Migration {
  version: number;
  description?: string;
  up(db: Database): void;
  down(db: Database): void;
}

const ALL_MIGRATIONS: Migration[] = [m001, m002, m003];

// ─── Validation (runs once at module load) ────────────────────────────────

(function validateRegistry(): void {
  const sorted = [...ALL_MIGRATIONS].sort((a, b) => a.version - b.version);
  for (let i = 0; i < sorted.length; i++) {
    const m = sorted[i]!;
    if (typeof m.version !== 'number' || m.version <= 0 || !Number.isInteger(m.version)) {
      throw new Error(`migrator: invalid version on migration #${i}: ${m.version}`);
    }
    if (i > 0 && sorted[i - 1]!.version === m.version) {
      throw new Error(`migrator: duplicate version ${m.version}`);
    }
    if (typeof m.up !== 'function' || typeof m.down !== 'function') {
      throw new Error(`migrator: migration ${m.version} missing up/down`);
    }
  }
})();

// ─── Helpers ──────────────────────────────────────────────────────────────

function ensureSchemaMigrationsTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);
}

function legacyMigrationsApplied(db: Database): boolean {
  const t = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='crm_migrations'`)
    .get() as { name?: string } | undefined;
  if (!t?.name) return false;
  const c = db.prepare('SELECT COUNT(*) AS c FROM crm_migrations').get() as { c: number };
  return c.c > 0;
}

function bridgeLegacyMigrationState(db: Database): void {
  if (!legacyMigrationsApplied(db)) return;
  db.prepare(
    'INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (1, ?)',
  ).run(Date.now());
}

function sortedMigrations(): Migration[] {
  return [...ALL_MIGRATIONS].sort((a, b) => a.version - b.version);
}

// ─── Public API ───────────────────────────────────────────────────────────

export function loadMigrations(): Migration[] {
  return sortedMigrations();
}

export function getAppliedVersions(db: Database): Set<number> {
  ensureSchemaMigrationsTable(db);
  const rows = db.prepare('SELECT version FROM schema_migrations').all() as Array<{
    version: number;
  }>;
  return new Set(rows.map((r) => r.version));
}

export interface ApplyResult {
  applied: Array<{ version: number; description?: string; durationMs: number }>;
  skipped: number[];
}

export function applyMigrations(
  db: Database,
  opts: { logger?: (msg: string) => void } = {},
): ApplyResult {
  const log = opts.logger ?? (() => undefined);
  ensureSchemaMigrationsTable(db);
  bridgeLegacyMigrationState(db);

  const applied = getAppliedVersions(db);
  const result: ApplyResult = { applied: [], skipped: [] };

  for (const m of sortedMigrations()) {
    if (applied.has(m.version)) {
      result.skipped.push(m.version);
      continue;
    }
    const t0 = Date.now();
    const txn = db.transaction(() => {
      m.up(db);
      db.prepare(
        'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
      ).run(m.version, Date.now());
    });
    txn();
    const durationMs = Date.now() - t0;
    log(`[migrator] ✓ applied ${m.version} ${m.description ?? ''} (${durationMs}ms)`);
    result.applied.push({ version: m.version, description: m.description, durationMs });
  }

  if (result.applied.length === 0 && result.skipped.length > 0) {
    log(`[migrator] up to date — ${result.skipped.length} migration(s) already applied`);
  }
  return result;
}

/**
 * Roll back the most-recently-applied migration. Returns the version that
 * was reverted, or null if nothing was applied. Runs `down()` and the
 * DELETE in a single transaction so the DB stays consistent on failure.
 */
export function rollbackLast(
  db: Database,
  opts: { logger?: (msg: string) => void } = {},
): number | null {
  const log = opts.logger ?? (() => undefined);
  ensureSchemaMigrationsTable(db);

  const last = db
    .prepare('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1')
    .get() as { version: number } | undefined;
  if (!last) {
    log('[migrator] nothing to rollback');
    return null;
  }

  const m = sortedMigrations().find((x) => x.version === last.version);
  if (!m) {
    throw new Error(
      `cannot rollback version ${last.version} — no migration registered with that version. ` +
        `Did you delete a migration file without rolling it back first?`,
    );
  }

  // FK enforcement makes DROP TABLE on a parent fire CASCADE deletes on
  // child rows; if down() drops tables in arbitrary order, those cascades
  // can hit a child that was already dropped. PRAGMA foreign_keys can only
  // be toggled outside of an open transaction, so we toggle here and
  // restore on the way out.
  const fkRows = db.pragma('foreign_keys') as Array<{ foreign_keys: number }>;
  const fkWasOn = fkRows[0]?.foreign_keys === 1;
  if (fkWasOn) db.pragma('foreign_keys = OFF');

  const t0 = Date.now();
  try {
    const txn = db.transaction(() => {
      m.down(db);
      db.prepare('DELETE FROM schema_migrations WHERE version = ?').run(m.version);
    });
    txn();
  } finally {
    if (fkWasOn) db.pragma('foreign_keys = ON');
  }
  log(`[migrator] ✓ rolled back ${m.version} ${m.description ?? ''} (${Date.now() - t0}ms)`);
  return m.version;
}

/**
 * Read-only view of every known migration with its applied state. Used
 * by the CLI tools and the test suite.
 */
export function status(
  db: Database,
): Array<{ version: number; description?: string; applied: boolean; appliedAt?: number }> {
  ensureSchemaMigrationsTable(db);
  const rows = db
    .prepare('SELECT version, applied_at FROM schema_migrations')
    .all() as Array<{ version: number; applied_at: number }>;
  const appliedByVersion = new Map(rows.map((r) => [r.version, r.applied_at]));
  return sortedMigrations().map((m) => ({
    version: m.version,
    description: m.description,
    applied: appliedByVersion.has(m.version),
    appliedAt: appliedByVersion.get(m.version),
  }));
}
