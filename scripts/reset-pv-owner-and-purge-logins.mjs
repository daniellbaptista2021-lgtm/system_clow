// One-shot: tenant PV Corretora
//  1) reseta senha do OWNER (login principal)
//  2) remove TODOS os additional_logins (vendedores/consultores)
//  3) revoga TODAS as crm-shell keys do tenant (desloga todos aparelhos)
// Uso: PV_NEW_PASSWORD='...' /usr/bin/node scripts/reset-pv-owner-and-purge-logins.mjs
import bcrypt from 'bcryptjs';
import { mutateTenant, getTenant, revokeOldCrmShellKeys } from '../dist/tenancy/tenantStore.js';

const TENANT_ID = 'be5f5042-d939-447d-8777-5ac841e7aa07';
const NEW_PASSWORD = process.env.PV_NEW_PASSWORD;
if (!NEW_PASSWORD) { console.error('ERRO: set PV_NEW_PASSWORD'); process.exit(1); }

const tenant = getTenant(TENANT_ID);
if (!tenant) { console.error('ERRO: tenant não encontrado'); process.exit(1); }

const newHash = await bcrypt.hash(NEW_PASSWORD, 10);

const result = mutateTenant(TENANT_ID, (t) => {
  const removed = (t.additional_logins || []).map((l) => l.email);
  t.password_hash = newHash;
  t.additional_logins = [];
  return { owner_email: t.email, removed };
});
if (!result) { console.error('ERRO: mutateTenant retornou null'); process.exit(1); }

const revoked = revokeOldCrmShellKeys(TENANT_ID);

console.log('Senha do owner (' + result.owner_email + ') resetada.');
console.log('additional_logins removidos (' + result.removed.length + '): ' + (result.removed.join(', ') || '—'));
console.log('crm-shell keys revogadas (desloga todos aparelhos): ' + revoked);

// verificação do hash
const t2 = getTenant(TENANT_ID);
console.log('verificação bcrypt:', await bcrypt.compare(NEW_PASSWORD, t2.password_hash) ? 'OK' : 'FALHOU');
console.log('additional_logins agora:', (t2.additional_logins || []).length);
