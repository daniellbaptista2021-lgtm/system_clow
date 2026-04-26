#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────
# backup-sqlite.sh — Live, WAL-safe SQLite backup for System Clow
# ─────────────────────────────────────────────────────────────────────────
# Uses the SQLite `.backup` command (NOT cp) — produces a single consistent
# snapshot file even while the database is being written to.
#
# Targets:
#   $CLOW_HOME/crm.sqlite3
#   $CLOW_HOME/memory/*.sqlite3
#
# Output:
#   $CLOW_HOME/backups/YYYY-MM-DD-HH/
#     ├── crm.sqlite3
#     └── memory/{tenant}.sqlite3
#
# Retention:
#   - last 24 hourly snapshots
#   - last 7 daily   (newest per calendar day, ages 24h–7d)
#   - last 4 weekly  (newest per ISO week,    ages 7d–28d)
#   - everything older is pruned.
# ─────────────────────────────────────────────────────────────────────────
set -euo pipefail

CLOW_HOME="${CLOW_HOME:-$HOME/.clow}"
BACKUP_ROOT="$CLOW_HOME/backups"
TIMESTAMP="$(date -u +'%Y-%m-%d-%H')"
TARGET="$BACKUP_ROOT/$TIMESTAMP"

log() { printf '[backup-sqlite] %s\n' "$*"; }
fail() { printf '[backup-sqlite] ERROR: %s\n' "$*" >&2; exit 1; }

command -v sqlite3 >/dev/null 2>&1 || fail "sqlite3 binary not found in PATH"
[ -d "$CLOW_HOME" ] || fail "CLOW_HOME does not exist: $CLOW_HOME"

mkdir -p "$TARGET/memory"

backup_db() {
  local src="$1" dst="$2"
  # `.backup` is online and atomic — sqlite3 takes a read lock and writes a
  # consistent snapshot, even with concurrent writers in WAL mode.
  if sqlite3 "$src" ".backup '$dst'"; then
    log "✓ $(basename "$src") → $(printf '%s' "$dst" | sed "s|$BACKUP_ROOT/||")"
  else
    fail "backup failed: $src"
  fi
}

# ── 1. crm.sqlite3 ───────────────────────────────────────────────────────
if [ -f "$CLOW_HOME/crm.sqlite3" ]; then
  backup_db "$CLOW_HOME/crm.sqlite3" "$TARGET/crm.sqlite3"
else
  log "skip: crm.sqlite3 not present"
fi

# ── 2. per-tenant memory DBs ─────────────────────────────────────────────
shopt -s nullglob
for db in "$CLOW_HOME/memory/"*.sqlite3; do
  backup_db "$db" "$TARGET/memory/$(basename "$db")"
done
shopt -u nullglob

# ── 3. retention / rotation ──────────────────────────────────────────────
prune_backups() {
  local now_ts
  now_ts="$(date -u +%s)"

  declare -A keep            # keep[bk]=1 means keep this dir
  declare -A by_day          # latest backup per YYYY-MM-DD (24h..7d tier)
  declare -A by_week         # latest backup per YYYY-WW    (7d..28d tier)

  # Iterate in chronological order so "latest of day/week" wins on overwrite.
  while IFS= read -r bk; do
    [ -n "$bk" ] || continue
    # Validate format YYYY-MM-DD-HH
    [[ "$bk" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{2}$ ]] || continue

    local y="${bk:0:4}" m="${bk:5:2}" d="${bk:8:2}" h="${bk:11:2}"
    local bk_ts age
    bk_ts="$(date -u -d "$y-$m-$d $h:00:00" +%s 2>/dev/null)" || continue
    age=$(( now_ts - bk_ts ))

    if (( age < 86400 )); then
      keep["$bk"]=1                                   # hourly
    elif (( age < 604800 )); then
      by_day["$y-$m-$d"]="$bk"                        # daily rep
    elif (( age < 2419200 )); then
      local week
      week="$(date -u -d "$y-$m-$d" +%G-%V 2>/dev/null)" || continue
      by_week["$week"]="$bk"                          # weekly rep
    fi
    # > 28 days: not added to keep — will be pruned below.
  done < <(cd "$BACKUP_ROOT" && ls -1d -- */ 2>/dev/null | sed 's|/$||' | sort)

  for v in "${by_day[@]}";  do keep["$v"]=1; done
  for v in "${by_week[@]}"; do keep["$v"]=1; done

  # Prune everything not in keep
  while IFS= read -r bk; do
    [ -n "$bk" ] || continue
    [[ "$bk" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{2}$ ]] || continue
    if [ -z "${keep[$bk]:-}" ]; then
      rm -rf -- "${BACKUP_ROOT:?}/$bk"
      log "pruned: $bk"
    fi
  done < <(cd "$BACKUP_ROOT" && ls -1d -- */ 2>/dev/null | sed 's|/$||' | sort)
}

prune_backups

log "done — snapshot: $TIMESTAMP"
