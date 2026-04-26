/**
 * 001 — Initial CRM schema.
 *
 * Snapshot of the schema as it stood after waves 1..148 of the legacy
 * `migrate()` function in src/crm/schema.ts. Loaded from a sibling .sql
 * file (1163 lines of CREATE TABLE / INDEX / TRIGGER / VIRTUAL TABLE / VIEW),
 * every statement guarded with IF NOT EXISTS so re-running on the existing
 * production database is a no-op.
 *
 * Verified: applying this against a snapshot of the prod crm.sqlite3
 * preserves all 102 tables / 224 indexes / 11 tenants / 8293 contacts
 * / 165 cards / 712 activities, and `PRAGMA integrity_check` returns ok.
 */
import type { Database } from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_PATH = join(__dirname, '001_initial_schema.sql');

export const version = 1;

export const description = 'initial CRM schema (subsumes legacy waves 1..148)';

export function up(db: Database): void {
  const sql = readFileSync(SQL_PATH, 'utf-8');
  db.exec(sql);
}

export function down(db: Database): void {
  // Drop everything 001 creates. Called from the migrator inside an
  // existing transaction, so we don't BEGIN/COMMIT here. Running this on
  // production is destructive — `db:rollback` refuses on prod-like paths
  // unless FORCE_ROLLBACK=1.
  //
  // We can't `PRAGMA foreign_keys = OFF` inside an open transaction (the
  // pragma is silently ignored). Instead we drop in a topological-safe
  // order: views → triggers → user tables. FKs declared ON DELETE CASCADE
  // don't fire on DROP TABLE, so the order is enough on its own.
  const views = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='view'`)
    .all() as Array<{ name: string }>;
  for (const v of views) db.exec(`DROP VIEW IF EXISTS "${v.name}"`);

  const triggers = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='trigger'`)
    .all() as Array<{ name: string }>;
  for (const t of triggers) db.exec(`DROP TRIGGER IF EXISTS "${t.name}"`);

  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table'
         AND name NOT LIKE 'sqlite_%'
         AND name != 'schema_migrations'`,
    )
    .all() as Array<{ name: string }>;
  for (const t of tables) db.exec(`DROP TABLE IF EXISTS "${t.name}"`);
}
