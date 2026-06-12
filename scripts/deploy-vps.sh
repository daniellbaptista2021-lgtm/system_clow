#!/usr/bin/env bash
# deploy-vps.sh — deploy seguro do branch de melhorias na VPS.
#
# Uso (na VPS, como root ou usuario do deploy):
#   cd /opt/system-clow && bash scripts/deploy-vps.sh claude/friendly-galileo-10cebi
#
# O que faz:
#   1. Salva o commit atual em .last-deploy-rev (rollback de 1 comando)
#   2. Fetch + checkout do branch
#   3. npm ci + build + migrations
#   4. Reload do PM2 (zero-downtime) e health check
#   5. Avisa sobre envs de seguranca pendentes (ASAAS_WEBHOOK_TOKEN, senha admin)
#
# Rollback:
#   git checkout "$(cat .last-deploy-rev)" && npm ci && npm run build && pm2 reload all
set -euo pipefail

BRANCH="${1:?Uso: bash scripts/deploy-vps.sh <branch>}"
# Usa o diretorio atual se for um repo git (permite rodar o script extraido
# pra fora do repo, ex: /tmp); senao, assume que o script vive em <repo>/scripts.
if [ -d .git ]; then
  APP_DIR="$(pwd)"
else
  APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
fi
cd "$APP_DIR"
if [ ! -d .git ]; then
  echo "ERRO: $APP_DIR nao e um repositorio git. Rode de dentro de /opt/system-clow." >&2
  exit 1
fi

echo "==> Deploy de '$BRANCH' em $APP_DIR"

# 1. Ponto de rollback
CURRENT_REV="$(git rev-parse HEAD)"
echo "$CURRENT_REV" > .last-deploy-rev
echo "==> Rollback point salvo: $CURRENT_REV (.last-deploy-rev)"

# Recusa deploy com working tree sujo — mudanca local nao commitada se perderia
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "ERRO: working tree tem mudancas nao commitadas. Commit/stash antes do deploy." >&2
  git status --short
  exit 1
fi

# 2. Fetch + checkout (retry com backoff pra rede instavel)
for delay in 0 2 4 8 16; do
  sleep "$delay"
  if git fetch origin "$BRANCH"; then break; fi
  echo "fetch falhou, retry em ${delay}s..."
done
git checkout "$BRANCH"
git reset --hard "origin/$BRANCH"
echo "==> Agora em: $(git log -1 --oneline)"

# 3. Build
npm ci
npm run build
npm run db:migrate || { echo "ERRO: migrations falharam — abortando antes do reload"; exit 1; }

# 4. Checks de env de seguranca (avisa, nao bloqueia)
ENV_FILE="$APP_DIR/.env"
if [ -f "$ENV_FILE" ]; then
  if ! grep -q '^ASAAS_WEBHOOK_TOKEN=..*' "$ENV_FILE"; then
    echo ""
    echo "⚠️  ASAAS_WEBHOOK_TOKEN nao configurado no .env."
    echo "   O webhook /webhooks/asaas agora e FAIL-CLOSED: sem token, rejeita tudo (503)."
    echo "   Se voce USA Asaas: gere um token, adicione ASAAS_WEBHOOK_TOKEN=<token> no .env"
    echo "   e configure o MESMO token no painel Asaas (Integracoes → Webhooks)."
    echo "   Se NAO usa Asaas: nada a fazer."
    echo ""
  fi
  if grep -q '^CLOW_ADMIN_PASS=..*' "$ENV_FILE" && ! grep -q '^CLOW_ADMIN_PASS_HASH=..*' "$ENV_FILE"; then
    echo ""
    echo "⚠️  CLOW_ADMIN_PASS em texto puro no .env (login admin continua funcionando)."
    echo "   Migrar pra hash bcrypt:"
    echo "     node scripts/hash-admin-pass.cjs 'SuaSenha'"
    echo "   Cole o CLOW_ADMIN_PASS_HASH gerado no .env e remova CLOW_ADMIN_PASS."
    echo ""
  fi
fi

# 5. Reload + health check
if command -v pm2 >/dev/null 2>&1; then
  pm2 reload all --update-env
  echo "==> PM2 reloaded. Aguardando health..."
  sleep 5
  for i in 1 2 3 4 5 6; do
    if curl -skf https://127.0.0.1:3001/health/ready >/dev/null 2>&1 \
       || curl -sf http://127.0.0.1:3001/health/ready >/dev/null 2>&1; then
      echo "==> ✓ Health OK — deploy concluido: $(git log -1 --oneline)"
      exit 0
    fi
    echo "   health ainda nao respondeu (tentativa $i/6)..."
    sleep 5
  done
  echo "ERRO: health check falhou apos reload. Logs: pm2 logs --lines 100" >&2
  echo "Rollback: git checkout $CURRENT_REV && npm ci && npm run build && pm2 reload all" >&2
  exit 1
else
  echo "==> PM2 nao encontrado — reinicie o servico manualmente (node dist/server/server.js)."
fi
