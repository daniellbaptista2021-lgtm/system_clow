/**
 * Migration runner — integration tests.
 *
 * Covers:
 *   - Fresh-DB migrate creates schema_migrations + applies every registered
 *     migration in order; counts and contents are right.
 *   - Re-running migrate is a no-op (everything already applied).
 *   - rollbackLast() reverts the most recent migration and removes its
 *     row from schema_migrations.
 *   - After a rollback, the very next applyMigrations() reapplies that
 *     migration cleanly.
 *   - Legacy bridge: when a fresh DB has the old `crm_migrations` table
 *     populated (the prod state before this refactor), the migrator
 *     auto-marks v1 as applied and 001's up() is NOT re-executed.
 *   - The registered set has unique versions and 001 covers the prod
 *     schema (canary tables present after up()).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyMigrations,
  rollbackLast,
  status,
  loadMigrations,
  getAppliedVersions,
} from '../../src/crm/migrator.js';

function freshDb(): { db: Database.Database; path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'clow-mig-'));
  const path = join(dir, 'crm.sqlite3');
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return {
    db,
    path,
    cleanup: () => {
      try { db.close(); } catch { /* already closed */ }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`)
    .get(name);
  return row !== undefined;
}

describe('migrator — fresh DB', () => {
  let env: ReturnType<typeof freshDb>;
  beforeEach(() => { env = freshDb(); });
  afterEach(() => env.cleanup());

  it('applies every registered migration on first run', () => {
    const r = applyMigrations(env.db);
    const all = loadMigrations();
    expect(r.applied.length).toBe(all.length);
    expect(r.skipped.length).toBe(0);
    // schema_migrations exists with one row per migration
    const versions = getAppliedVersions(env.db);
    expect(versions.size).toBe(all.length);
    for (const m of all) expect(versions.has(m.version)).toBe(true);
  });

  it('001 creates the prod schema (canary tables present)', () => {
    applyMigrations(env.db);
    // Tables we know exist in prod that 001 must create
    for (const t of ['crm_contacts', 'crm_cards', 'crm_activities', 'crm_channels', 'crm_boards']) {
      expect(tableExists(env.db, t), `missing ${t}`).toBe(true);
    }
    // FTS5 virtual tables come along too
    expect(tableExists(env.db, 'crm_fts_cards')).toBe(true);
  });

  it('re-running applyMigrations is a no-op (idempotent)', () => {
    applyMigrations(env.db);
    const r2 = applyMigrations(env.db);
    expect(r2.applied.length).toBe(0);
    expect(r2.skipped.length).toBe(loadMigrations().length);
  });

  it('status() reports correct applied/pending state', () => {
    const before = status(env.db);
    expect(before.every((s) => s.applied === false)).toBe(true);
    applyMigrations(env.db);
    const after = status(env.db);
    expect(after.every((s) => s.applied === true)).toBe(true);
    for (const s of after) expect(s.appliedAt).toBeGreaterThan(0);
  });
});

describe('migrator — rollback round trip', () => {
  let env: ReturnType<typeof freshDb>;
  beforeEach(() => { env = freshDb(); });
  afterEach(() => env.cleanup());

  it('rollbackLast reverts the latest applied migration and reapply restores it', () => {
    applyMigrations(env.db);
    const all = loadMigrations();
    const lastVersion = all[all.length - 1]!.version;

    expect(getAppliedVersions(env.db).has(lastVersion)).toBe(true);

    const rolledBack = rollbackLast(env.db);
    expect(rolledBack).toBe(lastVersion);
    expect(getAppliedVersions(env.db).has(lastVersion)).toBe(false);

    // Re-apply: the migration we just rolled back gets re-installed.
    const r = applyMigrations(env.db);
    expect(r.applied.map((a) => a.version)).toContain(lastVersion);
    expect(getAppliedVersions(env.db).has(lastVersion)).toBe(true);

    // After round-trip the canary tables exist again.
    expect(tableExists(env.db, 'crm_contacts')).toBe(true);
  });

  it('rollbackLast on an empty DB returns null', () => {
    expect(rollbackLast(env.db)).toBeNull();
  });
});

describe('migrator — legacy bridge', () => {
  let env: ReturnType<typeof freshDb>;
  beforeEach(() => { env = freshDb(); });
  afterEach(() => env.cleanup());

  it('marks v1 applied without re-running up() when crm_migrations has rows', () => {
    // Simulate the legacy state: old table exists with rows, but the
    // 001-managed CRM tables don't yet (so we can detect whether up() ran).
    env.db.exec(`
      CREATE TABLE crm_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
      INSERT INTO crm_migrations VALUES (1, ${Date.now()}), (101, ${Date.now()});
    `);
    expect(tableExists(env.db, 'crm_contacts')).toBe(false);

    const r = applyMigrations(env.db);
    // v1 is bridged-as-applied, so it appears in skipped, not applied.
    expect(r.applied.find((a) => a.version === 1)).toBeUndefined();
    expect(r.skipped).toContain(1);

    // And up() did NOT run, so the table is still absent.
    expect(tableExists(env.db, 'crm_contacts')).toBe(false);
  });

  it('on a clean DB (no legacy table) v1 runs normally', () => {
    expect(
      env.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='crm_migrations'`).get(),
    ).toBeUndefined();
    const r = applyMigrations(env.db);
    expect(r.applied.find((a) => a.version === 1)).toBeDefined();
    expect(tableExists(env.db, 'crm_contacts')).toBe(true);
  });
});

describe('migrator — registry sanity', () => {
  it('all registered migrations have unique, ascending versions', () => {
    const all = loadMigrations();
    const versions = all.map((m) => m.version);
    expect(new Set(versions).size).toBe(versions.length);
    const sorted = [...versions].sort((a, b) => a - b);
    expect(versions).toEqual(sorted);
  });

  it('001_initial_schema.sql is shipped alongside the JS', () => {
    // When this test runs from src/ via vitest, the .sql file must be
    // discoverable next to the .ts module.
    const sqlPath = join(
      __dirname,
      '..',
      '..',
      'src',
      'crm',
      'migrations',
      '001_initial_schema.sql',
    );
    expect(existsSync(sqlPath)).toBe(true);
  });
});
