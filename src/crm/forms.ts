/**
 * Forms & Webhooks — Onda 18.
 *
 * 3 capture surfaces:
 *   1. Hosted form at /p/forms/:slug (HTML render + submit endpoint)
 *   2. Embed.js at /p/forms/:slug/embed.js — drop into any site via <script src=...>
 *   3. Inbound webhook at /p/hooks/:hookKey — accepts arbitrary JSON payload
 *
 * All three apply a mapping_json to turn source payload into a CRM contact
 * (and optionally a card on a specific board/column).
 */

import { randomBytes, createHmac, timingSafeEqual } from 'crypto';
import { getCrmDb } from './schema.js';
import * as store from './store.js';

function nid(prefix: string): string { return prefix + '_' + randomBytes(6).toString('hex'); }
function genKey(prefix: string): string { return prefix + '_' + randomBytes(16).toString('base64url'); }

export interface FormFieldDef {
  name: string;               // form field name
  label: string;              // UI label
  type: 'text' | 'email' | 'phone' | 'textarea' | 'select' | 'number' | 'hidden';
  required?: boolean;
  options?: string[];          // for select
  placeholder?: string;
}

export interface FieldMapping {
  // source field → CRM target
  //   target: "contact.name" | "contact.email" | "contact.phone" | "contact.source"
  //         | "contact.customFields.<key>" | "card.title" | "card.description" | "card.valueCents"
  [sourceField: string]: string;
}

export interface FormDef {
  id: string;
  tenantId: string;
  name: string;
  slug: string;
  publicKey: string;
  fields: FormFieldDef[];
  mapping: FieldMapping;
  redirectUrl?: string;
  boardId?: string;
  columnId?: string;
  defaultSource?: string;
  notifyEmails?: string[];
}

function rowToForm(r: any): FormDef {
  return {
    id: r.id, tenantId: r.tenant_id, name: r.name, slug: r.slug, publicKey: r.public_key,
    fields: JSON.parse(r.fields_json || '[]'),
    mapping: JSON.parse(r.mapping_json || '{}'),
    redirectUrl: r.redirect_url ?? undefined,
    boardId: r.board_id ?? undefined,
    columnId: r.column_id ?? undefined,
    defaultSource: r.default_source ?? undefined,
    notifyEmails: JSON.parse(r.notify_emails_json || '[]'),
  };
}

export function getFormBySlug(slug: string): FormDef | null {
  const r = getCrmDb().prepare('SELECT * FROM crm_forms WHERE slug = ?').get(slug) as any;
  return r ? rowToForm(r) : null;
}

export function getFormById(tenantId: string, id: string): FormDef | null {
  const r = getCrmDb().prepare('SELECT * FROM crm_forms WHERE id = ? AND tenant_id = ?').get(id, tenantId) as any;
  return r ? rowToForm(r) : null;
}

export function listForms(tenantId: string): FormDef[] {
  const rows = getCrmDb().prepare('SELECT * FROM crm_forms WHERE tenant_id = ? ORDER BY created_at DESC').all(tenantId) as any[];
  return rows.map(rowToForm);
}

