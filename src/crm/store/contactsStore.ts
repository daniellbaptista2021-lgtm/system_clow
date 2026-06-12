// CRM contactsStore module — split out from the legacy monolithic file in a refactor.
// Edit this file directly; scripts/split-store.cjs is retained only as a record
// of how the original was decomposed (it ran once against the .ts.bak snapshot).
import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import { getCrmDb } from '.././schema.js';
import type {
  Board, BoardColumn, Contact, Card, Activity, Agent, Channel2,
  Subscription, Automation, InventoryItem, BoardType, ActivityType,
  Channel, MediaType, ChannelType, ChannelStatus, BillingCycle, SubscriptionStatus, AgentRole,
} from '.././types.js';
import type { Segment, SegmentFilter, BulkContactOp } from '.././types.js';
import type { Swimlane, Checklist, ChecklistItem, BoardSettings, ColumnStageType } from '.././types.js';
import type { Team, AgentPermissions, AgentMetricsPro, SlaRule,
              Label, QuickReply, InboxRule } from '.././types.js';
import type { ActivityFilter, ReminderChannel, ReminderStatus, ReminderPro } from '.././types.js';
import type { InventoryCategory, InventoryVariant, InventoryMovement,
              Proposal, ProposalStatus, ProposalTemplate } from '.././types.js';
import type { StripeConnectAccount, InvoicePro, InvoiceStatus, Coupon, DunningLog, MrrSnapshot } from '.././types.js';
import type { AutomationLog, AssignmentRule, AssignmentConditions, AssignmentLog } from '.././types.js';
import type { ChannelTemplate, ChannelHealth, ChannelMetrics } from '.././types.js';
import { now, getAutoAssign, getCommitStock, getPublish, getEmit, nid, J, HEADER_ALIASES } from './_internals.js';
import type { ImportResult, EvalContext } from './_internals.js';


