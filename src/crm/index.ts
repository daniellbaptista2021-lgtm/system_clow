/**
 * CRM module entry point.
 *
 * import { initCrm } from '../crm/index.js';
 * await initCrm();  // called once from server bootstrap
 */

import { getCrmDb } from './schema.js';

let _initialized = false;

export function initCrm(): void {
  if (_initialized) return;
  // Touching getCrmDb() runs migrations.
  const db = getCrmDb();
  const meta = db.prepare('SELECT COUNT(*) as n FROM crm_migrations').get() as { n: number };
  console.log(`[CRM] Schema ready (${meta.n} migration(s) applied)`);
  _initialized = true;
}

export * as store from './store.js';
export * from './types.js';
export { encryptJson, decryptJson, maskSecret } from './crypto.js';
