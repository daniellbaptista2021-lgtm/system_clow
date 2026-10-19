#!/usr/bin/env bash
# CRM Vector — cria a conta de um corretor (um CRM próprio, separado dos outros).
#
# Uso (no Mac):
#   printf '%s' 'SENHA' | ssh tp1 'bash /root/criar-conta-vector.sh email@x.com "Nome Completo"'
# A senha vem pela entrada padrão, nunca por argumento (linha de comando é
# pública em `ps`).
#
# Idempotente: se a conta já existe, não troca a senha nem apaga nada — só
# confere que o dono (owner) está cadastrado na equipe dela.
set -euo pipefail

APP=/opt/crm-vector
DADOS=/var/lib/crm-vector
export PATH=/opt/node26/bin:$PATH

EMAIL="${1:-}"; NOME="${2:-}"
[ -n "$EMAIL" ] && [ -n "$NOME" ] || { echo "uso: criar-conta-vector.sh email \"Nome\"" >&2; exit 1; }
echo "$EMAIL" | grep -Eq '^[^@ ]+@[^@ ]+\.[^@ ]+$' || { echo "e-mail inválido: $EMAIL" >&2; exit 1; }
SENHA="$(cat)"
[ "${#SENHA}" -ge 8 ] || { echo "senha ausente ou curta (mande pela entrada padrão)" >&2; exit 1; }

cd "$APP"
SENHA="$SENHA" CLOW_HOME="$DADOS" EMAIL="$EMAIL" NOME="$NOME" node --input-type=module -e "
import bcrypt from 'bcryptjs';
const ts = await import('./dist/tenancy/tenantStore.js');
const { bootstrapTenantRBAC } = await import('./dist/auth/authRoutes.js');
const email = process.env.EMAIL.toLowerCase();
let t = ts.listTenants().find((x) => (x.email || '').toLowerCase() === email);
if (!t) {
  t = ts.createTenant({ email, name: process.env.NOME, tier: 'empresarial' }).tenant;
  ts.updateTenant(t.id, { password_hash: bcrypt.hashSync(process.env.SENHA, 10), full_name: process.env.NOME });
  console.log('CONTA CRIADA:', process.env.NOME, '<' + email + '>', t.id.slice(0, 8));
} else {
  console.log('conta já existia (senha mantida):', email, t.id.slice(0, 8));
}
bootstrapTenantRBAC(t.id, process.env.NOME, email);
console.log('contas no CRM Vector:', ts.listTenants().length);
process.exit(0);
" 2>&1 | grep -v -E 'INFO|ts\":|\[3[0-9]m' || true

echo -n "conferência do login: "
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:3031/auth/login -H 'Content-Type: application/json' \
  --data "$(SENHA="$SENHA" EMAIL="$EMAIL" node -e "console.log(JSON.stringify({email:process.env.EMAIL,password:process.env.SENHA}))")"
