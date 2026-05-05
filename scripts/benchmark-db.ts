/**
 * benchmark-db.ts — before/after micro-benchmark for the CRM SQLite tuning.
 *
 * Same workload, two flavors:
 *   BASELINE — vanilla pragmas (only journal_mode=WAL + foreign_keys=ON,
 *              what we'd have without Comando 17's tuning).
 *              Each iteration calls db.prepare() fresh (no cache).
 *
 *   TUNED    — Comando 17's full pragma set (cache_size=-64000,
 *              temp_store=MEMORY, mmap_size=256MB) + preparedCache.
 *
 * Workload: 10,000 reads + 1,000 writes against a freshly-migrated DB.
 *   - reads: SELECT * FROM crm_cards WHERE id = ? AND tenant_id = ?
 *   - writes: INSERT new contact, then UPDATE its last_interaction_at
 *
 * Each phase is timed end-to-end; we report ops/sec and the ratio.
 *
 * Run:  tsx scripts/benchmark-db.ts
 */
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { applyMigrations } from '../src/crm/migrator.js';
import { prep, clearPreparedCache } from '../src/crm/store/preparedCache.js';

const READS = 10_000;
const WRITES = 1_000;

interface PhaseResult {
  label: string;
  reads: { totalMs: number; opsPerSec: number };
  writes: { totalMs: number; opsPerSec: number };
}

