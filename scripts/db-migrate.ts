/**
 * CLI runner for the CRM migrator.
 *
 *   npm run db:migrate              # apply pending migrations
 *   npm run db:status               # list migrations + applied state
 *   npm run db:rollback             # rollback the last applied migration
 *
 * Honors CLOW_HOME / CRM_DB_PATH so you can target a non-default DB:
 *   CRM_DB_PATH=/tmp/x.db npm run db:migrate
 */
import Database from 'better-sqlite3';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { applyMigrations, rollbackLast, status } from '../src/crm/migrator.js';

function dbPath(): string {
  if (process.env.CRM_DB_PATH) return process.env.CRM_DB_PATH;
  const home = process.env.CLOW_HOME ?? path.join(os.homedir(), '.clow');
  if (!fs.existsSync(home)) fs.mkdirSync(home, { recursive: true });
  return path.join(home, 'crm.sqlite3');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const action = args.includes('--rollback')
    ? 'rollback'
    : args.includes('--status')
      ? 'status'
      : 'migrate';

  const target = dbPath();
  const db = new Database(target);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  console.log(`[db-migrate] target: ${target}`);

  try {
    if (action === 'status') {
      const rows = status(db);
      if (rows.length === 0) {
        console.log('[db-migrate] no migrations registered');
        return;
      }
      console.log('[db-migrate] migrations:');
      for (const r of rows) {
        const mark = r.applied ? '✓' : '·';
        const when = r.appliedAt ? new Date(r.appliedAt).toISOString() : 'pending';
        console.log(
          `  ${mark} ${String(r.version).padStart(4, '0')}  ${when}  ${r.description ?? ''}`,
        );
      }
      return;
    }

    if (action === 'rollback') {
      // Production safety net: require explicit confirmation. Tests and dev
      // can pass FORCE_ROLLBACK=1 to skip the prompt.
      if (process.env.FORCE_ROLLBACK !== '1') {
        const isProdLike =
          target.includes('.clow/crm.sqlite3') && !target.includes('test') && !target.includes('tmp');
        if (isProdLike) {
          console.error(
            '[db-migrate] ⚠️  refusing to rollback against what looks like a production DB.',
          );
          console.error('             set FORCE_ROLLBACK=1 to proceed (this WILL drop tables).');
          process.exit(2);
        }
      }
      const v = rollbackLast(db, { logger: (m) => console.log(m) });
      if (v == null) {
        console.log('[db-migrate] nothing to rollback');
      } else {
        console.log(`[db-migrate] rolled back version ${v}`);
      }
      return;
    }

    const result = applyMigrations(db, { logger: (m) => console.log(m) });
    console.log(
      `[db-migrate] done — applied ${result.applied.length}, skipped ${result.skipped.length}`,
    );
  } finally {
    db.close();
  }
}

void main().catch((err) => {
  console.error('[db-migrate] error:', err);
  process.exit(1);
});
