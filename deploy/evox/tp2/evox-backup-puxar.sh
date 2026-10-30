#!/usr/bin/env bash
# Busca a cópia do EVOX (tp2) e guarda na tp1. Timer diário: evox-backup.timer.
# Usa a chave do parque, que só a tp1 tem. Guarda 14 dias.
set -euo pipefail
DESTINO=/root/backup-evox
CHAVE=/var/lib/territorio-controller/id_ed25519
TP2=root@184.107.178.49
mkdir -p "$DESTINO"; chmod 700 "$DESTINO"
ARQ="$DESTINO/evox-$(date +%Y-%m-%d-%H%M).tar.gz"
ssh -i "$CHAVE" -o BatchMode=yes -o ConnectTimeout=20 "$TP2" \
  'incus exec evox -- bash /usr/local/bin/evox-backup.sh' > "$ARQ.parcial"
# Cópia vazia ou truncada não substitui nada: confere antes de dar nome final.
tar -tzf "$ARQ.parcial" | grep -q 'dados/crm.sqlite3' || { echo "cópia inválida"; rm -f "$ARQ.parcial"; exit 1; }
mv "$ARQ.parcial" "$ARQ"; chmod 600 "$ARQ"
find "$DESTINO" -name 'evox-*.tar.gz' -mtime +14 -delete
echo "ok $ARQ $(du -h "$ARQ" | cut -f1)"
