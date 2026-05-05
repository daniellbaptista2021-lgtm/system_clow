// One-shot: provisiona login adicional Monique no tenant PV Corretor.
// Uso: node scripts/provision-monique.mjs
import bcrypt from 'bcryptjs';
import { createAgent, listAgents } from '../dist/crm/store/agentsStore.js';
import { addAdditionalLogin, getTenant, findTenantByAnyLogin } from '../dist/tenancy/tenantStore.js';

const TENANT_ID = 'be5f5042-d939-447d-8777-5ac841e7aa07'; // PV Corretor
const EMAIL = 'moniquecorretora@gmail.com';
const PASSWORD = process.env.MONIQUE_PASSWORD;
const FULL_NAME = 'Monique Corretora';

function fatal(msg) { console.error('ERRO:', msg); process.exit(1); }

if (!PASSWORD) fatal('Set MONIQUE_PASSWORD env var antes de rodar (ex: MONIQUE_PASSWORD=... node scripts/provision-monique.mjs)');

const tenant = getTenant(TENANT_ID);
if (!tenant) fatal(`Tenant ${TENANT_ID} não encontrado`);
console.log(`Tenant: ${tenant.name} (${tenant.email})`);

// 1) Garantir que email não está em uso
const existing = findTenantByAnyLogin(EMAIL);
if (existing) {
  fatal(`Email ${EMAIL} já está em uso (tenant ${existing.tenant.id}, ${existing.login ? 'additional_login' : 'owner'})`);
}

// 2) Criar / reutilizar agente em crm_agents
const agents = listAgents(TENANT_ID);
let agent = agents.find((a) => a.email === EMAIL.toLowerCase());
if (agent) {
  console.log(`Agente já existe: ${agent.id} (${agent.name})`);
} else {
  agent = createAgent(TENANT_ID, {
    name: FULL_NAME,
    email: EMAIL,
    role: 'owner', // acesso total
  });
  console.log(`Agente criado: ${agent.id}`);
}

// 3) Hash da senha + add additional_login
const password_hash = await bcrypt.hash(PASSWORD, 10);
const login = addAdditionalLogin(TENANT_ID, {
  email: EMAIL,
  password_hash,
  full_name: FULL_NAME,
  role: 'owner',
  agent_id: agent.id,
});
console.log(`additional_login provisionado: ${login.email} → agent ${login.agent_id}`);
console.log('OK.');
