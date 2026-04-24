/**
 * TOP 10 #1 — Pipeline Analytics (Onda 13)
 * Testa funnel, winRate, velocity, stageTimes, compare com dados seedados.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'crypto';
import { unlinkSync } from 'fs';

const DB = '/tmp/clow-test-analytics-' + randomBytes(6).toString('hex') + '.db';
process.env.CRM_DB_PATH = DB;

describe('TOP 10 #1 — Pipeline Analytics', () => {
  let analytics: any, store: any, schema: any;
  const tid = 'analytics-tenant';
  let boardId: string;
  let openCol: string, wonCol: string, lostCol: string;

  beforeAll(async () => {
    schema = await import('../../../src/crm/schema.js');
    store = await import('../../../src/crm/store.js');
    analytics = await import('../../../src/crm/analytics.js');
    schema.getCrmDb();

    // Seed: board + won/lost columns + cards com varias idades
    const board = store.seedDefaultBoards(tid);
    boardId = board.id;
    const cols = store.listColumns(tid, boardId);
    openCol = cols[0].id;
    // Set stage_type in columns
    const wonC = cols.find((c: any) => /ganho|won/i.test(c.name));
    const lostC = cols.find((c: any) => /perdido|lost/i.test(c.name));
    wonCol = wonC.id;
    lostCol = lostC.id;
    const db = schema.getCrmDb();
    db.prepare("UPDATE crm_columns SET stage_type='won' WHERE id=?").run(wonCol);
    db.prepare("UPDATE crm_columns SET stage_type='lost' WHERE id=?").run(lostCol);

    // Create 10 cards: 5 open, 3 won, 2 lost — with activities for stage_change timeline
    for (let i = 0; i < 5; i++) {
      store.createCard(tid, { boardId, columnId: openCol, title: 'Open ' + i, valueCents: 100000 * (i + 1), probability: 20 });
    }
    for (let i = 0; i < 3; i++) {
      const card = store.createCard(tid, { boardId, columnId: openCol, title: 'Won ' + i, valueCents: 500000, probability: 100 });
      store.moveCard(tid, card.id, wonCol);
    }
    for (let i = 0; i < 2; i++) {
      const card = store.createCard(tid, { boardId, columnId: openCol, title: 'Lost ' + i, valueCents: 200000, probability: 0 });
      store.moveCard(tid, card.id, lostCol);
    }
  });

  afterAll(() => { try { unlinkSync(DB); } catch {} });

  it('funnel returns counts and values per stage', () => {
    const rows = analytics.funnel(tid, boardId);
    expect(rows.length).toBeGreaterThan(0);
    const totalCards = rows.reduce((s: number, r: any) => s + r.cardCount, 0);
    expect(totalCards).toBe(10);
    const firstStage = rows.find((r: any) => r.columnId === openCol);
    expect(firstStage?.cardCount).toBe(5);
  });

  it('winRate: 3 won + 2 lost -> winRate = 0.6', () => {
    const s = analytics.winRate(tid, boardId);
    expect(s.won).toBe(3);
    expect(s.lost).toBe(2);
    expect(s.total).toBe(10);
    expect(s.winRate).toBeCloseTo(0.6, 2);
    expect(s.totalRevenueCents).toBeGreaterThan(0);
  });

  it('velocity returns bucketed data with won/lost counts', () => {
    const v = analytics.velocity(tid, boardId, 'day', {});
    // Should have at least 1 bucket since we closed deals today
    expect(v.length).toBeGreaterThanOrEqual(1);
    const totalWon = v.reduce((s: number, p: any) => s + p.wonCount, 0);
    expect(totalWon).toBe(3);
  });

  it('stageTimes returns avg/median/p90 per column', () => {
    const rows = analytics.stageTimes(tid, boardId);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r).toHaveProperty('avgSeconds');
      expect(r).toHaveProperty('medianSeconds');
      expect(r).toHaveProperty('p90Seconds');
      expect(r).toHaveProperty('sampleCount');
    }
  });

  it('compare returns deltas between two periods', () => {
    const now = Date.now();
    const r = analytics.compare(tid, boardId,
      { from: now - 86400_000, to: now },
      { from: now - 172800_000, to: now - 86400_000 }
    );
    expect(r).toHaveProperty('current');
    expect(r).toHaveProperty('previous');
    expect(r).toHaveProperty('deltas');
    expect(r.deltas).toHaveProperty('won');
    expect(r.deltas).toHaveProperty('winRateDelta');
    expect(r.deltas).toHaveProperty('revenueDeltaCents');
  });
});
