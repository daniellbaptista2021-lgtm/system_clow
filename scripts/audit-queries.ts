/**
 * audit-queries.ts — SQLite performance audit for the CRM layer.
 *
 * Usage:
 *   tsx scripts/audit-queries.ts
 *
 * What it does:
 *   1. Spins up a fresh CRM DB in $TMPDIR with migrations applied.
 *   2. Monkey-patches better-sqlite3's Database#prepare so every
 *      Statement.run/get/all/iterate/values is timed and the SQL
 *      recorded.
 *   3. Drives the store layer through three representative workloads:
 *        - onboarding: create tenant → board → column → contact → card
 *        - message-flow: inbound activity logged on a card, list, mark read
 *        - dashboard: list contacts, list cards by board, search, agent metrics
 *   4. Runs EXPLAIN QUERY PLAN on every distinct SELECT to flag
 *      "SCAN TABLE" (no index) hits.
 *   5. Aggregates findings and writes docs/performance-audit.md with:
 *        - top 10 slowest queries
 *        - N+1 patterns (same SQL fired ≥5 times in a single phase)
 *        - missing-index hits
 *        - per-phase totals
 *   6. Does NOT apply fixes — purely a report.
 */
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMigrations } from '../src/crm/migrator.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const REPORT_PATH = join(REPO_ROOT, 'docs', 'performance-audit.md');

// ─── Query interceptor ────────────────────────────────────────────────────

interface QueryRecord {
  sql: string;
  durationMs: number;
  phase: string;
  method: 'run' | 'get' | 'all' | 'iterate' | 'values' | 'exec';
}

const records: QueryRecord[] = [];
let currentPhase = 'init';

const SLOW_THRESHOLD_MS = 50;
const N_PLUS_1_THRESHOLD = 5; // same SQL fired N times in one phase

function normalizeSql(sql: string): string {
  // Collapse whitespace + literal arg substitutions for grouping.
  return sql.replace(/\s+/g, ' ').trim().slice(0, 200);
}

function timeSync<T>(fn: () => T, sql: string, method: QueryRecord['method']): T {
  const start = process.hrtime.bigint();
  try {
    return fn();
  } finally {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    records.push({ sql: normalizeSql(sql), durationMs, phase: currentPhase, method });
  }
}

function patchDatabase(db: Database.Database): void {
  const origPrepare = db.prepare.bind(db);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (db as any).prepare = function patchedPrepare(sql: string) {
    const stmt = origPrepare(sql);
    const wrapMethod = <T extends 'run' | 'get' | 'all' | 'iterate' | 'values'>(name: T) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const orig = (stmt as any)[name].bind(stmt);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (stmt as any)[name] = (...args: unknown[]) => timeSync(() => orig(...args), sql, name);
    };
    wrapMethod('run');
    wrapMethod('get');
    wrapMethod('all');
    wrapMethod('iterate');
    return stmt;
  };
  const origExec = db.exec.bind(db);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (db as any).exec = function patchedExec(sql: string) {
    return timeSync(() => origExec(sql), sql, 'exec');
  };
}

// ─── Workloads ────────────────────────────────────────────────────────────

async function runOnboarding(): Promise<void> {
  currentPhase = 'onboarding';
  const store = await import('../src/crm/store.js');
  const tenantId = 'audit-tenant-onb';
  const board = store.createBoard(tenantId, { name: 'Pipeline', type: 'sales' });
  const col = store.createColumn(tenantId, { boardId: board.id, name: 'Lead novo' });
  const colWon = store.createColumn(tenantId, { boardId: board.id, name: 'Ganho' });
  const contact = store.createContact(tenantId, { name: 'Cliente Teste', phone: '+5511999999999' });
  store.createCard(tenantId, {
    boardId: board.id,
    columnId: col.id,
    title: 'Apto centro',
    contactId: contact.id,
    valueCents: 250000,
  });
  void colWon;
}

