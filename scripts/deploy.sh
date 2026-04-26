#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────
# deploy.sh — Pull, build, test, zero-downtime reload via PM2.
# ─────────────────────────────────────────────────────────────────────────
# Run from /opt/system-clow on the production VPS.
#
# Sequence:
#   1. git pull
#   2. npm ci          (lockfile-faithful install, no postinstall surprises)
#   3. npm run build   (tsc → dist/ + copy migrations/*.sql)
#   4. npm run db:migrate   (apply any new SQL migrations)
#   5. npm test        (catches breaking changes BEFORE rolling them to users)
#   6. pm2 reload clow --update-env
#        ↳ rolls workers ONE AT A TIME, traffic stays served by the
#          surviving worker(s). /health/live should return 200 throughout.
#
# Tunables (env vars):
#   SKIP_TESTS=1     — skip the test step (use only for emergency hotfix
#                      where you've already validated the change locally)
#   SKIP_MIGRATE=1   — skip db:migrate (rare; only if you committed a
#                      schema-only change that's already applied OOB)
#   CLOW_INSTANCES=N — override PM2 cluster size for this reload
#
# To verify zero-downtime in another shell while this runs:
#   while true; do
#     curl -s -o /dev/null -w "%{http_code} %{time_total}s\n" \
#       https://system-clow.pvcorretor01.com.br/health/live
#     sleep 0.2
#   done | grep -v "^200 "
# That command should print NOTHING during the reload. If it prints 502 or
# 5xx, something failed and the reload was NOT zero-downtime.
# ─────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO_DIR="${REPO_DIR:-/opt/system-clow}"
APP_NAME="${APP_NAME:-clow}"

cd "$REPO_DIR"

step() { printf '\n[deploy] ▸ %s\n' "$*"; }
fail() { printf '[deploy] ✗ %s\n' "$*" >&2; exit 1; }

# Sanity: this directory must be a git checkout.
[ -d .git ] || fail "not a git repo: $REPO_DIR"

# Show what we're about to deploy.
CURRENT_SHA="$(git rev-parse --short HEAD)"
step "current revision: $CURRENT_SHA"

# ── 1. git pull ─────────────────────────────────────────────────────────
step "git pull"
git fetch origin --quiet
LOCAL_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
git reset --hard "origin/$LOCAL_BRANCH"
NEW_SHA="$(git rev-parse --short HEAD)"
if [ "$CURRENT_SHA" = "$NEW_SHA" ]; then
  step "no new commits ($CURRENT_SHA) — proceeding anyway (rebuild + reload)"
else
  step "$CURRENT_SHA → $NEW_SHA"
  git log --oneline "$CURRENT_SHA..$NEW_SHA" | head -10
fi

# ── 2. npm ci ───────────────────────────────────────────────────────────
step "npm ci"
HUSKY=0 npm ci --no-audit --no-fund --silent

# ── 3. build ────────────────────────────────────────────────────────────
step "npm run build"
npm run build

# ── 4. db:migrate (idempotent) ──────────────────────────────────────────
if [ "${SKIP_MIGRATE:-0}" != "1" ]; then
  step "npm run db:migrate"
  npm run db:migrate
else
  step "SKIP_MIGRATE=1 — migrations skipped"
fi

# ── 5. tests ────────────────────────────────────────────────────────────
if [ "${SKIP_TESTS:-0}" != "1" ]; then
  step "npm test"
  npm test
else
  step "SKIP_TESTS=1 — test step skipped (HOTFIX MODE)"
fi

# ── 6. zero-downtime reload ─────────────────────────────────────────────
step "pm2 reload $APP_NAME --update-env"
pm2 reload "$APP_NAME" --update-env

# Confirm the new revision is live.
sleep 2
RUNNING_SHA="$(curl -fsS http://127.0.0.1:3001/health/version 2>/dev/null | sed -nE 's/.*"commit_sha":"([0-9a-f]{7})[0-9a-f]*".*/\1/p')"
if [ -n "$RUNNING_SHA" ] && [ "$RUNNING_SHA" = "$NEW_SHA" ]; then
  step "✓ /health/version reports $RUNNING_SHA — deploy verified"
else
  step "⚠ /health/version reports '${RUNNING_SHA:-?}', expected '$NEW_SHA'"
  step "  workers may still be reloading; tail \`pm2 logs $APP_NAME\` to confirm"
fi

step "done"
