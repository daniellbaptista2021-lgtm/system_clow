/**
 * 014 — BYOK: credencial e modelo de IA por tenant.
 *
 * O System Clow virou bonus do Territorio Proprio (ver tenancy/modoBonus.ts) e
 * junto com isso a IA passou a rodar na chave do PROPRIO cliente. Sem essa
 * tabela, o custo por mensagem continuaria sendo nosso — que era justamente o
 * que a cota existia pra conter.
 *
 * `api_key_encrypted` guarda a chave cifrada, nunca em texto puro; `key_hint`
 * guarda so o suficiente pra tela mostrar qual chave e (sk-ant-…a1b2) sem
 * nunca devolver a credencial ao navegador.
 *
 * `model` e o modelo do agente; `crm_model` e o dos agentes de coluna do CRM,
 * separado de proposito: sao cargas de trabalho diferentes e nada obriga o
 * cliente a pagar o modelo caro nas duas.
 *
 * Idempotente (CREATE TABLE IF NOT EXISTS).
 */
import type { Database } from 'better-sqlite3';

export const version = 14;
export const description = 'BYOK: credencial e modelo de IA por tenant';

export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenant_ai_credentials (
      tenant_id         TEXT PRIMARY KEY,
      provider          TEXT NOT NULL,
      api_key_encrypted TEXT NOT NULL,
      base_url          TEXT,
      model             TEXT NOT NULL,
      crm_model         TEXT,
      key_hint          TEXT NOT NULL,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL,
      last_ok_at        INTEGER,
      last_error        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tenant_ai_credentials_updated
      ON tenant_ai_credentials(updated_at);
  `);
}

export function down(db: Database): void {
  db.exec('DROP TABLE IF EXISTS tenant_ai_credentials');
}
