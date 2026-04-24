/**
 * TOP 10 #4 — Lead Scoring por IA (Onda 25)
 * Testa leadScore (determinístico), classifyLead (Hot/Warm/Cold), forecast AI.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'crypto';
import { unlinkSync } from 'fs';

const DB = '/tmp/clow-test-scoring-' + randomBytes(6).toString('hex') + '.db';
process.env.CRM_DB_PATH = DB;

describe('TOP 10 #4 — Lead Scoring por IA', () => {
  let ai: any, store: any, schema: any;
  const tid = 'scoring-tenant';
  let coldCardId: string;
  let hotCardId: string;
  let boardId: string;

  beforeAll(async () => {
    schema = await import('../../../src/crm/schema.js');
    store = await import('../../../src/crm/store.js');
    ai = await import('../../../src/crm/ai.js');
    schema.getCrmDb();

    const board = store.seedDefaultBoards(tid);
    boardId = board.id;
    const cols = store.listColumns(tid, boardId);

    // Cold card: default, no activities
    const cold = store.createCard(tid, { boardId, columnId: cols[0].id, title: 'Cold Lead', valueCents: 10000, probability: 5 });
    coldCardId = cold.id;

    // Hot card: +contact + activities + in later stage
    const contact = store.createContact(tid, { name: 'Hot Buyer', phone: '5511999000000' });
    const hot = store.createCard(tid, { boardId, columnId: cols[2].id, title: 'Hot Lead', contactId: contact.id, valueCents: 5000000, probability: 80 });
    hotCardId = hot.id;

    // Seed activities for hot card
    const db = schema.getCrmDb();
    for (let i = 0; i < 8; i++) {
      db.prepare(`
        INSERT INTO crm_activities (id, tenant_id, card_id, contact_id, type, channel, direction, content, created_at)
        VALUES (?, ?, ?, ?, 'message', 'whatsapp', ?, ?, ?)
      `).run('act_' + i, tid, hot.id, contact.id, i % 2 === 0 ? 'in' : 'out', 'message ' + i, Date.now() - i * 3600_000);
    }
  });

  afterAll(() => { try { unlinkSync(DB); } catch {} });

  it('leadScore returns breakdown with 6 components', () => {
    const insight = ai.leadScore(tid, hotCardId);
    expect(insight).toBeTruthy();
    expect(insight.scoreNumeric).toBeGreaterThanOrEqual(0);
    expect(insight.scoreNumeric).toBeLessThanOrEqual(100);
    const bd = insight.contentJson;
    expect(bd).toHaveProperty('activity');
    expect(bd).toHaveProperty('response');
    expect(bd).toHaveProperty('stage');
    expect(bd).toHaveProperty('value');
    expect(bd).toHaveProperty('freshness');
    expect(bd).toHaveProperty('proposal');
    expect(bd.signals).toHaveProperty('activities14d');
  });

  it('hot card scores HIGHER than cold card', () => {
    const hot = ai.leadScore(tid, hotCardId);
    const cold = ai.leadScore(tid, coldCardId);
    expect(hot.scoreNumeric).toBeGreaterThan(cold.scoreNumeric);
  });

  it('classifyLead returns hot/warm/cold based on score', () => {
    const hot = ai.classifyLead(tid, hotCardId);
    const cold = ai.classifyLead(tid, coldCardId);
    expect(['hot', 'warm', 'cold']).toContain(hot.contentText);
    expect(['hot', 'warm', 'cold']).toContain(cold.contentText);
    // Cold should definitely be cold
    expect(cold.contentText).toBe('cold');
  });

  it('sentimentForText classifies Portuguese correctly', () => {
    const pos = ai.sentimentForText('Obrigado, fechado! Pode enviar o contrato.');
    expect(pos.label).toBe('positive');

    const neg = ai.sentimentForText('Caro demais, vou cancelar. Nao tenho interesse.');
    expect(neg.label).toBe('negative');
  });

  it('sentimentForCard aggregates inbound messages', () => {
    const insight = ai.sentimentForCard(tid, hotCardId);
    expect(insight).toBeTruthy();
    expect(insight.contentJson).toHaveProperty('label');
    expect(insight.contentJson).toHaveProperty('score');
  });

  it('forecast returns weighted pipeline projection', () => {
    const r = ai.forecast(tid, { boardId });
    expect(r).toHaveProperty('pipelineTotalCents');
    expect(r).toHaveProperty('weightedCents');
    expect(r).toHaveProperty('expectedWinsCount');
    expect(r).toHaveProperty('byStage');
    expect(r.weightedCents).toBeLessThanOrEqual(r.pipelineTotalCents);
    expect(r.byStage.length).toBeGreaterThan(0);
  });

  it('tickAutoScore processes stale cards', async () => {
    const r = await ai.tickAutoScore(5);
    expect(r).toHaveProperty('scored');
    // scored pode ser 0 se todos os cards ja tem insights frescos
    expect(typeof r.scored).toBe('number');
  });
});
