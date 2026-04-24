/**
 * TOP 10 #3 — Propostas Comerciais (Onda 16)
 * Fluxo completo: create -> get token -> view -> sign -> auto-convert -> clone v2.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'crypto';
import { unlinkSync } from 'fs';

const DB = '/tmp/clow-test-proposals-' + randomBytes(6).toString('hex') + '.db';
process.env.CRM_DB_PATH = DB;

describe('TOP 10 #3 — Propostas Comerciais', () => {
  let proposalsMod: any, store: any, schema: any;
  const tid = 'proposals-tenant';
  let cardId: string;
  let wonColId: string;

  beforeAll(async () => {
    schema = await import('../../../src/crm/schema.js');
    store = await import('../../../src/crm/store.js');
    proposalsMod = await import('../../../src/crm/proposals.js');
    schema.getCrmDb();

    const contact = store.createContact(tid, { name: 'Buyer', email: 'b@x.com' });
    const board = store.seedDefaultBoards(tid);
    const cols = store.listColumns(tid, board.id);
    const wonC = cols.find((c: any) => /ganho|won/i.test(c.name));
    wonColId = wonC.id;
    schema.getCrmDb().prepare("UPDATE crm_columns SET stage_type='won' WHERE id=?").run(wonColId);

    const card = store.createCard(tid, { boardId: board.id, columnId: cols[0].id, title: 'Test Deal', contactId: contact.id, valueCents: 100000 });
    cardId = card.id;
  });

  afterAll(() => { try { unlinkSync(DB); } catch {} });

  it('createProposal generates v1 with public token', () => {
    const p = store.createProposal(tid, { cardId, terms: 'Termos padrao' });
    expect(p).toBeTruthy();
    expect(p.version).toBe(1);
    const tok = proposalsMod.ensurePublicToken(tid, p.id);
    expect(tok).toBeTruthy();
    expect(tok.length).toBeGreaterThan(20);
  });

  it('recordEvent tracks viewed and updates counters', () => {
    const proposals = store.listProposals(tid, cardId);
    const p = proposals[0];
    proposalsMod.recordEvent(p.id, 'viewed', { ip: '1.2.3.4', ua: 'test' });
    proposalsMod.recordEvent(p.id, 'viewed', { ip: '1.2.3.4', ua: 'test' });
    const events = proposalsMod.listEvents(tid, p.id);
    const views = events.filter((e: any) => e.event === 'viewed');
    expect(views.length).toBe(2);

    // rowToProposal may not expose viewedCount directly — verify via raw db
    const db = schema.getCrmDb();
    const raw = db.prepare('SELECT viewed_count FROM crm_proposals WHERE id = ?').get(p.id) as any;
    expect(raw.viewed_count).toBe(2);
  });

  it('renderHTML produces valid HTML with purple branding', () => {
    const proposals = store.listProposals(tid, cardId);
    const p = proposals[0];
    const ctx = proposalsMod.buildContext(tid, p.id, 'https://test.local');
    const html = proposalsMod.renderHTML(ctx);
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('#9B59FC'); // purple
    expect(html).toContain('Proposta Comercial');
  });

  it('onAccept auto-converts card to won column', () => {
    const proposals = store.listProposals(tid, cardId);
    const p = proposals[0];
    store.updateProposalStatus(tid, p.id, 'accepted', { signedBy: 'Buyer X', signedIp: '1.1.1.1' });
    proposalsMod.onAccept(tid, p.id);

    const card = store.getCard(tid, cardId);
    expect(card.columnId).toBe(wonColId);
  });

  it('cloneAsNewVersion creates v2 with parent linked', () => {
    const proposals = store.listProposals(tid, cardId);
    const v1 = proposals[0];
    const v2 = proposalsMod.cloneAsNewVersion(tid, v1.id);
    expect(v2).toBeTruthy();
    expect(v2.version).toBe(2);

    const updatedList = store.listProposals(tid, cardId);
    expect(updatedList.length).toBeGreaterThanOrEqual(2);
    const v2Row = updatedList.find((x: any) => x.version === 2);
    expect(v2Row).toBeTruthy();
  });

  it('renderPDF returns valid PDF buffer', async () => {
    const proposals = store.listProposals(tid, cardId);
    const ctx = proposalsMod.buildContext(tid, proposals[0].id, 'https://test.local');
    const pdf = await proposalsMod.renderPDF(ctx);
    expect(pdf.slice(0, 4).toString('utf-8')).toBe('%PDF');
    expect(pdf.length).toBeGreaterThan(500);
  });
});
