/**
 * 014 — Adiciona toggle de resposta em audio (TTS) por coluna.
 *
 * Contexto: cliente do System Clow pediu que o bot responda em audio
 * quando o cliente manda audio (modo "mirror"). Implementacao usa OpenAI
 * TTS (tts-1) chamada a partir do columnAgentRunner antes do sendOutbound.
 *
 * Campos novos em crm_columns:
 *   - agent_voice_enabled INTEGER NOT NULL DEFAULT 0
 *       Toggle on/off por coluna. Quando 1, runner detecta se o cliente
 *       mandou audio e gera TTS antes de enviar.
 *   - agent_voice_id TEXT DEFAULT 'nova'
 *       Voz da OpenAI. Opcoes: alloy, echo, fable, onyx, nova, shimmer.
 *       Default 'nova' (feminina, jovem) — combina com persona Safira.
 *
 * Idempotente: usa hasColumn guard, no-op se ja existir.
 * Down: no-op (SQLite < 3.35 nao tem DROP COLUMN; campos sao opcionais).
 */
import type { Database } from 'better-sqlite3';

export const version = 14;
export const description = 'add agent_voice_enabled + agent_voice_id to crm_columns';

function hasColumn(db: Database, table: string, col: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === col);
}

export function up(db: Database): void {
  if (!hasColumn(db, 'crm_columns', 'agent_voice_enabled')) {
    db.exec(`ALTER TABLE crm_columns ADD COLUMN agent_voice_enabled INTEGER NOT NULL DEFAULT 0`);
  }
  if (!hasColumn(db, 'crm_columns', 'agent_voice_id')) {
    db.exec(`ALTER TABLE crm_columns ADD COLUMN agent_voice_id TEXT DEFAULT 'nova'`);
  }
}

export function down(_db: Database): void {
  // no-op: SQLite < 3.35 nao suporta DROP COLUMN; campos opcionais
}
