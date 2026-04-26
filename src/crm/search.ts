/**
 * Search & Filters & Views & Bulk — Onda 22.
 *
 * FTS5 provides:
 *   - globalSearch(tenantId, q, entities?) — multi-entity ranked by BM25
 *   - entity-specific filtered searches (multi-field, structured)
 *
 * Saved views persist a filter+sort pair per entity. Optionally shared across tenant.
 *
 * Bulk actions fan out mutations over a set of IDs in a single transaction.
 */

import { randomBytes } from 'crypto';
import { getCrmDb } from './schema.js';
import * as store from './store.js';

function nid(prefix: string): string { return prefix + '_' + randomBytes(6).toString('hex'); }
const now = () => Date.now();

// ─── Global full-text search ───────────────────────────────────────────
export type Entity = 'cards' | 'contacts' | 'activities' | 'notes';

export interface SearchHit {
  entity: Entity;
  id: string;
  title: string;
  snippet: string;
  score: number;
  metadata?: Record<string, any>;
}

/**
 * Rank hits across multiple FTS5 indices using BM25.
 * Query pattern: `prefix` tokens to allow partial matching. Quotes preserved.
 */
export function globalSearch(
  tenantId: string,
  q: string,
  opts: { entities?: Entity[]; limit?: number } = {},
): SearchHit[] {
  const db = getCrmDb();
  const entities = opts.entities || ['cards', 'contacts', 'activities', 'notes'];
  const limit = Math.min(200, opts.limit || 25);
  const query = buildFtsQuery(q);
  if (!query) return [];

  const hits: SearchHit[] = [];

  if (entities.includes('cards')) {
    try {
      const rows = db.prepare(`
        SELECT c.id, c.title, c.description, c.value_cents, c.column_id, c.contact_id,
               snippet(crm_fts_cards, 1, '<mark>', '</mark>', '...', 12) AS snip,
               bm25(crm_fts_cards) AS rank
        FROM crm_fts_cards JOIN crm_cards c ON c.rowid = crm_fts_cards.rowid
        WHERE crm_fts_cards MATCH ? AND c.tenant_id = ?
        ORDER BY rank LIMIT ?
      `).all(query, tenantId, limit) as any[];
      for (const r of rows) hits.push({
        entity: 'cards', id: r.id, title: r.title, snippet: r.snip || '',
        score: -r.rank, metadata: { valueCents: r.value_cents, columnId: r.column_id, contactId: r.contact_id },
      });
    } catch (e: any) { /* FTS may not find anything */ }
  }
  if (entities.includes('contacts')) {
    try {
      const rows = db.prepare(`
        SELECT c.id, c.name, c.email, c.phone,
               snippet(crm_fts_contacts, 1, '<mark>', '</mark>', '...', 12) AS snip,
               bm25(crm_fts_contacts) AS rank
        FROM crm_fts_contacts JOIN crm_contacts c ON c.rowid = crm_fts_contacts.rowid
        WHERE crm_fts_contacts MATCH ? AND c.tenant_id = ?
        ORDER BY rank LIMIT ?
      `).all(query, tenantId, limit) as any[];
      for (const r of rows) hits.push({
        entity: 'contacts', id: r.id, title: r.name, snippet: r.snip || '',
        score: -r.rank, metadata: { email: r.email, phone: r.phone },
      });
    } catch {}
  }
  if (entities.includes('activities')) {
    try {
      const rows = db.prepare(`
        SELECT a.id, a.type, a.content, a.card_id, a.contact_id, a.created_at,
               snippet(crm_fts_activities, 0, '<mark>', '</mark>', '...', 12) AS snip,
               bm25(crm_fts_activities) AS rank
        FROM crm_fts_activities JOIN crm_activities a ON a.rowid = crm_fts_activities.rowid
        WHERE crm_fts_activities MATCH ? AND a.tenant_id = ?
        ORDER BY rank LIMIT ?
      `).all(query, tenantId, limit) as any[];
      for (const r of rows) hits.push({
        entity: 'activities', id: r.id, title: r.type || 'activity', snippet: r.snip || '',
        score: -r.rank, metadata: { cardId: r.card_id, contactId: r.contact_id, createdAt: r.created_at },
      });
    } catch {}
  }
  if (entities.includes('notes')) {
    try {
      const rows = db.prepare(`
        SELECT n.id, n.content, n.contact_id, n.pinned, n.created_at,
               snippet(crm_fts_notes, 0, '<mark>', '</mark>', '...', 12) AS snip,
               bm25(crm_fts_notes) AS rank
        FROM crm_fts_notes JOIN crm_contact_notes n ON n.rowid = crm_fts_notes.rowid
        WHERE crm_fts_notes MATCH ? AND n.tenant_id = ?
        ORDER BY rank LIMIT ?
      `).all(query, tenantId, limit) as any[];
      for (const r of rows) hits.push({
        entity: 'notes', id: r.id, title: r.pinned === 1 ? '📌 Note' : 'Note',
        snippet: r.snip || '', score: -r.rank,
        metadata: { contactId: r.contact_id, pinned: r.pinned === 1, createdAt: r.created_at },
      });
    } catch {}
  }

  // Merge ordered by score (higher = better)
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

/**
 * Convert user input into FTS5-safe query.
 *   - Strip FTS operators we don't want user-facing (., :, MATCH, NEAR, etc.)
 *   - Tokenize and append * for prefix matching per token
 *   - Wrap quoted phrases intact
 */
function buildFtsQuery(q: string): string {
  const raw = String(q || '').trim();
  if (!raw) return '';
  // Preserve quoted phrases
  const phrases: string[] = [];
  let remainder = raw.replace(/"([^"]+)"/g, (_m, p) => {
    phrases.push('"' + p.replace(/"/g, '""') + '"');
    return ' ';
  });
  // Remove bad FTS punctuation
  remainder = remainder.replace(/[^\p{L}\p{N}\s_-]+/gu, ' ');
  const tokens = remainder.split(/\s+/).filter(Boolean).map(t => {
    const s = t.replace(/-/g, '').trim();
    return s.length >= 2 ? s + '*' : '';
  }).filter(Boolean);
  return [...phrases, ...tokens].join(' ');
}