export function createContact(tenantId: string, input: {
  name: string; phone?: string; email?: string; avatarUrl?: string;
  tags?: string[]; customFields?: Record<string, unknown>; notes?: string; source?: string;
  company?: string; title?: string; website?: string; address?: string;
  birthdateTs?: number; cpfCnpj?: string; leadScore?: number;
}): Contact {
  const db = getCrmDb();
  const c: Contact = {
    id: nid('crm_contact'),
    tenantId,
    name: input.name,
    phone: input.phone,
    email: input.email,
    avatarUrl: input.avatarUrl,
    tags: input.tags ?? [],
    customFields: input.customFields ?? {},
    notes: input.notes,
    source: input.source,
    company: input.company,
    title: input.title,
    website: input.website,
    address: input.address,
    birthdateTs: input.birthdateTs,
    cpfCnpj: input.cpfCnpj,
    leadScore: input.leadScore,
    createdAt: now(),
    updatedAt: now(),
  };
  db.prepare(`
    INSERT INTO crm_contacts (id, tenant_id, name, phone, email, avatar_url, tags_json, custom_fields_json, notes, source,
      company, title, website, address, birthdate_ts, cpf_cnpj, lead_score, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(c.id, c.tenantId, c.name, c.phone ?? null, c.email ?? null, c.avatarUrl ?? null,
    J.stringify(c.tags), J.stringify(c.customFields), c.notes ?? null, c.source ?? null,
    c.company ?? null, c.title ?? null, c.website ?? null, c.address ?? null,
    c.birthdateTs ?? null, c.cpfCnpj ?? null, c.leadScore ?? 0,
    c.createdAt, c.updatedAt);
  return c;
}

export function findContactByPhone(tenantId: string, phone: string): Contact | null {
  const db = getCrmDb();
  const cleaned = phone.replace(/\D/g, '');
  // Try exact + last 10 digits (Brazil phone variants w/ or w/o country code)
  const r = db.prepare(`
    SELECT * FROM crm_contacts WHERE tenant_id = ? AND (phone = ? OR phone = ? OR phone LIKE ?)
    LIMIT 1
  `).get(tenantId, phone, cleaned, `%${cleaned.slice(-10)}`) as any;
  return r ? rowToContact(r) : null;
}

export function findContactByEmail(tenantId: string, email: string): Contact | null {
  const db = getCrmDb();
  const r = db.prepare('SELECT * FROM crm_contacts WHERE tenant_id = ? AND LOWER(email) = LOWER(?)')
    .get(tenantId, email) as any;
  return r ? rowToContact(r) : null;
}

export function getContact(tenantId: string, contactId: string): Contact | null {
  const db = getCrmDb();
  const r = db.prepare('SELECT * FROM crm_contacts WHERE id = ? AND tenant_id = ?').get(contactId, tenantId) as any;
  return r ? rowToContact(r) : null;
}

export function searchContacts(tenantId: string, query: string, limit = 100): Contact[] {
  const db = getCrmDb();
  const raw = String(query || '').trim();
  if (!raw) return [];

  // Normalizacao: lowercase + remove acentos
  const norm = raw.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const qLike = `%${norm}%`;

  // Digitos puros: pra phone E cpf_cnpj (ambos podem ter formatacao)
  const digits = raw.replace(/\D/g, '');
  const digitsLike = digits ? `%${digits}%` : null;

  // Construcao dinamica
  const wh: string[] = ['tenant_id = ?', 'deleted_at IS NULL'];
  const params: any[] = [tenantId];

  // Match por nome/email/empresa (normalizado)
  // SQLite nao tem unaccent nativo, mas como o LIKE eh case-sensitive,
  // comparamos LOWER(coluna) com qLike (que ja eh lowercase). Acentos: o usuario
  // pode digitar com ou sem acento, e a comparacao tradicional ja vai falhar.
  // Solucao pratica: gerar tambem variacoes com acento removido na coluna
  // via REPLACE em cascata (gera SQL grande, mas funciona). Pra simplificar:
  // 1) match direto LOWER LIKE (pega quem digita certinho)
  // 2) match removendo acentos comuns no input vs banco
  wh.push('(LOWER(name) LIKE ? OR LOWER(email) LIKE ? OR LOWER(COALESCE(company,\'\')) LIKE ?)');
  params.push(qLike, qLike, qLike);

  // Adicional: phone OU cpf_cnpj (matching por digitos, ignora formatacao)
  let extraSql = '';
  if (digitsLike && digits.length >= 4) {
    // Remove formatacao do banco no momento da query
    extraSql = ` OR REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(phone,''), ' ', ''), '-', ''), '(', ''), ')', '') LIKE ?` +
               ` OR REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(cpf_cnpj,''), '.', ''), '-', ''), '/', ''), ' ', '') LIKE ?`;
    params.push(digitsLike, digitsLike);
  }

  // Substitui o ultimo wh.push pra incluir o OR extra
  wh[wh.length - 1] = '(' + wh[wh.length - 1] + extraSql + ')';

  params.push(Math.min(limit, 500));

  const sql = `SELECT * FROM crm_contacts WHERE ${wh.join(' AND ')} ORDER BY (avatar_url IS NOT NULL) DESC, updated_at DESC LIMIT ?`;
  const rows = db.prepare(sql).all(...params) as any[];
  return rows.map(rowToContact);
}

export function listContacts(tenantId: string, opts: { limit?: number; offset?: number; tag?: string } = {}): Contact[] {
  const db = getCrmDb();
  const limit = Math.min(opts.limit ?? 50, 500);
  const offset = opts.offset ?? 0;
  // Onda 58: ordena por foto WhatsApp primeiro (com avatar), depois updated_at
  const rows = opts.tag
    ? db.prepare(`
        SELECT * FROM crm_contacts WHERE tenant_id = ? AND tags_json LIKE ? AND deleted_at IS NULL
        ORDER BY (avatar_url IS NOT NULL) DESC, updated_at DESC LIMIT ? OFFSET ?
      `).all(tenantId, `%"${opts.tag}"%`, limit, offset) as any[]
    : db.prepare(`
        SELECT * FROM crm_contacts WHERE tenant_id = ? AND deleted_at IS NULL
        ORDER BY (avatar_url IS NOT NULL) DESC, updated_at DESC LIMIT ? OFFSET ?
      `).all(tenantId, limit, offset) as any[];
  return rows.map(rowToContact);
}

export function countContacts(tenantId: string, opts: { tag?: string } = {}): number {
  const db = getCrmDb();
  const r = opts.tag
    ? db.prepare(`SELECT COUNT(*) AS n FROM crm_contacts WHERE tenant_id = ? AND tags_json LIKE ? AND deleted_at IS NULL`).get(tenantId, `%"${opts.tag}"%`) as any
    : db.prepare(`SELECT COUNT(*) AS n FROM crm_contacts WHERE tenant_id = ? AND deleted_at IS NULL`).get(tenantId) as any;
  return r?.n ?? 0;
}

export function updateContact(tenantId: string, contactId: string, patch: Partial<Omit<Contact, 'id' | 'tenantId' | 'createdAt'>>): Contact | null {
  const db = getCrmDb();
  const existing = getContact(tenantId, contactId);
  if (!existing) return null;
  const upd: Contact = { ...existing, ...patch, updatedAt: now() };
  db.prepare(`
    UPDATE crm_contacts SET name = ?, phone = ?, email = ?, avatar_url = ?,
      tags_json = ?, custom_fields_json = ?, notes = ?, source = ?,
      company = ?, title = ?, website = ?, address = ?, birthdate_ts = ?, cpf_cnpj = ?, lead_score = ?,
      updated_at = ?, last_interaction_at = ?
    WHERE id = ? AND tenant_id = ?
  `).run(upd.name, upd.phone ?? null, upd.email ?? null, upd.avatarUrl ?? null,
    J.stringify(upd.tags), J.stringify(upd.customFields), upd.notes ?? null, upd.source ?? null,
    upd.company ?? null, upd.title ?? null, upd.website ?? null, upd.address ?? null,
    upd.birthdateTs ?? null, upd.cpfCnpj ?? null, upd.leadScore ?? 0,
    upd.updatedAt, upd.lastInteractionAt ?? null, contactId, tenantId);
  return upd;
}

export function deleteContact(tenantId: string, contactId: string): boolean {
  const db = getCrmDb();
  const r = db.prepare('DELETE FROM crm_contacts WHERE id = ? AND tenant_id = ?').run(contactId, tenantId);
  return r.changes > 0;
}

export function upsertContactByPhone(tenantId: string, phone: string, input: {
  name?: string; avatarUrl?: string; source?: string;
}): Contact {
  const existing = findContactByPhone(tenantId, phone);
  if (existing) {
    if ((input.name && input.name !== existing.name) || input.avatarUrl) {
      return updateContact(tenantId, existing.id, {
        name: input.name ?? existing.name,
        avatarUrl: input.avatarUrl ?? existing.avatarUrl,
        lastInteractionAt: now(),
      }) ?? existing;
    }
    updateContact(tenantId, existing.id, { lastInteractionAt: now() });
    return existing;
  }
  return createContact(tenantId, {
    name: input.name ?? phone,
    phone,
    avatarUrl: input.avatarUrl,
    source: input.source ?? 'whatsapp',
  });
}

function rowToContact(r: any): Contact {
  return {
    id: r.id, tenantId: r.tenant_id, name: r.name,
    phone: r.phone ?? undefined, email: r.email ?? undefined, avatarUrl: r.avatar_url ?? undefined,
    tags: J.parse(r.tags_json, []),
    customFields: J.parse(r.custom_fields_json, {}),
    notes: r.notes ?? undefined, source: r.source ?? undefined,
    company: r.company ?? undefined,
    title: r.title ?? undefined,
    website: r.website ?? undefined,
    address: r.address ?? undefined,
    birthdateTs: r.birthdate_ts ?? undefined,
    cpfCnpj: r.cpf_cnpj ?? undefined,
    leadScore: r.lead_score ?? undefined,
    createdAt: r.created_at, updatedAt: r.updated_at,
    lastInteractionAt: r.last_interaction_at ?? undefined,
  };
}

function rowToContactPro(r: any): Contact {
  const base = rowToContact(r);
  return {
    ...base,
    company: r.company ?? undefined,
    title: r.title ?? undefined,
    website: r.website ?? undefined,
    address: r.address ?? undefined,
    birthdateTs: r.birthdate_ts ?? undefined,
    cpfCnpj: r.cpf_cnpj ?? undefined,
    leadScore: r.lead_score ?? 0,
  } as any;
}

export function listContactsPro(tenantId: string, opts: { limit?: number; offset?: number; tag?: string } = {}): Contact[] {
  const db = getCrmDb();
  const limit = Math.min(opts.limit ?? 100, 1000);
  const offset = opts.offset ?? 0;
  let sql = 'SELECT * FROM crm_contacts WHERE tenant_id = ?';
  const args: any[] = [tenantId];
  if (opts.tag) { sql += ' AND tags_json LIKE ?'; args.push('%"' + opts.tag + '"%'); }
  sql += ' ORDER BY updated_at DESC LIMIT ? OFFSET ?';
  args.push(limit, offset);
  const rows = db.prepare(sql).all(...args) as any[];
  return rows.map(rowToContactPro);
}

export function findDuplicateContacts(tenantId: string): Array<{ by: 'phone' | 'email' | 'name'; key: string; ids: string[] }> {
  const db = getCrmDb();
  const dups: Array<{ by: 'phone' | 'email' | 'name'; key: string; ids: string[] }> = [];

  // por phone
  const phoneDups = db.prepare(`
    SELECT phone, GROUP_CONCAT(id) as ids, COUNT(*) as cnt
    FROM crm_contacts WHERE tenant_id = ? AND phone IS NOT NULL AND phone != ''
    GROUP BY phone HAVING cnt > 1
  `).all(tenantId) as any[];
  for (const p of phoneDups) dups.push({ by: 'phone', key: p.phone, ids: String(p.ids).split(',') });

  // por email
  const emailDups = db.prepare(`
    SELECT email, GROUP_CONCAT(id) as ids, COUNT(*) as cnt
    FROM crm_contacts WHERE tenant_id = ? AND email IS NOT NULL AND email != ''
    GROUP BY LOWER(email) HAVING cnt > 1
  `).all(tenantId) as any[];
  for (const e of emailDups) dups.push({ by: 'email', key: e.email, ids: String(e.ids).split(',') });

  return dups;
}

export function mergeContacts(tenantId: string, keepId: string, mergeId: string): { ok: boolean; error?: string } {
  const db = getCrmDb();
  const keep = db.prepare('SELECT * FROM crm_contacts WHERE id = ? AND tenant_id = ?').get(keepId, tenantId) as any;
  const merge = db.prepare('SELECT * FROM crm_contacts WHERE id = ? AND tenant_id = ?').get(mergeId, tenantId) as any;
  if (!keep || !merge) return { ok: false, error: 'contact_not_found' };
  if (keepId === mergeId) return { ok: false, error: 'same_contact' };

  // Merge fields: keep tem prioridade, fill missing with merge's
  const mergedTags = Array.from(new Set([...JSON.parse(keep.tags_json || '[]'), ...JSON.parse(merge.tags_json || '[]')]));
  const mergedCustom = { ...JSON.parse(merge.custom_fields_json || '{}'), ...JSON.parse(keep.custom_fields_json || '{}') };

  const merged = {
    name: keep.name || merge.name,
    phone: keep.phone || merge.phone,
    email: keep.email || merge.email,
    avatar_url: keep.avatar_url || merge.avatar_url,
    tags_json: JSON.stringify(mergedTags),
    custom_fields_json: JSON.stringify(mergedCustom),
    notes: [keep.notes, merge.notes].filter(Boolean).join('\n\n---\n\n') || null,
    company: keep.company || merge.company,
    title: keep.title || merge.title,
    website: keep.website || merge.website,
    address: keep.address || merge.address,
    birthdate_ts: keep.birthdate_ts || merge.birthdate_ts,
    cpf_cnpj: keep.cpf_cnpj || merge.cpf_cnpj,
    lead_score: Math.max(keep.lead_score || 0, merge.lead_score || 0),
  };

  const tx = db.transaction(() => {
    // Atualiza keep com campos merged
    db.prepare(`
      UPDATE crm_contacts SET name=?, phone=?, email=?, avatar_url=?, tags_json=?, custom_fields_json=?,
        notes=?, company=?, title=?, website=?, address=?, birthdate_ts=?, cpf_cnpj=?, lead_score=?, updated_at=?
      WHERE id=? AND tenant_id=?
    `).run(merged.name, merged.phone, merged.email, merged.avatar_url, merged.tags_json, merged.custom_fields_json,
      merged.notes, merged.company, merged.title, merged.website, merged.address, merged.birthdate_ts,
      merged.cpf_cnpj, merged.lead_score, Date.now(), keepId, tenantId);

    // Transfere cards e activities
    db.prepare('UPDATE crm_cards SET contact_id = ? WHERE contact_id = ? AND tenant_id = ?').run(keepId, mergeId, tenantId);
    db.prepare('UPDATE crm_activities SET contact_id = ? WHERE contact_id = ? AND tenant_id = ?').run(keepId, mergeId, tenantId);
    db.prepare('UPDATE crm_subscriptions SET contact_id = ? WHERE contact_id = ? AND tenant_id = ?').run(keepId, mergeId, tenantId);

    // Deleta o merge
    db.prepare('DELETE FROM crm_contacts WHERE id = ? AND tenant_id = ?').run(mergeId, tenantId);
  });

  try { tx(); return { ok: true }; }
  catch (err: any) { return { ok: false, error: err.message }; }
}

function parseCsvLine(line: string, sep: string = ','): string[] {
  const result: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i+1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else cur += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === sep) { result.push(cur); cur = ''; }
      else cur += c;
    }
  }
  result.push(cur);
  return result;
}

function detectCsvSeparator(headerLine: string): ',' | ';' {
  // Conta ocorrencias FORA de aspas
  let inQ = false, commas = 0, semis = 0;
  for (const c of headerLine) {
    if (c === '"') inQ = !inQ;
    else if (!inQ && c === ',') commas++;
    else if (!inQ && c === ';') semis++;
  }
  return semis > commas ? ';' : ',';
}

function csvEscape(v: unknown, sep: string = ','): string {
  if (v == null) return '';
  const s = String(v);
  if (s.includes(sep) || s.includes('"') || s.includes('\n') || s.includes('\r')) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function normalizeHeader(h: string): string {
  return String(h || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove acentos
    .toLowerCase()
    .replace(/[^a-z0-9 _]/g, ' ') // mantem so alfanum, espaco, _
    .replace(/\s+/g, ' ')
    .trim();
}

function buildHeaderMap(headerCols: string[]): Record<number, string> {
  const map: Record<number, string> = {};
  for (let i = 0; i < headerCols.length; i++) {
    const norm = normalizeHeader(headerCols[i]);
    if (!norm) continue;
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      if (aliases.includes(norm)) { map[i] = field; break; }
    }
  }
  return map;
}

function cleanPhone(s: string): string {
  return String(s || '').replace(/[^\d]/g, '');
}

export function importContactsCsv(tenantId: string, csvText: string): ImportResult {
  // Remove BOM se presente
  if (csvText.charCodeAt(0) === 0xFEFF) csvText = csvText.slice(1);
  let lines = csvText.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return { total: 0, created: 0, updated: 0, errors: [{ line: 0, error: 'csv vazio ou sem header' }] };

  // Diretiva sep= do Excel
  let sepOverride: ',' | ';' | null = null;
  if (/^sep=([,;])\s*$/i.test(lines[0])) {
    const m = lines[0].match(/^sep=([,;])/i)!;
    sepOverride = m[1] as ',' | ';';
    lines = lines.slice(1);
  }
  if (lines.length < 2) return { total: 0, created: 0, updated: 0, errors: [{ line: 0, error: 'csv vazio ou sem header' }] };

  const sep = sepOverride || detectCsvSeparator(lines[0]);
  const headerCols = parseCsvLine(lines[0], sep);
  const headerMap = buildHeaderMap(headerCols);
  const headerDetected = headerCols.map((h, i) => `${h.trim()} → ${headerMap[i] || '(ignorado)'}`);

  const result: ImportResult = { total: 0, created: 0, updated: 0, errors: [], headerDetected } as any;

  // Se nao achou NENHUM campo conhecido, retorna erro claro
  if (Object.keys(headerMap).length === 0) {
    return { ...result, errors: [{ line: 1, error: `Nenhuma coluna reconhecida. Headers vistos: ${headerCols.map(h => '"'+h.trim()+'"').join(', ')}. Renomeie pra: nome/telefone/email/empresa/cargo/tags/observacoes` }] };
  }

  for (let i = 1; i < lines.length; i++) {
    try {
      const row = parseCsvLine(lines[i], sep);

      // Skip linha totalmente vazia
      if (row.every(c => !c || !String(c).trim())) continue;

      // Mapeia campos via headerMap
      const obj: Record<string, string> = {};
      for (let j = 0; j < headerCols.length && j < row.length; j++) {
        const field = headerMap[j];
        if (field && row[j]) obj[field] = String(row[j]).trim();
      }
      result.total++;

      // Nome: campo name OU fallback phone/email
      let name = obj.name;
      const phone = obj.phone ? cleanPhone(obj.phone) : undefined;
      const email = obj.email;
      if (!name) name = phone || email || '';
      if (!name) {
        result.errors.push({ line: i + 1, error: 'linha sem nome, telefone nem email' });
        continue;
      }

      // Upsert por phone ou email
      const existing = phone
        ? findContactByPhone(tenantId, phone)
        : email
          ? (getCrmDb().prepare('SELECT * FROM crm_contacts WHERE tenant_id=? AND LOWER(email)=LOWER(?)').get(tenantId, email) as any)
          : null;

      const tags = obj.tags ? obj.tags.split(/[;|,]/).map(t => t.trim()).filter(Boolean) : [];
      const fields = {
        name, phone, email,
        company: obj.company || undefined,
        title: obj.title || undefined,
        website: obj.website || undefined,
        address: obj.address || undefined,
        cpfCnpj: obj.cpfCnpj || undefined,
        notes: obj.notes || undefined,
        source: obj.source || 'import',
        tags,
      };

      if (existing) {
        updateContact(tenantId, existing.id, fields as any);
        result.updated++;
      } else {
        createContact(tenantId, fields as any);
        result.created++;
      }
    } catch (err: any) {
      result.errors.push({ line: i + 1, error: err.message });
    }
  }
  return result;
}

export function exportContactsCsv(tenantId: string): string {
  const db = getCrmDb();
  const rows = db.prepare('SELECT * FROM crm_contacts WHERE tenant_id = ? AND deleted_at IS NULL ORDER BY created_at DESC').all(tenantId) as any[];
  const SEP = ';'; // pt-BR Excel default
  const header = ['name', 'phone', 'email', 'company', 'title', 'website', 'address', 'cpf_cnpj', 'lead_score', 'tags', 'source', 'notes', 'created_at'];
  // 'sep=;' no topo: Excel reconhece e força o delimitador correto
  const lines: string[] = [`sep=${SEP}`, header.join(SEP)];
  for (const r of rows) {
    // tags separadas por | dentro do campo (porque ; eh nosso delimitador agora)
    const tags = (() => { try { return JSON.parse(r.tags_json || '[]').join('|'); } catch { return ''; } })();
    lines.push([
      csvEscape(r.name, SEP),
      csvEscape(r.phone, SEP),
      csvEscape(r.email, SEP),
      csvEscape(r.company, SEP),
      csvEscape(r.title, SEP),
      csvEscape(r.website, SEP),
      csvEscape(r.address, SEP),
      csvEscape(r.cpf_cnpj, SEP),
      csvEscape(r.lead_score, SEP),
      csvEscape(tags, SEP),
      csvEscape(r.source, SEP),
      csvEscape(r.notes, SEP),
      csvEscape(new Date(r.created_at).toISOString(), SEP),
    ].join(SEP));
  }
  return lines.join('\r\n');
}

export function bulkContactOp(tenantId: string, op: BulkContactOp): { affected: number; errors: string[] } {
  const db = getCrmDb();
  const errors: string[] = [];
  let affected = 0;

  const tx = db.transaction(() => {
    for (const id of op.ids) {
      try {
        if (op.action === 'delete') {
          const r = db.prepare('DELETE FROM crm_contacts WHERE id = ? AND tenant_id = ?').run(id, tenantId);
          if (r.changes > 0) affected++;
          continue;
        }
        const c = db.prepare('SELECT * FROM crm_contacts WHERE id = ? AND tenant_id = ?').get(id, tenantId) as any;
        if (!c) { errors.push(`${id}: not_found`); continue; }

        if (op.action === 'addTag' && op.payload?.tag) {
          const tags: string[] = JSON.parse(c.tags_json || '[]');
          if (!tags.includes(op.payload.tag)) {
            tags.push(op.payload.tag);
            db.prepare('UPDATE crm_contacts SET tags_json=?, updated_at=? WHERE id=? AND tenant_id=?')
              .run(JSON.stringify(tags), Date.now(), id, tenantId);
            affected++;
          }
        } else if (op.action === 'removeTag' && op.payload?.tag) {
          const tags: string[] = JSON.parse(c.tags_json || '[]');
          const filtered = tags.filter(t => t !== op.payload!.tag);
          if (filtered.length !== tags.length) {
            db.prepare('UPDATE crm_contacts SET tags_json=?, updated_at=? WHERE id=? AND tenant_id=?')
              .run(JSON.stringify(filtered), Date.now(), id, tenantId);
            affected++;
          }
        } else if (op.action === 'updateField' && op.payload?.field) {
          const field = op.payload.field;
          const value = op.payload.value;
          const allowed = new Set(['name','phone','email','company','title','website','address','cpf_cnpj','lead_score','notes','source']);
          if (!allowed.has(field)) { errors.push(`${id}: field ${field} not allowed`); continue; }
          db.prepare(`UPDATE crm_contacts SET ${field}=?, updated_at=? WHERE id=? AND tenant_id=?`)
            .run(value as any, Date.now(), id, tenantId);
          affected++;
        }
      } catch (err: any) { errors.push(`${id}: ${err.message}`); }
    }
  });
  tx();
  return { affected, errors };
}

export function getContactHistory(tenantId: string, contactId: string, opts: { limit?: number; type?: string } = {}): { activities: any[]; cards: any[]; subscriptions: any[] } {
  const db = getCrmDb();
  const limit = opts.limit ?? 500;
  let sql = 'SELECT * FROM crm_activities WHERE tenant_id = ? AND contact_id = ?';
  const args: any[] = [tenantId, contactId];
  if (opts.type) { sql += ' AND type = ?'; args.push(opts.type); }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  args.push(limit);
  const activities = db.prepare(sql).all(...args) as any[];
  const cards = db.prepare('SELECT * FROM crm_cards WHERE tenant_id = ? AND contact_id = ?').all(tenantId, contactId) as any[];
  const subs = db.prepare('SELECT * FROM crm_subscriptions WHERE tenant_id = ? AND contact_id = ?').all(tenantId, contactId) as any[];
  return { activities, cards, subscriptions: subs };
}

export function createSegment(tenantId: string, input: { name: string; description?: string; filter: SegmentFilter }): Segment {
  const db = getCrmDb();
  const s: Segment = {
    id: nid('crm_seg'), tenantId, name: input.name, description: input.description,
    filter: input.filter, createdAt: now(), updatedAt: now(),
  };
  db.prepare(`INSERT INTO crm_segments (id,tenant_id,name,description,filter_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
    .run(s.id, s.tenantId, s.name, s.description ?? null, JSON.stringify(s.filter), s.createdAt, s.updatedAt);
  return s;
}

