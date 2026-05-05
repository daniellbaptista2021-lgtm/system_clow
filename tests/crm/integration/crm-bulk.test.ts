/**
 * Bulk operations — Integration Test
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'crypto';

const TEST_DB_PATH = '/tmp/clow-test-bulk-' + randomBytes(6).toString('hex') + '.db';
process.env.CRM_DB_PATH = TEST_DB_PATH;

describe('CRM — Bulk ops', () => {
  let bulkOps: any;
  let schema: any;

  beforeAll(async () => {
    schema = await import('../../../src/crm/schema.js');
    bulkOps = await import('../../../src/crm/bulkOps.js');
    schema.getCrmDb();  // trigger lazy init
  });

  afterAll(() => {
    try { require('fs').unlinkSync(TEST_DB_PATH); } catch { /* ignore */ }
  });

  it('bulkCreateContacts succeeds for all valid + dedups email', () => {
    const tid = 'bulk-test';
    const r = bulkOps.bulkCreateContacts(tid, [
      { name: 'A', email: 'a@x.com' },
      { name: 'B', email: 'b@x.com' },
      { name: 'A Updated', email: 'a@x.com' }, // dedup to update
    ]);
    expect(r.ok).toBe(3);
    expect(r.failed).toBe(0);
  });

  it('bulkCreateContacts reports errors for invalid', () => {
    const tid = 'bulk-test-2';
    const r = bulkOps.bulkCreateContacts(tid, [
      { name: 'Valid', email: 'v@x.com' },
      { email: 'noname@x.com' }, // no name -> error
      { name: 'Another' },
    ]);
    expect(r.ok).toBe(2);
    expect(r.failed).toBe(1);
    expect(r.errors[0].index).toBe(1);
  });
});
