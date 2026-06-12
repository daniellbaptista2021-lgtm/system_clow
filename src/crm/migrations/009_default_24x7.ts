/**
 * 009 — Defaults de horario 24/7 pra agentes de coluna.
 *
 * Bug detectado em producao (PV Corretora 2026-04-29): cliente mandou
 * msg as 21:42 e o bot respondeu "te respondo a partir das 08:00".
 * Pra PV (e provavelmente pra maioria dos tenants brasileiros que
 * vendem seguro/funeral), o atendimento eh 24/7 — leads que entram
 * de madrugada precisam ser atendidos NA HORA.
 *
 * SQLite NAO suporta ALTER COLUMN ... SET DEFAULT — entao essa migration:
 *   1. Atualiza ROWS EXISTENTES que estao com 08:00-21:00 (default antigo)
 *      pra 00:00-23:59. Defensivo: nao toca em rows que admin ja customizou
 *      (ex: '09:00'-'18:00').
 *   2. O DEFAULT da coluna no schema fica como '08:00'/'21:00' (nao da pra
 *      mudar em SQLite). MAS a migration 004 source foi atualizada — em
 *      deploys NOVOS (test DB / fresh prod) a coluna eh criada ja com
 *      default '00:00'/'23:59'. Em DBs existentes, essa migration 009
 *      faz o catch-up.
 *
 * Idempotente: rodar 2x nao causa efeito (segunda iteracao nao acha mais
 * rows com 08:00-21:00).
 */
import type { Database } from 'better-sqlite3';

export const version = 9;
export const description = 'PR 5.3: agente de coluna default 24/7 (retroativo + futuro)';

function tableExists(db: Database, table: string): boolean {
  const r = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(table) as { name?: string } | undefined;
  return !!r?.name;
}

export function up(db: Database): void {
  if (!tableExists(db, 'crm_columns')) return;
  // Apenas rows que ainda estao com o default antigo 08:00-21:00
  // (admin que customizou ja tem horario proprio — nao mexer)
  db.prepare(`
    UPDATE crm_columns SET
      agent_active_hours_start = '00:00',
      agent_active_hours_end = '23:59'
    WHERE agent_active_hours_start = '08:00'
      AND agent_active_hours_end = '21:00'
  `).run();
}

export function down(_db: Database): void {
  // Nao reverte automaticamente — qualquer admin que tiver customizado
  // os horarios via UI ficaria sobrescrito. No-op intencional.
}
