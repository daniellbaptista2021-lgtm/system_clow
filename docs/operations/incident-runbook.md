# Incident runbook

> **Cenário-base**: 3 da manhã, alerta no Telegram, você com sono.
> **Regra**: leia o sintoma → cole o comando → leia a saída → siga a seta. Não improvisa.

```bash
# Roda isso primeiro, sempre. Define as variáveis pro resto do doc.
export VPS_IP=<vps-ip>
export DOMAIN=system-clow.pvcorretor01.com.br
export METRICS_TOKEN=<valor-do-.env>
```

---

## Triagem em 60 segundos

```bash
curl -fsS https://$DOMAIN/health/ready | jq '{status, checks}'
```

| Output | Vai pra |
|---|---|
| `status: "ok"`, todos os checks ok | Alerta provavelmente já passou. Confere [on-call-handbook.md](on-call-handbook.md). |
| `checks.sqlite.ok: false` | [(a) SQLite corrompido](#a-sqlite-corrompido) |
| `checks.litellm.ok: false` | [(c) GLM API rate limited](#c-glm-api-rate-limited) |
| `checks.disk.ok: false` (`>=85% used`) | [(d) VPS sem disco](#d-vps-sem-disco) |
| `connection refused` / 502 / 504 | servidor caiu — ver [(b)](#b-z-api-offline) primeiro porque aviso costuma vir do Z-API timeout, depois [rollback.md](rollback.md) |
| 200 mas `clow_errors_total` subindo | [(e) DDoS no /webhooks](#e-ddos-no-webhooks) ou erro de aplicação — ver Sentry primeiro |

---

## (a) SQLite corrompido

**Sintoma**: `/health/ready` mostra `checks.sqlite.ok: false` com detalhe tipo `database disk image is malformed` ou `unable to open database file`.

**Causa típica**: power-cut da VPS interrompeu uma escrita; mais raramente, disco I/O com erro físico.

### Comandos

```bash
ssh root@$VPS_IP

# 1. Para o servidor pra evitar escritas adicionais
pm2 stop clow

# 2. Confirma a corrupção com integrity_check
sqlite3 ~/.clow/crm.sqlite3 "PRAGMA integrity_check;" | head -20

# 3. Identifica o backup mais recente íntegro
/opt/system-clow/scripts/verify-backup.sh
# Se o "latest" passa, vai pro 5. Se falhar, lista todos:
ls -1 ~/.clow/backups/ | grep -E '^[0-9]{4}-' | sort | tail -10
# Pra cada um do mais recente pro mais antigo:
/opt/system-clow/scripts/verify-backup.sh 2026-04-26-21
# Para no primeiro que retornar "OK".

# 4. Renomeia o DB corrompido pra forensics depois
mv ~/.clow/crm.sqlite3 ~/.clow/crm.sqlite3.corrupt-$(date -u +%s)
rm -f ~/.clow/crm.sqlite3-wal ~/.clow/crm.sqlite3-shm

# 5. Restaura
/opt/system-clow/scripts/restore-sqlite.sh latest
# OU pra timestamp específico:
# /opt/system-clow/scripts/restore-sqlite.sh 2026-04-26-21

# 6. Confirma integridade pós-restore
sqlite3 ~/.clow/crm.sqlite3 "PRAGMA integrity_check;"
# Esperado: "ok"

# 7. Religa o servidor
pm2 start clow
sleep 5
curl -fsS https://$DOMAIN/health/ready | jq .

# 8. Confirma que dados estão lá
sqlite3 ~/.clow/crm.sqlite3 "SELECT COUNT(*) FROM crm_contacts;"
sqlite3 ~/.clow/crm.sqlite3 "SELECT COUNT(*) FROM crm_cards;"
```

### Comunicação

- **Antes do passo 5**: posta no canal: `🚨 SQLite corrompido — restaurando do backup das XX:XX. Esperado: 5-10 min downtime.`
- **Depois do passo 7**: `✅ Restore OK — perdidos N atividades das últimas Y minutos. Sem perda de tenants/cards.`

### Pós-mortem (no dia seguinte)

```bash
# Mantém o .corrupt pra investigação
ls -la ~/.clow/crm.sqlite3.corrupt-*
# dmesg pra ver se foi disco físico
dmesg | tail -30
# Se for power-cut, considere UPS ou ativar synchronous=FULL temporariamente
```

---

## (b) Z-API offline

**Sintoma**: alertas do tipo `WebhooksDown` (Prometheus regra) ou usuários reclamando que IA não responde a WhatsApp. `/health/ready` continua verde — Z-API é externo, não está nos checks.

### Diagnóstico

```bash
ssh root@$VPS_IP

# 1. Volume de webhooks recebidos no último minuto
curl -fsS -H "Authorization: Bearer $METRICS_TOKEN" https://$DOMAIN/metrics \
  | grep 'clow_webhooks_received_total{channel="zapi"}'
# Se o valor não cresce comparado a 60s atrás, ZAPI parou de mandar.

# 2. Status dos canais no DB
sqlite3 ~/.clow/crm.sqlite3 "
  SELECT id, type, name, status, last_health_check, last_error
  FROM crm_channels WHERE type='zapi';
"

# 3. Pinga Z-API direto
# Pega instanceId/token do canal:
sqlite3 ~/.clow/crm.sqlite3 "SELECT credentials_encrypted FROM crm_channels WHERE type='zapi' LIMIT 1;"
# Decripta no app pra pegar instance + token, depois:
curl -fsS "https://api.z-api.io/instances/<INSTANCE_ID>/token/<TOKEN>/status"
# Esperado: {"connected": true, "session": ...}
# Se "connected: false" ou 4xx/5xx: Z-API caiu OU instância foi desconectada.

# 4. Status global da Z-API
curl -fsS https://status.z-api.io
```

### Resolução

**Caso 4xx (token inválido)**: tenant precisa re-autenticar via UI (`/crm/channels`).

**Caso 5xx Z-API**: do lado da Z-API. Não é problema nosso.
```bash
# Comunica usuários afetados via WhatsApp/email — opcional, batch script:
ssh root@$VPS_IP 'cd /opt/system-clow && node -e "
  const store = require(\"./dist/crm/store.js\");
  for (const t of require(\"./dist/tenancy/tenantStore.js\").listTenants()) {
    const channels = store.listChannels(t.id).filter(c => c.type === \"zapi\");
    if (channels.length === 0) continue;
    console.log(\`tenant=\${t.id} email=\${t.email} channels=\${channels.length}\`);
  }
"'
```

**Caso "connected: false" mas conta Z-API ok**: instância foi desconectada (cliente fez logout no celular). Tenant tem que re-escanear QR. UI já tem fluxo: `/crm/channels/<id>/qr-code`.

### Mitigation: failover pro Meta

Se você tem Meta WhatsApp configurado como segundo canal:
```bash
sqlite3 ~/.clow/crm.sqlite3 "
  UPDATE crm_channels SET status='disabled' WHERE type='zapi' AND tenant_id='<tenant_x>';
  UPDATE crm_channels SET status='active' WHERE type='meta' AND tenant_id='<tenant_x>';
"
```

---

## (c) GLM API rate limited

**Sintoma**: `/health/ready` mostra `checks.litellm.ok: false`, OU sessões IA devolvendo erro `rate_limited` / `429`. Mensagens chegam mas não respondem.

### Diagnóstico

```bash
ssh root@$VPS_IP

# 1. LiteLLM está vivo?
curl -fsS http://127.0.0.1:4000/health
# Se conexão recusada → LiteLLM caiu. Vai pro "Reiniciar LiteLLM" abaixo.

# 2. Logs do LiteLLM
pm2 logs litellm --lines 50 --nostream | grep -iE "rate|429|error"

# 3. Logs do clow procurando 429
pm2 logs clow --lines 100 --nostream | grep -iE "429|rate_limited|RateLimitError"

# 4. Conta de mensagens nos últimos minutos (pra saber se foi pico)
curl -fsS -H "Authorization: Bearer $METRICS_TOKEN" https://$DOMAIN/metrics \
  | grep "clow_ai_messages_total" | head -10
```

### Resolução

**Caso A — LiteLLM caiu**:
```bash
pm2 restart litellm
sleep 3
curl -fsS http://127.0.0.1:4000/health
# Se voltou ok, monitora 5 min.
```

**Caso B — OpenRouter rate limit no provider GLM**:
```bash
# Solução paliativa: troca temporariamente pra outro modelo no LiteLLM
ssh root@$VPS_IP 'cat /opt/litellm/config.yaml | head -30'
# Edita pra ativar fallback (deepseek-v3, qwen, etc):
ssh root@$VPS_IP 'nano /opt/litellm/config.yaml'  # ou sed
ssh root@$VPS_IP 'pm2 restart litellm'
```

**Caso C — Crédito OpenRouter zerou**:
```bash
# Confere saldo:
# https://openrouter.ai/credits — login
# Se zero, recarrega URGENTE. Sem isso, 100% das IAs ficam down.
```

### Mitigation: throttle de entrada

Enquanto resolve, baixa rate limit pra absorver menos:
```bash
# Edita src/server/rateLimiter.ts:13 — reduz cada tier pela metade:
ssh root@$VPS_IP "sed -i 's/one:          20/one:          10/' /opt/system-clow/src/server/rateLimiter.ts"
ssh root@$VPS_IP 'cd /opt/system-clow && npm run build && pm2 reload clow --update-env'
# Reverte quando resolver: git checkout src/server/rateLimiter.ts && rebuild
```

---

## (d) VPS sem disco

**Sintoma**: `/health/ready` com `checks.disk.details: "92% used"`. Ou alerta Prometheus `DBGrowingTooFast`. Ou `pm2` mostrando `errored` com `ENOSPC`.

### Diagnóstico

```bash
ssh root@$VPS_IP

# 1. Onde tá ocupado
df -h | grep -vE 'tmpfs|udev'
du -sh /opt/* /root/* 2>/dev/null | sort -rh | head -10
du -sh /root/.clow/* 2>/dev/null | sort -rh
du -sh /var/log/* 2>/dev/null | sort -rh | head -10

# 2. Top arquivos individuais
find / -type f -size +500M 2>/dev/null | head -20
```

### Resolução — top 5 culprits prováveis

**1. PM2 logs gigantes** (mais comum):
```bash
ls -lah /root/.pm2/logs/
pm2 flush
# Cap o tamanho daqui pra frente:
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 50M
pm2 set pm2-logrotate:retain 5
```

**2. Backups antigos não rotacionados** (deveria estar OK pelo script):
```bash
du -sh /root/.clow/backups/*
# Se > 1GB total, força rotation:
ls /root/.clow/backups/ | sort | head -n -32 | xargs -I{} rm -rf /root/.clow/backups/{}
# (mantém os 32 mais recentes)
```

**3. node_modules de versões antigas**:
```bash
# Se tem clones em /opt/system-clow.bak ou similar:
ls -la /opt/ | grep -v system-clow
# Apaga backups locais que não sejam o ativo:
rm -rf /opt/system-clow.bak  # se existir
```

**4. Meta WhatsApp media uploads cache**:
```bash
du -sh /root/.clow/crm-media/
# Se grande (>500MB), limpa uploads > 30 dias:
find /root/.clow/crm-media/ -type f -mtime +30 -delete
```

**5. SQLite WAL gigante** (raro, indica falha de checkpoint):
```bash
ls -lah /root/.clow/crm.sqlite3*
# Se -wal > 100MB, força checkpoint:
sqlite3 /root/.clow/crm.sqlite3 "PRAGMA wal_checkpoint(TRUNCATE);"
```

### Verificação

```bash
df -h /root/.clow
# Esperado: <70% used. Se ainda alto, expande o disco da VPS no painel da Hostinger/etc.
```

---

## (e) DDoS no /webhooks

**Sintoma**: latência subiu, /health/live ainda OK mas lentíssimo, `clow_http_requests_total` subindo > 100 req/s para `/webhooks/*`. Alertas Telegram com `HighErrorRate`.

### Diagnóstico

```bash
ssh root@$VPS_IP

# 1. IPs mais ativos no nginx access log
tail -10000 /var/log/nginx/access.log | awk '{print $1}' | sort | uniq -c | sort -rn | head -20

# 2. Paths mais batidos
tail -10000 /var/log/nginx/access.log | awk '{print $7}' | sort | uniq -c | sort -rn | head -10

# 3. Status code distribution
tail -10000 /var/log/nginx/access.log | awk '{print $9}' | sort | uniq -c | sort -rn

# 4. Métrica por rota
curl -fsS -H "Authorization: Bearer $METRICS_TOKEN" https://$DOMAIN/metrics \
  | grep 'clow_http_requests_total{route="/webhooks' | head
```

### Resolução

**Step 1 — bloqueia IPs ofensivos no nginx imediatamente**:
```bash
# Pega o IP mais bativo do diagnóstico acima e bloqueia:
ATTACKER_IP=<ip-da-saida>
echo "deny $ATTACKER_IP;" | sudo tee -a /etc/nginx/conf.d/blocked-ips.conf
sudo nginx -t && sudo nginx -s reload
```

**Step 2 — rate limit por IP no nginx pra todo /webhooks**:
```nginx
# Adiciona em /etc/nginx/sites-available/system-clow ANTES do server { }:
limit_req_zone $binary_remote_addr zone=webhook_limit:10m rate=10r/s;

# Dentro do server { } adiciona um location:
location /webhooks/ {
    limit_req zone=webhook_limit burst=20 nodelay;
    limit_req_status 429;
    proxy_pass http://clow_cluster;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

```bash
sudo nginx -t && sudo nginx -s reload
```

**Step 3 — escalation: Cloudflare** (se o ataque é distribuído):

1. Acessa https://dash.cloudflare.com — DNS aponta para o IP da VPS
2. Liga **Under Attack Mode** (botão laranja gigante na página principal do site)
3. Aguarda 5 min — Cloudflare desafia cada visitante com challenge
4. Se persistir, ativa **WAF Rule**: `(http.request.uri.path contains "/webhooks/")` + `Action: Managed Challenge`
5. **Stripe webhooks**: adiciona allowlist pros IPs do Stripe (https://stripe.com/files/ips/ips_webhooks.txt)

**Step 4 — fail2ban como segunda camada**:
```bash
# Já vem instalado. Confere se está ativo:
sudo systemctl status fail2ban
# Adiciona regra pra nginx:
sudo nano /etc/fail2ban/jail.local
# (cola a config de nginx-limit-req — exemplo padrão)
sudo systemctl reload fail2ban
sudo fail2ban-client status nginx-limit-req
```

### Verificação

```bash
# Volume de requests deveria cair
tail -1000 /var/log/nginx/access.log | wc -l
# Comparar com 1 min atrás
```

### Comunicação

- Posta status no canal: `🛡️ DDoS detectado em /webhooks — mitigação ativa via nginx rate limit + Cloudflare. Webhooks legítimos continuam fluindo.`
- Stripe pode marcar nosso endpoint como `dead` se rate-limit demorar pra responder. Stripe retry automaticamente, mas se passar de 24h sem entrega, eventos são perdidos. Re-enviar manualmente: dashboard Stripe → Webhooks → Endpoint → Failed events.

---

## Quando NÃO está em nenhum desses 5

Se nenhum bate, vai pro [on-call-handbook.md](on-call-handbook.md) — passo "diagnóstico genérico". Se ainda não resolver, [rollback.md](rollback.md) e reverte pro último commit estável enquanto investiga em ambiente isolado.
