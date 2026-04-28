/**
 * 004 — Multi-agent funnel: agente IA por coluna do Kanban.
 *
 * Estende o "agente por canal" (introduzido na 003) pra "agente por coluna".
 * Cada coluna de um board pode ter um agente com role distinto
 * (qualificador, cotador, closer, finalizador, custom), prompt proprio,
 * checklist de promocao, e regras de funcionamento (horario, timeout
 * de inatividade, limite de turnos).
 *
 * Persona externa (nome visivel pro cliente) eh unificada por tenant —
 * o cliente nao percebe que mudou de coluna. O que muda eh o objetivo
 * interno do agente, suas tools disponiveis, e os criterios pra promover
 * o card pra proxima coluna do funil.
 *
 * Importante: agent_enabled = 0 por default em TODAS as colunas. Nada
 * comeca a responder cliente sem o corretor explicitamente ativar via
 * UI — evita bot indo ao ar sem o operador ter revisado o prompt.
 *
 * Tabela crm_card_agent_state guarda o estado por card: turnos, timestamps
 * pro timer de inatividade, dados estruturados ja coletados, log de
 * promocoes. Uma row por card (PK card_id) — quando o card eh promovido,
 * a row eh atualizada (nao duplicada).
 *
 * Tabela crm_agent_metrics eh append-only — cada evento relevante
 * (promoted, lost, escalated, stuck, inactive_timeout) gera uma linha
 * pro dashboard de funil (PR 7).
 */
import type { Database } from 'better-sqlite3';

export const version = 4;
export const description = 'multi-agent funnel: agent config per column + card state + metrics';

function tableExists(db: Database, table: string): boolean {
  const r = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(table) as { name?: string } | undefined;
  return !!r?.name;
}

function hasColumn(db: Database, table: string, col: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === col);
}

export function up(db: Database): void {
  // ── crm_columns: agent config fields ────────────────────────────────
  if (tableExists(db, 'crm_columns')) {
    const adds: Array<[string, string]> = [
      ['agent_enabled', 'INTEGER NOT NULL DEFAULT 0'],
      ['agent_name', 'TEXT'],
      ['agent_system_prompt', 'TEXT'],
      ['agent_role', 'TEXT'],
      ['agent_promote_to_column_id', 'TEXT'],
      ['agent_inactivity_timeout_minutes', 'INTEGER NOT NULL DEFAULT 20'],
      ['agent_max_turns', 'INTEGER NOT NULL DEFAULT 30'],
      ['agent_active_hours_start', `TEXT NOT NULL DEFAULT '08:00'`],
      ['agent_active_hours_end', `TEXT NOT NULL DEFAULT '21:00'`],
      ['agent_promotion_criteria', 'TEXT'],
    ];
    for (const [col, def] of adds) {
      if (!hasColumn(db, 'crm_columns', col)) {
        db.exec(`ALTER TABLE crm_columns ADD COLUMN ${col} ${def}`);
      }
    }
  }

  // ── crm_card_agent_state ────────────────────────────────────────────
  // Uma row por card. PK em card_id garante 1:1 — quando o card eh
  // promovido, atualizamos column_id/current_agent_role/turns_count/etc
  // em vez de inserir uma row nova. promotion_log preserva o historico
  // como JSON array dentro da propria row.
  //
  // FK em card_id com ON DELETE CASCADE: se o card eh deletado, o estado
  // tambem some — nao queremos rows orfas atrapalhando o scheduler de
  // inatividade.
  if (!tableExists(db, 'crm_card_agent_state')) {
    db.exec(`
      CREATE TABLE crm_card_agent_state (
        card_id TEXT PRIMARY KEY REFERENCES crm_cards(id) ON DELETE CASCADE,
        column_id TEXT NOT NULL,
        current_agent_role TEXT NOT NULL,
        turns_count INTEGER NOT NULL DEFAULT 0,
        last_client_message_at INTEGER,
        last_agent_message_at INTEGER,
        inactivity_timer_at INTEGER,
        status TEXT NOT NULL DEFAULT 'active',
        collected_data TEXT,
        promotion_log TEXT,
        tenant_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    // Index parcial pra varredura rapida do scheduler de inatividade.
    // So precisa de WHERE status='active' — cards pausados/escalados
    // nao disparam timer.
    db.exec(`
      CREATE INDEX idx_card_agent_state_inactivity
      ON crm_card_agent_state(inactivity_timer_at)
      WHERE status = 'active'
    `);
    db.exec(`
      CREATE INDEX idx_card_agent_state_tenant
      ON crm_card_agent_state(tenant_id, status)
    `);
  }

  // ── crm_agent_metrics ───────────────────────────────────────────────
  // Append-only event log do funil. Cada movimentacao relevante grava
  // 1 row, sem update/delete na vida normal. Indice por (tenant_id,
  // column_id, occurred_at) atende as queries do dashboard (PR 7):
  // "quantos cards saíram da coluna X nos ultimos N dias agrupados
  // por evento".
  if (!tableExists(db, 'crm_agent_metrics')) {
    db.exec(`
      CREATE TABLE crm_agent_metrics (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        column_id TEXT NOT NULL,
        card_id TEXT NOT NULL,
        event TEXT NOT NULL,
        reason TEXT,
        duration_in_column_seconds INTEGER,
        turns_in_column INTEGER,
        occurred_at INTEGER NOT NULL
      )
    `);
    db.exec(`
      CREATE INDEX idx_agent_metrics_tenant_column_time
      ON crm_agent_metrics(tenant_id, column_id, occurred_at)
    `);
    db.exec(`
      CREATE INDEX idx_agent_metrics_card
      ON crm_agent_metrics(card_id, occurred_at)
    `);
  }
}

export function down(db: Database): void {
  // SQLite < 3.35 nao suporta DROP COLUMN — campos novos em crm_columns
  // ficam orfaos no rollback (no-op safe; default 0/null nao quebra
  // queries existentes). Ja as tabelas novas dao pra dropar.
  if (tableExists(db, 'crm_agent_metrics')) {
    db.exec('DROP TABLE crm_agent_metrics');
  }
  if (tableExists(db, 'crm_card_agent_state')) {
    db.exec('DROP TABLE crm_card_agent_state');
  }
}
