/**
 * Gera SQL paste-ready pra ativar o funil multi-agente nas colunas
 * do PV Corretora. Lê os prompts default + critérios de promocao
 * direto do dist/ pra evitar drift entre defaultPrompts.ts e o SQL.
 *
 * Uso:
 *   node scripts/gen-activate-pv-funnel.mjs > /tmp/activate-pv-funnel.sql
 *   sqlite3 /root/.clow/crm.sqlite3 < /tmp/activate-pv-funnel.sql
 */
import { DEFAULT_PROMPTS, DEFAULT_PROMOTION_CRITERIA } from '/opt/system-clow/dist/crm/agents/defaultPrompts.js';

const TENANT_ID = 'be5f5042-d939-447d-8777-5ac841e7aa07';

// Mapeamento role → coluna existente do PV (Pipeline de Vendas)
// PR 5.2: 4 estagios → 3 estagios SDR. Coluna "Negociação" fica SEM bot
// (passada visual manual). Cotador + Closer consolidados em Educador.
const STAGES = [
  {
    role: 'qualificador',
    columnId: 'crm_col_ef28102e464b', // Lead novo
    columnName: 'Lead novo',
    promoteTo: 'crm_col_534d6959a178', // pula Negociação, vai direto pra Agendado
  },
  {
    role: 'educador',
    columnId: 'crm_col_534d6959a178', // Agendado
    columnName: 'Agendado',
    promoteTo: 'crm_col_7090fc2ce1a9', // Lançar venda
  },
  {
    role: 'finalizador',
    columnId: 'crm_col_7090fc2ce1a9', // Lançar venda
    columnName: 'Lançar venda',
    promoteTo: 'crm_col_pendente_daniel', // Pendente Daniel (handoff humano)
  },
];

// Coluna "Negociação" (crm_col_94c4d692a8b3) fica explicitamente
// DESLIGADA — sem bot. SQL desativa essa coluna ao final.
const NEGOCIACAO_COL_ID = 'crm_col_94c4d692a8b3';

const esc = (s) => s.replace(/'/g, "''");

console.log(`-- Ativar funil multi-agente — PV Corretora`);
console.log(`-- Tenant: ${TENANT_ID}`);
console.log(`-- Board:  Pipeline de Vendas (crm_board_048c4738a15b)`);
console.log(`-- Gerado em: ${new Date().toISOString()}`);
console.log(`-- ─────────────────────────────────────────────────────────────`);
console.log(`-- Prompts vêm de src/crm/agents/defaultPrompts.ts.`);
console.log(`-- Pra editar prompt de uma coluna depois sem rerun, usar:`);
console.log(`--   UPDATE crm_columns SET agent_system_prompt = '...' WHERE id = '<col_id>';`);
console.log(``);
console.log(`BEGIN TRANSACTION;`);
console.log(``);

for (const stage of STAGES) {
  const prompt = DEFAULT_PROMPTS[stage.role];
  const criteria = DEFAULT_PROMOTION_CRITERIA[stage.role];
  console.log(`-- ${stage.columnName} → role=${stage.role} → promove pra ${stage.promoteTo}`);
  console.log(`UPDATE crm_columns SET`);
  console.log(`  agent_enabled = 1,`);
  console.log(`  agent_role = '${stage.role}',`);
  console.log(`  agent_name = NULL,  -- usa default 'Safira' do tenant`);
  console.log(`  agent_system_prompt = '${esc(prompt)}',`);
  console.log(`  agent_promotion_criteria = '${esc(criteria)}',`);
  console.log(`  agent_promote_to_column_id = '${stage.promoteTo}',`);
  console.log(`  agent_max_turns = 30,`);
  console.log(`  agent_inactivity_timeout_minutes = 20,`);
  // PR 5.3: 24/7. PV (e qualquer tenant brasileiro de seguro/funeral)
  // atende madrugada e fim de semana — bot nao pode dizer "te respondo
  // as 08:00" pra lead que entrou as 22h.
  console.log(`  agent_active_hours_start = '00:00',`);
  console.log(`  agent_active_hours_end = '23:59'`);
  console.log(`WHERE id = '${stage.columnId}';`);
  console.log(``);
}

// PR 5.2: garantir que coluna "Negociação" fica SEM bot (passada visual)
console.log(`-- Negociação → SEM bot (passada visual manual, sem agente IA)`);
console.log(`UPDATE crm_columns SET`);
console.log(`  agent_enabled = 0,`);
console.log(`  agent_role = NULL,`);
console.log(`  agent_promote_to_column_id = NULL,`);
console.log(`  agent_system_prompt = NULL,`);
console.log(`  agent_promotion_criteria = NULL`);
console.log(`WHERE id = '${NEGOCIACAO_COL_ID}';`);
console.log(``);

console.log(`COMMIT;`);
console.log(``);
console.log(`-- Verificar:`);
console.log(`SELECT name, agent_enabled, agent_role,`);
console.log(`       (SELECT name FROM crm_columns WHERE id = c.agent_promote_to_column_id) AS promote_to,`);
console.log(`       agent_max_turns, agent_active_hours_start || '-' || agent_active_hours_end AS hours`);
console.log(`FROM crm_columns c WHERE board_id = 'crm_board_048c4738a15b' ORDER BY position;`);
