/**
 * 017 — Mensagens prontas (quick replies) por tenant.
 *
 * Tabela usada pelo botão "Mensagens prontas" do composer dentro de cada
 * card. Cada item guarda o texto e, opcionalmente, uma única mídia
 * (imagem/vídeo/áudio/documento/link). Envio é feito pelo mesmo path do
 * composer manual (POST /channels/:id/send), então qualquer mensagem
 * pronta vira uma mensagem real no histórico do card.
 *
 * Escopo: tenant_id. Sem RBAC gating — segue a regra SaaS do Clow
 * (owner full). Idempotente.
 */
import type { Database } from 'better-sqlite3';

export const version = 17;
export const description = 'add crm_quick_messages table';

function tableExists(db: Database, name: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
    .get(name) as { name?: string } | undefined;
  return Boolean(row?.name);
}

export function up(db: Database): void {
  if (tableExists(db, 'crm_quick_messages')) return;
  db.exec(`
    CREATE TABLE crm_quick_messages (
      id              TEXT PRIMARY KEY,
      tenant_id       TEXT NOT NULL,
      title           TEXT NOT NULL,
      body            TEXT NOT NULL DEFAULT '',
      media_url       TEXT,
      media_type      TEXT,
      media_filename  TEXT,
      sort_order      INTEGER NOT NULL DEFAULT 0,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );
    CREATE INDEX idx_quick_msgs_tenant ON crm_quick_messages (tenant_id, sort_order, created_at);
  `);
}

export function down(db: Database): void {
  db.exec(`DROP TABLE IF EXISTS crm_quick_messages`);
}
