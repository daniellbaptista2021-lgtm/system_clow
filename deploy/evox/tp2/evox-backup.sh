#!/usr/bin/env bash
# Cópia de segurança do EVOX — roda DENTRO do container "evox" da tp2.
# Escreve um .tar.gz na saída padrão; quem guarda é a tp1 (evox-backup-puxar.sh),
# para a cópia não morar no mesmo disco que os dados.
#
# O SQLite está com WAL ativo: copiar o arquivo com o EVOX no ar corrompe o
# banco. Por isso a cópia sai pela API de backup do próprio SQLite.
# A configuração (/etc/evox.env) vai junto de propósito: sem a CLOW_PII_KEY de
# lá, os dados cifrados da cópia não abrem.
set -euo pipefail
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/dados" "$T/etc"

cd /opt/evox
node -e '
  const D = require("better-sqlite3");
  D(process.argv[1], { readonly: true }).backup(process.argv[2]).then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
' /var/lib/evox/dados/crm.sqlite3 "$T/dados/crm.sqlite3"
cp -a /var/lib/evox/dados/tenants.json "$T/dados/"
for f in /var/lib/evox/dados/*.json; do [ -e "$f" ] && cp -a "$f" "$T/dados/"; done
tar -C /var/lib/evox -cf "$T/workspaces.tar" workspaces
cp -a /etc/evox.env "$T/etc/"
if systemctl is-active --quiet postgresql && [ -s /etc/evolution.env ]; then
  su postgres -c "pg_dump -Fc evolution" > "$T/evolution.pgdump"
  cp -a /etc/evolution.env "$T/etc/"
fi
date -Is > "$T/criado-em.txt"
tar -C "$T" -czf - .
