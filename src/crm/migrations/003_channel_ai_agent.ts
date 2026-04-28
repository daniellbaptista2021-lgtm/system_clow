/**
 * 003 — AI agent fields on crm_channels.
 *
 * Padroniza um agente de IA por canal (Z-API/Meta) sem precisar de n8n
 * externo. Cada tenant tem seu próprio bot conversacional dentro do
 * System Clow:
 *   - ai_enabled: liga/desliga o agente automatico
 *   - ai_system_prompt: personalidade + contexto do bot
 *   - ai_model: deepseek-chat (default) | gpt-4o-mini | etc
 *   - ai_audio_enabled: transcreve audio via Whisper antes de processar
 *
 * Fluxo: webhook inbound → ingest → se ai_enabled → agente roda em
 * background → resposta enviada via canal. Sem isso, cliente tinha que
 * orquestrar via n8n separado pra cada conta.
 */
import type { Database } from 'better-sqlite3';

export const version = 3;
export const description = 'add AI agent config fields to crm_channels';

function hasColumn(db: Database, table: string, col: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === col);
}

function tableExists(db: Database, table: string): boolean {
  const r = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(table) as { name?: string } | undefined;
  return !!r?.name;
}

export function up(db: Database): void {
  if (!tableExists(db, 'crm_channels')) return; // legacy bridge safety
  const adds: Array<[string, string]> = [
    ['ai_enabled', 'INTEGER NOT NULL DEFAULT 0'],
    ['ai_system_prompt', 'TEXT'],
    ['ai_model', 'TEXT DEFAULT \'deepseek-chat\''],
    ['ai_audio_enabled', 'INTEGER NOT NULL DEFAULT 1'],
    ['ai_max_history', 'INTEGER NOT NULL DEFAULT 20'],
    ['ai_debounce_seconds', 'INTEGER NOT NULL DEFAULT 8'],
  ];
  for (const [col, def] of adds) {
    if (!hasColumn(db, 'crm_channels', col)) {
      db.exec(`ALTER TABLE crm_channels ADD COLUMN ${col} ${def}`);
    }
  }
}

export function down(_db: Database): void {
  // SQLite < 3.35 não suporta DROP COLUMN. Campos opcionais, no-op safe.
}
