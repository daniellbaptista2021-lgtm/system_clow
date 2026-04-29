/**
 * 011 — PR 7.0: Funil v2 Timer-Driven (RECONSTRUÇÃO ARQUITETURAL).
 *
 * Schema novo:
 *   - crm_columns.agent_role_type, agent_entry_delay_minutes,
 *     agent_no_response_chase_steps_json, agent_followup_steps_hours_json
 *   - crm_cards.last_bot_message_at, last_client_message_at,
 *     followup_origin_column_id, column_changed_at
 *   - crm_card_tags (nova tabela)
 *
 * Operacoes:
 *   1. Renomeia roles 'vendedor_funeral' → 'vendedor', 'coletor_dados' → 'coletor'
 *      em crm_columns.agent_role + crm_card_agent_state.current_agent_role
 *   2. Para tenants com board "Pipeline de Vendas":
 *      - Renomeia "Folow up" → "Follow Up" (corrige typo) ou consolida se ja
 *        houver "Follow Up"
 *      - Cria coluna "Qualificado" se nao existir (entre Lead novo e Vendedor)
 *      - Cria coluna "Coletar Dados" se nao existir (entre Vendedor e Lançar Venda)
 *      - Move cards de "Agendado", "Negociação", "Sem retorno", "Pendente Daniel"
 *        pra "Lead novo" (preserva activities)
 *      - Deleta colunas zumbi: "Agendado", "Negociação", "Sem retorno",
 *        "Pendente Daniel"
 *      - Reordena positions sequencialmente
 *
 * Idempotente: rodar 2x nao causa efeito colateral.
 *
 * NAO toca em activities, comentarios, mensagens — preserva historico.
 */
import type { Database } from 'better-sqlite3';

export const version = 11;
export const description = 'PR 7.0: Funil v2 timer-driven — schema + role rename + column cleanup';

function tableExists(db: Database, table: string): boolean {
  const r = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(table) as { name?: string } | undefined;
  return !!r?.name;
}

function columnExists(db: Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((r) => r.name === column);
}

