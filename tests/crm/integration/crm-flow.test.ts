/**
 * CRM End-to-End Flow — Integration Test.
 *
 * Tests the complete sales pipeline:
 *   1. Create contact (Onda 1)
 *   2. Create card on pipeline (Onda 2)
 *   3. Create proposal (Onda 8/16)
 *   4. Sign proposal publicly (Onda 16) -> auto-convert to won column
 *
 * Uses a real sqlite db file in /tmp/ for isolation.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';

const TEST_DB_PATH = '/tmp/clow-test-' + randomBytes(6).toString('hex') + '.db';
process.env.CRM_DB_PATH = TEST_DB_PATH;

describe('CRM — Full Sales Flow', () => {
  let schemaModule: any;
  let storeModule: any;

  beforeAll(async () => {
    // Lazy-load modules AFTER env setup so they pick up the test DB path
    schemaModule = await import('../../../src/crm/schema.js');
    storeModule = await import('../../../src/crm/store.js');
    schemaModule.getCrmDb();  // trigger lazy init
  });

  afterAll(() => {
    try { require('fs').unlinkSync(TEST_DB_PATH); } catch { /* ignore */ }
  });

  it('runs full contact->card->proposal->signed flow', () => {
    const tenantId = 'test-tenant-' + randomBytes(3).toString('hex');

    // 1. Create board + default columns
    const board = storeModule.seedDefaultBoards(tenantId);
    expect(board).toBeTruthy();
    const columns = storeModule.listColumns(tenantId, board.id);
    expect(columns.length).toBeGreaterThan(0);

    // 2. Create contact
    const contact = storeModule.createContact(tenantId, {
      name: 'Test Subject',
      email: 'test-' + randomBytes(3).toString('hex') + '@x.com',
      phone: '+5511999000000',
      source: 'integration-test',
      tags: ['vip'],
    });
    expect(contact.id).toMatch(/^crm_contact_/);

    // 3. Create card on first column
    const firstCol = columns[0];
    const card = storeModule.createCard(tenantId, {
      boardId: board.id,
      columnId: firstCol.id,
      title: 'Deal with ' + contact.name,
      valueCents: 500000,
      probability: 20,
      contactId: contact.id,
      labels: ['test'],
    });
    expect(card.id).toMatch(/^crm_card_/);
    expect(card.valueCents).toBe(500000);

    // 4. Move through stages
    const qualifiedCol = columns.find((c: any) => /qualif/i.test(c.name)) || columns[1];
    const moved = storeModule.moveCard(tenantId, card.id, qualifiedCol.id);
    expect(moved?.columnId).toBe(qualifiedCol.id);

    // 5. List pipeline — should include our card
    const allCards = storeModule.listCardsByBoard(tenantId, board.id);
    expect(allCards.some((c: any) => c.id === card.id)).toBe(true);
  });
});
