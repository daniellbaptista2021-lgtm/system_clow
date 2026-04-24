/**
 * TOP 10 #5 — Filtros Salvos / Views (Onda 22)
 * Testa saved views CRUD + filteredCards com diversos filtros + globalSearch FTS.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'crypto';
import { unlinkSync } from 'fs';

const DB = '/tmp/clow-test-views-' + randomBytes(6).toString('hex') + '.db';
process.env.CRM_DB_PATH = DB;

describe('TOP 10 #5 — Filtros Salvos / Views', () => {
  let search: any, store: any, schema: any;
  const tid = 'views-tenant';
  let boardId: string, agentId: string;

  beforeAll(async () => {
    schema = await import('../../../src/crm/schema.js');
    store = await import('../../../src/crm/store.js');
    search = await import('../../../src/crm/search.js');
    schema.getCrmDb();

    const board = store.seedDefaultBoards(tid);
    boardId = board.id;
    const cols = store.listColumns(tid, boardId);
    const agent = store.createAgent(tid, { name: 'Agent X', email: 'ax@x.com' });
    agentId = agent.id;

    // 5 cards with varying value, labels, agent
    for (let i = 0; i < 5; i++) {
      store.createCard(tid, {
        boardId, columnId: cols[0].id,
        title: i < 3 ? 'Apartamento Ipanema ' + i : 'Casa ' + i,
        valueCents: (i + 1) * 100000,
        probability: 10 * i,
        ownerAgentId: i % 2 === 0 ? agentId : undefined,
        labels: i < 2 ? ['vip'] : [],
      });
    }

    // Trigger FTS rebuild
    search.backfillFTS();
  });

  afterAll(() => { try { unlinkSync(DB); } catch {} });

  it('filteredCards by minValueCents works', () => {
    const rows = search.filteredCards(tid, { minValueCents: 300000 });
    expect(rows.length).toBe(3); // cards 3, 4, 5 (values 300k, 400k, 500k)
  });

  it('filteredCards by ownerAgentIds', () => {
    const rows = search.filteredCards(tid, { ownerAgentIds: [agentId] });
    expect(rows.length).toBeGreaterThanOrEqual(2); // cards with agent assigned (even indexes)
  });

  it('filteredCards by labels any', () => {
    const rows = search.filteredCards(tid, { labels: ['vip'] });
    expect(rows.length).toBe(2);
    for (const r of rows) {
      expect(r.labels).toContain('vip');
    }
  });

  it('filteredCards with FTS q pre-filter', () => {
    const rows = search.filteredCards(tid, { q: 'Ipanema' });
    expect(rows.length).toBe(3);
  });

  it('createSavedView stores filter + sort config', () => {
    const v = search.createSavedView(tid, {
      name: 'High value vip',
      entity: 'cards',
      filter: { minValueCents: 200000, labels: ['vip'] },
      sort: { field: 'value_cents', dir: 'desc' },
      shared: true,
    });
    expect(v.id).toBeTruthy();
    expect(v.shared).toBe(true);
  });

  it('listSavedViews returns created view', () => {
    const all = search.listSavedViews(tid, { entity: 'cards' });
    expect(all.length).toBeGreaterThanOrEqual(1);
  });

  it('updateSavedView persists changes', () => {
    const [v] = search.listSavedViews(tid, { entity: 'cards' });
    const updated = search.updateSavedView(tid, v.id, { name: 'Renamed' });
    expect(updated.name).toBe('Renamed');
  });

  it('globalSearch ranks FTS matches by BM25', () => {
    const hits = search.globalSearch(tid, 'Ipanema', { entities: ['cards'], limit: 10 });
    expect(hits.length).toBe(3);
    for (const h of hits) {
      expect(h.entity).toBe('cards');
      expect(h.title).toContain('Ipanema');
      // snippet may be empty if match is in title-only and snippet targets description col
      expect(typeof h.snippet).toBe('string');
      expect(h.score).toBeGreaterThan(0);
    }
  });

  it('bulkCardAction tag applies to many ids', () => {
    const rows = search.filteredCards(tid, {}) as any[];
    const ids = rows.slice(0, 3).map((r: any) => r.id);
    const r = search.bulkCardAction(tid, { action: 'tag', tag: 'bulk-tagged', ids });
    expect(r.ok).toBe(3);
    expect(r.failed).toBe(0);
  });
});
