#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────
# verify-backup.sh — Validate a System Clow SQLite backup
# ─────────────────────────────────────────────────────────────────────────
# Usage:
#   verify-backup.sh                 # verify the latest snapshot
#   verify-backup.sh <YYYY-MM-DD-HH> # verify a specific snapshot
#
# For each .sqlite3 file in the snapshot, runs `PRAGMA integrity_check`.
# Exits 0 if all DBs report "ok", non-zero otherwise. Suitable for cron
# health checks.
# ─────────────────────────────────────────────────────────────────────────
set -euo pipefail

CLOW_HOME="${CLOW_HOME:-$HOME/.clow}"
BACKUP_ROOT="$CLOW_HOME/backups"

command -v sqlite3 >/dev/null 2>&1 || { echo "sqlite3 binary not found in PATH" >&2; exit 2; }
[ -d "$BACKUP_ROOT" ] || { echo "no backups dir: $BACKUP_ROOT" >&2; exit 1; }

if [ $# -ge 1 ]; then
  TIMESTAMP="$1"
else
  TIMESTAMP="$(cd "$BACKUP_ROOT" && ls -1d -- 20*-*-*-*/ 2>/dev/null | sed 's|/$||' | sort | tail -1 || true)"
  [ -n "$TIMESTAMP" ] || { echo "no backups found" >&2; exit 1; }
fi

DIR="$BACKUP_ROOT/$TIMESTAMP"
[ -d "$DIR" ] || { echo "backup not found: $DIR" >&2; exit 1; }

echo "[verify-backup] checking snapshot: $TIMESTAMP"

failed=0
checked=0
shopt -s nullglob
for db in "$DIR/crm.sqlite3" "$DIR/memory/"*.sqlite3; do
  [ -f "$db" ] || continue
  checked=$((checked + 1))
  rel="${db#$DIR/}"
  # integrity_check returns "ok" (single line) or one or more error rows
  result="$(sqlite3 "$db" 'PRAGMA integrity_check;' 2>&1 || true)"
  if [ "$result" = "ok" ]; then
    echo "  ✓ $rel"
  else
    echo "  ✗ $rel"
    printf '    %s\n' "$result"
    failed=$((failed + 1))
  fi
done
shopt -u nullglob

if [ "$checked" -eq 0 ]; then
  echo "[verify-backup] no .sqlite3 files in $DIR" >&2
  exit 1
fi

if [ "$failed" -eq 0 ]; then
  echo "[verify-backup] OK — $checked database(s) passed"
  exit 0
fi

echo "[verify-backup] FAIL — $failed of $checked failed integrity_check" >&2
exit 1
