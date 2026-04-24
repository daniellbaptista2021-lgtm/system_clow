/**
 * TOP 10 #7 — Formularios de Captura (Onda 18)
 * Testa submit -> applyMapping -> cria contato + card + submission log.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'crypto';
import { unlinkSync } from 'fs';

const DB = '/tmp/clow-test-forms-' + randomBytes(6).toString('hex') + '.db';
process.env.CRM_DB_PATH = DB;

describe('TOP 10 #7 — Formularios de Captura', () => {
  let forms: any, store: any, schema: any;
  const tid = 'forms-tenant';
  let boardId: string, columnId: string, formId: string;

  beforeAll(async () => {
    schema = await import('../../../src/crm/schema.js');
    store = await import('../../../src/crm/store.js');
    forms = await import('../../../src/crm/forms.js');
    schema.getCrmDb();

    const board = store.seedDefaultBoards(tid);
    boardId = board.id;
    const cols = store.listColumns(tid, boardId);
    columnId = cols[0].id;
  });

  afterAll(() => { try { unlinkSync(DB); } catch {} });

  it('createForm stores config with slug + public_key', () => {
    const f = forms.createForm(tid, {
      name: 'Landing Site Test',
      fields: [
        { name: 'full_name', label: 'Nome', type: 'text', required: true },
        { name: 'email_addr', label: 'Email', type: 'email', required: true },
        { name: 'interest', label: 'Interesse', type: 'select', options: ['Comprar', 'Alugar'] },
        { name: 'msg', label: 'Mensagem', type: 'textarea' },
      ],
      mapping: {
        full_name: 'contact.name',
        email_addr: 'contact.email',
        interest: 'contact.customFields.interest',
        msg: 'card.description',
      },
      boardId, columnId,
      defaultSource: 'landing_test',
    });
    formId = f.id;
    expect(f.slug).toBeTruthy();
    expect(f.publicKey).toBeTruthy();
    expect(f.fields.length).toBe(4);
  });

  it('getFormBySlug retrieves form', () => {
    const created = forms.getFormById(tid, formId);
    const bySlug = forms.getFormBySlug(created.slug);
    expect(bySlug?.id).toBe(formId);
  });

  it('submitForm creates contact + card with mapped fields', () => {
    const form = forms.getFormById(tid, formId);
    const r = forms.submitForm(form, {
      full_name: 'Test Buyer',
      email_addr: 'buyer@test.com',
      interest: 'Comprar',
      msg: 'Quero apartamento 3Q',
    }, { ip: '1.2.3.4', ua: 'test' });

    expect(r.ok).toBe(true);
    expect(r.contactId).toBeTruthy();
    expect(r.cardId).toBeTruthy();

    const contact = store.getContact(tid, r.contactId);
    expect(contact.name).toBe('Test Buyer');
    expect(contact.email).toBe('buyer@test.com');
    expect(contact.source).toBe('landing_test');
    expect(contact.customFields).toEqual({ interest: 'Comprar' });

    const card = store.getCard(tid, r.cardId);
    expect(card.description).toBe('Quero apartamento 3Q');
    expect(card.contactId).toBe(r.contactId);
    expect(card.columnId).toBe(columnId);
  });

  it('duplicate submit dedupes contact by email', () => {
    const form = forms.getFormById(tid, formId);
    const r = forms.submitForm(form, {
      full_name: 'Test Buyer 2',
      email_addr: 'buyer@test.com', // same as before
      interest: 'Alugar',
      msg: 'Nova mensagem',
    }, {});

    const all = forms.listSubmissions(tid, formId);
    expect(all.length).toBe(2);
    // Both submissions should reference the same contact
    expect(all[0].contact_id).toBe(all[1].contact_id);
  });

  it('listSubmissions keeps full audit trail', () => {
    const subs = forms.listSubmissions(tid, formId, 100);
    expect(subs.length).toBe(2);
    for (const s of subs) {
      expect(s).toHaveProperty('payload_json');
      const payload = JSON.parse(s.payload_json);
      expect(payload.full_name).toBeTruthy();
    }
  });

  it('createHook + processWebhookPayload works like form', () => {
    const hook = forms.createHook(tid, {
      name: 'Zapier Test',
      mapping: { Name: 'contact.name', Email: 'contact.email' },
      defaultSource: 'zapier_test',
    });
    const r = forms.processWebhookPayload(hook, { Name: 'Webhook Lead', Email: 'wh@x.com' }, {});
    expect(r.ok).toBe(true);
    expect(r.contactId).toBeTruthy();
  });
});
