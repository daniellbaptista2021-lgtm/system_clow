#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────
# backup-offsite.sh — push backups locais pra storage externo
# ─────────────────────────────────────────────────────────────────────────
# Roda DEPOIS do backup-sqlite.sh (que produz snapshots em ~/.clow/backups).
# Sincroniza o diretorio inteiro pra storage off-VPS, escolhendo o backend
# automaticamente:
#
#   1. rclone — se CLOW_BACKUP_RCLONE_REMOTE setado (ex: "b2:clow-backups").
#      Pre-req: `rclone config` configurado pro remote (Backblaze B2,
#      Wasabi, S3, GDrive — qualquer um suportado por rclone).
#   2. AWS CLI — se CLOW_BACKUP_S3_BUCKET setado (ex: "s3://clow-backups").
#      Pre-req: AWS_ACCESS_KEY_ID/SECRET_ACCESS_KEY no env (ou IAM role).
#   3. SCP — se CLOW_BACKUP_SCP_TARGET setado (ex: "user@host:/path").
#      Pre-req: chave SSH em ~/.ssh/id_rsa configurada pro target.
#
# Se nenhuma dessas estiver setada, sai com warning (mas exit 0 — pra nao
# poluir logs de cron com falha previsivel quando ainda nao foi configurado).
#
# Output:
#   stdout/stderr append em ~/.clow/backups/cron.log via redirect do cron
#
# Usage:
#   ./backup-offsite.sh
# ─────────────────────────────────────────────────────────────────────────
set -euo pipefail

CLOW_HOME="${CLOW_HOME:-$HOME/.clow}"
BACKUPS_DIR="$CLOW_HOME/backups"
TS="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

if [[ ! -d "$BACKUPS_DIR" ]]; then
  echo "[$TS][backup-offsite] sem ${BACKUPS_DIR} — pula"
  exit 0
fi

# Carrega so as vars CLOW_BACKUP_* do .env (evita interpolacao de $X em valores
# como bcrypt hash CLOW_ADMIN_PASS_HASH=$2b$10$...).
if [[ -f /opt/system-clow/.env ]]; then
  while IFS= read -r line; do
    [[ "$line" =~ ^CLOW_BACKUP_[A-Z_]+= ]] || continue
    key="${line%%=*}"
    val="${line#*=}"
    # Strip surrounding quotes if present
    val="${val%\"}"; val="${val#\"}"
    val="${val%\'}"; val="${val#\'}"
    export "$key=$val"
  done < /opt/system-clow/.env
fi

# 1) rclone (recomendado — Backblaze B2 sai a ~$0.005/GB/mes)
if [[ -n "${CLOW_BACKUP_RCLONE_REMOTE:-}" ]]; then
  if ! command -v rclone >/dev/null 2>&1; then
    echo "[$TS][backup-offsite] CLOW_BACKUP_RCLONE_REMOTE setado mas rclone nao instalado. apt install rclone"
    exit 0
  fi
  echo "[$TS][backup-offsite] sync via rclone -> ${CLOW_BACKUP_RCLONE_REMOTE}"
  rclone sync "$BACKUPS_DIR" "$CLOW_BACKUP_RCLONE_REMOTE" \
    --config "${CLOW_BACKUP_RCLONE_CONFIG:-/root/.config/rclone/rclone.conf}" \
    --transfers 4 --checkers 8 \
    --exclude 'cron.log' \
    --exclude '*.tmp'
  echo "[$TS][backup-offsite] rclone OK"
  exit 0
fi

# 2) AWS S3
if [[ -n "${CLOW_BACKUP_S3_BUCKET:-}" ]]; then
  if ! command -v aws >/dev/null 2>&1; then
    echo "[$TS][backup-offsite] CLOW_BACKUP_S3_BUCKET setado mas aws-cli nao instalado. apt install awscli"
    exit 0
  fi
  echo "[$TS][backup-offsite] sync via aws s3 -> ${CLOW_BACKUP_S3_BUCKET}"
  aws s3 sync "$BACKUPS_DIR" "$CLOW_BACKUP_S3_BUCKET" \
    --exclude 'cron.log' \
    --exclude '*.tmp' \
    --storage-class STANDARD_IA
  echo "[$TS][backup-offsite] aws s3 OK"
  exit 0
fi

# 3) SCP (fallback simples — tar + scp pra outro host)
if [[ -n "${CLOW_BACKUP_SCP_TARGET:-}" ]]; then
  TARFILE="/tmp/clow-backup-$(date -u '+%Y%m%d-%H%M%S').tar.gz"
  echo "[$TS][backup-offsite] empacotando ${BACKUPS_DIR} -> ${TARFILE}"
  tar czf "$TARFILE" -C "$(dirname "$BACKUPS_DIR")" "$(basename "$BACKUPS_DIR")" \
    --exclude='cron.log' --exclude='*.tmp'
  echo "[$TS][backup-offsite] scp -> ${CLOW_BACKUP_SCP_TARGET}"
  scp -o StrictHostKeyChecking=accept-new "$TARFILE" "$CLOW_BACKUP_SCP_TARGET"
  rm -f "$TARFILE"
  echo "[$TS][backup-offsite] scp OK"
  exit 0
fi

# Nada configurado — apenas avisa
echo "[$TS][backup-offsite] OFF-SITE BACKUP NAO CONFIGURADO. setar CLOW_BACKUP_RCLONE_REMOTE, CLOW_BACKUP_S3_BUCKET ou CLOW_BACKUP_SCP_TARGET no .env"
exit 0
