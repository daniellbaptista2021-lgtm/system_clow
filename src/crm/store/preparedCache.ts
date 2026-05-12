/**
 * preparedCache.ts — module-scoped cache of compiled SQLite Statements.
 *
 * better-sqlite3's `db.prepare(sql)` parses + compiles the SQL on every
 * call. For the hot path (every CRM read/write hits prepare()), reusing
 * compiled statements is a 2-5× speedup at zero correctness cost — the
 * bytecode is bound to the exact SQL string + the exact db connection.
 *
 * Cache key: SQL string. Cache value: compiled Statement.
 *
 * Invalidation: bound to the db connection identity. When the
 * underlying db is closed and reopened (test isolation, schema reset),
 * `prep()` notices a different `db` instance and rebuilds the cache.
 *
 * NOT THREAD-SAFE: better-sqlite3 is synchronous Node-only; one
 * worker = one cache. PM2 cluster mode = one cache per worker, which
 * is the design (each worker has its own db connection too).
 */
import type Database from 'better-sqlite3';

interface CachedStatement {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  stmt: Database.Statement<any>;
  db: Database.Database;
}

const cache = new Map<string, CachedStatement>();

/**
 * Return a compiled Statement for `sql`, prepared once and reused
 * forever (until the db is reopened).
 *
 *   const row = prep(db, 'SELECT * FROM crm_cards WHERE id = ? AND tenant_id = ?').get(cardId, tenantId);
 *
 * Pass-through usage means callers don't need to be cache-aware. The
 * Statement they get back is the same instance until invalidation.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function prep<T = unknown>(db: Database.Database, sql: string): Database.Statement<T extends any[] ? T : [T]> {
  const cached = cache.get(sql);
  if (cached && cached.db === db) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return cached.stmt as any;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stmt = db.prepare(sql) as any;
  cache.set(sql, { stmt, db });
  return stmt;
}

/** Cache size, useful for tests / metrics. */
export function preparedCacheSize(): number {
  return cache.size;
}

/** Drop everything — use after closing the db connection. */
export function clearPreparedCache(): void {
  cache.clear();
}
