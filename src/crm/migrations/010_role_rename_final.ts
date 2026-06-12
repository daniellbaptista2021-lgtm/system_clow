/**
 * 010 — PR 6.0: rename final dos roles SDR pro modelo Bot Vendedor Completo.
 *
 * Modelo final (definido pelo Daniel apos teste real):
 *   educador     → vendedor_funeral  (substitui SDR neutro por VENDEDOR direto)
 *   finalizador  → coletor_dados     (substitui FINALIZADOR por COLETOR de DADOS)
 *
 * Bot vende SOZINHO ate o fim. SO escala pro humano se cliente quiser
 * produto adicional (vida, doencas graves, cirurgia, DIT).
 *
 * Idempotente: rodar 2x nao causa efeito (segunda iteracao nao acha mais
 * educador/finalizador).
 *
 * Defesa: NAO mexe em rows com role 'qualificador' / 'custom' / cotador /
 * closer (esses ultimos ja foram convertidos pra educador na migration 008).
 */
import type { Database } from 'better-sqlite3';

export const version = 10;
export const description = 'PR 6.0: educador → vendedor_funeral, finalizador → coletor_dados';

function tableExists(db: Database, table: string): boolean {
  const r = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(table) as { name?: string } | undefined;
  return !!r?.name;
}

export function up(db: Database): void {
  if (!tableExists(db, 'crm_columns')) return;

  db.prepare(`
    UPDATE crm_columns SET agent_role = 'vendedor_funeral'
    WHERE agent_role = 'educador'
  `).run();

  db.prepare(`
    UPDATE crm_columns SET agent_role = 'coletor_dados'
    WHERE agent_role = 'finalizador'
  `).run();

  // Tambem em crm_card_agent_state (current_agent_role)
  if (tableExists(db, 'crm_card_agent_state')) {
    db.prepare(`
      UPDATE crm_card_agent_state SET current_agent_role = 'vendedor_funeral'
      WHERE current_agent_role = 'educador'
    `).run();
    db.prepare(`
      UPDATE crm_card_agent_state SET current_agent_role = 'coletor_dados'
      WHERE current_agent_role = 'finalizador'
    `).run();
  }
}

export function down(_db: Database): void {
  // Forward-only — admin que tiver editado prompts manuais ficaria
  // sobrescrito ao reverter. No-op intencional.
}
