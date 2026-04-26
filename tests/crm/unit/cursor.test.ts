/**
 * Cursor Pagination — Unit Tests
 */
import { describe, it, expect } from 'vitest';
import { encodeCursor, decodeCursor, applyCursor } from '../../../src/crm/cursor.js';

describe('Cursor — encode/decode', () => {
  it('round-trips simple values', () => {
    const cur = encodeCursor(1700000000000, 'crm_contact_abc');
    const decoded = decodeCursor(cur);
    expect(decoded?.lastSort).toBe(1700000000000);
    expect(decoded?.lastId).toBe('crm_contact_abc');
  });

  it('produces urlsafe base64 (no +/=)', () => {
    const cur = encodeCursor(1, 'x');
    expect(cur).not.toMatch(/[+/=]/);
  });

  it('returns null on invalid cursor', () => {
    expect(decodeCursor('garbage')).toBeNull();
    expect(decodeCursor('')).toBeNull();
    expect(decodeCursor(undefined)).toBeNull();
  });
});

describe('Cursor — applyCursor', () => {
  it('appends WHERE clause when cursor present', () => {
    const cur = encodeCursor(1000, 'id_42');
    const { sql, params } = applyCursor(
      'SELECT * FROM x WHERE tenant = ?',
      ['t1'],
      'ORDER BY created_at DESC, id DESC',
      { cursor: cur, sortField: 'created_at', limit: 50 },
    );
    expect(sql).toContain('created_at < ?');
    expect(sql).toContain('created_at = ? AND id < ?');
    expect(sql).toContain('LIMIT ?');
    expect(params).toContain('t1');
    expect(params).toContain(1000);
    expect(params).toContain('id_42');
    expect(params[params.length - 1]).toBe(51); // limit + 1
  });

  it('skips WHERE when no cursor', () => {
    const { sql, params } = applyCursor(
      'SELECT * FROM x WHERE tenant = ?',
      ['t1'],
      'ORDER BY created_at DESC, id DESC',
      { limit: 10 },
    );
    // No additional WHERE conditions from cursor
    expect((sql.match(/\?/g) || []).length).toBe(2); // tenant + limit
    expect(params).toHaveLength(2);
  });

  it('clamps limit to max 500', () => {
    const { params } = applyCursor('SELECT 1', [], 'ORDER BY 1', { limit: 10000 });
    expect(params[params.length - 1]).toBe(501);
  });
});