function nid(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function seedFixtures(db: Database.Database): { tenantId: string; cardIds: string[] } {
  const tenantId = 'bench-tenant';
  const boardId = nid('crm_board');
  const colId = nid('crm_col');
  const now = Date.now();
  db.prepare(`INSERT INTO crm_boards (id, tenant_id, name, type, position, created_at, updated_at) VALUES (?, ?, ?, 'sales', 0, ?, ?)`).run(boardId, tenantId, 'Bench', now, now);
  db.prepare(`INSERT INTO crm_columns (id, board_id, name, position, created_at) VALUES (?, ?, ?, 0, ?)`).run(colId, boardId, 'Bench Col', now);

  const cardIds: string[] = [];
  const insertCard = db.prepare(`
    INSERT INTO crm_cards (id, tenant_id, board_id, column_id, title, position, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction((n: number) => {
    for (let i = 0; i < n; i++) {
      const id = nid('crm_card');
      insertCard.run(id, tenantId, boardId, colId, `Card ${i}`, i, now, now);
      cardIds.push(id);
    }
  });
  tx(500); // 500 cards available for the read workload

  return { tenantId, cardIds };
}

function tunePragmas(db: Database.Database, tuned: boolean): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  if (tuned) {
    db.pragma('synchronous = NORMAL');
    db.pragma('cache_size = -64000');
    db.pragma('temp_store = MEMORY');
    db.pragma('mmap_size = 268435456');
  } else {
    // BASELINE: leave synchronous at FULL (default), small page cache,
    // no mmap, no temp store override. This is roughly what the code
    // would do before Comando 17.
    db.pragma('synchronous = FULL');
  }
}

function runReads(
  db: Database.Database,
  tenantId: string,
  cardIds: string[],
  useCache: boolean,
): PhaseResult['reads'] {
  const SQL = 'SELECT * FROM crm_cards WHERE id = ? AND tenant_id = ?';
  // For BASELINE: re-prepare every iteration (mimics the worst case).
  // For TUNED: prep() returns the cached compiled statement.
  const start = process.hrtime.bigint();
  for (let i = 0; i < READS; i++) {
    const id = cardIds[i % cardIds.length]!;
    if (useCache) {
      prep(db, SQL).get(id, tenantId);
    } else {
      db.prepare(SQL).get(id, tenantId);
    }
  }
  const totalMs = Number(process.hrtime.bigint() - start) / 1e6;
  return { totalMs, opsPerSec: (READS / totalMs) * 1000 };
}

function runWrites(
  db: Database.Database,
  tenantId: string,
  useCache: boolean,
): PhaseResult['writes'] {
  const INSERT_SQL = `INSERT INTO crm_contacts (id, tenant_id, name, phone, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`;
  const UPDATE_SQL = `UPDATE crm_contacts SET last_interaction_at = ?, updated_at = ? WHERE id = ?`;
  const now = Date.now();
  const start = process.hrtime.bigint();
  for (let i = 0; i < WRITES; i++) {
    const id = nid('crm_contact');
    if (useCache) {
      prep(db, INSERT_SQL).run(id, tenantId, `Bench ${i}`, `+5511955${i.toString().padStart(6, '0')}`, now, now);
      prep(db, UPDATE_SQL).run(now + i, now + i, id);
    } else {
      db.prepare(INSERT_SQL).run(id, tenantId, `Bench ${i}`, `+5511955${i.toString().padStart(6, '0')}`, now, now);
      db.prepare(UPDATE_SQL).run(now + i, now + i, id);
    }
  }
  const totalMs = Number(process.hrtime.bigint() - start) / 1e6;
  return { totalMs, opsPerSec: (WRITES / totalMs) * 1000 };
}

function bench(label: string, tuned: boolean): PhaseResult {
  const tmp = mkdtempSync(join(tmpdir(), `clow-bench-${tuned ? 'tuned' : 'base'}-`));
  const dbPath = join(tmp, 'crm.sqlite3');
  const db = new Database(dbPath);
  tunePragmas(db, tuned);
  applyMigrations(db);
  const { tenantId, cardIds } = seedFixtures(db);

  // Warm-up — page cache, file system cache, JIT warmup.
  for (let i = 0; i < 100; i++) {
    db.prepare('SELECT * FROM crm_cards WHERE id = ? AND tenant_id = ?').get(cardIds[i]!, tenantId);
  }
  if (tuned) clearPreparedCache(); // make sure cache starts empty for fair measurement

  const reads = runReads(db, tenantId, cardIds, tuned);
  const writes = runWrites(db, tenantId, tuned);

  if (tuned) clearPreparedCache();
  db.close();
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* fine */ }

  return { label, reads, writes };
}

function fmt(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function main(): void {
  console.log(`[benchmark] CRM SQLite — ${READS.toLocaleString()} reads + ${WRITES.toLocaleString()} writes per phase\n`);

  console.log('[benchmark] running BASELINE (vanilla pragmas, no prepared cache)...');
  const base = bench('BASELINE', false);
  console.log(`[benchmark]   reads:  ${fmt(base.reads.opsPerSec)} ops/sec  (${base.reads.totalMs.toFixed(0)}ms)`);
  console.log(`[benchmark]   writes: ${fmt(base.writes.opsPerSec)} ops/sec  (${base.writes.totalMs.toFixed(0)}ms)\n`);

  console.log('[benchmark] running TUNED (Comando 17 pragmas + preparedCache)...');
  const tuned = bench('TUNED', true);
  console.log(`[benchmark]   reads:  ${fmt(tuned.reads.opsPerSec)} ops/sec  (${tuned.reads.totalMs.toFixed(0)}ms)`);
  console.log(`[benchmark]   writes: ${fmt(tuned.writes.opsPerSec)} ops/sec  (${tuned.writes.totalMs.toFixed(0)}ms)\n`);

  const readSpeedup = tuned.reads.opsPerSec / base.reads.opsPerSec;
  const writeSpeedup = tuned.writes.opsPerSec / base.writes.opsPerSec;
  console.log('[benchmark] ─────────────── SPEEDUP ───────────────');
  console.log(`[benchmark]   reads:  ${readSpeedup.toFixed(2)}× faster (${fmt(tuned.reads.opsPerSec - base.reads.opsPerSec)} extra ops/sec)`);
  console.log(`[benchmark]   writes: ${writeSpeedup.toFixed(2)}× faster (${fmt(tuned.writes.opsPerSec - base.writes.opsPerSec)} extra ops/sec)`);

  // Persist a JSON sidecar so docs/db-tuning.md can be regenerated with
  // fresh numbers later without re-eyeballing.
  const out = {
    timestamp: new Date().toISOString(),
    reads_per_phase: READS,
    writes_per_phase: WRITES,
    baseline: base,
    tuned,
    speedup: { reads: readSpeedup, writes: writeSpeedup },
  };
  mkdirSync('docs', { recursive: true });
  writeFileSync('docs/db-bench-results.json', JSON.stringify(out, null, 2));
  console.log('\n[benchmark] results → docs/db-bench-results.json');
}

main();
