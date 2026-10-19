#!/usr/bin/env bash
# CRM Vector — instala (ou atualiza) a cópia do CRM na tp1, ao lado do
# CRM Território Próprio, SEM tocar nele: pasta, banco, porta, processo PM2
# e endereço próprios. Só reaproveita a Evolution API (WhatsApp), que já é
# multi-instância; as instâncias do Vector nascem com prefixo "vector-".
#
# Uso (no Mac):
#   printf '%s' 'SENHA' | ssh tp1 'bash /root/instalar-crm-vector.sh'
# A senha vem pela entrada padrão, nunca por argumento (linha de comando é
# pública em `ps`). Ela vira o login de admin E a senha da conta do Daniel.
#
# Idempotente: rodar de novo atualiza o código e preserva .env e dados.
set -euo pipefail

NOME=crm-vector
DOMINIO=vector.pvcorretor01.com.br
PORTA=3031
APP=/opt/crm-vector
DADOS=/var/lib/crm-vector
ORIGEM=/opt/system_clow          # repositório git que recebe o push do Mac
EMAIL_ADMIN=daniellbaptista2021@gmail.com
NOME_ADMIN="Daniel Baptista"
ZONA_CF=a80bb1480dc14d59dcd0fe918080d2a3
IP_HOST=184.107.160.5
export PATH=/opt/node26/bin:$PATH

passo() { printf '\n== %s\n' "$*"; }
falha() { printf '\nFALHOU: %s\n' "$*" >&2; exit 1; }

SENHA="$(cat)"
[ "${#SENHA}" -ge 8 ] || falha "senha ausente ou curta (mande pela entrada padrão)"

# Trava: a porta não pode estar com outro processo que não seja o nosso.
if ss -ltnp | grep -q "127.0.0.1:$PORTA " && ! pm2 describe "$NOME" >/dev/null 2>&1; then
  falha "porta $PORTA ocupada por outro processo"
fi

passo "1/8 código (branch vector)"
if [ -d "$APP/.git" ]; then
  git -C "$APP" fetch -q origin vector
  git -C "$APP" reset -q --hard origin/vector
else
  git clone -q --branch vector "$ORIGEM" "$APP"
fi
git -C "$APP" log --oneline -1

passo "2/8 dependências e build (Node $(node -v))"
cd "$APP"
if [ ! -d node_modules ]; then
  # Mesmo package-lock e mesmo Node do CRM atual: copiar evita recompilar
  # o better-sqlite3 (binário nativo) e baixar tudo de novo.
  cp -a "$ORIGEM/node_modules" ./
fi
npm run build >/tmp/crm-vector-build.log 2>&1 || { tail -20 /tmp/crm-vector-build.log; falha "build"; }
[ -s dist/server/server.js ] || falha "build não gerou dist/server/server.js"

passo "3/8 pasta de dados"
install -d -m 700 "$DADOS"

passo "4/8 .env (só cria se não existir)"
if [ ! -f "$APP/.env" ]; then
  gerar() { openssl rand -hex 32; }
  EVO_URL=$(grep -E '^EVOLUTION_BASE_URL=' "$ORIGEM/.env" | cut -d= -f2-)
  EVO_KEY=$(grep -E '^EVOLUTION_API_KEY=' "$ORIGEM/.env" | cut -d= -f2-)
  [ -n "$EVO_URL" ] && [ -n "$EVO_KEY" ] || falha "não achei a Evolution no .env do CRM atual"
  HASH=$(SENHA="$SENHA" node -e "process.stdout.write(require('bcryptjs').hashSync(process.env.SENHA,10))")
  umask 077
  cat >"$APP/.env" <<EOF
PORT=$PORTA
CLOW_HOME=$DADOS
CLOW_PUBLIC_BASE_URL=https://$DOMINIO
CLOW_USE_HTTPS=false
CLOW_ALLOWED_ORIGINS=https://$DOMINIO
EVOLUTION_BASE_URL=$EVO_URL
EVOLUTION_API_KEY=$EVO_KEY
CLOW_ADMIN_USER=$EMAIL_ADMIN
CLOW_ADMIN_PASS_HASH='$HASH'
CLOW_ADMIN_SESSION_SECRET=$(gerar)
CLOW_USER_SESSION_SECRET=$(gerar)
CLOW_CRM_SECRET=$(gerar)
CLOW_PII_KEY=$(gerar)
CLOW_SSO_SECRET=$(gerar)
CRM_TERRITORIO_ENABLED=false
CRM_TERRITORIO_EXCLUSIVO=false
EOF
  chmod 600 "$APP/.env"
  echo "criado (segredos novos, nenhum compartilhado com o CRM atual)"
else
  echo "já existe — preservado"
fi

passo "5/8 processo PM2 ($NOME)"
cat >"$APP/ecosystem.vector.cjs" <<'EOF'
// O daemon do PM2 desta máquina carrega env de outros apps (incidente de
// 20/08: CLOW_HOME vazado), e o dotenv NÃO sobrescreve variável que já
// existe. Por isso o .env é lido aqui e passado inteiro ao processo: ele
// vence qualquer coisa herdada do daemon.
const fs = require('fs');
const env = { NODE_ENV: 'production' };
for (const linha of fs.readFileSync(__dirname + '/.env', 'utf8').split('\n')) {
  const m = linha.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^'(.*)'$/, '$1');
}
module.exports = { apps: [{
  name: 'crm-vector',
  script: 'dist/server/server.js',
  cwd: __dirname,
  exec_mode: 'fork', instances: 1,
  autorestart: true, watch: false,
  max_memory_restart: '1G',
  node_args: ['--max-old-space-size=1024'],
  env,
  time: true,
  out_file: '/root/.pm2/logs/crm-vector-out.log',
  error_file: '/root/.pm2/logs/crm-vector-error.log',
  merge_logs: true,
  log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
  kill_timeout: 8000, listen_timeout: 10000, exp_backoff_restart_delay: 200,
}] };
EOF
if pm2 describe "$NOME" >/dev/null 2>&1; then
  pm2 reload "$APP/ecosystem.vector.cjs" --update-env >/dev/null
