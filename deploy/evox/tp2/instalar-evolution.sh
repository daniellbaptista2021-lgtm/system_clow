#!/usr/bin/env bash
# Evolution API (WhatsApp) dentro do container "evox" da tp2 — sem Docker.
#
# Docker não roda em container Incus sem privilégio (o runc tenta escrever um
# sysctl somente-leitura), então a Evolution roda nativa: Node + Postgres
# locais, só no loopback (127.0.0.1:8080). O EVOX fala com ela por dentro; os
# avisos dela voltam ao EVOX pelo endereço público.
#
# Mesma versão da tp1 (2.3.7). Idempotente: rodar de novo não recria banco nem
# troca a chave. Uso, DENTRO do container: bash instalar-evolution.sh
set -euo pipefail
VERSAO=2.3.7
APP=/opt/evolution
export DEBIAN_FRONTEND=noninteractive

command -v psql >/dev/null || apt-get install -y -qq postgresql >/dev/null
systemctl enable --now postgresql >/dev/null

# Banco: senha gerada aqui e guardada só neste container.
if [ ! -s /root/.evolution-db ]; then
  umask 077; openssl rand -hex 16 > /root/.evolution-db
fi
SENHA_DB=$(cat /root/.evolution-db)
if ! su postgres -c "psql -tAc \"SELECT 1 FROM pg_roles WHERE rolname='evolution'\"" | grep -q 1; then
  su postgres -c "psql -qc \"CREATE USER evolution WITH PASSWORD '$SENHA_DB'\""
fi
if ! su postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='evolution'\"" | grep -q 1; then
  su postgres -c "psql -qc \"CREATE DATABASE evolution OWNER evolution\""
fi
echo "banco ok"

if [ ! -d "$APP/.git" ]; then
  git clone -q --depth 1 --branch "$VERSAO" https://github.com/EvolutionAPI/evolution-api "$APP"
fi
cd "$APP"

if [ ! -s /etc/evolution.env ]; then
  umask 077
  cat > /etc/evolution.env <<EOF
SERVER_TYPE=http
SERVER_PORT=8080
SERVER_URL=http://127.0.0.1:8080
AUTHENTICATION_API_KEY=$(openssl rand -hex 24)
AUTHENTICATION_EXPOSE_IN_FETCH_INSTANCES=true
DATABASE_PROVIDER=postgresql
DATABASE_CONNECTION_URI=postgresql://evolution:${SENHA_DB}@127.0.0.1:5432/evolution?schema=public
DATABASE_CONNECTION_CLIENT_NAME=evox
DATABASE_SAVE_DATA_INSTANCE=true
DATABASE_SAVE_DATA_NEW_MESSAGE=true
DATABASE_SAVE_MESSAGE_UPDATE=true
DATABASE_SAVE_DATA_CONTACTS=true
DATABASE_SAVE_DATA_CHATS=true
CACHE_REDIS_ENABLED=false
CACHE_LOCAL_ENABLED=true
S3_ENABLED=false
DEL_INSTANCE=false
CONFIG_SESSION_PHONE_CLIENT=EVOX
CONFIG_SESSION_PHONE_NAME=Chrome
LOG_LEVEL=ERROR,WARN
LOG_BAILEYS=error
LANGUAGE=pt-BR
TZ=America/Sao_Paulo
EOF
fi
cp /etc/evolution.env "$APP/.env"
# Os scripts do prisma (db:generate/db:deploy) leem DATABASE_PROVIDER do ambiente.
set -a; . /etc/evolution.env; set +a

npm ci --no-audit --no-fund >/dev/null 2>&1 && echo "dependencias ok"
npm run db:generate >/dev/null 2>&1 && echo "prisma ok"
npm run db:deploy 2>&1 | tail -2
npm run build >/dev/null 2>&1 || { echo "build da Evolution falhou"; exit 1; }
test -f dist/main.js && echo "build ok"

cat > /etc/systemd/system/evolution.service <<EOF
[Unit]
Description=Evolution API (WhatsApp do EVOX)
After=network-online.target postgresql.service
Requires=postgresql.service

[Service]
WorkingDirectory=$APP
EnvironmentFile=/etc/evolution.env
ExecStart=/usr/local/bin/node dist/main.js
Restart=always
RestartSec=5
MemoryMax=1500M

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable evolution >/dev/null 2>&1
systemctl restart evolution
for i in $(seq 1 30); do
  curl -sf http://127.0.0.1:8080/ >/dev/null && break
  sleep 2
done
curl -s http://127.0.0.1:8080/ | head -c 200; echo
