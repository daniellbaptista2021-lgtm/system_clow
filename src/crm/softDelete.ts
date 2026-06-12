/**
 * Soft delete helpers — Onda 29.
 *
 * Generic soft-delete wrappers. Entities opt-in by having a deleted_at column.
 * All list queries in routes.ts automatically exclude deleted rows unless
 * ?includeDeleted=true is passed.
 */

import { getCrmDb } from './schema.js';

const ENTITIES_WITH_SOFT_DELETE = new Set([
  'crm_cards', 'crm_contacts', 'crm_activities',
  'crm_tasks', 'crm_appointments', 'crm_documents', 'crm_proposals',
]);

export function softDelete(table: string, tenantId: string, id: string): boolean {
  if (!ENTITIES_WITH_SOFT_DELETE.has(table)) {
    throw new Error('soft-delete not supported for ' + table);
  }
  const r = getCrmDb().prepare(
    `UPDATE ${table} SET deleted_at = ? WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`
  ).run(Date.now(), id, tenantId);
  return r.changes > 0;
}

export function restore(table: string, tenantId: string, id: string): boolean {
  if (!ENTITIES_WITH_SOFT_DELETE.has(table)) {
    throw new Error('soft-delete not supported for ' + table);
  }
  const r = getCrmDb().prepare(
    `UPDATE ${table} SET deleted_at = NULL WHERE id = ? AND tenant_id = ? AND deleted_at IS NOT NULL`
  ).run(id, tenantId);
  return r.changes > 0;
}

export function purge(table: string, tenantId: string, id: string): boolean {
  // HARD delete after soft delete — permanent removal
  const r = getCrmDb().prepare(
    `DELETE FROM ${table} WHERE id = ? AND tenant_id = ?`
  ).run(id, tenantId);
  return r.changes > 0;
}

export function listTrash(table: string, tenantId: string, limit = 100): any[] {
  if (!ENTITIES_WITH_SOFT_DELETE.has(table)) return [];
  return getCrmDb().prepare(
    `SELECT * FROM ${table} WHERE tenant_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT ?`
  ).all(tenantId, limit) as any[];
}

export function countTrash(tenantId: string): Record<string, number> {
  const db = getCrmDb();
  const out: Record<string, number> = {};
  for (const table of ENTITIES_WITH_SOFT_DELETE) {
    try {
      out[table] = (db.prepare(
        `SELECT COUNT(*) n FROM ${table} WHERE tenant_id = ? AND deleted_at IS NOT NULL`
      ).get(tenantId) as any).n;
    } catch { out[table] = 0; }
  }
  return out;
}

/** Auto-purge rows deleted more than N days ago. Called from scheduler. */
export function autoPurge(olderThanDays = 30): Record<string, number> {
  const db = getCrmDb();
  const cutoff = Date.now() - olderThanDays * 86400_000;
  const out: Record<string, number> = {};
  for (const table of ENTITIES_WITH_SOFT_DELETE) {
    try {
      out[table] = db.prepare(
        `DELETE FROM ${table} WHERE deleted_at IS NOT NULL AND deleted_at < ?`
      ).run(cutoff).changes;
    } catch { out[table] = 0; }
  }
  return out;
}
