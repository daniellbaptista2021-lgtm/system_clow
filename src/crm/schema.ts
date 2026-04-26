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
import { logger } from '../utils/logger.js';

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

  // ─── Performance tuning ────────────────────────────────────────────
  // Documented in docs/db-tuning.md. Each PM2 cluster worker opens its
  // OWN connection (better-sqlite3 is per-process); WAL mode allows
  // concurrent readers across processes without blocking writers.
  _db.pragma('journal_mode = WAL');
  // synchronous=NORMAL trades a fsync per transaction for ~order-of-
  // magnitude write throughput. Recovery still works (WAL guarantees
  // durability of committed transactions on crash); only the very last
  // not-yet-checkpointed transaction can be lost on power-cut.
  _db.pragma('synchronous = NORMAL');
  _db.pragma('foreign_keys = ON');
  // 5s wait for the busy lock; if cluster contention on the writer
  // ever exceeds this we'll see SQLITE_BUSY at the call site and can
  // tune up.
  _db.pragma('busy_timeout = 5000');
  // 64MB page cache (negative = KB). Default is ~2MB which is way too
  // small once the DB passes 100MB. With 64MB and our biggest table
  // ~30MB we keep almost the whole working set hot.
  _db.pragma('cache_size = -64000');
  // Temp tables (subqueries, GROUP BY scratch, FTS rebuild) live in
  // RAM instead of disk — material speedup for analytics queries that
  // GROUP BY tenant_id across crm_activities / crm_cards.
  _db.pragma('temp_store = MEMORY');
  // 256MB memory map. Reads under the mmap window are zero-copy from
  // the OS page cache — major boost for read-heavy workloads (board
  // listings, contact searches). Writes still go through the journal.
  _db.pragma('mmap_size = 268435456');

  // Apply migrations on first open — synchronous, idempotent, fast on a
  // fully-migrated DB (just an INSERT-existence check per migration).
  applyMigrations(_db, {
    logger: (msg) => {
      if (process.env.CLOW_MIGRATION_LOG !== '0') logger.info(msg);
    },
  });

  return _db;
}

export function closeCrmDb(): void {
  if (_db) {
    // Drop the prepared-statement cache first — the Statement objects
    // hold references to the db and would survive past close otherwise,
    // breaking the next reopen (test isolation, schema reset).
    void import('./store/preparedCache.js').then(({ clearPreparedCache }) => clearPreparedCache());
    _db.close();
    _db = null;
  }
}
