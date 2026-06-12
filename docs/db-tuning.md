# SQLite tuning — System Clow

This document records the database-tuning decisions in [src/crm/schema.ts](../src/crm/schema.ts) and [src/crm/store/preparedCache.ts](../src/crm/store/preparedCache.ts), plus the measured impact of each.

Numbers below come from [scripts/benchmark-db.ts](../scripts/benchmark-db.ts) — run `npx tsx scripts/benchmark-db.ts` to refresh them on a different machine. The latest run output lives at [docs/db-bench-results.json](db-bench-results.json).

## Pragmas applied on every connection open

```ts
db.pragma('journal_mode = WAL');           // multi-reader / single-writer concurrency
db.pragma('synchronous = NORMAL');         // 1 fsync per checkpoint, not per txn
db.pragma('foreign_keys = ON');            // enforce CRM relationship integrity
db.pragma('busy_timeout = 5000');          // 5s wait before SQLITE_BUSY
db.pragma('cache_size = -64000');          // 64MB page cache
db.pragma('temp_store = MEMORY');          // temp tables in RAM
db.pragma('mmap_size = 268435456');        // 256MB memory-mapped reads
```

### Why each one

| Pragma | Rationale |
|---|---|
| `journal_mode = WAL` | Allows concurrent readers while a writer holds the lock — critical when a PM2 cluster worker is mid-INSERT and another worker wants to SELECT for the dashboard. Recovery on crash uses the WAL file. |
| `synchronous = NORMAL` | Default `FULL` issues an `fsync()` on every transaction commit, killing write throughput. `NORMAL` only fsyncs at checkpoint time. The window of vulnerability is "the last commit that hadn't checkpointed yet" — survives process crash, can lose 1 transaction on power-cut. Acceptable for our workload. |
| `foreign_keys = ON` | The CRM schema declares FKs (`crm_columns.board_id REFERENCES crm_boards(id) ON DELETE CASCADE`). SQLite ignores them by default. We turn them on explicitly. |
| `busy_timeout = 5000` | When two cluster workers want the writer lock simultaneously, the loser polls for 5 seconds before giving up. Long enough for normal writes; short enough that a stuck writer surfaces fast. |
| `cache_size = -64000` | 64 MB of in-process page cache. The negative value means "kibibytes" instead of "pages". Default ~2 MB is far too small once the DB passes 100 MB. Our biggest tables are `crm_activities` (~20 MB after ~10 tenants) and `crm_cards` (~10 MB) — 64 MB keeps essentially the whole working set hot. |
| `temp_store = MEMORY` | `GROUP BY`, subqueries, FTS5 rebuilds use scratch space. Default writes that scratch to disk; `MEMORY` keeps it in RAM. Big speedup for analytics on `crm_activities` aggregations. |
| `mmap_size = 268435456` | 256 MB of memory-mapped reads. Pages inside the mmap window are zero-copy from the OS page cache (no `read(2)` syscall, no buffer fill). Hot SELECTs (board list, contact search) get a measurable boost. Writes still go through the WAL — no consistency change. |

## Prepared statement cache

`db.prepare(sql)` parses + compiles SQL into bytecode every call. For hot paths (every CRM query goes through prepare) this is the dominant cost. [src/crm/store/preparedCache.ts](../src/crm/store/preparedCache.ts) caches compiled `Statement` objects keyed by SQL string.

Usage:

```ts
import { prep } from './preparedCache.js';

const card = prep(db, 'SELECT * FROM crm_cards WHERE id = ? AND tenant_id = ?').get(cardId, tenantId);
```

`prep(db, sql)` returns the cached `Statement` if one exists for the same `(db, sql)` pair, or compiles + caches it on first call. Compilation cost is paid once per process lifetime, never again.

Cache invalidation: `closeCrmDb()` calls `clearPreparedCache()` so a re-opened connection gets fresh statements. PM2 cluster mode = one cache per worker (each worker has its own connection too).

## Cluster-mode connection pool

There's no explicit pool. **better-sqlite3 is per-process synchronous**; you can't share a connection across processes. The natural shape is:

- 1 PM2 worker = 1 better-sqlite3 connection = 1 prepared cache
- N workers = N connections to the same DB file
- WAL mode allows them to run concurrently — readers don't block readers, and a writer only blocks other writers (one-at-a-time at the OS file lock level)

This is the design called out in [README.md → Deploy](../README.md#deploy-zero-downtime--pm2-cluster-mode); raising `CLOW_INSTANCES` past 4 needs nginx sticky-session support for `sessionPool` first.

## Benchmark results

Workload: **10,000 reads + 1,000 writes** per phase, against a freshly-migrated DB on this machine. Reads = `SELECT * FROM crm_cards WHERE id = ? AND tenant_id = ?`, writes = `INSERT crm_contacts` + `UPDATE last_interaction_at`.

|  | BASELINE (FULL fsync, no cache) | TUNED (Comando 17) | Speedup |
|---|---:|---:|---:|
| reads (ops/sec) | ~13.9k | ~82.5k | **5.94×** |
| writes (ops/sec) | ~283 | ~1,597 | **5.64×** |
| reads total wall | 721 ms | 121 ms | — |
| writes total wall | 3,529 ms | 626 ms | — |

> Numbers vary 5-15% run-to-run depending on disk cache state. The order of magnitude is stable: ~6× across the board.

The two big contributors are the prepared-statement cache (read path) and `synchronous = NORMAL` (write path). `mmap_size` and `cache_size` are smaller tail-end wins that show up as the DB grows past 100 MB.

## Re-running the benchmark

```bash
npx tsx scripts/benchmark-db.ts
```

Output goes to stdout + `docs/db-bench-results.json` (machine-readable for follow-up automation).
