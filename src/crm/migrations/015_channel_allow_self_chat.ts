/**
 * 015 — Adiciona toggle por canal pra aceitar self-chat (msgs com
 * phone == numero conectado).
 *
 * Contexto: Onda 60 introduziu filtro em parseWebhook que dropa msgs
 * onde phone == connectedPhone (Z-API as vezes ecoa outbound como
 * inbound com receive-all-notifications). O filtro era necessario pra
 * evitar dup de history. Mas alguns clientes (Daniel/PV 2026-05-08)
 * precisam ACEITAR self-msgs reais — site/sistema externo usa a Z-API
 * da PV pra mandar mensagens-tracking pro proprio numero quando lead
 * clica em ad. Sem essa flag, esses leads ficam invisiveis no CRM.
 *
 * Comportamento:
 *   - allow_self_chat=0 (default): mantem filtro original. Self-msgs sao
 *     dropadas em parseWebhook.
 *   - allow_self_chat=1: aceita self-msgs que tem fromMe=true (msgs
 *     enviadas via API por sistema externo). Self-msgs com fromMe=false
 *     continuam dropadas (sao ecos do receive-all-notifications).
 *
 * Bot AI dispatch (webhooks.ts) SEMPRE dropa self-phone, independente
 * dessa flag — evita loop de bot conversando consigo mesmo.
 *
 * Idempotente. Down: no-op (SQLite nao suporta DROP COLUMN seguro).
 */
import type { Database } from 'better-sqlite3';

export const version = 15;
export const description = 'add allow_self_chat to crm_channels';

function hasColumn(db: Database, table: string, col: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === col);
}

export function up(db: Database): void {
  if (!hasColumn(db, 'crm_channels', 'allow_self_chat')) {
    db.exec(`ALTER TABLE crm_channels ADD COLUMN allow_self_chat INTEGER NOT NULL DEFAULT 0`);
  }
}

export function down(_db: Database): void {
  // no-op: campo opcional, manter pra rollback seguro
}
