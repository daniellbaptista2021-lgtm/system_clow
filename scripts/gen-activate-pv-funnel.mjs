/**
 * Gera SQL paste-ready pra ativar o funil v2 timer-driven (PR 7.0) nas
 * colunas do PV Corretora. Lê os prompts default + critérios de promocao
 * + timers default direto do dist/ pra evitar drift.
 *
 * Uso:
 *   node scripts/gen-activate-pv-funnel.mjs > /tmp/activate-pv-funnel.sql
 *   sqlite3 /root/.clow/crm.sqlite3 < /tmp/activate-pv-funnel.sql
 *
 * Pre-requisitos:
 *   - Migration 011 ja rodou (criou colunas Qualificado, Coletar Dados,
 *     Vendedor, e adicionou os campos de timer no schema)
 */
import { DEFAULT_PROMPTS, DEFAULT_PROMOTION_CRITERIA, DEFAULT_TIMERS } from '/opt/system-clow/dist/crm/agents/defaultPrompts.js';

const TENANT_ID = 'be5f5042-d939-447d-8777-5ac841e7aa07';
const BOARD_ID = 'crm_board_048c4738a15b';

// Mapeamento role → coluna no funil v2 (PR 7.0)
//   qualificador  — Lead novo    → Qualificado
//   cotador       — Qualificado  → Vendedor (timer 5min)
//   vendedor      — Vendedor     → Coletar Dados (timer 4min + chase 30/120/360)
//   coletor       — Coletar Dados → Lançar Venda (chase 30/120/360)
//   followupper   — Follow Up    → Vendedor (steps 24/48/72h, delete 96h)
const STAGES_BY_NAME = [
  { role: 'qualificador', columnName: 'Lead novo',       promoteToName: 'Qualificado' },
  { role: 'cotador',      columnName: 'Qualificado',     promoteToName: 'Vendedor' },
  { role: 'vendedor',     columnName: 'Vendedor',        promoteToName: 'Coletar Dados' },
  { role: 'coletor',      columnName: 'Coletar Dados',   promoteToName: 'Lançar venda' },
  { role: 'followupper',  columnName: 'Follow Up',       promoteToName: 'Vendedor' },
];

const esc = (s) => String(s).replace(/'/g, "''");
const jsonOrNull = (a) => (a == null ? 'NULL' : `'${esc(JSON.stringify(a))}'`);

console.log(`-- Ativar funil v2 timer-driven — PV Corretora (PR 7.0)`);
console.log(`-- Tenant: ${TENANT_ID}`);
console.log(`-- Board:  Pipeline de Vendas (${BOARD_ID})`);
console.log(`-- Gerado em: ${new Date().toISOString()}`);
console.log(`-- ─────────────────────────────────────────────────────────────`);
console.log(`-- Migration 011 deve ter rodado pra criar colunas Qualificado/`);
console.log(`-- Vendedor/Coletar Dados e os campos novos de timer.`);
console.log(``);
console.log(`BEGIN TRANSACTION;`);
console.log(``);

for (const stage of STAGES_BY_NAME) {
  const prompt = DEFAULT_PROMPTS[stage.role];
  const criteria = DEFAULT_PROMOTION_CRITERIA[stage.role];
  const t = DEFAULT_TIMERS[stage.role];
  const chase = t.chaseStepsMinutes ? t.chaseStepsMinutes : null;
  const fu = t.followupStepsHours ? t.followupStepsHours : null;

  console.log(`-- ${stage.columnName} → role=${stage.role} → promove pra ${stage.promoteToName}`);
  console.log(`UPDATE crm_columns SET`);
  console.log(`  agent_enabled = 1,`);
  console.log(`  agent_role = '${stage.role}',`);
  console.log(`  agent_role_type = '${stage.role}',`);
  console.log(`  agent_name = NULL,`);
  console.log(`  agent_system_prompt = '${esc(prompt)}',`);
  console.log(`  agent_promotion_criteria = '${esc(criteria)}',`);
  console.log(`  agent_promote_to_column_id = (SELECT id FROM crm_columns WHERE board_id = '${BOARD_ID}' AND name = '${esc(stage.promoteToName)}' LIMIT 1),`);
  console.log(`  agent_max_turns = 30,`);
  console.log(`  agent_inactivity_timeout_minutes = 20,`);
  console.log(`  agent_active_hours_start = '00:00',`);
  console.log(`  agent_active_hours_end = '23:59',`);
  console.log(`  agent_entry_delay_minutes = ${t.entryDelayMinutes},`);
  console.log(`  agent_no_response_chase_steps_json = ${jsonOrNull(chase)},`);
  console.log(`  agent_followup_steps_hours_json = ${jsonOrNull(fu)}`);
  console.log(`WHERE board_id = '${BOARD_ID}' AND name = '${esc(stage.columnName)}';`);
  console.log(``);
}

console.log(`-- Lançar venda → SEM bot (humano assume)`);
console.log(`UPDATE crm_columns SET`);
console.log(`  agent_enabled = 0,`);
console.log(`  agent_role = NULL,`);
console.log(`  agent_role_type = NULL,`);
console.log(`  agent_promote_to_column_id = NULL,`);
console.log(`  agent_system_prompt = NULL,`);
console.log(`  agent_promotion_criteria = NULL`);
console.log(`WHERE board_id = '${BOARD_ID}' AND name IN ('Lançar venda', 'Lançar Venda');`);
console.log(``);

console.log(`COMMIT;`);
console.log(``);
console.log(`-- Verificar:`);
console.log(`SELECT name, agent_enabled, agent_role,`);
console.log(`       (SELECT name FROM crm_columns WHERE id = c.agent_promote_to_column_id) AS promote_to,`);
console.log(`       agent_entry_delay_minutes AS entry_min,`);
console.log(`       agent_no_response_chase_steps_json AS chase,`);
console.log(`       agent_followup_steps_hours_json AS fu`);
console.log(`FROM crm_columns c WHERE board_id = '${BOARD_ID}' ORDER BY position;`);
