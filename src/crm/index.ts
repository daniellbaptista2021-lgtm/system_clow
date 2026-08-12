/**
 * CRM module entry point.
 *
 * import { initCrm } from '../crm/index.js';
 * await initCrm();  // called once from server bootstrap
 */

import { getCrmDb } from './schema.js';
import { logger } from '../utils/logger.js';

let _initialized = false;

export function initCrm(): void {
  if (_initialized) return;
  // Touching getCrmDb() runs migrations.
  const db = getCrmDb();
  // State table is `schema_migrations`. `crm_migrations` is the pre-migrator
  // legacy table and only exists on databases old enough to predate it — a
  // fresh install has no such table, and reading it unconditionally used to
  // kill boot on every brand-new deploy.
  const meta = db
    .prepare('SELECT COUNT(*) as n FROM schema_migrations')
    .get() as { n: number };
  logger.info(`[CRM] Schema ready (${meta.n} migration(s) applied)`);
  _initialized = true;
}

export * as store from './store.js';
export * from './types.js';
export { encryptJson, decryptJson, maskSecret } from './crypto.js';
