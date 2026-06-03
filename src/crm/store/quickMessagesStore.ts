// Mensagens prontas (quick replies) por tenant.
// Escopo: tenant_id. Sem RBAC gating — segue regra SaaS do Clow.
import { getCrmDb } from '.././schema.js';
import { now, nid } from './_internals.js';

export interface QuickMessage {
  id: string;
  tenantId: string;
  title: string;
  body: string;
  mediaUrl?: string | null;
  mediaType?: string | null;
  mediaFilename?: string | null;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

function rowToQuickMessage(r: any): QuickMessage {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    title: r.title,
    body: r.body,
    mediaUrl: r.media_url ?? null,
    mediaType: r.media_type ?? null,
    mediaFilename: r.media_filename ?? null,
    sortOrder: r.sort_order ?? 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function listQuickMessages(tenantId: string): QuickMessage[] {
  const db = getCrmDb();
  const rows = db
    .prepare(
      `SELECT * FROM crm_quick_messages WHERE tenant_id = ?
       ORDER BY sort_order ASC, created_at ASC`,
    )
    .all(tenantId) as any[];
  return rows.map(rowToQuickMessage);
}

export function getQuickMessage(tenantId: string, id: string): QuickMessage | null {
  const db = getCrmDb();
  const r = db
    .prepare(`SELECT * FROM crm_quick_messages WHERE id = ? AND tenant_id = ?`)
    .get(id, tenantId) as any;
  return r ? rowToQuickMessage(r) : null;
}

export function createQuickMessage(
  tenantId: string,
  input: {
    title: string;
    body?: string;
    mediaUrl?: string | null;
    mediaType?: string | null;
    mediaFilename?: string | null;
    sortOrder?: number;
  },
): QuickMessage {
  const db = getCrmDb();
  const ts = now();
  const qm: QuickMessage = {
    id: nid('crm_qm'),
    tenantId,
    title: input.title.trim().slice(0, 120),
    body: (input.body ?? '').slice(0, 8000),
    mediaUrl: input.mediaUrl ?? null,
    mediaType: input.mediaType ?? null,
    mediaFilename: input.mediaFilename ?? null,
    sortOrder: input.sortOrder ?? 0,
    createdAt: ts,
    updatedAt: ts,
  };
  db.prepare(
    `INSERT INTO crm_quick_messages
       (id, tenant_id, title, body, media_url, media_type, media_filename, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    qm.id,
    qm.tenantId,
    qm.title,
    qm.body,
    qm.mediaUrl,
    qm.mediaType,
    qm.mediaFilename,
    qm.sortOrder,
    qm.createdAt,
    qm.updatedAt,
  );
  return qm;
}

export function updateQuickMessage(
  tenantId: string,
  id: string,
  patch: Partial<{
    title: string;
    body: string;
    mediaUrl: string | null;
    mediaType: string | null;
    mediaFilename: string | null;
    sortOrder: number;
  }>,
): QuickMessage | null {
  const existing = getQuickMessage(tenantId, id);
  if (!existing) return null;
  const db = getCrmDb();
  const merged: QuickMessage = {
    ...existing,
    title: patch.title !== undefined ? patch.title.trim().slice(0, 120) : existing.title,
    body: patch.body !== undefined ? patch.body.slice(0, 8000) : existing.body,
    mediaUrl: patch.mediaUrl !== undefined ? patch.mediaUrl : existing.mediaUrl,
    mediaType: patch.mediaType !== undefined ? patch.mediaType : existing.mediaType,
    mediaFilename:
      patch.mediaFilename !== undefined ? patch.mediaFilename : existing.mediaFilename,
    sortOrder: patch.sortOrder !== undefined ? patch.sortOrder : existing.sortOrder,
    updatedAt: now(),
  };
  db.prepare(
    `UPDATE crm_quick_messages
        SET title = ?, body = ?, media_url = ?, media_type = ?, media_filename = ?,
            sort_order = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ?`,
  ).run(
    merged.title,
    merged.body,
    merged.mediaUrl,
    merged.mediaType,
    merged.mediaFilename,
    merged.sortOrder,
    merged.updatedAt,
    id,
    tenantId,
  );
  return merged;
}

export function deleteQuickMessage(tenantId: string, id: string): boolean {
  const db = getCrmDb();
  const r = db
    .prepare(`DELETE FROM crm_quick_messages WHERE id = ? AND tenant_id = ?`)
    .run(id, tenantId);
  return r.changes > 0;
}
