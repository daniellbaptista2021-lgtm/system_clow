// One-shot: provisiona tenant Ceglia Soluções (plano empresarial, tudo liberado).
// Uso: CEGLIA_PASSWORD='...' node scripts/provision-ceglia.mjs
//
// Cria:
//  - Tenant novo (owner login cegliasolucoes@gmail.com, tier empresarial)
//  - Senha bcrypt + status active + email já verificado (login direto)
//  - RBAC bootstrap (agent owner com admin.full)
//  - Boards padrão do CRM (Pipeline de Vendas + Atendimento)
//  - API key própria do cliente
//
// NÃO cria canal de WhatsApp nem credencial de IA — o cliente conecta o
// próprio número e cadastra a própria chave (Anthropic/OpenAI) pelo painel.
// Os agentes dele NUNCA usam credencial do admin: src/crm/ai/agent.ts e
// src/api/anthropic.ts lançam SemCredencialIa quando o tenant não tem chave.

import 'dotenv/config';
import bcrypt from 'bcryptjs';
import {
  createTenant, updateTenant, findTenantByAnyLogin,
} from '../dist/tenancy/tenantStore.js';
import { bootstrapTenantRBAC } from '../dist/auth/authRoutes.js';
import { seedDefaultBoards } from '../dist/crm/store/boardsStore.js';

const EMAIL = 'cegliasolucoes@gmail.com';
const PASSWORD = process.env.CEGLIA_PASSWORD;
const FULL_NAME = 'Ceglia Soluções';
const TIER = 'empresarial';

function fatal(msg) { console.error('ERRO:', msg); process.exit(1); }

if (!PASSWORD) fatal('Set CEGLIA_PASSWORD env var antes de rodar');
if (PASSWORD.length < 8) fatal('Senha precisa de no mínimo 8 caracteres');

// 0) Pre-flight: email livre?
const existing = findTenantByAnyLogin(EMAIL);
if (existing) {
  fatal(`Email ${EMAIL} já está em uso (tenant ${existing.tenant.id}, ${existing.login ? 'additional_login' : 'owner'})`);
}

// 1) Criar tenant (tier empresarial) — createTenant já gera a API key default
const { tenant, apiKey } = createTenant({ email: EMAIL.toLowerCase(), name: FULL_NAME, tier: TIER });
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
bootstrapTenantRBAC(tenant.id, FULL_NAME, EMAIL.toLowerCase());
console.log('RBAC bootstrapped (owner / admin.full)');

// 4) Boards padrão do CRM (idempotente)
const board = seedDefaultBoards(tenant.id);
console.log(`Boards do CRM prontos (board inicial: ${board.id})`);

// 5) Resumo
console.log('\n=== PROVISIONAMENTO OK ===');
console.log(`tenant_id = ${tenant.id}`);
console.log(`tier      = ${tenant.tier}`);
console.log(`login     = ${EMAIL}  /  (senha do env CEGLIA_PASSWORD)`);
console.log(`api_key   = ${apiKey}`);