export function listSegments(tenantId: string): Segment[] {
  const db = getCrmDb();
  const rows = db.prepare('SELECT * FROM crm_segments WHERE tenant_id = ? ORDER BY updated_at DESC').all(tenantId) as any[];
  return rows.map(rowToSegment);
}

export function getSegment(tenantId: string, id: string): Segment | null {
  const db = getCrmDb();
  const r = db.prepare('SELECT * FROM crm_segments WHERE id = ? AND tenant_id = ?').get(id, tenantId) as any;
  return r ? rowToSegment(r) : null;
}

export function updateSegment(tenantId: string, id: string, patch: Partial<Omit<Segment,'id'|'tenantId'|'createdAt'>>): Segment | null {
  const existing = getSegment(tenantId, id);
  if (!existing) return null;
  const upd = { ...existing, ...patch, updatedAt: now() };
  const db = getCrmDb();
  db.prepare('UPDATE crm_segments SET name=?, description=?, filter_json=?, updated_at=? WHERE id=? AND tenant_id=?')
    .run(upd.name, upd.description ?? null, JSON.stringify(upd.filter), upd.updatedAt, id, tenantId);
  return upd;
}

export function deleteSegment(tenantId: string, id: string): boolean {
  const db = getCrmDb();
  const r = db.prepare('DELETE FROM crm_segments WHERE id=? AND tenant_id=?').run(id, tenantId);
  return r.changes > 0;
}

