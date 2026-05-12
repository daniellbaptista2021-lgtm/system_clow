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
  // Skip se a tabela nem existe — caso "legacy bridge" do migrator,
  // onde v1 é marcada applied sem rodar up() (DB pré-existente sem
  // crm_subscriptions). Não há nada pra fazer aqui se a tabela não
  // veio da v1 — o ALTER seria no-op safe quando ela aparecer (não
  // aparece, porque só v1 cria, e v1 não rodou). No teste integration,
  // isso ocorre quando crm_migrations legacy diz "v1 ok" mas o schema
  // mock só tem crm_migrations.
  if (!tableExists(db, 'crm_subscriptions')) return;
  if (!hasColumn(db, 'crm_subscriptions', 'last_paid_at')) {
    db.exec(`ALTER TABLE crm_subscriptions ADD COLUMN last_paid_at INTEGER`);
  }
}

export function down(_db: Database): void {
  // SQLite < 3.35 não suporta DROP COLUMN. Esse campo é opcional e
  // não quebra nada se ficar — no-op safe.
}
