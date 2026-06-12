/**
 * 019 — Central de Alertas (crm_alerts).
 *
 * Tabela de notificações persistentes do CRM. Alimenta o sino do header,
 * a aba "Notificações" da sidebar e o badge de não-lidas. Cada linha é um
 * alerta unificado (tarefa vencendo, mensalidade vencendo, vencimento de
 * card, reminder, etc).
 *
 * Pontos de design:
 *   • `dedup_key` + UNIQUE(tenant_id, dedup_key) garante idempotência —
 *     o scheduler roda a cada 60s e re-computa alertas; INSERT OR IGNORE
 *     evita duplicar o mesmo alerta no mesmo "bucket" de dia.
 *   • `read` (0/1) controla o badge de não-lidas; zerado por endpoint.
 *   • Isolamento total por tenant_id (igual às outras 12 tabelas do CRM).
 *   • Alertas de NOVA MENSAGEM NÃO entram aqui — já são tratados pelo
 *     fluxo message.in (SSE + push) e derivados ao vivo de crm_cards
 *     .unread_count. Esta tabela cobre os alertas "standing" (tempo).
 *
 * Idempotente: CREATE TABLE IF NOT EXISTS.
 */
import type { Database } from 'better-sqlite3';

export const version = 19;
export const description = 'Central de Alertas — crm_alerts (sino + histórico)';

function tableExists(db: Database, table: string): boolean {
  const r = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(table) as { name?: string } | undefined;
  return !!r?.name;
}

export function up(db: Database): void {
  if (tableExists(db, 'crm_alerts')) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS crm_alerts (
      id          TEXT PRIMARY KEY,
      tenant_id   TEXT NOT NULL,
      type        TEXT NOT NULL,           -- task_due | task_overdue | billing_due | billing_overdue | due_date | reminder | system
      severity    TEXT NOT NULL DEFAULT 'info',  -- info | warning | urgent
      title       TEXT,
      body        TEXT,
      card_id     TEXT,
      contact_id  TEXT,
      ref_id      TEXT,                    -- task id / subscription id / card id que originou
      url         TEXT,
      dedup_key   TEXT NOT NULL,
      read        INTEGER NOT NULL DEFAULT 0,
      meta        TEXT,                    -- json livre
      created_at  INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_alerts_dedup ON crm_alerts(tenant_id, dedup_key);
    CREATE INDEX IF NOT EXISTS idx_crm_alerts_tenant_created ON crm_alerts(tenant_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_crm_alerts_tenant_read ON crm_alerts(tenant_id, read);
  `);
}

export function down(db: Database): void {
  db.exec(`DROP TABLE IF EXISTS crm_alerts;`);
}
