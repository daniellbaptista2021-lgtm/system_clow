#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────
# verify-backup.sh — Validate a EVOX SQLite backup
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
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SQLITE3_BIN="$(command -v sqlite3 2>/dev/null || true)"
NODE_BIN="$(command -v node 2>/dev/null || true)"

[ -n "$SQLITE3_BIN" ] || [ -n "$NODE_BIN" ] || { echo "sqlite3 and node binaries not found in PATH" >&2; exit 2; }
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
  if [ -n "$SQLITE3_BIN" ]; then
    result="$("$SQLITE3_BIN" "$db" 'PRAGMA integrity_check;' 2>&1 || true)"
  else
    result="$(cd "$PROJECT_ROOT" && "$NODE_BIN" -e '
      const Database = require("better-sqlite3");
      const db = new Database(process.argv[1], { readonly: true });
      console.log(db.pragma("integrity_check", { simple: true }));
      db.close();
    ' "$db" 2>&1 || true)"
  fi
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
