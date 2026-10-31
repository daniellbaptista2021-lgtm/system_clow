#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────
# backup-sqlite.sh — Live, WAL-safe SQLite backup for EVOX
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
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SQLITE3_BIN="$(command -v sqlite3 2>/dev/null || true)"
NODE_BIN="$(command -v node 2>/dev/null || true)"

log() { printf '[backup-sqlite] %s\n' "$*"; }
fail() { printf '[backup-sqlite] ERROR: %s\n' "$*" >&2; exit 1; }

[ -n "$SQLITE3_BIN" ] || [ -n "$NODE_BIN" ] || fail "sqlite3 and node binaries not found in PATH"
[ -d "$CLOW_HOME" ] || fail "CLOW_HOME does not exist: $CLOW_HOME"

mkdir -p "$TARGET/memory"

backup_db() {
  local src="$1" dst="$2"
  # `.backup` is online and atomic — sqlite3 takes a read lock and writes a
  # consistent snapshot, even with concurrent writers in WAL mode.
  if [ -n "$SQLITE3_BIN" ]; then
    "$SQLITE3_BIN" "$src" ".backup '$dst'" || fail "backup failed: $src"
  else
    (cd "$PROJECT_ROOT" && "$NODE_BIN" -e '
      const Database = require("better-sqlite3");
      const [src, dst] = process.argv.slice(1);
      const db = new Database(src, { readonly: true });
      db.backup(dst).then(() => db.close()).catch((error) => {
        console.error(error.message); process.exit(1);
      });
    ' "$src" "$dst") || fail "backup failed: $src"
  fi
  if [ -f "$dst" ]; then
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

  # macOS ainda traz Bash 3.2, sem arrays associativos. Arquivos temporários
  # mantêm esta rotação compatível com o Mac e com o Linux do servidor.
  local rotation_tmp keep_file day_file week_file
  rotation_tmp="$(mktemp -d "${TMPDIR:-/tmp}/evox-backup-rotation.XXXXXX")"
  keep_file="$rotation_tmp/keep"
  day_file="$rotation_tmp/day"
  week_file="$rotation_tmp/week"
  : > "$keep_file"
  : > "$day_file"
  : > "$week_file"

  backup_epoch() {
    local value="$1"
    date -u -d "$value" +%s 2>/dev/null \
      || date -u -j -f '%Y-%m-%d %H:%M:%S' "$value" +%s 2>/dev/null
  }

  backup_week() {
    local value="$1"
    date -u -d "$value" +%G-%V 2>/dev/null \
      || date -u -j -f '%Y-%m-%d' "$value" +%G-%V 2>/dev/null
  }

  remember_latest() {
    local file="$1" key="$2" value="$3" next="$rotation_tmp/next"
    awk -v wanted="$key" '$1 != wanted { print }' "$file" > "$next"
    printf '%s %s\n' "$key" "$value" >> "$next"
    mv "$next" "$file"
  }

  # Iterate in chronological order so "latest of day/week" wins on overwrite.
  while IFS= read -r bk; do
    [ -n "$bk" ] || continue
    # Validate format YYYY-MM-DD-HH
    [[ "$bk" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{2}$ ]] || continue

    local y="${bk:0:4}" m="${bk:5:2}" d="${bk:8:2}" h="${bk:11:2}"
    local bk_ts age
    bk_ts="$(backup_epoch "$y-$m-$d $h:00:00")" || continue
    age=$(( now_ts - bk_ts ))

    if (( age < 86400 )); then
      printf '%s\n' "$bk" >> "$keep_file"            # hourly
    elif (( age < 604800 )); then
      remember_latest "$day_file" "$y-$m-$d" "$bk"  # daily rep
    elif (( age < 2419200 )); then
      local week
      week="$(backup_week "$y-$m-$d")" || continue
      remember_latest "$week_file" "$week" "$bk"    # weekly rep
    fi
    # > 28 days: not added to keep — will be pruned below.
  done < <(cd "$BACKUP_ROOT" && ls -1d -- */ 2>/dev/null | sed 's|/$||' | sort)

  awk '{ print $2 }' "$day_file" >> "$keep_file"
  awk '{ print $2 }' "$week_file" >> "$keep_file"

  # Prune everything not in keep
  while IFS= read -r bk; do
    [ -n "$bk" ] || continue
    [[ "$bk" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{2}$ ]] || continue
    if ! grep -Fqx "$bk" "$keep_file"; then
      rm -rf -- "${BACKUP_ROOT:?}/$bk"
      log "pruned: $bk"
    fi
  done < <(cd "$BACKUP_ROOT" && ls -1d -- */ 2>/dev/null | sed 's|/$||' | sort)

  rm -rf -- "$rotation_tmp"
}

prune_backups

log "done — snapshot: $TIMESTAMP"