else
  pm2 start "$APP/ecosystem.vector.cjs" >/dev/null
fi
pm2 save >/dev/null
for i in $(seq 1 30); do
  curl -fsS -o /dev/null "http://127.0.0.1:$PORTA/" 2>/dev/null && break
  sleep 1
done
curl -fsS -o /dev/null "http://127.0.0.1:$PORTA/" || { tail -30 /root/.pm2/logs/crm-vector-error.log; falha "servidor não respondeu na porta $PORTA"; }
echo "no ar em 127.0.0.1:$PORTA"
# Prova de que ele usa o banco DELE, e não o do CRM atual.
ls "$DADOS"/crm.sqlite3 >/dev/null || falha "banco não nasceu em $DADOS"

passo "6/8 conta do admin ($EMAIL_ADMIN)"
cd "$APP"
SENHA="$SENHA" CLOW_HOME="$DADOS" EMAIL="$EMAIL_ADMIN" NOME="$NOME_ADMIN" node --input-type=module -e "
import bcrypt from 'bcryptjs';
const ts = await import('./dist/tenancy/tenantStore.js');
const { bootstrapTenantRBAC } = await import('./dist/auth/authRoutes.js');
const email = process.env.EMAIL;
let t = ts.listTenants().find((x) => x.email === email);
if (!t) {
  t = ts.createTenant({ email, name: process.env.NOME, tier: 'empresarial' }).tenant;
  ts.updateTenant(t.id, { password_hash: bcrypt.hashSync(process.env.SENHA, 10), full_name: process.env.NOME });
  console.log('conta criada', t.id.slice(0, 8));
} else {
  console.log('conta já existia', t.id.slice(0, 8));
}
bootstrapTenantRBAC(t.id, process.env.NOME, email);
console.log('contas no CRM Vector:', ts.listTenants().length);
process.exit(0);
"

passo "7/8 Traefik ($DOMINIO)"
cat >/etc/traefik/dynamic/crm-vector.yml <<EOF
# CRM Vector — cópia do CRM para a equipe do Bruno Herradon.
# Mesmas barreiras do system-clow.yml, mais: o cadastro público e a página
# de planos ficam fechados (conta só nasce pelas mãos do admin).
http:
  middlewares:
    vector-somente-local:
      ipAllowList:
        sourceRange:
          - "127.0.0.1/32"

  routers:
    crm-vector-bloqueado:
      rule: >-
        Host(\`$DOMINIO\`) &&
        (PathPrefix(\`/admin\`) || PathPrefix(\`/docs\`) ||
         PathPrefix(\`/openapi.json\`) || PathPrefix(\`/v1/metrics\`) ||
         PathPrefix(\`/metrics\`) || PathPrefix(\`/signup\`) ||
         PathPrefix(\`/pricing\`) || PathPrefix(\`/onboarding\`) ||
         PathPrefix(\`/auth/signup\`) || PathPrefix(\`/billing\`))
      priority: 100
      entryPoints: [websecure]
      service: crm-vector
      middlewares:
        - vector-somente-local
      tls:
        certResolver: le

    crm-vector:
      rule: "Host(\`$DOMINIO\`)"
      priority: 10
      entryPoints: [websecure]
      service: crm-vector
      tls:
        certResolver: le

  services:
    crm-vector:
      loadBalancer:
        servers:
          - url: "http://127.0.0.1:$PORTA"
EOF
echo "rota gravada"

passo "8/8 DNS na Cloudflare"
CF=$(grep -E '^CF_DNS_API_TOKEN=' /etc/territorio-worker.env | cut -d= -f2- | tr -d '"')
[ -n "$CF" ] || falha "sem CF_DNS_API_TOKEN"
EXISTE=$(curl -fsS -H "Authorization: Bearer $CF" \
  "https://api.cloudflare.com/client/v4/zones/$ZONA_CF/dns_records?type=A&name=$DOMINIO" \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).result.length))")
if [ "$EXISTE" = "0" ]; then
  curl -fsS -X POST -H "Authorization: Bearer $CF" -H 'Content-Type: application/json' \
    "https://api.cloudflare.com/client/v4/zones/$ZONA_CF/dns_records" \
    --data "{\"type\":\"A\",\"name\":\"$DOMINIO\",\"content\":\"$IP_HOST\",\"ttl\":300,\"proxied\":false}" >/dev/null
  echo "registro A criado -> $IP_HOST"
else
  echo "registro A já existia"
fi

passo "conferência"
CODIGO=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORTA/auth/login" \
  -H 'Content-Type: application/json' \
  --data "$(SENHA="$SENHA" EMAIL="$EMAIL_ADMIN" node -e "console.log(JSON.stringify({username:process.env.EMAIL,password:process.env.SENHA}))")")
echo "login do admin: HTTP $CODIGO"
[ "$CODIGO" = "200" ] || falha "login recusado"
echo "CRM atual (clow) continua: HTTP $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3021/)"
echo
echo "OK. O certificado HTTPS sai em 1-3 min; depois abra https://$DOMINIO"
