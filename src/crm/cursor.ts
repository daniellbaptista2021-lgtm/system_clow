/**
 * Cursor pagination — Onda 29.
 *
 * Cursors encode the last row's sort value + id in base64url, allowing
 * consistent pagination regardless of writes during browsing.
 *
 * Usage:
 *   const { items, nextCursor } = paginateQuery(db, sql, params, { cursor, limit, sortField });
 *
 * Contract:
 *   - Sort always DESC by (sortField, id) for deterministic tiebreaker.
 *   - nextCursor is null when no more rows.
 */

import { Buffer } from 'buffer';

export interface CursorOpts {
  cursor?: string;
  limit?: number;
  sortField?: string;  // e.g. 'created_at', 'updated_at'
}

export function encodeCursor(lastSort: number, lastId: string): string {
  return Buffer.from(JSON.stringify({ s: lastSort, i: lastId })).toString('base64url');
}

export function decodeCursor(cursor: string | undefined): { lastSort: number; lastId: string } | null {
  if (!cursor) return null;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf-8'));
    if (typeof decoded.s === 'number' && typeof decoded.i === 'string') {
      return { lastSort: decoded.s, lastId: decoded.i };
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Append cursor WHERE clause + LIMIT to a query. Returns augmented SQL + params.
 * The caller must already have an ORDER BY <sortField> DESC, id DESC on the SQL.
 *
 * Example:
 *   const base = 'SELECT * FROM crm_contacts WHERE tenant_id = ?';
 *   const order = 'ORDER BY updated_at DESC, id DESC';
 *   const { sql, params, limit } = applyCursor(base, [tid], order, { cursor, sortField: 'updated_at', limit: 50 });
 */
export function applyCursor(
  baseSQL: string,
  baseParams: any[],
  orderBySQL: string,
  opts: CursorOpts,
): { sql: string; params: any[]; limit: number } {
  const sortField = opts.sortField || 'created_at';
  const limit = Math.min(500, opts.limit || 50);
  const cur = decodeCursor(opts.cursor);

  let sql = baseSQL;
  const params = [...baseParams];
  if (cur) {
    const glue = /where /i.test(sql) ? ' AND ' : ' WHERE ';
    sql += `${glue}(${sortField} < ? OR (${sortField} = ? AND id < ?))`;
    params.push(cur.lastSort, cur.lastSort, cur.lastId);
  }
  sql += ' ' + orderBySQL + ' LIMIT ?';
  params.push(limit + 1); // fetch one extra to determine hasMore

  return { sql, params, limit };
}

/** Run a cursor-paginated query. Returns items + nextCursor (or null if end). */
export function paginateQuery(
  db: any,
  baseSQL: string,
  baseParams: any[],
  orderBySQL: string,
  opts: CursorOpts,
): { items: any[]; nextCursor: string | null; hasMore: boolean } {
  const { sql, params, limit } = applyCursor(baseSQL, baseParams, orderBySQL, opts);
  const rows = db.prepare(sql).all(...params) as any[];
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;

  let nextCursor: string | null = null;
  if (hasMore && items.length > 0) {
    const last = items[items.length - 1];
    const sortField = opts.sortField || 'created_at';
    nextCursor = encodeCursor(last[sortField], last.id);
  }
  return { items, nextCursor, hasMore };
}
