/**
 * Card line items — link inventory products to cards (deals).
 *
 * Schema (migration v2):
 *   crm_card_items (card_id, inventory_id, qty, unit_price_cents)
 *
 * Behaviors:
 *   - addItemToCard: appends; recalculates card.value_cents if no manual override
 *   - removeItemFromCard: removes + recalc
 *   - On card moved to "Ganho": commit stock decrement (idempotent via flag)
 */

import { getCrmDb } from './schema.js';
import * as store from './store.js';
import type { Card } from './types.js';

// ─── Migration v2: line items table ─────────────────────────────────────
function ensureLineItemsTable(): void {
  const db = getCrmDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS crm_card_items (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      card_id TEXT NOT NULL REFERENCES crm_cards(id) ON DELETE CASCADE,
      inventory_id TEXT NOT NULL REFERENCES crm_inventory(id) ON DELETE RESTRICT,
      qty INTEGER NOT NULL DEFAULT 1,
      unit_price_cents INTEGER NOT NULL,
      stock_committed INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_card_items_card ON crm_card_items(card_id);
    CREATE INDEX IF NOT EXISTS idx_card_items_tenant ON crm_card_items(tenant_id);
  `);
}

export interface CardItem {
  id: string;
  tenantId: string;
  cardId: string;
  inventoryId: string;
  qty: number;
  unitPriceCents: number;
  stockCommitted: boolean;
  createdAt: number;
}

// ─── CRUD ───────────────────────────────────────────────────────────────
export function listItemsByCard(tenantId: string, cardId: string): CardItem[] {
  ensureLineItemsTable();
  const db = getCrmDb();
  const rows = db.prepare(`
    SELECT * FROM crm_card_items WHERE tenant_id = ? AND card_id = ? ORDER BY created_at ASC
  `).all(tenantId, cardId) as any[];
  return rows.map(rowToItem);
}

export function addItemToCard(tenantId: string, cardId: string, input: {
  inventoryId: string; qty: number; unitPriceCents?: number;
}): CardItem | null {
  ensureLineItemsTable();
  const db = getCrmDb();
  const card = store.getCard(tenantId, cardId);
  if (!card) return null;
  // Pull product to default the price
  const product = store.listInventory(tenantId).find(p => p.id === input.inventoryId);
  if (!product) return null;
  if (product.stock < input.qty) {
    throw new Error(`Estoque insuficiente: ${product.name} tem ${product.stock}, pedido ${input.qty}`);
  }
  const item: CardItem = {
    id: 'crm_li_' + Math.random().toString(36).slice(2, 14),
    tenantId, cardId,
    inventoryId: input.inventoryId,
    qty: input.qty,
    unitPriceCents: input.unitPriceCents ?? product.priceCents,
    stockCommitted: false,
    createdAt: Date.now(),
  };
  db.prepare(`
    INSERT INTO crm_card_items (id, tenant_id, card_id, inventory_id, qty, unit_price_cents, stock_committed, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?)
  `).run(item.id, item.tenantId, item.cardId, item.inventoryId, item.qty, item.unitPriceCents, item.createdAt);
  recalcCardValue(tenantId, cardId);
  store.logActivity(tenantId, {
    cardId, contactId: card.contactId, type: 'system', channel: 'manual',
    content: `📦 Item adicionado: ${input.qty}x ${product.name}`,
  });
  return item;
}

export function removeItemFromCard(tenantId: string, cardId: string, itemId: string): boolean {
  ensureLineItemsTable();
  const db = getCrmDb();
  const r = db.prepare('DELETE FROM crm_card_items WHERE id = ? AND tenant_id = ? AND card_id = ?').run(itemId, tenantId, cardId);
  if (r.changes > 0) recalcCardValue(tenantId, cardId);
  return r.changes > 0;
}

function rowToItem(r: any): CardItem {
  return {
    id: r.id, tenantId: r.tenant_id, cardId: r.card_id, inventoryId: r.inventory_id,
    qty: r.qty, unitPriceCents: r.unit_price_cents,
    stockCommitted: r.stock_committed === 1, createdAt: r.created_at,
  };
}

// ─── Auto: recalc card.value_cents = sum(items) ─────────────────────────
function recalcCardValue(tenantId: string, cardId: string): void {
  const db = getCrmDb();
  const r = db.prepare(`
    SELECT COALESCE(SUM(qty * unit_price_cents), 0) as total FROM crm_card_items
    WHERE tenant_id = ? AND card_id = ?
  `).get(tenantId, cardId) as any;
  if (r) store.updateCard(tenantId, cardId, { valueCents: r.total });
}

// ─── Stock commit on card won ───────────────────────────────────────────
/**
 * Called when a card moves to a terminal "won" column.
 * For each item not yet committed: decrement inventory + mark committed.
 * Idempotent: re-running won't double-decrement.
 */
export function commitStockForWonCard(tenantId: string, cardId: string): void {
  const items = listItemsByCard(tenantId, cardId);
  for (const item of items) {
    if (item.stockCommitted) continue;
    try {
      const updated = store.updateInventoryStock(tenantId, item.inventoryId, -item.qty);
      if (!updated) continue;
      const db = getCrmDb();
      db.prepare('UPDATE crm_card_items SET stock_committed = 1 WHERE id = ?').run(item.id);
      const product = store.listInventory(tenantId).find(p => p.id === item.inventoryId);
      store.logActivity(tenantId, {
        cardId, contactId: store.getCard(tenantId, cardId)?.contactId,
        type: 'system', channel: 'manual',
        content: `📦 Estoque baixado: -${item.qty} ${product?.name || item.inventoryId} (restante: ${updated.stock})`,
      });
      // Low stock alert
      if (updated.stock <= 5 && updated.stock > 0) {
        store.logActivity(tenantId, {
          cardId, type: 'system', channel: 'ai',
          content: `⚠️ Estoque baixo: ${product?.name} (${updated.stock} restantes)`,
        });
      } else if (updated.stock <= 0) {
        store.logActivity(tenantId, {
          cardId, type: 'system', channel: 'ai',
          content: `🚨 Estoque ZERADO: ${product?.name}`,
        });
      }
    } catch (e: any) {
      console.warn('[stock commit] failed', e.message);
    }
  }
}
