/**
 * Connection / DB introspection — Onda 32.
 *
 * better-sqlite3 is single-threaded + file-backed, so "connection pooling"
 * doesn't apply the same way as pg/mysql. But we can:
 *   - WAL mode enabled (concurrent readers + 1 writer)
 *   - Prepared statement cache (automatic in better-sqlite3)
 *   - Pragmas tuning
 *   - Expose query plan explanations for debugging
 */

import { getCrmDb } from './schema.js';

export function applyPerformancePragmas(): void {
  const db = getCrmDb();
  // WAL: concurrent reads + serialized writes (30-70% faster for typical workload)
  db.pragma('journal_mode = WAL');
  // Reduce fsync frequency — still safe with WAL
  db.pragma('synchronous = NORMAL');
  // 64MB page cache
  db.pragma('cache_size = -64000');
  // Memory-mapped I/O for 256MB
  db.pragma('mmap_size = 268435456');
  // Delay checkpointing (WAL) — performed on demand
  db.pragma('wal_autocheckpoint = 1000');
  // Temp store in RAM
  db.pragma('temp_store = MEMORY');
}

export function dbInfo(): any {
  const db = getCrmDb();
  return {
    journal_mode: db.pragma('journal_mode', { simple: true }),
    synchronous: db.pragma('synchronous', { simple: true }),
    cache_size: db.pragma('cache_size', { simple: true }),
    page_size: db.pragma('page_size', { simple: true }),
    page_count: db.pragma('page_count', { simple: true }),
    auto_vacuum: db.pragma('auto_vacuum', { simple: true }),
    wal_autocheckpoint: db.pragma('wal_autocheckpoint', { simple: true }),
    mmap_size: db.pragma('mmap_size', { simple: true }),
    db_size_bytes: Number(db.pragma('page_size', { simple: true })) * Number(db.pragma('page_count', { simple: true })),
  };
}

export function explain(sql: string, params: any[] = []): any[] {
  const db = getCrmDb();
  return db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...params) as any[];
}

export function tableStats(): any[] {
  const db = getCrmDb();
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'crm_%' ORDER BY name"
  ).all() as any[];
  return tables.map((t: any) => {
    const count = (db.prepare(`SELECT COUNT(*) n FROM ${t.name}`).get() as any).n;
    return { table: t.name, rowCount: count };
  });
}

/** VACUUM — reclaim space, defragment. Blocking operation — use sparingly. */
export function vacuum(): { sizeBefore: number; sizeAfter: number; durationMs: number } {
  const db = getCrmDb();
  const before = Number(db.pragma('page_size', { simple: true })) * Number(db.pragma('page_count', { simple: true }));
  const t0 = Date.now();
  db.exec('VACUUM');
  const after = Number(db.pragma('page_size', { simple: true })) * Number(db.pragma('page_count', { simple: true }));
  return { sizeBefore: before, sizeAfter: after, durationMs: Date.now() - t0 };
}
