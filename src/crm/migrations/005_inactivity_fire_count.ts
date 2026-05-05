/**
 * 005 — Adiciona inactivity_fire_count em crm_card_agent_state.
 *
 * Conta quantas vezes o timer de inatividade ja disparou pra esse card
 * desde a ultima resposta do cliente. PR 4 da Onda 62 usa pra:
 *   - 1a vez: agente decide (cobra / morno / promove com tag frio / perdido)
 *   - 2a vez: agente decide com prompt mais firme
 *   - 3a vez: scheduler FORCA marcar_morno (sem chamar LLM) — nao pode
 *     ficar cobrando 5x o cliente.
 *
 * Reseta pra 0 quando o cliente responde (recordAgentTurn 'client') e
 * tambem quando o card e promovido entre colunas (executePromotion).
 */
import type { Database } from 'better-sqlite3';

export const version = 5;
export const description = 'add inactivity_fire_count to crm_card_agent_state';

function tableExists(db: Database, table: string): boolean {
  const r = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(table) as { name?: string } | undefined;
  return !!r?.name;
}

function hasColumn(db: Database, table: string, col: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === col);
}

export function up(db: Database): void {
  if (!tableExists(db, 'crm_card_agent_state')) return;
  if (!hasColumn(db, 'crm_card_agent_state', 'inactivity_fire_count')) {
    db.exec(`ALTER TABLE crm_card_agent_state ADD COLUMN inactivity_fire_count INTEGER NOT NULL DEFAULT 0`);
  }
}

export function down(_db: Database): void {
  // SQLite < 3.35 nao suporta DROP COLUMN. Field e opcional, no-op safe.
}
