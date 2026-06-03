// One-shot: provisiona login adicional Rafael Alves no tenant PV Corretor.
// Uso: RAFAEL_PASSWORD=... node scripts/provision-rafael.mjs
import bcrypt from 'bcryptjs';
import { createAgent, listAgents, createTeam, listTeams } from '../dist/crm/store/agentsStore.js';
import { addAdditionalLogin, getTenant, findTenantByAnyLogin } from '../dist/tenancy/tenantStore.js';
import { getCrmDb } from '../dist/crm/schema.js';

const TENANT_ID = 'be5f5042-d939-447d-8777-5ac841e7aa07'; // PV Corretor
const EMAIL = 'rafaelalvespvcorretora@gmail.com';
const PASSWORD = process.env.RAFAEL_PASSWORD;
const FULL_NAME = 'Rafael Alves';
const TEAM_NAME = 'Atendimento';

function fatal(msg) { console.error('ERRO:', msg); process.exit(1); }

if (!PASSWORD) fatal('Set RAFAEL_PASSWORD env var antes de rodar');

const tenant = getTenant(TENANT_ID);
if (!tenant) fatal(`Tenant ${TENANT_ID} não encontrado`);
console.log(`Tenant: ${tenant.name} (${tenant.email})`);

// 1) Email não pode estar em uso como login
const existing = findTenantByAnyLogin(EMAIL);
if (existing) {
  fatal(`Email ${EMAIL} já está em uso como login (tenant ${existing.tenant.id}, ${existing.login ? 'additional_login' : 'owner'})`);
}

// 2) Garantir time "Atendimento"
let team = listTeams(TENANT_ID).find((t) => t.name.toLowerCase() === TEAM_NAME.toLowerCase());
if (team) {
  console.log(`Time "${TEAM_NAME}" já existe: ${team.id}`);
} else {
  team = createTeam(TENANT_ID, {
    name: TEAM_NAME,
    color: '#10B981',
    description: 'Equipe de atendimento da PV Corretora',
  });
  console.log(`Time "${TEAM_NAME}" criado: ${team.id}`);
}

// 3) Agente em crm_agents (Rafael já pode existir; manter role atual)
const agents = listAgents(TENANT_ID);
let agent = agents.find((a) => a.email === EMAIL.toLowerCase());
if (agent) {
  console.log(`Agente já existe: ${agent.id} (${agent.name}, role=${agent.role})`);
} else {
  agent = createAgent(TENANT_ID, {
    name: FULL_NAME,
    email: EMAIL,
    role: 'agent',
  });
  console.log(`Agente criado: ${agent.id}`);
}

// 4) Linka agente ao time (updateAgent nao cobre team_id, vai direto via SQL)
getCrmDb().prepare('UPDATE crm_agents SET team_id=? WHERE id=? AND tenant_id=?').run(team.id, agent.id, TENANT_ID);
console.log(`Agente ${agent.id} adicionado ao time ${team.id}`);

// 5) Hash + additional_login (role espelha a do crm_agent)
const password_hash = await bcrypt.hash(PASSWORD, 10);
const login = addAdditionalLogin(TENANT_ID, {
  email: EMAIL,
  password_hash,
  full_name: FULL_NAME,
  role: agent.role === 'owner' ? 'owner' : 'agent',
  agent_id: agent.id,
});
console.log(`additional_login provisionado: ${login.email} → agent ${login.agent_id}`);
console.log('OK.');
