/**
 * API v2 routes — scaffold for future breaking changes.
 *
 * For now, v2 mostly mirrors v1 with a few opinionated improvements:
 *   - All list endpoints are cursor-paginated by default
 *   - Unified error shape: { error: {code, message, details} }
 *   - Strict field validation
 *
 * Mounted at /v2/crm (alongside /v1/crm).
 */

import { Hono } from 'hono';
import { getCrmDb } from '../crm/schema.js';
import { encodeCursor, decodeCursor } from '../crm/cursor.js';

const app = new Hono();

function tenantOf(c: any): string {
  return c.get?.('tenantId') || c.get?.('tenant_id') || 'default';
}

function errV2(c: any, code: string, message: string, status: number = 400, details?: any) {
  return c.json({ error: { code, message, details }, apiVersion: 'v2' }, status);
}

app.get('/version', (c) => c.json({ apiVersion: 'v2', supported: ['v1', 'v2'] }));

// v2 example: cursor-paginated contacts with metadata envelope
app.get('/contacts', (c) => {
  const tid = tenantOf(c);
  const cursor = c.req.query('cursor') || undefined;
  const limit = Math.min(200, Number(c.req.query('limit')) || 50);
  const sortField = 'updated_at';
  const db = getCrmDb();
  const decoded = decodeCursor(cursor);
  let sql = 'SELECT * FROM crm_contacts WHERE tenant_id = ? AND deleted_at IS NULL';
  const params: any[] = [tid];
  if (decoded) {
    sql += ` AND (${sortField} < ? OR (${sortField} = ? AND id < ?))`;
    params.push(decoded.lastSort, decoded.lastSort, decoded.lastId);
  }
  sql += ` ORDER BY ${sortField} DESC, id DESC LIMIT ?`;
  params.push(limit + 1);

  const rows = db.prepare(sql).all(...params) as any[];
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore && items.length > 0
    ? encodeCursor(items[items.length - 1][sortField], items[items.length - 1].id)
    : null;

  return c.json({
    data: items.map((r: any) => ({
      id: r.id, name: r.name, email: r.email, phone: r.phone,
      source: r.source,
      tags: JSON.parse(r.tags_json || '[]'),
      customFields: JSON.parse(r.custom_fields_json || '{}'),
      createdAt: r.created_at, updatedAt: r.updated_at,
    })),
    pagination: { nextCursor, hasMore, limit },
    meta: { apiVersion: 'v2' },
  });
});

// v2 cards paginated
app.get('/cards', (c) => {
  const tid = tenantOf(c);
  const cursor = c.req.query('cursor') || undefined;
  const limit = Math.min(200, Number(c.req.query('limit')) || 50);
  const boardId = c.req.query('boardId');
  const sortField = 'updated_at';
  const db = getCrmDb();
  const decoded = decodeCursor(cursor);
  let sql = 'SELECT * FROM crm_cards WHERE tenant_id = ? AND deleted_at IS NULL';
  const params: any[] = [tid];
  if (boardId) { sql += ' AND board_id = ?'; params.push(boardId); }
  if (decoded) {
    sql += ` AND (${sortField} < ? OR (${sortField} = ? AND id < ?))`;
    params.push(decoded.lastSort, decoded.lastSort, decoded.lastId);
  }
  sql += ` ORDER BY ${sortField} DESC, id DESC LIMIT ?`;
  params.push(limit + 1);

  const rows = db.prepare(sql).all(...params) as any[];
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore && items.length > 0
    ? encodeCursor(items[items.length - 1][sortField], items[items.length - 1].id)
    : null;

  return c.json({
    data: items.map((r: any) => ({
      id: r.id, boardId: r.board_id, columnId: r.column_id, title: r.title,
      valueCents: r.value_cents, probability: r.probability,
      createdAt: r.created_at, updatedAt: r.updated_at,
    })),
    pagination: { nextCursor, hasMore, limit },
    meta: { apiVersion: 'v2' },
  });
});

// OpenAPI pointer
app.get('/openapi', (c) => c.redirect('/openapi.json', 302));

export default app;
