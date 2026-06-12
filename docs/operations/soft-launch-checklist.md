# Soft launch — checklist do dia anterior

> **Quando**: 24h antes de abrir cadastro pros 500 corretores.
> **Quem**: você + 1 dev backup acordado.
> **Tempo total**: ~45 min se nada quebrar.

Vai marcando `[x]` conforme rodar. Se qualquer comando der saída inesperada, **PARA** e abre [incident-runbook.md](incident-runbook.md). Não tenta consertar e seguir.

```bash
# Variáveis usadas pelo checklist inteiro — exporta primeiro.
export VPS_IP=<vps-ip>
export METRICS_TOKEN=<valor-do-.env>
export DOMAIN=system-clow.pvcorretor01.com.br
```

---

## 1. Backup íntegro nas últimas 1h — [ ]

```bash
ssh root@$VPS_IP '
  ls -la ~/.clow/backups/ | tail -5
  /opt/system-clow/scripts/backup-sqlite.sh
  /opt/system-clow/scripts/verify-backup.sh
'
```

**Esperado**: `[verify-backup] OK — N database(s) passed`. Se aparecer `FAIL`, pula pra `(a) SQLite corrompido` no [incident-runbook.md](incident-runbook.md#a-sqlite-corrompido).

## 2. Cron de backup ativo — [ ]

```bash
ssh root@$VPS_IP 'crontab -l | grep -E "backup-sqlite|verify-backup"'
```

**Esperado**: 2 linhas — `0 * * * * .../backup-sqlite.sh` e `30 * * * * .../verify-backup.sh`. Se não aparecer, roda:

```bash
ssh root@$VPS_IP '/opt/system-clow/scripts/setup-cron.sh'
```

## 3. /health/ready respondendo verde — [ ]

```bash
curl -fsS https://$DOMAIN/health/ready | jq .
```

**Esperado**: `"status": "ok"` e todos os 4 checks (sqlite/redis/litellm/disk) com `ok: true`. Se `degraded`, abre o detalhe do check que falhou no runbook.

## 4. /health/version mostra commit certo — [ ]

```bash
curl -fsS https://$DOMAIN/health/version | jq .
git -C /opt/system-clow log -1 --oneline   # roda no VPS via ssh
```

**Esperado**: `commit_sha` do `/health/version` bate com o `HEAD` do `git log`. Se diferente, deploy não foi aplicado — roda `pm2 reload clow --update-env`.

## 5. /metrics token configurado — [ ]

```bash
curl -fsS -H "Authorization: Bearer $METRICS_TOKEN" https://$DOMAIN/metrics | head -20
```

**Esperado**: linhas `# HELP clow_*`. Se 503, METRICS_TOKEN não está no `.env`. Se 401, valor errado. Edita `/opt/system-clow/.env` e `pm2 reload clow --update-env`.

## 6. Stripe live keys (NÃO test keys) — [ ]

```bash
ssh root@$VPS_IP '
  grep -E "^STRIPE_(SECRET_KEY|PRICE_)" /opt/system-clow/.env | head -5
'
```

**Esperado**: `STRIPE_SECRET_KEY=sk_live_...` (NÃO `sk_test_...`). Os 3 price IDs (`STRIPE_PRICE_STARTER`, `STRIPE_PRICE_PROFISSIONAL`, `STRIPE_PRICE_EMPRESARIAL`) tem que ser os live também — `price_xxx` que existe na conta live do Stripe.

Confere no dashboard Stripe (modo Live, não Test):
```
https://dashboard.stripe.com/products
```

## 7. Stripe webhook endpoint configurado em modo LIVE — [ ]

Dashboard Stripe → **Developers → Webhooks → Hosted endpoints** (modo **Live**).

Endpoint cadastrado tem que ser exatamente:
```
https://system-clow.pvcorretor01.com.br/webhooks/stripe
```

Eventos selecionados (mínimo):
- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `checkout.session.async_payment_failed`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.payment_failed`

Signing secret (`whsec_...`) **tem que bater** com `STRIPE_WEBHOOK_SECRET` no `.env`. Se trocou recentemente, ressincroniza:

```bash
# Stripe dashboard → Reveal signing secret → copia
ssh root@$VPS_IP 'sed -i "s|^STRIPE_WEBHOOK_SECRET=.*|STRIPE_WEBHOOK_SECRET=whsec_NOVO_VALOR|" /opt/system-clow/.env && pm2 reload clow --update-env'
```

## 8. Z-API + Meta credenciais válidas — [ ]

```bash
# Lista canais cadastrados (saída esperada: pelo menos 1 zapi ou meta com status='active')
ssh root@$VPS_IP "sqlite3 ~/.clow/crm.sqlite3 \"SELECT type, name, status, last_health_check FROM crm_channels WHERE status != 'disabled';\""
```

**Esperado**: pelo menos 1 canal com `status='active'`. Se aparecer `pending` ou `error`, segue [incident-runbook.md → (b) Z-API offline](incident-runbook.md#b-z-api-offline).

## 9. Logs zerados (rotação OK) — [ ]

```bash
ssh root@$VPS_IP '
  ls -la /root/.pm2/logs/clow-out.log /root/.pm2/logs/clow-error.log
  pm2 flush clow
  ls -la /root/.pm2/logs/clow-out.log /root/.pm2/logs/clow-error.log
'
```

**Esperado**: tamanhos antes > 0, depois 0 bytes. Logs zerados pra começar limpo.

## 10. Disco com headroom — [ ]

```bash
ssh root@$VPS_IP 'df -h /opt /root/.clow'
```

**Esperado**: `Use%` abaixo de **70%** nos 2 mounts. Se acima de 85%, [incident-runbook.md → (d) VPS sem disco](incident-runbook.md#d-vps-sem-disco) **antes** de continuar — não dá pra abrir 500 cadastros num disco cheio.

## 11. UptimeRobot com 2 monitores ativos — [ ]

Login em https://uptimerobot.com → Dashboard.

Esperado:
- Monitor 1: `https://$DOMAIN/health/live` — interval 1 min
- Monitor 2: `https://$DOMAIN/health/ready` — interval 5 min
- Ambos: status `Up` (verde) há pelo menos 24h
- Alert contacts: e-mail + Telegram bot configurados

## 12. Alerta Telegram funcional — [ ]

Manda manualmente uma mensagem de teste pro bot:

```bash
# Use seu BOT_TOKEN + CHAT_ID do .env do alerting
curl -fsS "https://api.telegram.org/bot$TG_BOT_TOKEN/sendMessage" \
  -d "chat_id=$TG_CHAT_ID" \
  -d "text=🧪 [soft-launch] teste $(date -u +%H:%M:%S)"
```

**Esperado**: mensagem chega no celular em < 5s.

## 13. Sentry recebendo eventos (se DSN configurado) — [ ]

```bash
ssh root@$VPS_IP 'grep -E "^SENTRY_DSN=" /opt/system-clow/.env'
```

Se a env existir, gera um evento de teste:

```bash
ssh root@$VPS_IP '
  cd /opt/system-clow
  node -e "
    require(\"./dist/utils/sentry.js\").initSentry();
    require(\"./dist/utils/sentry.js\").captureException(new Error(\"soft-launch test event\"), { source: \"checklist\" });
    setTimeout(() => process.exit(0), 2000);
  "
'
```

**Esperado**: dashboard Sentry mostra o evento com tag `source=checklist` em < 30s. Se não aparecer, DSN está errado ou outbound HTTP da VPS está bloqueado.

## 14. Branch protection ativa em `main` + `master` — [ ]

GitHub → repo → **Settings → Branches**.

Esperado em ambos: PR required + 4 status checks (typecheck, test, secrets-scan, build) + admins não bypassam.

## 15. Rollback testado nos últimos 7 dias — [ ]

```bash
git -C /opt/system-clow log --oneline -5
```

Anota o commit anterior ao HEAD atual. Se nunca rodou rollback, **roda agora em horário calmo** seguindo [rollback.md](rollback.md) num teste seco — confirma que `pm2 reload` traz o sha anterior em < 5min.

## 16. Plan limits batem com Stripe price IDs — [ ]

Confere que [src/billing/quotaGuard.ts:21-29](../../src/billing/quotaGuard.ts#L21) tem os 6 tiers (`starter`, `profissional`, `empresarial`, `business`, `one`, `smart`) e que cada `STRIPE_PRICE_*` no `.env` aponta pro produto certo no dashboard Stripe.

```bash
ssh root@$VPS_IP '
  grep -E "^STRIPE_PRICE_" /opt/system-clow/.env
  echo "---"
  grep -E "^  (starter|profissional|empresarial|business):" /opt/system-clow/src/billing/quotaGuard.ts
'
```

## 17. Migrations aplicadas — [ ]

```bash
ssh root@$VPS_IP 'cd /opt/system-clow && CRM_DB_PATH=/root/.clow/crm.sqlite3 npm run db:status 2>&1 | tail -10'
```

**Esperado**: cada migração com `✓` (applied). Se aparecer `·` (pending), **PARA tudo** e roda `npm run db:migrate` antes de prosseguir.

## 18. CI verde no commit em produção — [ ]

```bash
ssh root@$VPS_IP 'git -C /opt/system-clow rev-parse HEAD'
# Compara com:
gh run list --repo daniellbaptista2021-lgtm/system_clow --branch main --limit 5
```

Esperado: o commit em prod está em uma das CI runs com `success`.

## 19. Limites do PM2 cluster reservados — [ ]

```bash
ssh root@$VPS_IP 'pm2 list && pm2 describe clow | grep -E "instances|exec mode|max_memory"'
```

**Esperado**: `clow` em `cluster mode`, `instances: 2`, `max_memory_restart: 1G`. Se estiver em `fork`, edita `ecosystem.config.cjs` e roda `pm2 reload clow --update-env`.

## 20. Smoke test de signup → CRM → mensagem — [ ]

Cria um tenant teste com 1 cartão de teste real do Stripe live (gasto ~R$1, depois reembolsa):

```bash
# 1. Acessa https://$DOMAIN/onboarding
# 2. Cadastra um e-mail teste com plano starter
# 3. Stripe popup → cartão real → paga R$ 47 (mês fracionado)
# 4. Confirma que webhook chegou:
ssh root@$VPS_IP 'pm2 logs clow --lines 20 --nostream | grep -i stripe'
# 5. Loga no dashboard com a senha temp do e-mail
# 6. Cria 1 board, 1 contato, 1 card
# 7. Manda 1 mensagem WhatsApp pro número de teste do Z-API
# 8. Confirma que IA respondeu em < 30s
# 9. Reembolsa o pagamento no dashboard Stripe
# 10. Deleta o tenant teste:
ssh root@$VPS_IP "sqlite3 ~/.clow/tenants.json ..."  # ou via /admin
```

---

## Pré-launch — botão de pânico

Se qualquer item de 1-20 estiver vermelho, **adia o launch 24h**. Não negocia.

Se TUDO está verde, posta no canal:
```
✅ Soft launch GO — [data-hora]
- backup íntegro / cron ativo
- /health/ready verde
- Stripe live keys validadas
- 2/2 PM2 workers cluster mode
- UptimeRobot + Telegram + Sentry ativos
- smoke test signup→IA: passou
- commit em prod: <sha>
```

---

## Pós-launch — primeiras 4h

A cada 30 min (use cron-ish na sua cabeça):

```bash
# Saúde geral
curl -fsS https://$DOMAIN/health/ready | jq .status

# Throughput nos últimos 5 min
curl -fsS -H "Authorization: Bearer $METRICS_TOKEN" https://$DOMAIN/metrics | grep "clow_http_requests_total"

# Tenants ativos (deveria crescer)
curl -fsS -H "Authorization: Bearer $METRICS_TOKEN" https://$DOMAIN/metrics | grep "clow_tenants_active"

# Erros 5xx (deveria ser 0)
curl -fsS -H "Authorization: Bearer $METRICS_TOKEN" https://$DOMAIN/metrics | grep "clow_errors_total"
```

Se algum 5xx aparecer, abre [incident-runbook.md](incident-runbook.md) imediatamente.
