/**
 * 008 — PR 5.2: consolida roles 'cotador' e 'closer' em 'educador'.
 *
 * Mudanca estrutural do funil: 4 estagios SDR → 3 estagios SDR.
 * Cotador (Negociacao) e Closer (Agendado) viram um unico Educador
 * que vive na coluna do Closer (Agendado) — Negociacao fica sem agente
 * (passada visual manual).
 *
 * O que essa migration faz:
 *   1. Atualiza colunas com agent_role IN ('cotador', 'closer') pra
 *      agent_role='educador', desligando agent_enabled.
 *   2. Aponta agent_promote_to_column_id pra coluna chamada "Lançar venda"
 *      do mesmo board (se existir). Senao deixa NULL pra admin reconfigurar.
 *
 * Idempotente: rodar duas vezes nao causa efeito adicional (segunda
 * chamada nao acha mais cotador/closer).
 *
 * Defesa: NAO mexe em colunas com role 'custom' ou 'qualificador' /
 * 'finalizador'. So toca em rows que estao usando os roles deprecated.
 */
import type { Database } from 'better-sqlite3';

export const version = 8;
export const description = 'PR 5.2: consolida roles cotador/closer em educador (4 → 3 estagios)';

function tableExists(db: Database, table: string): boolean {
  const r = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(table) as { name?: string } | undefined;
  return !!r?.name;
}

export function up(db: Database): void {
  if (!tableExists(db, 'crm_columns')) return;

  // 1) Pra cada coluna com role deprecated, descobre coluna "Lançar venda"
  //    do mesmo board e usa como novo destino de promocao.
  //    Resolve por board (cada board pode ter nome de coluna diferente).
  const rowsToUpdate = db.prepare(`
    SELECT id, board_id FROM crm_columns
    WHERE agent_role IN ('cotador', 'closer')
  `).all() as Array<{ id: string; board_id: string }>;

  if (rowsToUpdate.length === 0) return;

  const findLancarVendaStmt = db.prepare(`
    SELECT id FROM crm_columns
    WHERE board_id = ? AND name = 'Lançar venda'
    LIMIT 1
  `);
  const updateStmt = db.prepare(`
    UPDATE crm_columns SET
      agent_role = 'educador',
      agent_enabled = 0,
      agent_promote_to_column_id = ?
    WHERE id = ?
  `);

  for (const row of rowsToUpdate) {
    const target = findLancarVendaStmt.get(row.board_id) as { id?: string } | undefined;
    updateStmt.run(target?.id ?? null, row.id);
  }
}

export function down(db: Database): void {
  // Nao reverte automaticamente — roles antigos ja foram aposentados
  // no codigo (cotador/closer marcados @deprecated). Reverter forca
  // admin a re-rodar prompts manualmente. Migration 008 fica forward-only.
  if (!tableExists(db, 'crm_columns')) return;
  // No-op intencional.
  void db;
}
