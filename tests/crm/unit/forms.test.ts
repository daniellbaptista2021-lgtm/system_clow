/**
 * Forms — extractMentions + applyMapping unit tests
 */
import { describe, it, expect } from 'vitest';
import { applyMapping } from '../../../src/crm/forms.js';
import { extractMentions } from '../../../src/crm/collaboration.js';

describe('Forms — applyMapping', () => {
  it('maps top-level contact fields', () => {
    const { contact } = applyMapping(
      { full_name: 'contact.name', email_addr: 'contact.email' },
      { full_name: 'John Doe', email_addr: 'john@x.com', extra: 'ignored' },
    );
    expect(contact.name).toBe('John Doe');
    expect(contact.email).toBe('john@x.com');
    expect(contact.extra).toBeUndefined();
  });

  it('maps customFields correctly', () => {
    const { contact } = applyMapping(
      { utm: 'contact.customFields.utm_source', city: 'contact.customFields.city' },
      { utm: 'facebook', city: 'SP' },
    );
    expect(contact.customFields).toEqual({ utm_source: 'facebook', city: 'SP' });
  });

  it('maps card fields separately', () => {
    const { card, contact } = applyMapping(
      { title: 'card.title', desc: 'card.description', name: 'contact.name' },
      { title: 'Apt 3Q', desc: 'Wants RJ', name: 'Maria' },
    );
    expect(card.title).toBe('Apt 3Q');
    expect(card.description).toBe('Wants RJ');
    expect(contact.name).toBe('Maria');
  });

  it('coerces valueCents to number', () => {
    const { card } = applyMapping(
      { budget: 'card.valueCents' },
      { budget: '500000' },
    );
    expect(card.valueCents).toBe(500000);
    expect(typeof card.valueCents).toBe('number');
  });

  it('skips null/undefined/empty values', () => {
    const { contact } = applyMapping(
      { a: 'contact.name', b: 'contact.email' },
      { a: 'Nome', b: '' },
    );
    expect(contact.name).toBe('Nome');
    expect(contact.email).toBeUndefined();
  });
});

describe('Collaboration — extractMentions', () => {
  const agents = [
    { id: 'agt_camila', name: 'Camila Ferreira', email: 'camila@x.com' },
    { id: 'agt_daniel', name: 'Daniel Baptista', email: 'daniel@x.com' },
    { id: 'agt_rafael', name: 'Rafael Mendes', email: 'rafael@x.com' },
  ];

  it('extracts @agent_id style', () => {
    const r = extractMentions('cc @agt_rafael please', agents);
    expect(r).toContain('agt_rafael');
  });

  it('extracts @firstName fuzzy match', () => {
    const r = extractMentions('@camila pode revisar?', agents);
    expect(r).toContain('agt_camila');
  });

  it('handles multiple mentions', () => {
    const r = extractMentions('@camila @agt_rafael urgent!', agents);
    expect(r).toContain('agt_camila');
    expect(r).toContain('agt_rafael');
  });

  it('returns empty for no mentions', () => {
    const r = extractMentions('just a regular message', agents);
    expect(r).toHaveLength(0);
  });

  it('dedupes mentions', () => {
    const r = extractMentions('@camila @camila @agt_camila', agents);
    expect(r.filter((x: string) => x === 'agt_camila')).toHaveLength(1);
  });
});