function slugify(s: string): string {
  return s.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

export function createForm(tenantId: string, input: {
  name: string; slug?: string; fields: FormFieldDef[]; mapping: FieldMapping;
  redirectUrl?: string; boardId?: string; columnId?: string; defaultSource?: string;
  notifyEmails?: string[];
}): FormDef {
  const db = getCrmDb();
  const id = nid('crm_form');
  let slug = input.slug ? slugify(input.slug) : slugify(input.name) || id.slice(-8);
  // Ensure unique
  let attempt = 0;
  while (db.prepare('SELECT 1 FROM crm_forms WHERE slug = ?').get(slug)) {
    attempt++;
    slug = slugify(input.name) + '-' + attempt;
    if (attempt > 50) { slug = id.slice(-12); break; }
  }
  const publicKey = genKey('pfk');
  db.prepare(`
    INSERT INTO crm_forms
      (id, tenant_id, name, slug, public_key, fields_json, mapping_json, redirect_url,
       board_id, column_id, default_source, notify_emails_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, tenantId, input.name, slug, publicKey,
    JSON.stringify(input.fields), JSON.stringify(input.mapping),
    input.redirectUrl ?? null, input.boardId ?? null, input.columnId ?? null,
    input.defaultSource ?? 'form', JSON.stringify(input.notifyEmails ?? []), Date.now(),
  );
  return getFormById(tenantId, id)!;
}

export function updateForm(tenantId: string, id: string, patch: Partial<FormDef>): FormDef | null {
  const db = getCrmDb();
  const existing = getFormById(tenantId, id);
  if (!existing) return null;
  const merged = { ...existing, ...patch };
  db.prepare(`
    UPDATE crm_forms SET name = ?, fields_json = ?, mapping_json = ?, redirect_url = ?,
      board_id = ?, column_id = ?, default_source = ?, notify_emails_json = ?
    WHERE id = ? AND tenant_id = ?
  `).run(
    merged.name, JSON.stringify(merged.fields), JSON.stringify(merged.mapping),
    merged.redirectUrl ?? null, merged.boardId ?? null, merged.columnId ?? null,
    merged.defaultSource ?? null, JSON.stringify(merged.notifyEmails ?? []), id, tenantId,
  );
  return getFormById(tenantId, id);
}

export function deleteForm(tenantId: string, id: string): boolean {
  const r = getCrmDb().prepare('DELETE FROM crm_forms WHERE id = ? AND tenant_id = ?').run(id, tenantId);
  return r.changes > 0;
}

// ─── Mapping engine ─────────────────────────────────────────────────────
export function applyMapping(mapping: FieldMapping, payload: Record<string, any>): {
  contact: Record<string, any>;
  card: Record<string, any>;
} {
  const contact: Record<string, any> = {};
  const card: Record<string, any> = {};
  for (const [srcKey, targetPath] of Object.entries(mapping)) {
    const value = getByPath(payload, srcKey);
    if (value === undefined || value === null || value === '') continue;

    if (targetPath.startsWith('contact.customFields.')) {
      const fieldKey = targetPath.slice('contact.customFields.'.length);
      contact.customFields = contact.customFields || {};
      contact.customFields[fieldKey] = value;
    } else if (targetPath.startsWith('contact.')) {
      const field = targetPath.slice('contact.'.length);
      contact[field] = value;
    } else if (targetPath.startsWith('card.')) {
      const field = targetPath.slice('card.'.length);
      if (field === 'valueCents') card[field] = Number(value) || 0;
      else card[field] = value;
    }
  }
  return { contact, card };
}

function getByPath(obj: any, path: string): any {
  const parts = path.split('.');
  let v = obj;
  for (const p of parts) v = v?.[p];
  return v;
}

// ─── Submission handler ────────────────────────────────────────────────
export interface SubmitResult {
  ok: boolean;
  contactId?: string;
  cardId?: string;
  formId?: string;
  redirectUrl?: string;
  error?: string;
}

export function submitForm(
  form: FormDef,
  payload: Record<string, any>,
  meta: { ip?: string; ua?: string } = {},
): SubmitResult {
  const db = getCrmDb();
  const { contact, card } = applyMapping(form.mapping, payload);

  // Contact name is mandatory — fallback to email or phone
  const name = String(contact.name || contact.email || contact.phone || 'Lead sem nome').slice(0, 200);
  const source = contact.source || form.defaultSource || 'form';

  // Check if contact already exists by email or phone
  let contactId: string | undefined;
  if (contact.email) {
    const existing = db.prepare('SELECT id FROM crm_contacts WHERE tenant_id = ? AND LOWER(email) = LOWER(?)')
      .get(form.tenantId, String(contact.email).trim()) as any;
    if (existing) contactId = existing.id;
  }
  if (!contactId && contact.phone) {
    const existing = db.prepare('SELECT id FROM crm_contacts WHERE tenant_id = ? AND phone = ?')
      .get(form.tenantId, String(contact.phone).trim()) as any;
    if (existing) contactId = existing.id;
  }

  if (contactId) {
    // Update existing contact with any new fields
    if (Object.keys(contact).length > 0) {
      store.updateContact(form.tenantId, contactId, {
        ...(contact.name ? { name: contact.name } : {}),
        ...(contact.email ? { email: contact.email } : {}),
        ...(contact.phone ? { phone: contact.phone } : {}),
        ...(contact.customFields ? { customFields: contact.customFields } : {}),
      } as any);
    }
  } else {
    const c = store.createContact(form.tenantId, {
      name,
      email: contact.email,
      phone: contact.phone,
      source,
      tags: [],
      customFields: contact.customFields,
    } as any);
    contactId = c.id;
  }

  // Optionally create card
  let cardId: string | undefined;
  if (form.boardId && form.columnId) {
    const title = card.title || name;
    const newCard = store.createCard(form.tenantId, {
      boardId: form.boardId,
      columnId: form.columnId,
      title,
      description: card.description,
      valueCents: Number(card.valueCents) || 0,
      contactId,
      probability: 0,
      labels: [],
    } as any);
    cardId = newCard?.id;
  }

  // Log submission
  db.prepare(`
    INSERT INTO crm_form_submissions (id, form_id, payload_json, contact_id, card_id, ip, ua, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(nid('crm_sub'), form.id, JSON.stringify(payload), contactId ?? null, cardId ?? null, meta.ip ?? null, meta.ua ?? null, Date.now());

  // Increment counter
  db.prepare('UPDATE crm_forms SET total_submissions = COALESCE(total_submissions, 0) + 1, last_submission_at = ? WHERE id = ?')
    .run(Date.now(), form.id);

  return {
    ok: true,
    contactId,
    cardId,
    formId: form.id,
    redirectUrl: form.redirectUrl,
  };
}

// ─── Inbound webhooks ──────────────────────────────────────────────────
export interface InboundWebhook {
  id: string;
  tenantId: string;
  name: string;
  hookKey: string;
  secret?: string;
  mapping: FieldMapping;
  boardId?: string;
  columnId?: string;
  defaultSource?: string;
  enabled: boolean;
}

function rowToHook(r: any): InboundWebhook {
  return {
    id: r.id, tenantId: r.tenant_id, name: r.name, hookKey: r.hook_key,
    secret: r.secret ?? undefined,
    mapping: JSON.parse(r.mapping_json || '{}'),
    boardId: r.board_id ?? undefined,
    columnId: r.column_id ?? undefined,
    defaultSource: r.default_source ?? undefined,
    enabled: r.enabled === 1,
  };
}

export function getHookByKey(key: string): InboundWebhook | null {
  const r = getCrmDb().prepare('SELECT * FROM crm_inbound_webhooks WHERE hook_key = ? AND enabled = 1').get(key) as any;
  return r ? rowToHook(r) : null;
}

export function listHooks(tenantId: string): InboundWebhook[] {
  return (getCrmDb().prepare('SELECT * FROM crm_inbound_webhooks WHERE tenant_id = ? ORDER BY created_at DESC').all(tenantId) as any[])
    .map(rowToHook);
}

export function createHook(tenantId: string, input: {
  name: string; mapping: FieldMapping; boardId?: string; columnId?: string;
  defaultSource?: string; secret?: string;
}): InboundWebhook {
  const id = nid('crm_hook');
  const hookKey = genKey('ihk');
  getCrmDb().prepare(`
    INSERT INTO crm_inbound_webhooks
      (id, tenant_id, name, hook_key, secret, mapping_json, board_id, column_id, default_source, enabled, total_received, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?)
  `).run(id, tenantId, input.name, hookKey, input.secret ?? null, JSON.stringify(input.mapping),
    input.boardId ?? null, input.columnId ?? null, input.defaultSource ?? 'webhook', Date.now());
  return getHookByKey(hookKey)!;
}

export function deleteHook(tenantId: string, id: string): boolean {
  return getCrmDb().prepare('DELETE FROM crm_inbound_webhooks WHERE id = ? AND tenant_id = ?').run(id, tenantId).changes > 0;
}

export function toggleHook(tenantId: string, id: string, enabled: boolean): boolean {
  return getCrmDb().prepare('UPDATE crm_inbound_webhooks SET enabled = ? WHERE id = ? AND tenant_id = ?')
    .run(enabled ? 1 : 0, id, tenantId).changes > 0;
}

export function verifyHookSignature(hook: InboundWebhook, rawBody: string, providedSig: string | null): boolean {
  if (!hook.secret) return true; // no secret configured → skip
  if (!providedSig) return false;
  const expected = createHmac('sha256', hook.secret).update(rawBody).digest('hex');
  try { return timingSafeEqual(Buffer.from(expected), Buffer.from(providedSig)); }
  catch { return false; }
}

export function processWebhookPayload(
  hook: InboundWebhook,
  payload: Record<string, any>,
  meta: { ip?: string; ua?: string } = {},
): SubmitResult {
  // Reuse submitForm logic by wrapping hook as form-like
  const pseudoForm: FormDef = {
    id: hook.id,
    tenantId: hook.tenantId,
    name: hook.name,
    slug: hook.hookKey,
    publicKey: hook.hookKey,
    fields: [],
    mapping: hook.mapping,
    boardId: hook.boardId,
    columnId: hook.columnId,
    defaultSource: hook.defaultSource,
  };
  const r = submitForm(pseudoForm, payload, meta);
  getCrmDb().prepare('UPDATE crm_inbound_webhooks SET total_received = COALESCE(total_received,0) + 1, last_received_at = ? WHERE id = ?')
    .run(Date.now(), hook.id);
  return r;
}

export function listSubmissions(tenantId: string, formId: string, limit = 100): any[] {
  const form = getFormById(tenantId, formId);
  if (!form) return [];
  return getCrmDb().prepare(
    'SELECT * FROM crm_form_submissions WHERE form_id = ? ORDER BY created_at DESC LIMIT ?'
  ).all(formId, limit) as any[];
}
