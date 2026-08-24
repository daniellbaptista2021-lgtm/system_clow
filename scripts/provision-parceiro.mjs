// Provisiona conta de parceiro/sócio: tenant próprio, plano empresarial, sem
// mensalidade e sem dados pessoais. Uso diário do CRM pelo painel.
//
// Uso: PARCEIRO_EMAIL='...' PARCEIRO_SENHA='...' PARCEIRO_NOME='...' \
//        node scripts/provision-parceiro.mjs
//
// Cria:
//  - Tenant novo (owner login = PARCEIRO_EMAIL, tier empresarial)
//  - Senha bcrypt + status active + email já verificado (login direto)
//  - RBAC bootstrap (agent owner com admin.full)
//  - Boards padrão do CRM (Pipeline de Vendas + Atendimento)
//  - API key própria
//
// NÃO cria canal de WhatsApp nem credencial de IA — o parceiro conecta o
// próprio número e cadastra a própria chave (Anthropic/OpenAI) pelo painel.
// Os agentes dele NUNCA usam credencial do admin: src/crm/ai/agent.ts e
// src/api/anthropic.ts lançam SemCredencialIa quando o tenant não tem chave.
//
// Sem cobrança: o servidor roda em modo bônus (src/tenancy/modoBonus.ts), que
// desliga licença, Stripe e cota. CPF/nascimento/telefone ficam em branco de
// propósito — só o signup público exige. Sem telefone em authorized_phones ele
// não comanda a IA por WhatsApp pessoal; o painel do CRM funciona inteiro.

import 'dotenv/config';
import bcrypt from 'bcryptjs';
import {
  createTenant, updateTenant, findTenantByAnyLogin,
} from '../dist/tenancy/tenantStore.js';
import { bootstrapTenantRBAC } from '../dist/auth/authRoutes.js';
import { seedDefaultBoards } from '../dist/crm/store/boardsStore.js';

const EMAIL = (process.env.PARCEIRO_EMAIL || '').trim().toLowerCase();
const PASSWORD = process.env.PARCEIRO_SENHA;
const FULL_NAME = (process.env.PARCEIRO_NOME || '').trim();
const TIER = 'empresarial';

function fatal(msg) { console.error('ERRO:', msg); process.exit(1); }

if (!EMAIL) fatal('Set PARCEIRO_EMAIL');
if (!FULL_NAME) fatal('Set PARCEIRO_NOME');
if (!PASSWORD) fatal('Set PARCEIRO_SENHA');
if (PASSWORD.length < 8) fatal('Senha precisa de no mínimo 8 caracteres');

// 0) Pre-flight: email livre?
const existing = findTenantByAnyLogin(EMAIL);
if (existing) {
  fatal(`Email ${EMAIL} já está em uso (tenant ${existing.tenant.id}, ${existing.login ? 'additional_login' : 'owner'})`);
}

// 1) Criar tenant — createTenant já gera a API key default
const { tenant, apiKey } = createTenant({ email: EMAIL, name: FULL_NAME, tier: TIER });
console.log(`Tenant criado: ${tenant.id} (${tenant.tier})`);

// 2) Senha + status
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
console.log(`tier      = ${tenant.tier}`);
console.log(`login     = ${EMAIL}  /  (senha do env PARCEIRO_SENHA)`);
console.log(`api_key   = ${apiKey}`);
