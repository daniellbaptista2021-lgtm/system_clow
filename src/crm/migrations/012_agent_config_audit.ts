/**
 * 012 — PR 7.1: tabela de audit log pra mudancas de config de agente por coluna.
 *
 * Schema:
 *   crm_agent_config_audit (
 *     id INTEGER PK AUTOINCREMENT,
 *     tenant_id TEXT NOT NULL,
 *     user_id TEXT,            -- agente que fez a mudanca (null = system)
 *     column_id TEXT NOT NULL,
 *     action TEXT NOT NULL,    -- 'column_agent_config_changed'
 *     before_json TEXT,        -- snapshot anterior
 *     after_json TEXT,         -- novo estado
 *     occurred_at INTEGER NOT NULL
 *   )
 *
 * Idempotente (CREATE TABLE IF NOT EXISTS).
 */
import type { Database } from 'better-sqlite3';

export const version = 12;
export const description = 'PR 7.1: agent config audit log table';

export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS crm_agent_config_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL,
      user_id TEXT,
      column_id TEXT NOT NULL,
      action TEXT NOT NULL,
      before_json TEXT,
      after_json TEXT,
      occurred_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_audit_column ON crm_agent_config_audit(column_id, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_audit_tenant ON crm_agent_config_audit(tenant_id, occurred_at DESC);
  `);
}

export function down(_db: Database): void {
  // Forward-only — preservamos audit log mesmo em rollback.
}
