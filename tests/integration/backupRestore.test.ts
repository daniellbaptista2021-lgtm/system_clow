/**
 * Backup / restore integration tests.
 *
 * Two layers:
 *   1. Cross-platform: exercises the SQLite live-backup semantics via the
 *      better-sqlite3 native API (the same machinery `sqlite3 .backup`
 *      uses). Runs on every platform and proves the snapshot is valid
 *      and a corrupted live DB can be replaced from it.
 *
 *   2. Linux-only: spawns the actual bash scripts (backup-sqlite.sh,
 *      verify-backup.sh, restore-sqlite.sh) against a fake $CLOW_HOME
 *      so end-to-end script wiring + rotation logic is covered. Skipped
 *      on platforms without bash + sqlite3 in PATH.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, mkdirSync, statSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPTS = join(REPO_ROOT, 'scripts');

function hasBin(name: string): boolean {
  const probe = process.platform === 'win32'
    ? spawnSync('where', [name], { stdio: 'ignore' })
    : spawnSync('which', [name], { stdio: 'ignore' });
  return probe.status === 0;
}

const SHELL_AVAILABLE = hasBin('bash') && hasBin('sqlite3');

function makeWorkDir(): string {
  return mkdtempSync(join(tmpdir(), 'clow-backup-'));
}

function seedDatabase(path: string, rows: Array<{ id: number; name: string }>): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE IF NOT EXISTS contacts (id INTEGER PRIMARY KEY, name TEXT)');
  const stmt = db.prepare('INSERT INTO contacts (id, name) VALUES (?, ?)');
  const insertMany = db.transaction((items: typeof rows) => {
    for (const r of items) stmt.run(r.id, r.name);
  });
  insertMany(rows);
  db.close();
}

function readContacts(path: string): Array<{ id: number; name: string }> {
  const db = new Database(path, { readonly: true });
  try {
    return db.prepare('SELECT id, name FROM contacts ORDER BY id').all() as Array<{ id: number; name: string }>;
  } finally {
    db.close();
  }
}

// ─── Layer 1: cross-platform semantics ────────────────────────────────────

describe('backup/restore — live-backup semantics', () => {
  let work: string;

  beforeEach(() => { work = makeWorkDir(); });
  afterEach(() => { rmSync(work, { recursive: true, force: true }); });

  it('backup() produces a snapshot with all rows even with concurrent writer', async () => {
    const live = join(work, 'crm.sqlite3');
    const snap = join(work, 'snap.sqlite3');
    seedDatabase(live, [{ id: 1, name: 'alice' }, { id: 2, name: 'bob' }]);

    const writer = new Database(live);
    writer.pragma('journal_mode = WAL');
    // Hold a writer open during the backup — this is the WAL-safety claim.
    const backupRunning = (async () => {
      await writer.backup(snap);
    })();

    // While backup runs, the writer keeps inserting.
    writer.prepare('INSERT INTO contacts (id, name) VALUES (?, ?)').run(3, 'carol');
    await backupRunning;
    writer.close();

    expect(existsSync(snap)).toBe(true);

    // Snapshot must be self-contained (no -wal/-shm) and readable.
    const snapped = readContacts(snap);
    expect(snapped.length).toBeGreaterThanOrEqual(2);
    expect(snapped.find((r) => r.name === 'alice')).toBeDefined();
    expect(snapped.find((r) => r.name === 'bob')).toBeDefined();
  });

  it('snapshot survives corruption of the live DB', async () => {
    const live = join(work, 'crm.sqlite3');
    const snap = join(work, 'snap.sqlite3');
    seedDatabase(live, [{ id: 1, name: 'alice' }]);

    // Take a backup
    const src = new Database(live);
    await src.backup(snap);
    src.close();

    // Corrupt the live DB by overwriting it with garbage
    writeFileSync(live, Buffer.from('not a sqlite file'));

    // The snapshot is still intact and integrity_check passes
    const checker = new Database(snap, { readonly: true });
    const result = checker.pragma('integrity_check') as Array<{ integrity_check: string }>;
    checker.close();
    expect(result[0].integrity_check).toBe('ok');

    // Restore = copy snapshot over live, drop stale -wal/-shm
    rmSync(live);
    rmSync(`${live}-wal`, { force: true });
    rmSync(`${live}-shm`, { force: true });
    copyFileSync(snap, live);

    expect(readContacts(live)).toEqual([{ id: 1, name: 'alice' }]);
  });
});

// ─── Layer 2: actual shell scripts (Linux/macOS only) ─────────────────────

describe.skipIf(!SHELL_AVAILABLE)('backup/restore — shell scripts end-to-end', () => {
  let clowHome: string;

  beforeEach(() => {
    clowHome = makeWorkDir();
  });

  afterEach(() => {
    rmSync(clowHome, { recursive: true, force: true });
  });

  function run(script: string, args: string[] = []): { stdout: string; stderr: string; status: number } {
    const r = spawnSync('bash', [join(SCRIPTS, script), ...args], {
      env: { ...process.env, CLOW_HOME: clowHome, PATH: process.env.PATH ?? '' },
      encoding: 'utf-8',
    });
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? -1 };
  }

  it('backup-sqlite.sh creates a YYYY-MM-DD-HH snapshot with crm + memory DBs', () => {
    seedDatabase(join(clowHome, 'crm.sqlite3'), [{ id: 1, name: 'crm-row' }]);
    seedDatabase(join(clowHome, 'memory', 'tenant-a.sqlite3'), [{ id: 1, name: 'mem-a' }]);
    seedDatabase(join(clowHome, 'memory', 'tenant-b.sqlite3'), [{ id: 1, name: 'mem-b' }]);

    const r = run('backup-sqlite.sh');
    expect(r.status, r.stderr).toBe(0);

    const backupRoot = join(clowHome, 'backups');
    const snaps = readdirSync(backupRoot).filter((n) => /^\d{4}-\d{2}-\d{2}-\d{2}$/.test(n));
    expect(snaps).toHaveLength(1);
    const snap = join(backupRoot, snaps[0]);

    expect(existsSync(join(snap, 'crm.sqlite3'))).toBe(true);
    expect(existsSync(join(snap, 'memory', 'tenant-a.sqlite3'))).toBe(true);
    expect(existsSync(join(snap, 'memory', 'tenant-b.sqlite3'))).toBe(true);

    expect(readContacts(join(snap, 'crm.sqlite3'))).toEqual([{ id: 1, name: 'crm-row' }]);
    expect(readContacts(join(snap, 'memory', 'tenant-a.sqlite3'))).toEqual([{ id: 1, name: 'mem-a' }]);
  });

  it('verify-backup.sh returns 0 on a healthy snapshot, non-zero on corruption', () => {
    seedDatabase(join(clowHome, 'crm.sqlite3'), [{ id: 1, name: 'x' }]);
    expect(run('backup-sqlite.sh').status).toBe(0);

    const ok = run('verify-backup.sh');
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toMatch(/OK|✓/);

    // Corrupt the snapshot — verify must catch it
    const snap = readdirSync(join(clowHome, 'backups')).filter((n) => /^\d{4}-\d{2}-\d{2}-\d{2}$/.test(n))[0];
    writeFileSync(join(clowHome, 'backups', snap, 'crm.sqlite3'), Buffer.from('garbage'));

    const bad = run('verify-backup.sh');
    expect(bad.status).not.toBe(0);
  });

  it('restore-sqlite.sh latest brings back data after live DB corruption', () => {
    const livePath = join(clowHome, 'crm.sqlite3');
    seedDatabase(livePath, [{ id: 1, name: 'before' }, { id: 2, name: 'snapshot-time' }]);

    expect(run('backup-sqlite.sh').status).toBe(0);

    // Simulate corruption: garbage out the live DB
    writeFileSync(livePath, Buffer.from('totally trashed'));

    const r = run('restore-sqlite.sh', ['latest']);
    expect(r.status, r.stderr).toBe(0);

    expect(readContacts(livePath)).toEqual([
      { id: 1, name: 'before' },
      { id: 2, name: 'snapshot-time' },
    ]);

    // The pre-restore version of the corrupted file is preserved
    const aside = readdirSync(clowHome).find((f) => f.startsWith('crm.sqlite3.pre-restore.'));
    expect(aside).toBeDefined();
    expect(statSync(join(clowHome, aside!)).size).toBeGreaterThan(0);
  });

  it('restore-sqlite.sh --dry-run does not modify the live DB', () => {
    const livePath = join(clowHome, 'crm.sqlite3');
    seedDatabase(livePath, [{ id: 1, name: 'untouched' }]);
    expect(run('backup-sqlite.sh').status).toBe(0);

    // Replace live with a different value
    writeFileSync(livePath, Buffer.from(''));
    seedDatabase(livePath, [{ id: 99, name: 'changed' }]);

    const r = run('restore-sqlite.sh', ['latest', '--dry-run']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/dry-run/i);

    // Live DB unchanged by dry-run
    expect(readContacts(livePath)).toEqual([{ id: 99, name: 'changed' }]);
  });
});
