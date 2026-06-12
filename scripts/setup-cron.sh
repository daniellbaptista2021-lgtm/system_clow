#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────
# setup-cron.sh — Install hourly SQLite backup in user crontab (idempotent)
# ─────────────────────────────────────────────────────────────────────────
# Adds two cron lines:
#   0 * * * *  backup-sqlite.sh     (every hour at :00)
#   30 * * * * verify-backup.sh     (every hour at :30 — sanity check)
#
# Output is appended to $CLOW_HOME/backups/cron.log. Re-running this script
# is safe — existing matching lines are not duplicated.
# ─────────────────────────────────────────────────────────────────────────
set -euo pipefail

CLOW_HOME="${CLOW_HOME:-$HOME/.clow}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_SH="$SCRIPT_DIR/backup-sqlite.sh"
VERIFY_SH="$SCRIPT_DIR/verify-backup.sh"

[ -f "$BACKUP_SH" ] || { echo "missing $BACKUP_SH" >&2; exit 1; }
[ -f "$VERIFY_SH" ] || { echo "missing $VERIFY_SH" >&2; exit 1; }

chmod +x "$BACKUP_SH" "$VERIFY_SH"
mkdir -p "$CLOW_HOME/backups"
LOG="$CLOW_HOME/backups/cron.log"

# We embed CLOW_HOME explicitly in case the cron user's environment differs.
LINE_BACKUP="0 * * * * CLOW_HOME='$CLOW_HOME' '$BACKUP_SH' >> '$LOG' 2>&1"
LINE_VERIFY="30 * * * * CLOW_HOME='$CLOW_HOME' '$VERIFY_SH' >> '$LOG' 2>&1"

current_crontab="$(crontab -l 2>/dev/null || true)"

add_if_missing() {
  local line="$1" tag="$2"
  if printf '%s\n' "$current_crontab" | grep -Fxq -- "$line"; then
    echo "[setup-cron] already present: $tag"
    return 0
  fi
  current_crontab="$(printf '%s\n%s\n' "$current_crontab" "$line" | sed '/^$/d')"
  echo "[setup-cron] added: $tag"
}

add_if_missing "$LINE_BACKUP" "hourly backup"
add_if_missing "$LINE_VERIFY" "hourly verify"

printf '%s\n' "$current_crontab" | crontab -

echo "[setup-cron] active crontab:"
crontab -l | grep -E "(backup|verify)-sqlite|verify-backup" || true