// ─── Structured multi-field card search ────────────────────────────────
export interface CardSearchFilter {
  q?: string;                      // FTS pre-filter (title/description)
  boardId?: string;
  columnIds?: string[];
  stageTypes?: Array<'open' | 'won' | 'lost' | 'paused'>;
  ownerAgentIds?: string[];
  contactId?: string;
  labels?: string[];               // any of
  createdFrom?: number;
  createdTo?: number;
  dueFrom?: number;
  dueTo?: number;
  minValueCents?: number;
  maxValueCents?: number;
  minProbability?: number;
  hasProposal?: boolean;
  lastActivityAfter?: number;
  lastActivityBefore?: number;
  sort?: { field: 'created_at' | 'updated_at' | 'value_cents' | 'last_activity_at' | 'due_date'; dir: 'asc' | 'desc' };
  limit?: number;
}

export function filteredCards(tenantId: string, filter: CardSearchFilter): any[] {
  const db = getCrmDb();
  const conds: string[] = ['c.tenant_id = ?'];
  const params: any[] = [tenantId];
  const joinCol = filter.stageTypes?.length ? 'JOIN crm_columns col ON col.id = c.column_id' : '';

  if (filter.boardId)       { conds.push('c.board_id = ?'); params.push(filter.boardId); }
  if (filter.columnIds?.length) {
    const ph = filter.columnIds.map(() => '?').join(',');
    conds.push(`c.column_id IN (${ph})`); params.push(...filter.columnIds);
  }
  if (filter.stageTypes?.length) {
    const ph = filter.stageTypes.map(() => '?').join(',');
    conds.push(`col.stage_type IN (${ph})`); params.push(...filter.stageTypes);
  }
  if (filter.ownerAgentIds?.length) {
    const ph = filter.ownerAgentIds.map(() => '?').join(',');
    conds.push(`c.owner_agent_id IN (${ph})`); params.push(...filter.ownerAgentIds);
  }
  if (filter.contactId)  { conds.push('c.contact_id = ?'); params.push(filter.contactId); }
  if (filter.labels?.length) {
    const labelConds = filter.labels.map(() => 'c.labels_json LIKE ?').join(' OR ');
    conds.push('(' + labelConds + ')');
    for (const l of filter.labels) params.push('%"' + l + '"%');
  }
  if (filter.createdFrom != null) { conds.push('c.created_at >= ?'); params.push(filter.createdFrom); }
  if (filter.createdTo != null)   { conds.push('c.created_at <= ?'); params.push(filter.createdTo); }
  if (filter.dueFrom != null)     { conds.push('c.due_date >= ?'); params.push(filter.dueFrom); }
  if (filter.dueTo != null)       { conds.push('c.due_date <= ?'); params.push(filter.dueTo); }
  if (filter.minValueCents != null) { conds.push('c.value_cents >= ?'); params.push(filter.minValueCents); }
  if (filter.maxValueCents != null) { conds.push('c.value_cents <= ?'); params.push(filter.maxValueCents); }
  if (filter.minProbability != null){ conds.push('c.probability >= ?'); params.push(filter.minProbability); }
  if (filter.lastActivityAfter != null)  { conds.push('c.last_activity_at >= ?'); params.push(filter.lastActivityAfter); }
  if (filter.lastActivityBefore != null) { conds.push('c.last_activity_at <= ?'); params.push(filter.lastActivityBefore); }
  if (filter.hasProposal) {
    conds.push('EXISTS (SELECT 1 FROM crm_proposals p WHERE p.card_id = c.id AND p.tenant_id = ?)');
    params.push(tenantId);
  }

  // Full-text pre-filter via FTS
  let ftsJoin = '';
  if (filter.q && filter.q.trim()) {
    const fq = buildFtsQuery(filter.q);
    if (fq) {
      ftsJoin = 'JOIN crm_fts_cards fts ON fts.rowid = c.rowid';
      conds.push('crm_fts_cards MATCH ?');
      params.push(fq);
    }
  }

  const sort = filter.sort || { field: 'updated_at', dir: 'desc' };
  const sortSQL = `ORDER BY c.${sort.field} ${sort.dir.toUpperCase() === 'ASC' ? 'ASC' : 'DESC'}`;
  const limit = Math.min(1000, filter.limit || 200);

  const sql = `
    SELECT c.* FROM crm_cards c
    ${joinCol}
    ${ftsJoin}
    WHERE ${conds.join(' AND ')}
    ${sortSQL}
    LIMIT ?
  `;
  const rows = db.prepare(sql).all(...params, limit) as any[];
  return rows.map((r: any) => ({
    id: r.id, boardId: r.board_id, columnId: r.column_id, title: r.title,
    description: r.description, contactId: r.contact_id, ownerAgentId: r.owner_agent_id,
    valueCents: r.value_cents, probability: r.probability,
    labels: JSON.parse(r.labels_json || '[]'),
    dueDate: r.due_date, position: r.position,
    customFields: JSON.parse(r.custom_fields_json || '{}'),
    createdAt: r.created_at, updatedAt: r.updated_at, lastActivityAt: r.last_activity_at,
  }));
}

