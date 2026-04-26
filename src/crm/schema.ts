/**
 * CRM database handle.
 *
 * Single-DB design (one file for all tenants). Every entity row carries
 * `tenant_id`. All queries MUST filter by tenant_id — enforced by the
 * store layer; routes never see the raw DB.
 *
 * Storage: ~/.clow/crm.sqlite3 — kept separate from memory.sqlite3 so CRM
 * growth doesn't bloat AI memory and vice-versa.
 *
 * Schema is owned by the migrator (src/crm/migrator.ts + src/crm/migrations/*).
 * Use `npm run db:migrate` to apply migrations to the configured DB; this
 * module's getCrmDb() runs them automatically the first time the connection
 * is opened so the server keeps working without manual setup.
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { applyMigrations } from './migrator.js';

let _db: Database.Database | null = null;

function getDbPath(): string {
  // Explicit override (used by tests for isolation)
  if (process.env.CRM_DB_PATH) return process.env.CRM_DB_PATH;
  const home = process.env.CLOW_HOME || path.join(os.homedir(), '.clow');
  if (!fs.existsSync(home)) fs.mkdirSync(home, { recursive: true });
  return path.join(home, 'crm.sqlite3');
}

export function getCrmDb(): Database.Database {
  if (_db) return _db;
  const p = getDbPath();
  _db = new Database(p);
  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous = NORMAL');
  _db.pragma('foreign_keys = ON');
  _db.pragma('busy_timeout = 5000');

  // Apply migrations on first open — synchronous, idempotent, fast on a
  // fully-migrated DB (just an INSERT-existence check per migration).
  applyMigrations(_db, {
    logger: (msg) => {
      if (process.env.CLOW_MIGRATION_LOG !== '0') console.log(msg);
    },
  });

  return _db;
}

export function closeCrmDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