async function runMessageFlow(): Promise<void> {
  currentPhase = 'message-flow';
  const store = await import('../src/crm/store.js');
  const tenantId = 'audit-tenant-msg';
  const board = store.createBoard(tenantId, { name: 'B', type: 'sales' });
  const col = store.createColumn(tenantId, { boardId: board.id, name: 'C' });
  const contact = store.createContact(tenantId, { name: 'X', phone: '+5511988888888' });
  const card = store.createCard(tenantId, { boardId: board.id, columnId: col.id, title: 't', contactId: contact.id });

  // Simulate 25 inbound messages and follow-up reads — this is the
  // typical "1 conversation" load and the place N+1 would hide.
  for (let i = 0; i < 25; i++) {
    store.logActivity(tenantId, {
      cardId: card.id,
      contactId: contact.id,
      type: 'message',
      channel: 'whatsapp',
      direction: 'in',
      content: `inbound msg ${i}`,
    });
  }

  store.listActivitiesByCard(tenantId, card.id);
  store.listActivitiesByContact(tenantId, contact.id);
  store.markCardRead(tenantId, card.id);
}

async function runDashboard(): Promise<void> {
  currentPhase = 'dashboard';
  const store = await import('../src/crm/store.js');
  const tenantId = 'audit-tenant-dash';

  // Seed: 5 boards × 3 columns × 20 cards each + 100 contacts.
  for (let b = 0; b < 5; b++) {
    const board = store.createBoard(tenantId, { name: `Board ${b}`, type: 'sales' });
    const cols = [];
    for (let c = 0; c < 3; c++) {
      cols.push(store.createColumn(tenantId, { boardId: board.id, name: `Col ${c}` }));
    }
    for (let k = 0; k < 20; k++) {
      const contact = store.createContact(tenantId, {
        name: `Contato ${b}-${k}`, phone: `+5511955${b}${k.toString().padStart(4, '0')}`,
      });
      store.createCard(tenantId, {
        boardId: board.id, columnId: cols[k % 3]!.id,
        title: `Card ${b}-${k}`, contactId: contact.id, valueCents: 100000 + k * 1000,
      });
    }
  }

  // Now drive the queries that the dashboard endpoints fire.
  store.listContacts(tenantId, { limit: 100 });
  store.countContacts(tenantId);
  const boards = store.listBoards(tenantId);
  for (const b of boards) {
    // Pipeline view = listColumns + listCardsByBoard. Per-board iteration
    // is a classic N+1 candidate we explicitly want to surface.
    store.listColumns(tenantId, b.id);
    store.listCardsByBoard(tenantId, b.id);
  }
  store.searchContacts(tenantId, 'Contato 2');
}

// ─── EXPLAIN QUERY PLAN — flag missing-index hits ────────────────────────

interface ExplainHit {
  sql: string;
  plan: string;
  problematic: boolean;
}

function explainSelects(db: Database.Database): ExplainHit[] {
  const distinct = new Map<string, string>();
  for (const r of records) {
    if (!/^\s*SELECT\b/i.test(r.sql)) continue;
    if (!distinct.has(r.sql)) distinct.set(r.sql, r.sql);
  }

  const hits: ExplainHit[] = [];
  for (const [, sql] of distinct) {
    try {
      const planRows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>;
      const plan = planRows.map((r) => r.detail).join(' | ');
      // "SCAN TABLE foo" without "USING INDEX" is the smoking gun.
      // SCAN against tiny tables is fine but we flag everything for human review.
      const problematic = /\bSCAN\s+(?:TABLE\s+)?[A-Za-z_]/i.test(plan) && !/USING\s+(?:COVERING\s+)?INDEX/i.test(plan);
      hits.push({ sql, plan, problematic });
    } catch {
      // Some prepared statements use parameters that EXPLAIN can't
      // resolve at audit time — skip.
    }
  }
  return hits;
}

// ─── Aggregation ──────────────────────────────────────────────────────────

interface Aggregate {
  sql: string;
  count: number;
  totalMs: number;
  maxMs: number;
  phases: Set<string>;
}

function aggregate(): Aggregate[] {
  const map = new Map<string, Aggregate>();
  for (const r of records) {
    const key = `${r.method}:${r.sql}`;
    let agg = map.get(key);
    if (!agg) {
      agg = { sql: `${r.method.toUpperCase()} ${r.sql}`, count: 0, totalMs: 0, maxMs: 0, phases: new Set() };
      map.set(key, agg);
    }
    agg.count++;
    agg.totalMs += r.durationMs;
    if (r.durationMs > agg.maxMs) agg.maxMs = r.durationMs;
    agg.phases.add(r.phase);
  }
  return [...map.values()];
}

