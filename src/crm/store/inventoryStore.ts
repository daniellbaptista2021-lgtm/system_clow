// CRM inventoryStore module — split out from the legacy monolithic file in a refactor.
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


export function createInventoryItem(tenantId: string, input: {
  sku: string; name: string; description?: string; priceCents?: number; stock?: number;
  category?: string; customFields?: Record<string, unknown>;
}): InventoryItem {
  const db = getCrmDb();
  const it: InventoryItem = {
    id: nid('crm_inv'), tenantId, sku: input.sku, name: input.name,
    description: input.description, priceCents: input.priceCents ?? 0,
    stock: input.stock ?? 0, category: input.category,
    customFields: input.customFields ?? {}, createdAt: now(), updatedAt: now(),
  };
  db.prepare(`
    INSERT INTO crm_inventory (id, tenant_id, sku, name, description, price_cents, stock, category, custom_fields_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(it.id, it.tenantId, it.sku, it.name, it.description ?? null, it.priceCents, it.stock,
    it.category ?? null, J.stringify(it.customFields), it.createdAt, it.updatedAt);
  return it;
}

export function listInventory(tenantId: string): InventoryItem[] {
  const db = getCrmDb();
  const rows = db.prepare('SELECT * FROM crm_inventory WHERE tenant_id = ? ORDER BY name ASC').all(tenantId) as any[];
  return rows.map((r: any) => ({
    id: r.id, tenantId: r.tenant_id, sku: r.sku, name: r.name,
    description: r.description ?? undefined, priceCents: r.price_cents, stock: r.stock,
    category: r.category ?? undefined, customFields: J.parse(r.custom_fields_json, {}),
    createdAt: r.created_at, updatedAt: r.updated_at,
  }));
}

export function updateInventoryStock(tenantId: string, itemId: string, delta: number): InventoryItem | null {
  const db = getCrmDb();
  const r = db.prepare(`
    UPDATE crm_inventory SET stock = stock + ?, updated_at = ? WHERE id = ? AND tenant_id = ?
  `).run(delta, now(), itemId, tenantId);
  if (r.changes === 0) return null;
  const row = db.prepare('SELECT * FROM crm_inventory WHERE id = ?').get(itemId) as any;
  return row ? {
    id: row.id, tenantId: row.tenant_id, sku: row.sku, name: row.name,
    description: row.description ?? undefined, priceCents: row.price_cents, stock: row.stock,
    category: row.category ?? undefined, customFields: J.parse(row.custom_fields_json, {}),
    createdAt: row.created_at, updatedAt: row.updated_at,
  } : null;
}

export function createInvCategory(tenantId: string, input: { name: string; parentId?: string }): InventoryCategory {
  const c: InventoryCategory = { id: nid('crm_ivcat'), tenantId, name: input.name, parentId: input.parentId, createdAt: now() };
  getCrmDb().prepare('INSERT INTO crm_inv_categories (id, tenant_id, name, parent_id, created_at) VALUES (?,?,?,?,?)')
    .run(c.id, tenantId, c.name, c.parentId ?? null, c.createdAt);
  return c;
}

export function listInvCategories(tenantId: string): InventoryCategory[] {
  return (getCrmDb().prepare('SELECT * FROM crm_inv_categories WHERE tenant_id=? ORDER BY name').all(tenantId) as any[])
    .map((r: any) => ({ id: r.id, tenantId: r.tenant_id, name: r.name, parentId: r.parent_id ?? undefined, createdAt: r.created_at }));
}

export function deleteInvCategory(tenantId: string, id: string): boolean {
  return getCrmDb().prepare('DELETE FROM crm_inv_categories WHERE id=? AND tenant_id=?').run(id, tenantId).changes > 0;
}

export function createVariant(tenantId: string, input: { inventoryId: string; sku: string; name: string; attrs?: Record<string,string>; stock?: number; priceCents?: number; barcode?: string }): InventoryVariant {
  const v: InventoryVariant = { id: nid('crm_ivvar'), tenantId, inventoryId: input.inventoryId,
    sku: input.sku, name: input.name, attrs: input.attrs || {}, stock: input.stock ?? 0,
    priceCents: input.priceCents, barcode: input.barcode, createdAt: now() };
  getCrmDb().prepare('INSERT INTO crm_inv_variants (id,tenant_id,inventory_id,sku,name,attrs_json,stock,price_cents,barcode,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(v.id, tenantId, v.inventoryId, v.sku, v.name, JSON.stringify(v.attrs), v.stock, v.priceCents ?? null, v.barcode ?? null, v.createdAt);
  return v;
}

export function listVariants(tenantId: string, inventoryId: string): InventoryVariant[] {
  return (getCrmDb().prepare('SELECT * FROM crm_inv_variants WHERE tenant_id=? AND inventory_id=? ORDER BY name').all(tenantId, inventoryId) as any[])
    .map((r: any) => ({ id: r.id, tenantId: r.tenant_id, inventoryId: r.inventory_id,
      sku: r.sku, name: r.name, attrs: JSON.parse(r.attrs_json || '{}'),
      stock: r.stock, priceCents: r.price_cents ?? undefined, barcode: r.barcode ?? undefined, createdAt: r.created_at }));
}

export function deleteVariant(tenantId: string, id: string): boolean {
  return getCrmDb().prepare('DELETE FROM crm_inv_variants WHERE id=? AND tenant_id=?').run(id, tenantId).changes > 0;
}

export function recordMovement(tenantId: string, input: { inventoryId: string; variantId?: string; delta: number; reason?: string; reference?: string; createdByAgentId?: string }): InventoryMovement {
  const db = getCrmDb();
  const m: InventoryMovement = { id: nid('crm_ivmov'), tenantId, inventoryId: input.inventoryId,
    variantId: input.variantId, delta: input.delta, reason: input.reason,
    reference: input.reference, createdByAgentId: input.createdByAgentId, createdAt: now() };
  db.prepare('INSERT INTO crm_inv_movements (id,tenant_id,inventory_id,variant_id,delta,reason,reference,created_by_agent_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(m.id, tenantId, m.inventoryId, m.variantId ?? null, m.delta, m.reason ?? null, m.reference ?? null, m.createdByAgentId ?? null, m.createdAt);
  // Atualiza stock agregado no item OU variante
  if (m.variantId) {
    db.prepare('UPDATE crm_inv_variants SET stock = MAX(0, stock + ?) WHERE id=? AND tenant_id=?').run(m.delta, m.variantId, tenantId);
  }
  db.prepare('UPDATE crm_inventory SET stock = MAX(0, stock + ?), updated_at=? WHERE id=? AND tenant_id=?').run(m.delta, Date.now(), m.inventoryId, tenantId);
  return m;
}

export function listMovements(tenantId: string, inventoryId: string, limit: number = 100): InventoryMovement[] {
  return (getCrmDb().prepare('SELECT * FROM crm_inv_movements WHERE tenant_id=? AND inventory_id=? ORDER BY created_at DESC LIMIT ?')
    .all(tenantId, inventoryId, Math.min(limit, 500)) as any[])
    .map((r: any) => ({ id: r.id, tenantId: r.tenant_id, inventoryId: r.inventory_id,
      variantId: r.variant_id ?? undefined, delta: r.delta, reason: r.reason ?? undefined,
      reference: r.reference ?? undefined, createdByAgentId: r.created_by_agent_id ?? undefined, createdAt: r.created_at }));
}

export function lowStockAlerts(tenantId: string): any[] {
  return getCrmDb().prepare(`
    SELECT id, sku, name, stock, min_stock FROM crm_inventory
    WHERE tenant_id = ? AND min_stock > 0 AND stock <= min_stock
    ORDER BY stock ASC
  `).all(tenantId) as any[];
}

function rowToProposal(r: any): Proposal {
  return {
    id: r.id, tenantId: r.tenant_id, cardId: r.card_id, version: r.version,
    subtotalCents: r.subtotal_cents, discountCents: r.discount_cents,
    taxCents: r.tax_cents, totalCents: r.total_cents,
    validUntilTs: r.valid_until_ts ?? undefined,
    status: (r.status || 'draft') as ProposalStatus,
    terms: r.terms ?? undefined,
    signedAt: r.signed_at ?? undefined, signedBy: r.signed_by ?? undefined, signedIp: r.signed_ip ?? undefined,
    pdfUrl: r.pdf_url ?? undefined,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export function calcProposalTotals(lineItems: Array<{ unitPriceCents: number; quantity: number; discountCents?: number; discountPercent?: number; taxCents?: number; taxPercent?: number }>): { subtotal: number; discount: number; tax: number; total: number } {
  let subtotal = 0, discount = 0, tax = 0;
  for (const li of lineItems) {
    const base = li.unitPriceCents * li.quantity;
    subtotal += base;
    const disc = (li.discountCents || 0) + (li.discountPercent ? Math.round(base * (li.discountPercent / 100)) : 0);
    discount += disc;
    const netAfterDisc = base - disc;
    const tx = (li.taxCents || 0) + (li.taxPercent ? Math.round(netAfterDisc * (li.taxPercent / 100)) : 0);
    tax += tx;
  }
  const total = Math.max(0, subtotal - discount + tax);
  return { subtotal, discount, tax, total };
}

export function createProposal(tenantId: string, input: { cardId: string; validUntilTs?: number; terms?: string }): Proposal | null {
  const db = getCrmDb();
  const card = db.prepare('SELECT id FROM crm_cards WHERE id=? AND tenant_id=?').get(input.cardId, tenantId);
  if (!card) return null;
  const prevVersion = (db.prepare('SELECT COALESCE(MAX(version),0) m FROM crm_proposals WHERE tenant_id=? AND card_id=?').get(tenantId, input.cardId) as any).m;
  const items = db.prepare('SELECT unit_price_cents, qty as quantity, 0 as discount_cents, 0 as discount_percent, 0 as tax_cents, 0 as tax_percent FROM crm_card_items WHERE tenant_id=? AND card_id=?').all(tenantId, input.cardId) as any[];
  const totals = calcProposalTotals(items.map(i => ({
    unitPriceCents: i.unit_price_cents, quantity: i.quantity,
    discountCents: i.discount_cents ?? 0, discountPercent: i.discount_percent ?? 0,
    taxCents: i.tax_cents ?? 0, taxPercent: i.tax_percent ?? 0,
  })));
  const p: Proposal = {
    id: nid('crm_prop'), tenantId, cardId: input.cardId, version: prevVersion + 1,
    subtotalCents: totals.subtotal, discountCents: totals.discount, taxCents: totals.tax, totalCents: totals.total,
    validUntilTs: input.validUntilTs, status: 'draft', terms: input.terms,
    createdAt: now(), updatedAt: now(),
  };
  db.prepare('INSERT INTO crm_proposals (id,tenant_id,card_id,version,subtotal_cents,discount_cents,tax_cents,total_cents,valid_until_ts,status,terms,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(p.id, tenantId, p.cardId, p.version, p.subtotalCents, p.discountCents, p.taxCents, p.totalCents,
         p.validUntilTs ?? null, p.status, p.terms ?? null, p.createdAt, p.updatedAt);
  return p;
}

export function listProposals(tenantId: string, cardId: string): Proposal[] {
  return (getCrmDb().prepare('SELECT * FROM crm_proposals WHERE tenant_id=? AND card_id=? ORDER BY version DESC').all(tenantId, cardId) as any[]).map(rowToProposal);
}

export function getProposal(tenantId: string, id: string): Proposal | null {
  const r = getCrmDb().prepare('SELECT * FROM crm_proposals WHERE id=? AND tenant_id=?').get(id, tenantId) as any;
  return r ? rowToProposal(r) : null;
}

export function updateProposalStatus(tenantId: string, id: string, status: ProposalStatus, meta?: { signedBy?: string; signedIp?: string }): Proposal | null {
  const db = getCrmDb();
  const r = db.prepare('SELECT * FROM crm_proposals WHERE id=? AND tenant_id=?').get(id, tenantId) as any;
  if (!r) return null;
  if (status === 'accepted' && meta?.signedBy) {
    db.prepare('UPDATE crm_proposals SET status=?, signed_at=?, signed_by=?, signed_ip=?, updated_at=? WHERE id=? AND tenant_id=?')
      .run(status, Date.now(), meta.signedBy, meta.signedIp ?? null, Date.now(), id, tenantId);
  } else {
    db.prepare('UPDATE crm_proposals SET status=?, updated_at=? WHERE id=? AND tenant_id=?').run(status, Date.now(), id, tenantId);
  }
  return getProposal(tenantId, id);
}

export function createProposalTemplate(tenantId: string, input: { name: string; items: any[]; defaultTerms?: string; taxPercent?: number; discountPercent?: number; validForDays?: number }): ProposalTemplate {
  const t: ProposalTemplate = { id: nid('crm_ptpl'), tenantId, ...input, createdAt: now() };
  getCrmDb().prepare('INSERT INTO crm_proposal_templates (id,tenant_id,name,items_json,default_terms,tax_percent,discount_percent,valid_for_days,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(t.id, tenantId, t.name, JSON.stringify(t.items), t.defaultTerms ?? null, t.taxPercent ?? null, t.discountPercent ?? null, t.validForDays ?? null, t.createdAt);
  return t;
}

export function listProposalTemplates(tenantId: string): ProposalTemplate[] {
  return (getCrmDb().prepare('SELECT * FROM crm_proposal_templates WHERE tenant_id=? ORDER BY name').all(tenantId) as any[])
    .map((r: any) => ({ id: r.id, tenantId: r.tenant_id, name: r.name,
      items: JSON.parse(r.items_json || '[]'),
      defaultTerms: r.default_terms ?? undefined,
      taxPercent: r.tax_percent ?? undefined,
      discountPercent: r.discount_percent ?? undefined,
      validForDays: r.valid_for_days ?? undefined,
      createdAt: r.created_at }));
}

export function deleteProposalTemplate(tenantId: string, id: string): boolean {
  return getCrmDb().prepare('DELETE FROM crm_proposal_templates WHERE id=? AND tenant_id=?').run(id, tenantId).changes > 0;
}
