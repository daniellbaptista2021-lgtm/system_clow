/**
 * Field Selector — Unit Tests
 */
import { describe, it, expect } from 'vitest';
import { pickFields, pickArray, parseFieldsParam } from '../../../src/crm/fieldSelector.js';

describe('pickFields', () => {
  it('picks top-level fields', () => {
    const obj = { id: '1', name: 'Felipe', email: 'f@x.com', phone: '123', extra: 'x' };
    const r = pickFields(obj, ['id', 'name']);
    expect(r).toEqual({ id: '1', name: 'Felipe' });
  });

  it('supports dot notation', () => {
    const obj = { id: '1', customFields: { company: 'Acme', role: 'CEO' } };
    const r = pickFields(obj, ['id', 'customFields.company']) as any;
    expect(r.id).toBe('1');
    expect(r.customFields).toEqual({ company: 'Acme' });
  });

  it('ignores unknown fields', () => {
    const obj = { id: '1', name: 'X' };
    const r = pickFields(obj, ['id', 'nonexistent']);
    expect(r).toEqual({ id: '1' });
  });

  it('returns full object when no fields passed', () => {
    const obj = { a: 1, b: 2 };
    expect(pickFields(obj, null)).toEqual(obj);
    expect(pickFields(obj, [])).toEqual(obj);
  });
});

describe('pickArray', () => {
  it('applies to all items', () => {
    const arr = [{ id: 'a', name: 'A', x: 1 }, { id: 'b', name: 'B', x: 2 }];
    const r = pickArray(arr, ['id', 'name']);
    expect(r).toEqual([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]);
  });
});

describe('parseFieldsParam', () => {
  it('splits CSV and trims', () => {
    expect(parseFieldsParam('id, name, email')).toEqual(['id', 'name', 'email']);
  });
  it('returns null for empty', () => {
    expect(parseFieldsParam('')).toBeNull();
    expect(parseFieldsParam(null)).toBeNull();
  });
});
