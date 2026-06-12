/**
 * TOP 10 #9 — Soft Delete + Audit Log (Ondas 28, 29, 31)
 * Testa soft-delete/restore/purge + LGPD forget + security.audit log.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'crypto';
import { unlinkSync } from 'fs';

const DB = '/tmp/clow-test-softdel-' + randomBytes(6).toString('hex') + '.db';
process.env.CRM_DB_PATH = DB;

describe('TOP 10 #9 — Soft Delete + Audit Log', () => {
  let soft: any, sec: any, lgpd: any, store: any, schema: any;
  const tid = 'softdel-tenant';
  let contactId: string, cardId: string, agentId: string;

  beforeAll(async () => {
    schema = await import('../../../src/crm/schema.js');
    store = await import('../../../src/crm/store.js');
    soft = await import('../../../src/crm/softDelete.js');
    sec = await import('../../../src/crm/security.js');
    lgpd = await import('../../../src/crm/lgpd.js');
    schema.getCrmDb();

    const contact = store.createContact(tid, { name: 'To Delete', email: 'del@x.com', phone: '123' });
    contactId = contact.id;
    const board = store.seedDefaultBoards(tid);
    const cols = store.listColumns(tid, board.id);
    const card = store.createCard(tid, { boardId: board.id, columnId: cols[0].id, title: 'To Trash', contactId });
    cardId = card.id;
    const agent = store.createAgent(tid, { name: 'Actor', email: 'actor@x.com' });
    agentId = agent.id;
  });

  afterAll(() => { try { unlinkSync(DB); } catch {} });

  it('softDelete moves row to trash (deleted_at set)', () => {
    const ok = soft.softDelete('crm_cards', tid, cardId);
    expect(ok).toBe(true);
    const counts = soft.countTrash(tid);
    expect(counts.crm_cards).toBe(1);
  });

  it('listTrash shows deleted rows', () => {
    const rows = soft.listTrash('crm_cards', tid, 100);
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe(cardId);
    expect(rows[0].deleted_at).toBeGreaterThan(0);
  });

  it('restore brings row back', () => {
    const ok = soft.restore('crm_cards', tid, cardId);
    expect(ok).toBe(true);
    const counts = soft.countTrash(tid);
    expect(counts.crm_cards).toBe(0);
    const card = store.getCard(tid, cardId);
    expect(card).toBeTruthy();
  });

  it('purge removes permanently', () => {
    soft.softDelete('crm_cards', tid, cardId);
    const ok = soft.purge('crm_cards', tid, cardId);
    expect(ok).toBe(true);
    const card = store.getCard(tid, cardId);
    expect(card).toBeNull();
  });

  it('audit() logs actions with before/after', () => {
    sec.audit({
      tenantId: tid, actorAgentId: agentId, action: 'test.action',
      entity: 'test_entity', entityId: 'e1',
      before: { v: 1 }, after: { v: 2 },
      ip: '1.2.3.4', ua: 'test-agent',
    });
    const entries = sec.queryAudit(tid, { action: 'test.action' });
    expect(entries.length).toBe(1);
    const e = entries[0];
    expect(e.actor_agent_id).toBe(agentId);
    expect(e.ip).toBe('1.2.3.4');
    expect(JSON.parse(e.before_json).v).toBe(1);
    expect(JSON.parse(e.after_json).v).toBe(2);
  });

  it('queryAudit filters by actor, action, entity', () => {
    sec.audit({ tenantId: tid, actorAgentId: agentId, action: 'role.assigned', entity: 'agent_role' });
    sec.audit({ tenantId: tid, actorAgentId: 'other', action: 'role.revoked', entity: 'agent_role' });

    const byActor = sec.queryAudit(tid, { actorAgentId: agentId });
    for (const e of byActor) expect(e.actor_agent_id).toBe(agentId);

    const byAction = sec.queryAudit(tid, { action: 'role.' });
    expect(byAction.length).toBeGreaterThanOrEqual(2);
  });

  it('LGPD logAccess records access events', () => {
    lgpd.logAccess({
      tenantId: tid, actorAgentId: agentId, action: 'view',
      targetEntity: 'contact', targetId: contactId,
      accessedFields: ['email', 'phone'], ip: '1.1.1.1',
    });
    const log = lgpd.queryAccessLog(tid, { contactId });
    expect(log.length).toBe(1);
    expect(log[0].action).toBe('view');
  });

  it('LGPD exportContactData returns full profile', () => {
    const data = lgpd.exportContactData(tid, contactId, agentId);
    expect(data).toBeTruthy();
    expect(data.profile.id).toBe(contactId);
    expect(data.profile.email).toBe('del@x.com');
    expect(Array.isArray(data.activities)).toBe(true);
    expect(Array.isArray(data.cards)).toBe(true);
    expect(Array.isArray(data.consents)).toBe(true);
  });

  it('LGPD forgetContact anonymize blanks PII', () => {
    const result = lgpd.forgetContact(tid, contactId, { mode: 'anonymize', actorAgentId: agentId });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('anonymize');

    const c = store.getContact(tid, contactId);
    expect(c.name).toMatch(/^anonymized_/);
    // rowToContact maps null -> undefined
    expect(c.email ?? null).toBeNull();
    expect(c.phone ?? null).toBeNull();
  });
});
