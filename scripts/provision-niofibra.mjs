// One-shot: provisiona tenant nio_fibra (plano empresarial) + canal Meta WhatsApp.
// Uso: NIOFIBRA_PASSWORD=... NIOFIBRA_META_TOKEN=... node scripts/provision-niofibra.mjs
//
// Cria:
//  - Tenant novo (owner login niofibra@gmail.com, tier empresarial)
//  - RBAC bootstrap (agent owner com admin.full)
//  - Canal Meta com credenciais cifradas (phone_number_id 1082183848315262)
//
// NÃO toca em .env, webhook do Meta App, ou config global. O cliente continua
// na mesma URL pública /webhooks/meta — resolução de tenant é por phone_number_id.

import 'dotenv/config';
import bcrypt from 'bcryptjs';
import {
  createTenant, updateTenant, getTenant, findTenantByEmail, findTenantByAnyLogin,
} from '../dist/tenancy/tenantStore.js';
import { bootstrapTenantRBAC } from '../dist/auth/authRoutes.js';
import { createChannel, findChannelByPhoneId } from '../dist/crm/store/channelsStore.js';
import { encryptJson } from '../dist/crm/crypto.js';

const EMAIL = 'niofibra@gmail.com';
const PASSWORD = process.env.NIOFIBRA_PASSWORD;
const FULL_NAME = 'Nio Fibra';
const TIER = 'empresarial';

// Meta WhatsApp creds
const META = {
  accessToken: process.env.NIOFIBRA_META_TOKEN,
  phoneNumberId: '1082183848315262',
  businessAccountId: '1587561738979037',
  appId: '2700441513674445',
  apiVersion: 'v23.0',
};
const DISPLAY_PHONE = '+552196556477';
const CHANNEL_NAME = 'Meta WhatsApp — nio_fibra';

function fatal(msg) { console.error('ERRO:', msg); process.exit(1); }

if (!PASSWORD) fatal('Set NIOFIBRA_PASSWORD env var antes de rodar');
if (!META.accessToken) fatal('Set NIOFIBRA_META_TOKEN env var antes de rodar');

// 0) Pre-flight: email livre? phone_number_id livre?
const existing = findTenantByAnyLogin(EMAIL);
if (existing) {
  fatal(`Email ${EMAIL} já está em uso (tenant ${existing.tenant.id}, ${existing.login ? 'additional_login' : 'owner'})`);
}
const existingChannel = findChannelByPhoneId(META.phoneNumberId);
if (existingChannel) {
  fatal(`phone_number_id ${META.phoneNumberId} já está vinculado ao tenant ${existingChannel.tenantId} (canal ${existingChannel.id})`);
}

// 1) Criar tenant (tier empresarial)
const { tenant } = createTenant({ email: EMAIL.toLowerCase(), name: FULL_NAME, tier: TIER });
console.log(`Tenant criado: ${tenant.id} (${tenant.tier})`);

// 2) Embed senha + dados extras (pula CPF/birth_date — owner pode preencher depois)
const password_hash = await bcrypt.hash(PASSWORD, 10);
updateTenant(tenant.id, {
  password_hash,
  full_name: FULL_NAME,
  phone_e164: DISPLAY_PHONE.replace(/\D/g, ''),
  authorized_phones: [DISPLAY_PHONE.replace(/\D/g, '')],
  status: 'active',
  email_verified_at: new Date().toISOString(),
});
console.log(`Senha + perfil gravados (status=active, email_verified)`);

// 3) Bootstrap RBAC (agent owner + role admin.full)
bootstrapTenantRBAC(tenant.id, FULL_NAME, EMAIL, DISPLAY_PHONE.replace(/\D/g, ''));
console.log(`RBAC bootstrapped (owner)`);

// 4) Criar canal Meta com credenciais cifradas
const credentialsEncrypted = encryptJson(META);
const channel = createChannel(tenant.id, {
  type: 'meta',
  name: CHANNEL_NAME,
  credentialsEncrypted,
  phoneNumber: DISPLAY_PHONE,
  phoneNumberId: META.phoneNumberId,
  status: 'pending', // virá 'active' no primeiro inbound webhook
});
console.log(`Canal Meta criado: ${channel.id}`);
console.log(`  webhook_secret (per-channel): ${channel.webhookSecret}`);

// 5) Resumo
console.log('\n=== PROVISIONAMENTO OK ===');
console.log(`tenant_id        = ${tenant.id}`);
console.log(`tier             = ${tenant.tier}`);
console.log(`login            = ${EMAIL}  /  (senha do env NIOFIBRA_PASSWORD)`);
console.log(`channel_id       = ${channel.id}`);
console.log(`phone_number_id  = ${META.phoneNumberId}`);
console.log(`waba_id          = ${META.businessAccountId}`);
console.log(`display_phone    = ${DISPLAY_PHONE}`);