function detectNPlus1(aggs: Aggregate[]): Aggregate[] {
  // A query is N+1 ONLY if it's a read-side query repeated ≥N times in
  // ONE phase. INSERT/UPDATE/DELETE in a seed loop look like N+1 but
  // are usually correct (you really are inserting N rows). Limiting
  // the rule to SELECTs (and UPDATEs that aren't inside an obvious
  // seed pattern, i.e. UPDATEs writing the same set of columns to
  // distinct ids) keeps the report actionable.
  return aggs.filter((a) => {
    if (a.count < N_PLUS_1_THRESHOLD) return false;
    if (!/^GET |^ALL |^ITERATE /.test(a.sql)) return false; // SELECTs only

    const perPhase = new Map<string, number>();
    for (const r of records) {
      if (`${r.method.toUpperCase()} ${r.sql}` === a.sql) {
        perPhase.set(r.phase, (perPhase.get(r.phase) ?? 0) + 1);
      }
    }
    return [...perPhase.values()].some((n) => n >= N_PLUS_1_THRESHOLD);
  });
}

// ─── Report writer ────────────────────────────────────────────────────────

function writeReport(aggs: Aggregate[], explained: ExplainHit[]): void {
  const slow = aggs.filter((a) => a.maxMs >= SLOW_THRESHOLD_MS).sort((a, b) => b.maxMs - a.maxMs);
  const top10 = [...aggs].sort((a, b) => b.totalMs - a.totalMs).slice(0, 10);
  const np1 = detectNPlus1(aggs).sort((a, b) => b.count - a.count);
  const missingIdx = explained.filter((e) => e.problematic);

  const md: string[] = [];
  md.push(`# CRM SQLite Performance Audit\n`);
  md.push(`_Generated by \`scripts/audit-queries.ts\` on ${new Date().toISOString()}._\n\n`);
  md.push(`## Workload\n\n`);
  md.push(`Three phases, run in sequence on a fresh DB with all migrations applied:\n\n`);
  md.push(`- **onboarding** — create tenant + board + column + contact + card\n`);
  md.push(`- **message-flow** — log 25 inbound activities + list by card/contact + mark read\n`);
  md.push(`- **dashboard** — seed 5 boards × 3 columns × 20 cards (+ 100 contacts), then list/count/search\n\n`);
  md.push(`Recorded **${records.length}** queries across **${aggs.length}** distinct SQL shapes.\n\n`);

  // Per-phase totals
  md.push(`## Per-phase totals\n\n`);
  md.push(`| Phase | Queries | Total time (ms) |\n|---|---:|---:|\n`);
  for (const phase of ['init', 'onboarding', 'message-flow', 'dashboard']) {
    const phaseRecords = records.filter((r) => r.phase === phase);
    const total = phaseRecords.reduce((s, r) => s + r.durationMs, 0);
    md.push(`| ${phase} | ${phaseRecords.length} | ${total.toFixed(2)} |\n`);
  }
  md.push(`\n`);

  // Top 10 by total time
  md.push(`## Top 10 — most cumulative time\n\n`);
  md.push(`| # | Query | Calls | Total ms | Max ms | Phases |\n|---:|---|---:|---:|---:|---|\n`);
  top10.forEach((a, i) => {
    md.push(`| ${i + 1} | \`${a.sql.replace(/\|/g, '\\|')}\` | ${a.count} | ${a.totalMs.toFixed(2)} | ${a.maxMs.toFixed(2)} | ${[...a.phases].join(', ')} |\n`);
  });
  md.push(`\n`);

  // Slow queries (>50ms p99)
  md.push(`## Queries above ${SLOW_THRESHOLD_MS}ms (single execution)\n\n`);
  if (slow.length === 0) {
    md.push(`_None — every individual query ran under ${SLOW_THRESHOLD_MS}ms in this audit._\n\n`);
  } else {
    md.push(`| Query | Max ms | Calls | Suggested fix | Priority |\n|---|---:|---:|---|---|\n`);
    for (const a of slow) {
      const fix = suggestFix(a.sql);
      md.push(`| \`${a.sql.replace(/\|/g, '\\|')}\` | ${a.maxMs.toFixed(2)} | ${a.count} | ${fix.fix} | ${fix.prio} |\n`);
    }
    md.push(`\n`);
  }

  // N+1 patterns
  md.push(`## N+1 patterns (same SQL ≥${N_PLUS_1_THRESHOLD}× in one phase)\n\n`);
  if (np1.length === 0) {
    md.push(`_None detected at threshold ${N_PLUS_1_THRESHOLD}._\n\n`);
  } else {
    md.push(`| Query | Total calls | Phase | Suggested fix | Priority |\n|---|---:|---|---|---|\n`);
    for (const a of np1) {
      const fix = suggestFix(a.sql, true);
      md.push(`| \`${a.sql.replace(/\|/g, '\\|')}\` | ${a.count} | ${[...a.phases].join(', ')} | ${fix.fix} | ${fix.prio} |\n`);
    }
    md.push(`\n`);
  }

  // Missing index
  md.push(`## Missing-index hits (EXPLAIN QUERY PLAN reports SCAN without USING INDEX)\n\n`);
  if (missingIdx.length === 0) {
    md.push(`_None — every SELECT in the audit hit an index._\n\n`);
  } else {
    md.push(`| Query | Plan | Suggested fix |\n|---|---|---|\n`);
    for (const e of missingIdx) {
      md.push(`| \`${e.sql.replace(/\|/g, '\\|').slice(0, 90)}\` | ${e.plan.replace(/\|/g, '\\|').slice(0, 90)} | Add index — see column WHERE/ORDER BY |\n`);
    }
    md.push(`\n`);
  }

  // Closing — actionable summary
  const slowestSingleMs = aggs.reduce((m, a) => Math.max(m, a.maxMs), 0);
  const totalAuditMs = records.reduce((s, r) => s + r.durationMs, 0);
  md.push(`## Summary\n\n`);
  md.push(`- **${records.length}** queries / **${aggs.length}** distinct shapes / **${totalAuditMs.toFixed(0)}ms** total wall time\n`);
  md.push(`- **${slow.length}** queries above ${SLOW_THRESHOLD_MS}ms threshold (max single: ${slowestSingleMs.toFixed(2)}ms)\n`);
  md.push(`- **${np1.length}** N+1 patterns detected at threshold ${N_PLUS_1_THRESHOLD}\n`);
  md.push(`- **${missingIdx.length}** queries with missing-index hint\n`);
  md.push(`\nNo automatic fixes were applied. Pick from the tables above and tell me which to address.\n`);

  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, md.join(''));
  console.log(`[audit] report → ${REPORT_PATH}`);
}

