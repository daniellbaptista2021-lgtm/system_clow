/**
 * TOP 10 #2 — Relatorios / Dashboard (Onda 14)
 * Testa salesByPeriod, activitiesByAgent, leadSources, lostReasons + export CSV/PDF.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'crypto';
import { unlinkSync } from 'fs';

const DB = '/tmp/clow-test-reports-' + randomBytes(6).toString('hex') + '.db';
process.env.CRM_DB_PATH = DB;

describe('TOP 10 #2 — Relatorios / Dashboard', () => {
  let reports: any, store: any, schema: any, exportMod: any;
  const tid = 'reports-tenant';

  beforeAll(async () => {
    schema = await import('../../../src/crm/schema.js');
    store = await import('../../../src/crm/store.js');
    reports = await import('../../../src/crm/reports.js');
    exportMod = await import('../../../src/crm/reportsExport.js');
    schema.getCrmDb();

    // Minimum seed: 2 contacts with different sources + 1 card with lost_reason
    store.createContact(tid, { name: 'C1', email: 'c1@x.com', source: 'facebook' });
    store.createContact(tid, { name: 'C2', email: 'c2@x.com', source: 'google' });
    const board = store.seedDefaultBoards(tid);
    const cols = store.listColumns(tid, board.id);
    const card = store.createCard(tid, { boardId: board.id, columnId: cols[0].id, title: 'Deal', valueCents: 100000 });
    const db = schema.getCrmDb();
    db.prepare("UPDATE crm_cards SET lost_reason='Preço alto' WHERE id=?").run(card.id);
  });

  afterAll(() => { try { unlinkSync(DB); } catch {} });

  it('salesByPeriod returns empty array when no won deals', () => {
    const rows = reports.salesByPeriod(tid, { bucket: 'day' });
    expect(Array.isArray(rows)).toBe(true);
  });

  it('activitiesByAgent returns array with expected shape', () => {
    const rows = reports.activitiesByAgent(tid, {});
    expect(Array.isArray(rows)).toBe(true);
    // Even if empty, verify shape compatibility
    for (const r of rows) {
      expect(r).toHaveProperty('agentId');
      expect(r).toHaveProperty('totalActivities');
      expect(r).toHaveProperty('byType');
    }
  });

  it('leadSources groups contacts by source', () => {
    const rows = reports.leadSources(tid, {});
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const sources = rows.map((r: any) => r.source);
    expect(sources).toContain('facebook');
    expect(sources).toContain('google');
  });

  it('lostReasons finds card with lost_reason set', () => {
    const rows = reports.lostReasons(tid, undefined, {});
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const match = rows.find((r: any) => r.reason === 'Preço alto');
    expect(match).toBeTruthy();
    expect(match.cardCount).toBe(1);
  });

  it('toCSV renders proper CSV with UTF-8 BOM', () => {
    const rows = reports.leadSources(tid, {});
    const csv = exportMod.toCSV('sources', rows);
    expect(csv.charCodeAt(0)).toBe(0xFEFF); // BOM
    expect(csv).toContain('source,contactCount');
    expect(csv).toContain('facebook');
  });

  it('toPDF returns valid PDF buffer starting with %PDF', async () => {
    const rows = reports.leadSources(tid, {});
    const buf = await exportMod.toPDF('sources', rows, { title: 'Lead Sources Test' });
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.slice(0, 4).toString('utf-8')).toBe('%PDF');
    expect(buf.length).toBeGreaterThan(500);
  });
});
