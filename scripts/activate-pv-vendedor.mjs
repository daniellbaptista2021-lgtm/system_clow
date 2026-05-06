// One-shot: ativa o agente VENDEDOR na coluna "Atendimento Humano" do tenant PV Corretora.
//
// Daniel 2026-05-06: vendedor virou agente único de cotação→venda→coleta.
// Cota via API real (cotar_sulamerica_api), tira dúvida com base nas
// Condições Gerais oficiais (SUSEP 15414.003991/2006-91), fecha venda,
// coleta os 9 dados de contratação (salvar_dados_proposta) e promove direto
// pra "Lançar Venda" (sem coletor intermediário). Daniel emite proposta lá.
//
// Mudanças aplicadas:
//   - agent_enabled = 1 (estava 0)
//   - agent_role / agent_role_type = 'vendedor'
//   - agent_promote_to_column_id = ID da coluna "Lançar venda" (era Aguardando Dados)
//   - agent_system_prompt = PROMPT_VENDEDOR novo (importado do build dist/)
//
// IMPORTANTE: passa o prompt como STRING JS direta pro UPDATE — sem readfile,
// sem cast, evita o bug de BLOB documentado em
// MEMORY/feedback_sqlite_readfile_blob.md (typeof != 'string' quebra pickAgent
// silencioso).

import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

const COLUMN_ATENDIMENTO_HUMANO = 'crm_col_591b12179732';
const COLUMN_LANCAR_VENDA       = 'crm_col_7090fc2ce1a9';
const TENANT_ID = 'be5f5042-d939-447d-8777-5ac841e7aa07';
const DB_PATH = process.env.CLOW_DB_PATH || '/root/.clow/crm.sqlite3';

// Importa PROMPT_VENDEDOR do build (dist/) — fonte unica de verdade.
const promptsModulePath = join(repoRoot, 'dist/crm/agents/defaultPrompts.js');
const { PROMPT_VENDEDOR } = await import(promptsModulePath);

if (typeof PROMPT_VENDEDOR !== 'string' || PROMPT_VENDEDOR.length < 1000) {
  console.error(`ERRO: PROMPT_VENDEDOR invalido (typeof=${typeof PROMPT_VENDEDOR} len=${PROMPT_VENDEDOR?.length}). Roda npm run build antes.`);
  process.exit(1);
}

const db = new Database(DB_PATH);

// 1) Valida coluna alvo existe + pertence ao tenant correto
const col = db.prepare(`
  SELECT c.id, c.name, c.agent_enabled, c.agent_role, c.agent_role_type,
         c.agent_promote_to_column_id, c.agent_entry_delay_minutes,
         c.agent_no_response_chase_steps_json,
         length(c.agent_system_prompt) AS prompt_len,
         b.tenant_id
  FROM crm_columns c
  JOIN crm_boards b ON b.id = c.board_id
  WHERE c.id = ?
`).get(COLUMN_ATENDIMENTO_HUMANO);

if (!col) {
  console.error(`ERRO: coluna ${COLUMN_ATENDIMENTO_HUMANO} nao encontrada`);
  process.exit(1);
}
if (col.tenant_id !== TENANT_ID) {
  console.error(`ERRO: coluna pertence ao tenant ${col.tenant_id}, esperado ${TENANT_ID}`);
  process.exit(1);
}
console.log(`Antes: name="${col.name}" enabled=${col.agent_enabled} role=${col.agent_role} role_type=${col.agent_role_type} promote_to=${col.agent_promote_to_column_id} entry=${col.agent_entry_delay_minutes} chase=${col.agent_no_response_chase_steps_json} prompt_len=${col.prompt_len}`);

// 2) Valida coluna Lançar Venda existe
const lv = db.prepare(`SELECT id, name FROM crm_columns WHERE id = ?`).get(COLUMN_LANCAR_VENDA);
if (!lv) {
  console.error(`ERRO: coluna Lancar Venda ${COLUMN_LANCAR_VENDA} nao encontrada`);
  process.exit(1);
}

// 3) Aplica update
const r = db.prepare(`
  UPDATE crm_columns SET
    agent_enabled = 1,
    agent_role = 'vendedor',
    agent_role_type = 'vendedor',
    agent_promote_to_column_id = ?,
    agent_entry_delay_minutes = 4,
    agent_no_response_chase_steps_json = '[30,120,360]',
    agent_active_hours_start = '00:00',
    agent_active_hours_end = '23:59',
    agent_inactivity_timeout_minutes = 20,
    agent_max_turns = 30,
    agent_system_prompt = ?
  WHERE id = ?
`).run(COLUMN_LANCAR_VENDA, PROMPT_VENDEDOR, COLUMN_ATENDIMENTO_HUMANO);
console.log(`UPDATE rows changed: ${r.changes}`);

// 4) Re-le e valida typeof do prompt
const after = db.prepare(`
  SELECT agent_enabled, agent_role, agent_role_type, agent_promote_to_column_id,
         agent_entry_delay_minutes, agent_no_response_chase_steps_json,
         typeof(agent_system_prompt) AS t,
         length(agent_system_prompt) AS n
  FROM crm_columns WHERE id = ?
`).get(COLUMN_ATENDIMENTO_HUMANO);

console.log(`Depois: enabled=${after.agent_enabled} role=${after.agent_role} role_type=${after.agent_role_type} promote_to=${after.agent_promote_to_column_id} entry=${after.agent_entry_delay_minutes} chase=${after.agent_no_response_chase_steps_json} prompt_typeof=${after.t} prompt_len=${after.n}`);

if (after.t !== 'text') {
  console.error(`ERRO: prompt_typeof=${after.t} (esperado 'text'). Re-tente.`);
  process.exit(1);
}
if (after.agent_enabled !== 1) {
  console.error(`ERRO: agent_enabled=${after.agent_enabled} (esperado 1).`);
  process.exit(1);
}
if (after.agent_promote_to_column_id !== COLUMN_LANCAR_VENDA) {
  console.error(`ERRO: promote_to=${after.agent_promote_to_column_id} (esperado ${COLUMN_LANCAR_VENDA}).`);
  process.exit(1);
}

console.log(`✓ OK — coluna "${col.name}" agora roda agente vendedor que promove pra "${lv.name}".`);
console.log(`  Prompt: ${after.n} chars armazenados como TEXT.`);
db.close();
