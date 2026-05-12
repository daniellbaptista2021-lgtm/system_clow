#!/usr/bin/env node
/**
 * Cria 2 tenants de teste no plano Profissional. One-shot — re-rodar pula
 * emails ja existentes em vez de duplicar.
 *
 * Uso: node scripts/create-test-tenants.mjs
 */
import bcrypt from 'bcryptjs';
import {
  createTenant,
  updateTenant,
  findTenantByEmail,
} from '../dist/tenancy/tenantStore.js';

const accounts = [
  { email: 'marciozamot@gmail.com',     password: 'zamot123',       name: 'Marcio Zamot' },
  { email: 'brunovbcorretora@gmail.com', password: 'vbcorretora123', name: 'Bruno VB Corretora' },
];

for (const a of accounts) {
  if (findTenantByEmail(a.email)) {
    console.log(`↷ skip ${a.email} (ja existe)`);
    continue;
  }
  const password_hash = await bcrypt.hash(a.password, 10);
  const { tenant, apiKey } = createTenant({
    email: a.email,
    name: a.name,
    tier: 'profissional',
  });
  updateTenant(tenant.id, { password_hash, full_name: a.name });
  console.log(`✓ ${a.email}  tenant=${tenant.id}  tier=profissional  apiKey=${apiKey}`);
}
