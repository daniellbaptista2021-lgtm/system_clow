/**
 * 002 — Add last_paid_at to crm_subscriptions.
 *
 * Sem isso, não dava pra distinguir "sub recém-criada esperando primeiro
 * pagamento" de "sub paga, próxima cobrança em 30 dias" — ambas tinham
 * o mesmo {status:'active', nextChargeAt:futuro}. Resultado: o card no
 * CRM mostrava "Paga" pra subs que nunca foram pagas, e o botão
 * "Marcar como pago" sumia errado.
 *
 * Esse campo é setado pelo markPaid() em src/crm/billing.ts e a UI
 * decide o estado visual baseado nele (pago_no_ciclo_atual vs
 * aguardando_pagamento).
 */
import type { Database } from 'better-sqlite3';

export const version = 2;
export const description = 'add last_paid_at to crm_subscriptions';

function hasColumn(db: Database, table: string, col: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === col);
}

export function up(db: Database): void {
  if (!hasColumn(db, 'crm_subscriptions', 'last_paid_at')) {
    db.exec(`ALTER TABLE crm_subscriptions ADD COLUMN last_paid_at INTEGER`);
  }
}

export function down(_db: Database): void {
  // SQLite < 3.35 não suporta DROP COLUMN. Esse campo é opcional e
  // não quebra nada se ficar — no-op safe.
}
