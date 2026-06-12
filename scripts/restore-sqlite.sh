#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────
# restore-sqlite.sh — Restore System Clow SQLite snapshot
# ─────────────────────────────────────────────────────────────────────────
# Usage:
#   restore-sqlite.sh <YYYY-MM-DD-HH>           # restore (overwrites live DBs)
#   restore-sqlite.sh <YYYY-MM-DD-HH> --dry-run # show what would be restored
#   restore-sqlite.sh latest                    # restore most recent snapshot
#
# Safety:
#   1. If a live DB exists, it is moved aside to <name>.pre-restore.<epoch>
#      so the restore is undoable.
#   2. WAL/SHM sidecar files of the live DB are removed so the restored
#      file is opened cleanly without a stale journal.
# ─────────────────────────────────────────────────────────────────────────
set -euo pipefail

CLOW_HOME="${CLOW_HOME:-$HOME/.clow}"
BACKUP_ROOT="$CLOW_HOME/backups"

usage() {
  sed -n '3,16p' "$0" >&2
  exit 1
}

[ $# -ge 1 ] || usage
TIMESTAMP="$1"
DRY_RUN=false
[ "${2:-}" = "--dry-run" ] && DRY_RUN=true

if [ "$TIMESTAMP" = "latest" ]; then
  TIMESTAMP="$(cd "$BACKUP_ROOT" 2>/dev/null && ls -1d -- 20*-*-*-*/ 2>/dev/null | sed 's|/$||' | sort | tail -1 || true)"
  [ -n "$TIMESTAMP" ] || { echo "no backups found in $BACKUP_ROOT" >&2; exit 1; }
fi

SOURCE="$BACKUP_ROOT/$TIMESTAMP"
[ -d "$SOURCE" ] || { echo "backup not found: $SOURCE" >&2; exit 1; }

log() { printf '[restore-sqlite] %s\n' "$*"; }

restore_one() {
  local src="$1" dst="$2"
  [ -f "$src" ] || return 0

  if $DRY_RUN; then
    log "[dry-run] $src → $dst"
    return 0
  fi

  if [ -f "$dst" ]; then
    local backup_name="${dst}.pre-restore.$(date -u +%s)"
    mv -- "$dst" "$backup_name"
    log "moved live DB aside: $backup_name"
  fi
  # Remove stale WAL/SHM that would belong to the moved-aside file —
  # the snapshot we're restoring is a single consistent file.
  rm -f -- "${dst}-wal" "${dst}-shm"
  cp -- "$src" "$dst"
  log "restored: $dst"
}

log "source snapshot: $TIMESTAMP"

# CRM
restore_one "$SOURCE/crm.sqlite3" "$CLOW_HOME/crm.sqlite3"

# Per-tenant memory DBs
if [ -d "$SOURCE/memory" ]; then
  mkdir -p "$CLOW_HOME/memory"
  shopt -s nullglob
  for db in "$SOURCE/memory/"*.sqlite3; do
    restore_one "$db" "$CLOW_HOME/memory/$(basename "$db")"
  done
  shopt -u nullglob
fi

if $DRY_RUN; then
  log "dry run complete — no files were modified"
else
  log "done"
fi
