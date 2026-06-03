// One-shot:
//  1) remove entrada stale da Monique de additional_logins do tenant PV
//  2) reseta senha do Rafael Alves
// Uso: RAFAEL_NEW_PASSWORD=... /usr/bin/node scripts/cleanup-monique-and-reset-rafael.mjs
import bcrypt from 'bcryptjs';
import { mutateTenant, getTenant } from '../dist/tenancy/tenantStore.js';

const TENANT_ID = 'be5f5042-d939-447d-8777-5ac841e7aa07';
const MONIQUE_EMAIL = 'moniquecorretora@gmail.com';
const RAFAEL_EMAIL = 'rafaelalvespvcorretora@gmail.com';
const RAFAEL_NEW_PASSWORD = process.env.RAFAEL_NEW_PASSWORD;

function fatal(msg) { console.error('ERRO:', msg); process.exit(1); }
if (!RAFAEL_NEW_PASSWORD) fatal('Set RAFAEL_NEW_PASSWORD env var');

const tenant = getTenant(TENANT_ID);
if (!tenant) fatal(`Tenant ${TENANT_ID} não encontrado`);

const newHash = await bcrypt.hash(RAFAEL_NEW_PASSWORD, 10);

const result = mutateTenant(TENANT_ID, (t) => {
  const before = t.additional_logins?.length ?? 0;
  let removedMonique = null;
  let updatedRafael = false;

  if (t.additional_logins) {
    const moniqueIdx = t.additional_logins.findIndex(
      (l) => l.email.toLowerCase() === MONIQUE_EMAIL.toLowerCase(),
    );
    if (moniqueIdx !== -1) {
      removedMonique = t.additional_logins[moniqueIdx];
      t.additional_logins.splice(moniqueIdx, 1);
    }

    const rafael = t.additional_logins.find(
      (l) => l.email.toLowerCase() === RAFAEL_EMAIL.toLowerCase(),
    );
    if (rafael) {
      rafael.password_hash = newHash;
      updatedRafael = true;
    }
  }

  return {
    before,
    after: t.additional_logins?.length ?? 0,
    removedMonique,
    updatedRafael,
  };
});

if (!result) fatal('mutateTenant retornou null');
console.log(`additional_logins: ${result.before} → ${result.after}`);
if (result.removedMonique) {
  console.log(`Removido: ${result.removedMonique.email} (agent_id=${result.removedMonique.agent_id})`);
} else {
  console.log(`Aviso: Monique (${MONIQUE_EMAIL}) não encontrada em additional_logins — nada removido`);
}
if (result.updatedRafael) {
  console.log(`Senha do Rafael (${RAFAEL_EMAIL}) atualizada`);
} else {
  console.log(`Aviso: Rafael (${RAFAEL_EMAIL}) não encontrado em additional_logins — senha NÃO atualizada`);
}
console.log('OK.');