function addColumnIfMissing(db: Database, table: string, column: string, ddl: string): void {
  if (!tableExists(db, table)) return;
  if (columnExists(db, table, column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

export function up(db: Database): void {
  // ─── 1. Schema additions ────────────────────────────────────────────

  // crm_columns: novos campos do agente v2
  addColumnIfMissing(db, 'crm_columns', 'agent_role_type', 'TEXT');
  addColumnIfMissing(db, 'crm_columns', 'agent_entry_delay_minutes', 'INTEGER DEFAULT 0');
  addColumnIfMissing(db, 'crm_columns', 'agent_no_response_chase_steps_json', 'TEXT');
  addColumnIfMissing(db, 'crm_columns', 'agent_followup_steps_hours_json', 'TEXT');

  // crm_cards: timestamps pra timer-driven scheduler
  addColumnIfMissing(db, 'crm_cards', 'last_bot_message_at', 'INTEGER');
  addColumnIfMissing(db, 'crm_cards', 'last_client_message_at', 'INTEGER');
  addColumnIfMissing(db, 'crm_cards', 'followup_origin_column_id', 'TEXT');
  addColumnIfMissing(db, 'crm_cards', 'column_changed_at', 'INTEGER');

  // crm_card_tags: tabela nova
  db.exec(`
    CREATE TABLE IF NOT EXISTS crm_card_tags (
      card_id TEXT NOT NULL,
      tag TEXT NOT NULL,
      applied_at INTEGER NOT NULL,
      applied_by TEXT,
      PRIMARY KEY (card_id, tag),
      FOREIGN KEY (card_id) REFERENCES crm_cards(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_card_tags_tag ON crm_card_tags(tag);
    CREATE INDEX IF NOT EXISTS idx_card_tags_applied_at ON crm_card_tags(applied_at);
  `);

  // ─── 2. Role rename (PR 6.x → PR 7.0) ───────────────────────────────

  if (tableExists(db, 'crm_columns')) {
    db.prepare(`UPDATE crm_columns SET agent_role = 'vendedor' WHERE agent_role = 'vendedor_funeral'`).run();
    db.prepare(`UPDATE crm_columns SET agent_role = 'coletor' WHERE agent_role = 'coletor_dados'`).run();
    // Set agent_role_type = agent_role pra rows que ja tem role configurado
    db.prepare(`UPDATE crm_columns SET agent_role_type = agent_role WHERE agent_role IS NOT NULL AND agent_role_type IS NULL`).run();
  }

  if (tableExists(db, 'crm_card_agent_state')) {
    db.prepare(`UPDATE crm_card_agent_state SET current_agent_role = 'vendedor' WHERE current_agent_role = 'vendedor_funeral'`).run();
    db.prepare(`UPDATE crm_card_agent_state SET current_agent_role = 'coletor' WHERE current_agent_role = 'coletor_dados'`).run();
  }

  // ─── 3. Backfill column_changed_at pra cards existentes ─────────────

  if (tableExists(db, 'crm_cards')) {
    // Sem coluna last_activity_at? backfill com updated_at.
    db.prepare(`UPDATE crm_cards SET column_changed_at = COALESCE(last_activity_at, updated_at) WHERE column_changed_at IS NULL`).run();
  }

  // ─── 4. Cleanup do board PV Corretora — colunas zumbi ───────────────

  if (!tableExists(db, 'crm_columns') || !tableExists(db, 'crm_cards')) return;

  // Pega todos os boards que tem alguma coluna zumbi (Agendado, Negociação,
  // Sem retorno, Pendente Daniel) — assim funciona pra qualquer tenant,
  // nao so PV.
  const ZOMBIE_NAMES = ['Agendado', 'Negociação', 'Sem retorno', 'Pendente Daniel'];

  // Pra cada board, faz a limpeza
  const allBoards = db.prepare(`SELECT DISTINCT board_id FROM crm_columns`).all() as Array<{ board_id: string }>;

  for (const { board_id: boardId } of allBoards) {
    const cols = db.prepare(`SELECT id, name, position FROM crm_columns WHERE board_id = ? ORDER BY position`).all(boardId) as Array<{ id: string; name: string; position: number }>;
    if (cols.length === 0) continue;

    // a) Renomeia "Folow up" (typo) → "Follow Up". Se ja existir "Follow Up",
    //    consolida cards e deleta o "Folow up" duplicado.
    const folowUpTypo = cols.find((c) => c.name === 'Folow up');
    const followUpProper = cols.find((c) => c.name === 'Follow Up');
    if (folowUpTypo && followUpProper) {
      // Move cards do typo pro proper, depois deleta o typo
      db.prepare(`UPDATE crm_cards SET column_id = ?, column_changed_at = ? WHERE column_id = ?`).run(followUpProper.id, Date.now(), folowUpTypo.id);
      db.prepare(`DELETE FROM crm_columns WHERE id = ?`).run(folowUpTypo.id);
    } else if (folowUpTypo) {
      db.prepare(`UPDATE crm_columns SET name = 'Follow Up' WHERE id = ?`).run(folowUpTypo.id);
    }

    // Re-le colunas (apos rename/delete acima)
    const colsRefreshed = db.prepare(`SELECT id, name, position FROM crm_columns WHERE board_id = ? ORDER BY position`).all(boardId) as Array<{ id: string; name: string; position: number }>;

    // b) Move cards de colunas zumbi → "Lead novo". Se Lead novo nao existir,
    //    pula (board nao eh do tipo Pipeline de Vendas).
    const leadNovoCol = colsRefreshed.find((c) => c.name === 'Lead novo');
    if (!leadNovoCol) continue;

    const zombieCols = colsRefreshed.filter((c) => ZOMBIE_NAMES.includes(c.name));
    for (const zombie of zombieCols) {
      const cards = db.prepare(`SELECT id FROM crm_cards WHERE column_id = ?`).all(zombie.id) as Array<{ id: string }>;
      for (const card of cards) {
        db.prepare(`UPDATE crm_cards SET column_id = ?, column_changed_at = ? WHERE id = ?`).run(leadNovoCol.id, Date.now(), card.id);
      }
      // Deleta a coluna zumbi (cards ja foram movidos)
      db.prepare(`DELETE FROM crm_columns WHERE id = ?`).run(zombie.id);
    }

    // c) Cria "Qualificado" se nao existir (entre Lead novo e proxima)
    const colsAfterCleanup = db.prepare(`SELECT id, name, position FROM crm_columns WHERE board_id = ? ORDER BY position`).all(boardId) as Array<{ id: string; name: string; position: number }>;
    const hasQualificado = colsAfterCleanup.some((c) => c.name === 'Qualificado');
    if (!hasQualificado) {
      const newId = 'crm_col_' + Math.random().toString(16).slice(2, 14);
      const leadNovoPos = colsAfterCleanup.find((c) => c.name === 'Lead novo')!.position;
      // Empurra todas as colunas com position > leadNovoPos
      db.prepare(`UPDATE crm_columns SET position = position + 1 WHERE board_id = ? AND position > ?`).run(boardId, leadNovoPos);
      db.prepare(`INSERT INTO crm_columns (id, board_id, name, position, color, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(newId, boardId, 'Qualificado', leadNovoPos + 1, '#22c55e', Date.now());
    }

    // d) Cria "Coletar Dados" se nao existir (antes de Lançar venda)
    const colsAfterQ = db.prepare(`SELECT id, name, position FROM crm_columns WHERE board_id = ? ORDER BY position`).all(boardId) as Array<{ id: string; name: string; position: number }>;
    const hasColetarDados = colsAfterQ.some((c) => c.name === 'Coletar Dados');
    const lancarVendaCol = colsAfterQ.find((c) => c.name === 'Lançar venda' || c.name === 'Lançar Venda');
    if (!hasColetarDados && lancarVendaCol) {
      const newId = 'crm_col_' + Math.random().toString(16).slice(2, 14);
      const targetPos = lancarVendaCol.position;
      db.prepare(`UPDATE crm_columns SET position = position + 1 WHERE board_id = ? AND position >= ?`).run(boardId, targetPos);
      db.prepare(`INSERT INTO crm_columns (id, board_id, name, position, color, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(newId, boardId, 'Coletar Dados', targetPos, '#a855f7', Date.now());
    }

    // e) Cria "Vendedor" se nao existir (entre Qualificado e Coletar Dados)
    //    Pula se nao houver tenant configurando funil — so cria pra boards
    //    que ja tinham "Qualificado" criada nesse run.
    const colsAfterCD = db.prepare(`SELECT id, name, position FROM crm_columns WHERE board_id = ? ORDER BY position`).all(boardId) as Array<{ id: string; name: string; position: number }>;
    const hasVendedor = colsAfterCD.some((c) => c.name === 'Vendedor');
    const qualCol = colsAfterCD.find((c) => c.name === 'Qualificado');
    if (!hasVendedor && qualCol) {
      const newId = 'crm_col_' + Math.random().toString(16).slice(2, 14);
      const targetPos = qualCol.position + 1;
      db.prepare(`UPDATE crm_columns SET position = position + 1 WHERE board_id = ? AND position >= ?`).run(boardId, targetPos);
      db.prepare(`INSERT INTO crm_columns (id, board_id, name, position, color, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(newId, boardId, 'Vendedor', targetPos, '#3b82f6', Date.now());
    }

    // f) Reordena positions sequencialmente (0..N-1)
    const finalCols = db.prepare(`SELECT id FROM crm_columns WHERE board_id = ? ORDER BY position`).all(boardId) as Array<{ id: string }>;
    finalCols.forEach((c, i) => {
      db.prepare(`UPDATE crm_columns SET position = ? WHERE id = ?`).run(i, c.id);
    });
  }
}

export function down(_db: Database): void {
  // Forward-only — colunas deletadas (Agendado, Negociação, Sem retorno,
  // Pendente Daniel) nao podem ser restauradas com seus IDs originais.
  // Cards perdidos seriam dificeis de devolver. No-op intencional.
}