function rowToSegment(r: any): Segment {
  return {
    id: r.id, tenantId: r.tenant_id, name: r.name,
    description: r.description ?? undefined,
    filter: JSON.parse(r.filter_json || '{}') as SegmentFilter,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export function runSegment(tenantId: string, filter: SegmentFilter, limit: number = 500): Contact[] {
  const db = getCrmDb();
  const conds: string[] = ['tenant_id = ?'];
  const args: any[] = [tenantId];

  if (filter.hasPhone) conds.push("phone IS NOT NULL AND phone != ''");
  if (filter.hasEmail) conds.push("email IS NOT NULL AND email != ''");
  if (filter.company) { conds.push('company LIKE ?'); args.push('%' + filter.company + '%'); }
  if (filter.source) { conds.push('source = ?'); args.push(filter.source); }
  if (filter.minLeadScore != null) { conds.push('COALESCE(lead_score,0) >= ?'); args.push(filter.minLeadScore); }
  if (filter.maxLeadScore != null) { conds.push('COALESCE(lead_score,0) <= ?'); args.push(filter.maxLeadScore); }
  if (filter.createdAfter) { conds.push('created_at >= ?'); args.push(filter.createdAfter); }
  if (filter.createdBefore) { conds.push('created_at <= ?'); args.push(filter.createdBefore); }
  if (filter.lastInteractionAfter) { conds.push('last_interaction_at >= ?'); args.push(filter.lastInteractionAfter); }
  if (filter.lastInteractionBefore) { conds.push('last_interaction_at <= ?'); args.push(filter.lastInteractionBefore); }
  if (filter.nameContains) { conds.push('name LIKE ?'); args.push('%' + filter.nameContains + '%'); }

  // Tags via LIKE (aproximacao)
  if (filter.tags && filter.tags.length) {
    const mode = filter.tagsMode || 'any';
    const tagConds = filter.tags.map(() => 'tags_json LIKE ?').join(mode === 'all' ? ' AND ' : ' OR ');
    conds.push('(' + tagConds + ')');
    for (const t of filter.tags) args.push('%"' + t + '"%');
  }

  const sql = `SELECT * FROM crm_contacts WHERE ${conds.join(' AND ')} ORDER BY updated_at DESC LIMIT ?`;
  args.push(Math.min(limit, 2000));
  const rows = db.prepare(sql).all(...args) as any[];

  // customFieldEquals filter na memoria (JSON match)
  let results = rows;
  if (filter.customFieldEquals) {
    results = results.filter(r => {
      const cf = JSON.parse(r.custom_fields_json || '{}');
      for (const [k, v] of Object.entries(filter.customFieldEquals!)) {
        if (cf[k] !== v) return false;
      }
      return true;
    });
  }
  return results.map(rowToContactPro);
}

function rowToInboxRule(r: any): InboxRule {
  return { id: r.id, tenantId: r.tenant_id, name: r.name,
    keyword: r.keyword ?? undefined, assignToAgentId: r.assign_to_agent_id ?? undefined,
    assignToTeamId: r.assign_to_team_id ?? undefined, labelId: r.label_id ?? undefined,
    priority: r.priority ?? 0, enabled: !!r.enabled, createdAt: r.created_at };
}

export function createInboxRule(tenantId: string, input: Omit<InboxRule,'id'|'tenantId'|'createdAt'>): InboxRule {
  const rule: InboxRule = { id: nid('crm_irule'), tenantId, ...input, createdAt: now() };
  getCrmDb().prepare('INSERT INTO crm_inbox_rules (id,tenant_id,name,keyword,assign_to_agent_id,assign_to_team_id,label_id,priority,enabled,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(rule.id, tenantId, rule.name, rule.keyword ?? null, rule.assignToAgentId ?? null, rule.assignToTeamId ?? null, rule.labelId ?? null, rule.priority, rule.enabled ? 1 : 0, rule.createdAt);
  return rule;
}

export function listInboxRules(tenantId: string): InboxRule[] {
  return (getCrmDb().prepare('SELECT * FROM crm_inbox_rules WHERE tenant_id=? ORDER BY priority DESC').all(tenantId) as any[]).map(rowToInboxRule);
}

export function deleteInboxRule(tenantId: string, id: string): boolean {
  return getCrmDb().prepare('DELETE FROM crm_inbox_rules WHERE id=? AND tenant_id=?').run(id, tenantId).changes > 0;
}

export function applyInboxRules(tenantId: string, text: string, cardId: string): { applied: string[]; assignedAgent?: string; appliedLabel?: string } {
  const rules = listInboxRules(tenantId).filter(r => r.enabled);
  const applied: string[] = [];
  let assignedAgent: string | undefined;
  let appliedLabel: string | undefined;
  const lc = (text || '').toLowerCase();
  for (const r of rules) {
    const matches = !r.keyword || lc.includes(r.keyword.toLowerCase());
    if (!matches) continue;
    applied.push(r.id);
    if (r.assignToAgentId && !assignedAgent) {
      getCrmDb().prepare('UPDATE crm_cards SET owner_agent_id=?, updated_at=? WHERE id=? AND tenant_id=?')
        .run(r.assignToAgentId, Date.now(), cardId, tenantId);
      assignedAgent = r.assignToAgentId;
    }
    if (r.labelId && !appliedLabel) appliedLabel = r.labelId;
  }
  return { applied, assignedAgent, appliedLabel };
}