// ─── Structured multi-field contact search ─────────────────────────────
export interface ContactSearchFilter {
  q?: string;
  tags?: string[];
  tagsMode?: 'any' | 'all';
  source?: string;
  hasEmail?: boolean;
  hasPhone?: boolean;
  createdFrom?: number;
  createdTo?: number;
  lastInteractionAfter?: number;
  lastInteractionBefore?: number;
  customFieldEquals?: Record<string, string | number | boolean>;
  sort?: { field: 'created_at' | 'updated_at' | 'last_interaction_at' | 'name'; dir: 'asc' | 'desc' };
  limit?: number;
}

export function filteredContacts(tenantId: string, filter: ContactSearchFilter): any[] {
  const db = getCrmDb();
  const conds: string[] = ['c.tenant_id = ?'];
  const params: any[] = [tenantId];

  if (filter.source) { conds.push('c.source = ?'); params.push(filter.source); }
  if (filter.hasEmail) conds.push("c.email IS NOT NULL AND c.email != ''");
  if (filter.hasPhone) conds.push("c.phone IS NOT NULL AND c.phone != ''");
  if (filter.createdFrom != null) { conds.push('c.created_at >= ?'); params.push(filter.createdFrom); }
  if (filter.createdTo != null)   { conds.push('c.created_at <= ?'); params.push(filter.createdTo); }
  if (filter.lastInteractionAfter != null)  { conds.push('c.last_interaction_at >= ?'); params.push(filter.lastInteractionAfter); }
  if (filter.lastInteractionBefore != null) { conds.push('c.last_interaction_at <= ?'); params.push(filter.lastInteractionBefore); }
  if (filter.tags?.length) {
    const mode = filter.tagsMode || 'any';
    const tagConds = filter.tags.map(() => 'c.tags_json LIKE ?').join(mode === 'all' ? ' AND ' : ' OR ');
    conds.push('(' + tagConds + ')');
    for (const t of filter.tags) params.push('%"' + t + '"%');
  }

  let ftsJoin = '';
  if (filter.q && filter.q.trim()) {
    const fq = buildFtsQuery(filter.q);
    if (fq) {
      ftsJoin = 'JOIN crm_fts_contacts fts ON fts.rowid = c.rowid';
      conds.push('crm_fts_contacts MATCH ?');
      params.push(fq);
    }
  }

  const sort = filter.sort || { field: 'updated_at', dir: 'desc' };
  const sortSQL = `ORDER BY c.${sort.field} ${sort.dir.toUpperCase() === 'ASC' ? 'ASC' : 'DESC'}`;
  const limit = Math.min(5000, filter.limit || 200);

  const sql = `SELECT c.* FROM crm_contacts c ${ftsJoin} WHERE ${conds.join(' AND ')} ${sortSQL} LIMIT ?`;
  let rows = db.prepare(sql).all(...params, limit) as any[];

  if (filter.customFieldEquals) {
    rows = rows.filter((r: any) => {
      const cf = JSON.parse(r.custom_fields_json || '{}');
      for (const [k, v] of Object.entries(filter.customFieldEquals!)) {
        if (cf[k] !== v) return false;
      }
      return true;
    });
  }

  return rows.map((r: any) => ({
    id: r.id, name: r.name, email: r.email, phone: r.phone, source: r.source,
    tags: JSON.parse(r.tags_json || '[]'),
    customFields: JSON.parse(r.custom_fields_json || '{}'),
    createdAt: r.created_at, updatedAt: r.updated_at, lastInteractionAt: r.last_interaction_at,
  }));
}