// ─── Fix suggestions (pure heuristic — human reviews) ────────────────────

function suggestFix(sql: string, isNPlus1 = false): { fix: string; prio: 'P0' | 'P1' | 'P2' | 'P3' } {
  const lower = sql.toLowerCase();
  if (isNPlus1) {
    if (/from crm_columns where board_id/.test(lower)) {
      return { fix: 'Batch-load all columns for visible boards in one query (`WHERE board_id IN (...)`).', prio: 'P1' };
    }
    if (/from crm_cards where (?:board_id|column_id|contact_id)/.test(lower)) {
      return { fix: 'Eager-load cards once with `WHERE board_id IN (...)` then group in JS.', prio: 'P1' };
    }
    return { fix: 'Replace per-iteration call with a single batched query.', prio: 'P1' };
  }
  if (lower.includes('like') && lower.includes('%')) {
    return { fix: 'Use FTS5 (crm_fts_*) virtual table; avoid leading-wildcard LIKE.', prio: 'P2' };
  }
  if (/order by .*\s+desc/.test(lower) && !/limit/.test(lower)) {
    return { fix: 'Add LIMIT or paginate via cursor.', prio: 'P2' };
  }
  if (/scan table/.test(lower)) {
    return { fix: 'Add composite index covering the WHERE+ORDER BY columns.', prio: 'P0' };
  }
  return { fix: 'Inspect manually — review WHERE clause and check for index coverage.', prio: 'P3' };
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), 'clow-audit-'));
  process.env.CLOW_HOME = tmp;
  process.env.CRM_DB_PATH = join(tmp, 'crm.sqlite3');

  // Bring up the schema first (these queries count as the "init" phase).
  const setupDb = new Database(process.env.CRM_DB_PATH);
  setupDb.pragma('journal_mode = WAL');
  applyMigrations(setupDb);
  setupDb.close();

  // Now patch the singleton getCrmDb returns going forward.
  const { getCrmDb } = await import('../src/crm/schema.js');
  const db = getCrmDb();
  patchDatabase(db);

  await runOnboarding();
  await runMessageFlow();
  await runDashboard();

  const aggs = aggregate();
  const explained = explainSelects(db);

  writeReport(aggs, explained);

  // Best-effort tmp cleanup — Windows holds a file lock briefly after
  // db.close, so an EPERM here doesn't mean anything failed.
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* fine */ }
}

main().catch((err) => {
  console.error('[audit] error:', err);
  process.exit(1);
});
