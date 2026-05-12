# On-call handbook

> **Quem lê isso**: você na primeira semana, ou um dev que entrou ontem e o alerta acabou de tocar.
> **Filosofia**: estabilizar primeiro, entender depois. Mitigation > root cause na hora.

```bash
# Sempre exporta isso primeiro:
export VPS_IP=<vps-ip>
export DOMAIN=system-clow.pvcorretor01.com.br
export METRICS_TOKEN=<valor-do-.env>
```

---

## Acordou com alerta no Telegram

### Passo 1 — identifica QUAL alerta (≤30s)

Olha a mensagem. Vai ser um destes 5 tipos:

| Texto do alerta | Significado | Vai pra |
|---|---|---|
| `UptimeRobot: /health/live DOWN` | servidor não responde HTTP | **PASSO 2A** abaixo |
| `UptimeRobot: /health/ready DOWN` ou `503` | dep externa caiu | **PASSO 2B** |
| `Prometheus: HighErrorRate` | 5xx > 1% por 5 min | **PASSO 2C** |
| `Prometheus: WebhooksDown` | Z-API/Meta sem entregar | [runbook (b)](incident-runbook.md#b-z-api-offline) |
| `Sentry: New issue` | exception nova | **PASSO 2D** |
| `Prometheus: DBGrowingTooFast` | disco enchendo | [runbook (d)](incident-runbook.md#d-vps-sem-disco) |

### Passo 2 — diagnostica em paralelo

Abre **3 terminais** ssh diferentes pra ganhar tempo:

```bash
# T1 — health endpoints
curl -fsS https://$DOMAIN/health/live -m 5 && echo
curl -fsS https://$DOMAIN/health/ready -m 5 | jq .
curl -fsS https://$DOMAIN/health/version | jq .

# T2 — pm2 + logs ao vivo
ssh root@$VPS_IP 'pm2 list && echo --- && pm2 logs clow --lines 30 --nostream'

# T3 — recursos VPS
ssh root@$VPS_IP 'df -h /root/.clow && echo --- && free -h && echo --- && uptime'
```

#### 2A — `/health/live` retorna timeout/refused

Significa: PM2 caiu inteiro OU nginx caiu OU rede.

```bash
# 1. Ping basal
ping -c 3 $VPS_IP

# Se ping falha → rede ou VPS down
# Acessa o painel da Hostinger/etc e confirma status. Se VPS está "stopped", liga.
# Se VPS está "running" mas ping falha, abre ticket urgente com a hospedagem.

# 2. Se ping ok → ssh
ssh root@$VPS_IP

# 3. Status pm2
pm2 list
# Se clow está "stopped" / "errored":
pm2 logs clow --err --lines 50 --nostream
pm2 restart clow
sleep 5
curl -fsS http://127.0.0.1:3001/health/live

# 4. Se pm2 ok mas /health/live ainda falha externamente, é nginx
sudo systemctl status nginx
sudo nginx -t && sudo systemctl reload nginx
sudo journalctl -u nginx --since "10 min ago" --no-pager | tail -30
```

#### 2B — `/health/ready` retorna 503

Olha o JSON. O check com `ok: false` te diz qual incidente:
- `checks.sqlite` → [(a) SQLite corrompido](incident-runbook.md#a-sqlite-corrompido)
- `checks.litellm` → [(c) GLM API rate limited](incident-runbook.md#c-glm-api-rate-limited)
- `checks.disk` → [(d) VPS sem disco](incident-runbook.md#d-vps-sem-disco)
- `checks.redis` → não-bloqueante, app funciona com fallback in-memory; baixa prioridade

#### 2C — `HighErrorRate` (5xx > 1%)

```bash
# Quais rotas estão em chamas?
curl -fsS -H "Authorization: Bearer $METRICS_TOKEN" https://$DOMAIN/metrics \
  | grep 'clow_errors_total' | sort -k2 -t'}' -rn | head -10

# Errors recentes nos logs
ssh root@$VPS_IP 'pm2 logs clow --err --lines 100 --nostream' | grep -iE "error|fail" | tail -30

# Sentry tem mais detalhe — abre o dashboard:
# https://sentry.io/organizations/<org>/issues/?project=<project_id>&statsPeriod=1h
```

Se a route que está pegando é `/v1/sessions/*/messages` → problema na pipeline IA — vai pro [runbook (c)](incident-runbook.md#c-glm-api-rate-limited).

Se é `/v1/crm/*` → bug. Última deploy quebrou algo. Considera [rollback](rollback.md).

#### 2D — Sentry New Issue

Abre o link da notificação. Lê o stack trace.

| Padrão | Ação |
|---|---|
| `database is locked` | Cluster + write contention. Ver [runbook (a)](incident-runbook.md#a-sqlite-corrompido) e considerar reduzir `CLOW_INSTANCES`. |
| `RateLimitError` (Anthropic/OpenRouter) | [runbook (c)](incident-runbook.md#c-glm-api-rate-limited) |
| `ECONNREFUSED 127.0.0.1:4000` | LiteLLM caiu. `pm2 restart litellm` |
| `tenant_not_found` | Provavelmente atacante. Confere taxa, considera bloquear IP |
| `TypeError: Cannot read properties of undefined` | Bug recém-deployado → [rollback](rollback.md) |
| Algo NOVO que nunca viu | Snooze a issue 24h, manda screenshot pro grupo, investiga depois |

---

## Comandos úteis (cola e usa)

### Ver o que está rodando agora

```bash
ssh root@$VPS_IP '
  echo "=== PM2 ==="
  pm2 list
  echo "=== top requests last 5 min ==="
  curl -fsS -H "Authorization: Bearer '$METRICS_TOKEN'" http://localhost:3001/metrics \
    | grep "clow_http_requests_total" | sort -k2 -rn | head -10
  echo "=== ai messages last min ==="
  curl -fsS -H "Authorization: Bearer '$METRICS_TOKEN'" http://localhost:3001/metrics \
    | grep "clow_ai_messages_total" | head -5
  echo "=== disk ==="
  df -h /root/.clow
'
```

### Restart só o app sem perder sessões em andamento (zero-downtime)

```bash
ssh root@$VPS_IP 'pm2 reload clow --update-env'
# Em outro terminal valida durante o reload:
while true; do curl -s -o /dev/null -w "%{http_code} %{time_total}s\n" https://$DOMAIN/health/live; sleep 0.2; done | grep -v "^200 "
# Esperado: nada printado (todos 200)
```

### Trazer logs de uma sessão específica

```bash
SESSION_ID=<uuid>
ssh root@$VPS_IP "pm2 logs clow --lines 5000 --nostream | grep '$SESSION_ID' | tail -100"
```

### Ver últimos webhooks Stripe processados

```bash
ssh root@$VPS_IP 'pm2 logs clow --lines 500 --nostream | grep -iE "stripe|webhook" | tail -20'
```

### Forçar backup AGORA (antes de uma operação arriscada)

```bash
ssh root@$VPS_IP '/opt/system-clow/scripts/backup-sqlite.sh && /opt/system-clow/scripts/verify-backup.sh'
```

### Tail de logs ao vivo durante incidente

```bash
ssh root@$VPS_IP 'pm2 logs clow --err'
# Ctrl+C pra sair
```

### Listar tenants ativos

```bash
ssh root@$VPS_IP "sqlite3 ~/.clow/crm.sqlite3 \"
  SELECT t.email, t.name, t.tier
  FROM crm_contacts c JOIN sqlite_master m ON 1=1
  WHERE 1=2;
\""
# Tenants ficam em ~/.clow/tenants.json (não no SQLite). Use:
ssh root@$VPS_IP 'cat ~/.clow/tenants.json | jq ".tenants | map({email, name, tier, status})"'
```

### Ver quais sessões estão hot agora

```bash
curl -fsS https://$DOMAIN/health | jq .activeSessions
```

---

## Escalation matrix

| Tempo desde alerta | Ação |
|---|---|
| 0-5 min | Você sozinho, segue runbook |
| 5-15 min sem resolver | Acorda o dev backup (canal `#oncall-pager` no Telegram) |
| 15-30 min sem resolver | Considera [rollback](rollback.md) preventivo enquanto investiga |
| 30+ min | Posta status público em https://status.system-clow.pvcorretor01.com.br (se tiver) ou e-mail aos tenants ativos |
| 1h+ | Escalate pro Daniel direto (WhatsApp pessoal, não canal) |

---

## Pós-incidente (no dia seguinte)

Mesmo se já resolveu, **escreve um post-mortem curto** em `docs/operations/incidents/YYYY-MM-DD-<slug>.md`:

```md
# YYYY-MM-DD — <título curto>

**Duração**: <início UTC> → <fim UTC> = X min
**Impacto**: <quantos tenants / quais features afetados>
**Severidade**: P0 / P1 / P2 / P3

## Timeline (UTC)
- HH:MM — alerta dispara
- HH:MM — você na frente
- HH:MM — diagnóstico identificado
- HH:MM — fix aplicado
- HH:MM — métricas voltam ao normal

## Root cause
<1-2 frases explicando o porquê>

## O que evitou ser pior
<o que funcionou — backup, rate limit, sticky session, etc>

## O que tornou pior do que precisava
<o que atrapalhou — falta de log, runbook desatualizado, etc>

## Action items
- [ ] <coisa pra arrumar pra não acontecer de novo>
- [ ] <melhorar runbook em X>
```

Manter o histórico ajuda a identificar padrões (ex: "toda terça às 3am algo falha → cron de algum cliente").

---

## Coisas que parecem incidente mas não são

- **`/health/version` mostra `commit_sha: "unknown"`** → não é bug, é a env `GIT_COMMIT_SHA` não setada no PM2. Deploy continua funcional.
- **Sentry mandou alerta de `database is locked` 1×** → pode ter sido contention transitória entre workers. Se não repetir em 30 min, ignora.
- **`/health/ready` mostra `redis: { ok: true, details: "not configured (in-memory fallback active)" }`** → esperado em dev. Em prod, preocupa só se você TINHA Redis e parou de funcionar.
- **`pm2 list` mostra `restarts > 5`** sem PM2 estar em `errored` → workers ciclaram por OOM (max_memory_restart=1G). Se acontece com frequência, ajusta a config; se for esporádico, ignora.