// ─── Saved Views ───────────────────────────────────────────────────────
export interface SavedView {
  id: string;
  tenantId: string;
  name: string;
  entity: 'cards' | 'contacts' | 'tasks' | 'appointments';
  filter: Record<string, any>;
  sort?: { field: string; dir: 'asc' | 'desc' };
  shared: boolean;
  createdByAgentId?: string;
  createdAt: number;
  updatedAt: number;
}

function rowToView(r: any): SavedView {
  return {
    id: r.id, tenantId: r.tenant_id, name: r.name, entity: r.entity,
    filter: JSON.parse(r.filter_json || '{}'),
    sort: r.sort_json ? JSON.parse(r.sort_json) : undefined,
    shared: r.shared === 1, createdByAgentId: r.created_by_agent_id ?? undefined,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export function createSavedView(tenantId: string, input: Omit<SavedView, 'id' | 'tenantId' | 'createdAt' | 'updatedAt'>): SavedView {
  const id = nid('crm_view');
  const t = now();
  getCrmDb().prepare(`
    INSERT INTO crm_saved_views (id, tenant_id, name, entity, filter_json, sort_json, shared, created_by_agent_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, tenantId, input.name, input.entity,
    JSON.stringify(input.filter || {}),
    input.sort ? JSON.stringify(input.sort) : null,
    input.shared ? 1 : 0, input.createdByAgentId ?? null, t, t);
  return getSavedView(tenantId, id)!;
}

export function getSavedView(tenantId: string, id: string): SavedView | null {
  const r = getCrmDb().prepare('SELECT * FROM crm_saved_views WHERE id = ? AND tenant_id = ?').get(id, tenantId) as any;
  return r ? rowToView(r) : null;
}

export function listSavedViews(tenantId: string, opts: { entity?: string; agentId?: string } = {}): SavedView[] {
  const wh: string[] = ['tenant_id = ?'];
  const params: any[] = [tenantId];
  if (opts.entity) { wh.push('entity = ?'); params.push(opts.entity); }
  if (opts.agentId) {
    wh.push('(shared = 1 OR created_by_agent_id = ?)'); params.push(opts.agentId);
  }
  return (getCrmDb().prepare(`SELECT * FROM crm_saved_views WHERE ${wh.join(' AND ')} ORDER BY updated_at DESC`).all(...params) as any[])
    .map(rowToView);
}

export function updateSavedView(tenantId: string, id: string, patch: Partial<SavedView>): SavedView | null {
  const ex = getSavedView(tenantId, id);
  if (!ex) return null;
  const merged = { ...ex, ...patch };
  getCrmDb().prepare(`
    UPDATE crm_saved_views SET name=?, filter_json=?, sort_json=?, shared=?, updated_at=?
    WHERE id = ? AND tenant_id = ?
  `).run(merged.name, JSON.stringify(merged.filter || {}),
    merged.sort ? JSON.stringify(merged.sort) : null,
    merged.shared ? 1 : 0, now(), id, tenantId);
  return getSavedView(tenantId, id);
}

export function deleteSavedView(tenantId: string, id: string): boolean {
  return getCrmDb().prepare('DELETE FROM crm_saved_views WHERE id = ? AND tenant_id = ?').run(id, tenantId).changes > 0;
}

// ─── Bulk actions ──────────────────────────────────────────────────────
export interface BulkCardAction {
  action: 'move' | 'tag' | 'untag' | 'assign' | 'delete' | 'archive' | 'update_value';
  ids: string[];
  toColumnId?: string;
  tag?: string;
  agentId?: string;
  valueCents?: number;
}

export interface BulkResult { ok: number; failed: number; }

export function bulkCardAction(tenantId: string, op: BulkCardAction): BulkResult {
  const db = getCrmDb();
  let ok = 0, failed = 0;
  const tx = db.transaction(() => {
    for (const id of op.ids) {
      try {
        switch (op.action) {
          case 'move':
            if (!op.toColumnId) throw new Error('toColumnId required');
            store.moveCard(tenantId, id, op.toColumnId);
            break;
          case 'assign':
            db.prepare('UPDATE crm_cards SET owner_agent_id = ?, updated_at = ? WHERE id = ? AND tenant_id = ?')
              .run(op.agentId ?? null, now(), id, tenantId);
            break;
          case 'tag': {
            const card = db.prepare('SELECT labels_json FROM crm_cards WHERE id = ? AND tenant_id = ?').get(id, tenantId) as any;
            if (!card) throw new Error('not found');
            const labels: string[] = JSON.parse(card.labels_json || '[]');
            if (op.tag && !labels.includes(op.tag)) labels.push(op.tag);
            db.prepare('UPDATE crm_cards SET labels_json = ?, updated_at = ? WHERE id = ? AND tenant_id = ?')
              .run(JSON.stringify(labels), now(), id, tenantId);
            break;
          }
          case 'untag': {
            const card = db.prepare('SELECT labels_json FROM crm_cards WHERE id = ? AND tenant_id = ?').get(id, tenantId) as any;
            if (!card) throw new Error('not found');
            const labels: string[] = JSON.parse(card.labels_json || '[]').filter((l: string) => l !== op.tag);
            db.prepare('UPDATE crm_cards SET labels_json = ?, updated_at = ? WHERE id = ? AND tenant_id = ?')
              .run(JSON.stringify(labels), now(), id, tenantId);
            break;
          }
          case 'update_value':
            db.prepare('UPDATE crm_cards SET value_cents = ?, updated_at = ? WHERE id = ? AND tenant_id = ?')
              .run(op.valueCents ?? 0, now(), id, tenantId);
            break;
          case 'delete':
            db.prepare('DELETE FROM crm_cards WHERE id = ? AND tenant_id = ?').run(id, tenantId);
            break;
          case 'archive':
            // archive via custom_fields_json archived=true
            db.prepare(`UPDATE crm_cards SET custom_fields_json = json_set(COALESCE(custom_fields_json,'{}'), '$.archived', json('true')), updated_at = ? WHERE id = ? AND tenant_id = ?`)
              .run(now(), id, tenantId);
            break;
        }
        ok++;
      } catch { failed++; }
    }
  });
  tx();
  return { ok, failed };
}

export interface BulkContactAction {
  action: 'tag' | 'untag' | 'delete' | 'set_source' | 'set_custom_field';
  ids: string[];
  tag?: string;
  source?: string;
  fieldKey?: string;
  fieldValue?: unknown;
}

export function bulkContactAction(tenantId: string, op: BulkContactAction): BulkResult {
  const db = getCrmDb();
  let ok = 0, failed = 0;
  const tx = db.transaction(() => {
    for (const id of op.ids) {
      try {
        switch (op.action) {
          case 'tag': {
            const c = db.prepare('SELECT tags_json FROM crm_contacts WHERE id = ? AND tenant_id = ?').get(id, tenantId) as any;
            if (!c) throw new Error('not found');
            const tags: string[] = JSON.parse(c.tags_json || '[]');
            if (op.tag && !tags.includes(op.tag)) tags.push(op.tag);
            db.prepare('UPDATE crm_contacts SET tags_json = ?, updated_at = ? WHERE id = ? AND tenant_id = ?')
              .run(JSON.stringify(tags), now(), id, tenantId);
            break;
          }
          case 'untag': {
            const c = db.prepare('SELECT tags_json FROM crm_contacts WHERE id = ? AND tenant_id = ?').get(id, tenantId) as any;
            if (!c) throw new Error('not found');
            const tags: string[] = JSON.parse(c.tags_json || '[]').filter((t: string) => t !== op.tag);
            db.prepare('UPDATE crm_contacts SET tags_json = ?, updated_at = ? WHERE id = ? AND tenant_id = ?')
              .run(JSON.stringify(tags), now(), id, tenantId);
            break;
          }
          case 'set_source':
            db.prepare('UPDATE crm_contacts SET source = ?, updated_at = ? WHERE id = ? AND tenant_id = ?')
              .run(op.source ?? null, now(), id, tenantId);
            break;
          case 'set_custom_field': {
            if (!op.fieldKey) throw new Error('fieldKey required');
            db.prepare(`UPDATE crm_contacts SET custom_fields_json = json_set(COALESCE(custom_fields_json,'{}'), ?, ?), updated_at = ? WHERE id = ? AND tenant_id = ?`)
              .run('$.' + op.fieldKey, String(op.fieldValue ?? ''), now(), id, tenantId);
            break;
          }
          case 'delete':
            db.prepare('DELETE FROM crm_contacts WHERE id = ? AND tenant_id = ?').run(id, tenantId);
            break;
        }
        ok++;
      } catch { failed++; }
    }
  });
  tx();
  return { ok, failed };
}

// ─── Backfill FTS (idempotent — safe to run after schema migration) ────
export function backfillFTS(): { cards: number; contacts: number; activities: number; notes: number } {
  const db = getCrmDb();
  const res = { cards: 0, contacts: 0, activities: 0, notes: 0 };
  res.cards = (db.prepare('INSERT OR REPLACE INTO crm_fts_cards(rowid, title, description) SELECT rowid, title, COALESCE(description,\'\') FROM crm_cards').run() as any).changes || 0;
  res.contacts = (db.prepare('INSERT OR REPLACE INTO crm_fts_contacts(rowid, name, email, phone, notes) SELECT rowid, name, COALESCE(email,\'\'), COALESCE(phone,\'\'), COALESCE(notes,\'\') FROM crm_contacts').run() as any).changes || 0;
  res.activities = (db.prepare('INSERT OR REPLACE INTO crm_fts_activities(rowid, content) SELECT rowid, content FROM crm_activities').run() as any).changes || 0;
  res.notes = (db.prepare('INSERT OR REPLACE INTO crm_fts_notes(rowid, content) SELECT rowid, content FROM crm_contact_notes').run() as any).changes || 0;
  return res;
}
