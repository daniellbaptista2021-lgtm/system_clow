/**
 * Generic bulk operations — Onda 30.
 *
 * Complements the entity-specific bulk endpoints (Onda 22) with generic
 * batch CREATE/UPDATE/DELETE for contacts, cards, and tasks.
 */

import { getCrmDb } from './schema.js';
import * as store from './store.js';

export interface BulkResult {
  ok: number;
  failed: number;
  errors: Array<{ index: number; error: string }>;
}

/** Bulk create contacts (with dedup by email/phone). */
export function bulkCreateContacts(tenantId: string, contacts: any[]): BulkResult {
  const db = getCrmDb();
  const result: BulkResult = { ok: 0, failed: 0, errors: [] };
  const tx = db.transaction(() => {
    for (let i = 0; i < contacts.length; i++) {
      const c = contacts[i];
      try {
        if (!c.name) throw new Error('name required');
        // Dedup by email/phone
        let existing: any = null;
        if (c.email) existing = db.prepare('SELECT id FROM crm_contacts WHERE tenant_id = ? AND LOWER(email) = LOWER(?)').get(tenantId, c.email);
        if (!existing && c.phone) existing = db.prepare('SELECT id FROM crm_contacts WHERE tenant_id = ? AND phone = ?').get(tenantId, c.phone);
        if (existing) {
          store.updateContact(tenantId, existing.id, c);
        } else {
          store.createContact(tenantId, c);
        }
        result.ok++;
      } catch (err: any) {
        result.failed++;
        result.errors.push({ index: i, error: err.message });
      }
    }
  });
  tx();
  return result;
}

/** Bulk create cards. */
export function bulkCreateCards(tenantId: string, cards: any[]): BulkResult {
  const db = getCrmDb();
  const result: BulkResult = { ok: 0, failed: 0, errors: [] };
  const tx = db.transaction(() => {
    for (let i = 0; i < cards.length; i++) {
      try {
        const c = cards[i];
        if (!c.title || !c.boardId || !c.columnId) throw new Error('title, boardId, columnId required');
        store.createCard(tenantId, c);
        result.ok++;
      } catch (err: any) {
        result.failed++;
        result.errors.push({ index: i, error: err.message });
      }
    }
  });
  tx();
  return result;
}

/** Bulk update contacts by id: [{ id, ...patch }, ...]. */
export function bulkUpdateContacts(tenantId: string, updates: Array<any>): BulkResult {
  const db = getCrmDb();
  const result: BulkResult = { ok: 0, failed: 0, errors: [] };
  const tx = db.transaction(() => {
    for (let i = 0; i < updates.length; i++) {
      try {
        const u = updates[i];
        if (!u.id) throw new Error('id required');
        const updated = store.updateContact(tenantId, u.id, u);
        if (updated) result.ok++;
        else throw new Error('not found');
      } catch (err: any) {
        result.failed++;
        result.errors.push({ index: i, error: err.message });
      }
    }
  });
  tx();
  return result;
}

/** Soft-delete ids. */
export function bulkSoftDelete(tenantId: string, table: string, ids: string[]): BulkResult {
  const db = getCrmDb();
  const result: BulkResult = { ok: 0, failed: 0, errors: [] };
  const now = Date.now();
  const tx = db.transaction(() => {
    for (let i = 0; i < ids.length; i++) {
      try {
        const r = db.prepare(
          `UPDATE ${table} SET deleted_at = ? WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`
        ).run(now, ids[i], tenantId);
        if (r.changes > 0) result.ok++;
        else throw new Error('not found or already deleted');
      } catch (err: any) {
        result.failed++;
        result.errors.push({ index: i, error: err.message });
      }
    }
  });
  tx();
  return result;
}
