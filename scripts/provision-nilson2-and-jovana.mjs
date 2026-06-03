// One-shot: provisiona DOIS logins adicionais no tenant PV Corretor.
//  1) Nilson #2 (segundo dispositivo) — agent_id NOVO/distinto pra nao colidir
//     sessao com o login atual (userKey = agent_id; mesmo agent_id => revoga a
//     sessao do outro PC). role=owner igual ao login atual do Nilson.
//  2) Jovana — atendente nova, role=agent (igual Rafael), time Atendimento.
// Senhas fortes sao geradas aqui e impressas no final.
// Uso: /usr/bin/node scripts/provision-nilson2-and-jovana.mjs
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { createAgent, listAgents, createTeam, listTeams } from '../dist/crm/store/agentsStore.js';
import { addAdditionalLogin, getTenant, findTenantByAnyLogin } from '../dist/tenancy/tenantStore.js';
import { getCrmDb } from '../dist/crm/schema.js';

const TENANT_ID = 'be5f5042-d939-447d-8777-5ac841e7aa07'; // PV Corretor
const TEAM_NAME = 'Atendimento';

const NEW_LOGINS = [
  { email: 'nilsonpvcorretor2@gmail.com', full_name: 'Nilson', agent_name: 'Nilson 2', role: 'owner' },
  { email: 'jovanapvcorretora@gmail.com', full_name: 'Jovana', agent_name: 'Jovana', role: 'agent' },
];

function fatal(msg) { console.error('ERRO:', msg); process.exit(1); }

// Senha forte: 16 chars base64url (sem ambiguidade visual)
function genPassword() {
  return crypto.randomBytes(12).toString('base64url');
}

const tenant = getTenant(TENANT_ID);
if (!tenant) fatal(`Tenant ${TENANT_ID} não encontrado`);
console.log(`Tenant: ${tenant.name} (${tenant.email})`);

// Garantir time "Atendimento"
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

const credentials = [];

for (const spec of NEW_LOGINS) {
  console.log(`\n=== ${spec.email} ===`);

  // 1) Email não pode estar em uso
  const existing = findTenantByAnyLogin(spec.email);
  if (existing) {
    fatal(`Email ${spec.email} já está em uso (tenant ${existing.tenant.id}, ${existing.login ? 'additional_login' : 'owner'})`);
  }

  // 2) Agente NOVO em crm_agents (agent_id distinto => userKey distinto)
  const agents = listAgents(TENANT_ID);
  let agent = agents.find((a) => a.email === spec.email.toLowerCase());
  if (agent) {
    console.log(`Agente já existe: ${agent.id} (${agent.name}, role=${agent.role})`);
  } else {
    agent = createAgent(TENANT_ID, {
      name: spec.agent_name,
      email: spec.email,
      role: spec.role,
    });
    console.log(`Agente criado: ${agent.id} (${agent.name}, role=${agent.role})`);
  }

  // 3) Linka ao time Atendimento
  getCrmDb().prepare('UPDATE crm_agents SET team_id=? WHERE id=? AND tenant_id=?').run(team.id, agent.id, TENANT_ID);
  console.log(`Agente ${agent.id} no time ${team.id}`);

  // 4) Senha + additional_login
  const password = genPassword();
  const password_hash = await bcrypt.hash(password, 10);
  const login = addAdditionalLogin(TENANT_ID, {
    email: spec.email,
    password_hash,
    full_name: spec.full_name,
    role: spec.role === 'owner' ? 'owner' : 'agent',
    agent_id: agent.id,
  });
  console.log(`additional_login provisionado: ${login.email} → agent ${login.agent_id}`);
  credentials.push({ email: spec.email, password, role: spec.role, agent_id: agent.id });
}

console.log('\n========== CREDENCIAIS (anote, a senha não fica recuperável) ==========');
for (const c of credentials) {
  console.log(`  login: ${c.email}`);
  console.log(`  senha: ${c.password}`);
  console.log(`  role:  ${c.role}   agent_id: ${c.agent_id}`);
  console.log('  ---');
}
console.log('OK.');
