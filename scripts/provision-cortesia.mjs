// Provisiona um tenant de cortesia (sem mensalidade). Genérico — substitui os
// one-shots por cliente (provision-karina.mjs foi o primeiro deste formato).
//
// Uso:
//   CLOW_HOME=/var/lib/system-clow \
//   CORTESIA_EMAIL='fulano@gmail.com' \
//   CORTESIA_NOME='Fulano de Tal' \
//   CORTESIA_PASSWORD='...' \
//   node scripts/provision-cortesia.mjs
//
// Cria: tenant novo (owner, tier empresarial) + senha bcrypt + status active
// + email já verificado + RBAC owner/admin.full + boards padrão + API key.
//
// SEM COBRANÇA: status 'active' e nenhum trial_ends_at / stripe_subscription_id.
// tenantAuth.ts só expira acesso quando status === 'trial' com trial_ends_at
// vencido, e só bloqueia em 'suspended'/'cancelled' — então a conta é vitalícia
// e nenhum job de billing encosta nela. Não confundir com crm_subscriptions,
// que é a cobrança que o TENANT faz nos clientes dele, não a nossa nele.
//
// NÃO cria canal de WhatsApp nem credencial de IA — o cliente conecta o próprio
// número e cadastra a própria chave (Anthropic/OpenAI) pelo painel.

import 'dotenv/config';
import bcrypt from 'bcryptjs';
import {
  createTenant, updateTenant, findTenantByAnyLogin,
} from '../dist/tenancy/tenantStore.js';
import { bootstrapTenantRBAC } from '../dist/auth/authRoutes.js';
import { seedDefaultBoards } from '../dist/crm/store/boardsStore.js';

const EMAIL = (process.env.CORTESIA_EMAIL || '').trim().toLowerCase();
const FULL_NAME = (process.env.CORTESIA_NOME || '').trim();
const PASSWORD = process.env.CORTESIA_PASSWORD;
const TIER = process.env.CORTESIA_TIER || 'empresarial';

function fatal(msg) { console.error('ERRO:', msg); process.exit(1); }

if (!EMAIL) fatal('Set CORTESIA_EMAIL');
if (!FULL_NAME) fatal('Set CORTESIA_NOME');
if (!PASSWORD) fatal('Set CORTESIA_PASSWORD');
if (PASSWORD.length < 8) fatal('Senha precisa de no mínimo 8 caracteres');
if (process.env.CLOW_HOME !== '/var/lib/system-clow') {
  fatal('CLOW_HOME precisa ser /var/lib/system-clow (o store ativo). Sem isso escreve no ~/.clow errado.');
}

// 0) Pre-flight: email livre?
const existing = findTenantByAnyLogin(EMAIL);
if (existing) {
  fatal(`Email ${EMAIL} já está em uso (tenant ${existing.tenant.id}, ${existing.login ? 'additional_login' : 'owner'})`);
}

// 1) Criar tenant — createTenant já gera a API key default
const { tenant, apiKey } = createTenant({ email: EMAIL, name: FULL_NAME, tier: TIER });
console.log(`Tenant criado: ${tenant.id} (${tenant.tier})`);

// 2) Senha + status. CPF/birth_date/phone ficam pro cliente preencher no painel.
const password_hash = await bcrypt.hash(PASSWORD, 10);
updateTenant(tenant.id, {
  password_hash,
  full_name: FULL_NAME,
  status: 'active',
  email_verified_at: new Date().toISOString(),
});
console.log('Senha + perfil gravados (status=active, email_verified)');

// 3) Bootstrap RBAC (agent owner + role admin.full)
bootstrapTenantRBAC(tenant.id, FULL_NAME, EMAIL);
console.log('RBAC bootstrapped (owner / admin.full)');

// 4) Boards padrão do CRM (idempotente)
const board = seedDefaultBoards(tenant.id);
console.log(`Boards do CRM prontos (board inicial: ${board.id})`);

// 5) Resumo
console.log('\n=== PROVISIONAMENTO OK ===');
console.log(`tenant_id = ${tenant.id}`);
console.log(`tier      = ${tenant.tier}  (cortesia, sem mensalidade)`);
console.log(`login     = ${EMAIL}  /  (senha do env CORTESIA_PASSWORD)`);
console.log(`api_key   = ${apiKey}`);
