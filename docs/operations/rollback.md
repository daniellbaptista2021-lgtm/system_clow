# Rollback — reverter deploy ruim em < 5 minutos

> **Quando usar**: deploy acabou de subir e o sistema piorou. Erros novos, latência subiu, feature crítica quebrou.
> **Quando NÃO usar**: bug antigo que ninguém percebeu até agora — investigar primeiro, rollback não vai ajudar.

```bash
export VPS_IP=<vps-ip>
export DOMAIN=system-clow.pvcorretor01.com.br
```

---

## Decisão em 30 segundos

Pergunta-se:

1. **A deploy aconteceu nas últimas 2h?** Se NÃO → não é regression, runbook normal.
2. **Os sintomas começaram DEPOIS da deploy?** Se sim → rollback agora.
3. **A deploy mexeu em SQL/migration?** Se sim → ver [seção "Rollback com migration"](#rollback-com-migration) — leva mais tempo.
4. **Tem usuários ativos no momento?** Se sim → use `pm2 reload` (zero-downtime). Se não, `pm2 restart` (mais rápido).

Se respondeu **sim ao 2**, vai pra **execução** abaixo.

---

## Execução — caminho feliz (sem migration)

```bash
ssh root@$VPS_IP
cd /opt/system-clow

# 1. Identifica o último commit estável
git log --oneline -10
# Anota o sha do commit ANTERIOR ao que quebrou.
# Esperado: olha o commit message — se contém "fix" / "feat" / "refactor" recente, é candidato.
# Se a deploy estava no sha XXXXXXX e o anterior era YYYYYYY, vamos pro YYYYYYY.

LAST_GOOD=<sha-anterior>

# 2. CONFIRMA que esse sha tem CI verde
git log --oneline $LAST_GOOD -1
# Compara com:
#   gh run list --repo daniellbaptista2021-lgtm/system_clow --branch <branch> --limit 20
# Procura esse sha na lista — tem que estar com "success".

# 3. Backup defensivo do estado atual (rápido, ~5s)
/opt/system-clow/scripts/backup-sqlite.sh

# 4. Reset hard pro último bom
git reset --hard $LAST_GOOD

# 5. Reinstala deps + rebuild (caso ts/deps mudaram)
HUSKY=0 npm ci --no-audit --no-fund --silent
npm run build

# 6. Reload (zero-downtime se cluster mode, 1 worker por vez)
pm2 reload clow --update-env

# 7. Confirma rollback aplicado
sleep 3
curl -fsS https://$DOMAIN/health/version | jq .commit_sha
# Tem que bater com $LAST_GOOD (primeiros 7 chars).

# 8. Sanidade
curl -fsS https://$DOMAIN/health/ready | jq .
```

**Tempo esperado**: 3-4 minutos (npm ci é o gargalo).

---

## Execução — caminho rápido se NADA muda em deps/build

Se a deploy ruim foi só código (sem `package.json` mexido, sem mudança em `src/`), pode pular `npm ci` e `npm run build`:

```bash
ssh root@$VPS_IP
cd /opt/system-clow

# Verifica que o diff entre HEAD atual e LAST_GOOD não toca em deps/build:
git diff $LAST_GOOD HEAD --stat | grep -E "package(-lock)?\.json|src/"
# Se NÃO mostrar nada (ou só docs/tests), pode rollback usando dist atual:

git reset --hard $LAST_GOOD
pm2 reload clow --update-env  # NÃO precisa rebuild — dist/ ainda é o velho
sleep 3
curl -fsS https://$DOMAIN/health/version | jq .commit_sha
```

**Tempo**: 30-60 segundos.

> **PEGADINHA**: se o `dist/` ficar fora de sync com `src/` por muito tempo, próximo `npm run build` (ou cron) vai recompilar. Faz o caminho completo dentro de 1h pra normalizar.

---

## Rollback com migration (mais cuidado)

Se a deploy ruim **adicionou uma migration** (arquivo novo em `src/crm/migrations/`), o rollback precisa reverter o schema também. Senão o código antigo + schema novo = errors.

```bash
ssh root@$VPS_IP
cd /opt/system-clow

# 1. Quais migrations rodaram desde o LAST_GOOD?
git diff $LAST_GOOD HEAD --name-only | grep "src/crm/migrations/"
# Cada arquivo NNN_xxxx.ts precisa ser revertido com `down()`.

# 2. ANTES de mexer em SQL: backup completo
/opt/system-clow/scripts/backup-sqlite.sh
/opt/system-clow/scripts/verify-backup.sh

# 3. Roda rollback uma migration por vez (em ordem reversa de aplicação):
FORCE_ROLLBACK=1 npm run db:rollback
# Repete pra cada migration nova.
# CONFIRMA cada vez:
npm run db:status

# 4. Agora sim, reset do código:
git reset --hard $LAST_GOOD
HUSKY=0 npm ci --no-audit --no-fund --silent
npm run build
pm2 reload clow --update-env
```

**Tempo**: 5-10 minutos. Tem migration grande (drop table com 50k rows)? Pode passar de 15.

### Caso a migration NÃO tem `down()` ou ela é destrutiva

Restaure do backup ao invés de rollback de migration:

```bash
# 1. Para o servidor (escritas vão parar)
pm2 stop clow

# 2. Identifica o backup mais recente ANTES da deploy ruim
ls -1 /root/.clow/backups/ | grep -E '^[0-9]{4}-' | sort | tail -5
# Pega o snapshot que é mais novo que o LAST_GOOD do código mas mais antigo que a deploy ruim.

# 3. Restaura
/opt/system-clow/scripts/restore-sqlite.sh 2026-04-26-NN

# 4. Confirma
sqlite3 /root/.clow/crm.sqlite3 "PRAGMA integrity_check;"

# 5. Rollback do código + restart
git reset --hard $LAST_GOOD
HUSKY=0 npm ci --no-audit --no-fund --silent
npm run build
pm2 start clow
```

**Tempo**: 5-10 minutos + perda de dados desde o backup (até 1h dado o cron horário).

---

## Validação pós-rollback (obrigatório)

Independente do caminho, **rode os 4 abaixo antes de respirar**:

```bash
# 1. Health verde
curl -fsS https://$DOMAIN/health/ready | jq '{status, checks}'
# Esperado: status="ok", todos checks ok.

# 2. Sha bateu
curl -fsS https://$DOMAIN/health/version | jq .commit_sha
# Esperado: bate com $LAST_GOOD.

# 3. Métricas voltam ao normal — aguarda 60s e olha:
curl -fsS -H "Authorization: Bearer $METRICS_TOKEN" https://$DOMAIN/metrics \
  | grep -E 'clow_(errors_total|http_requests_total)'

# 4. Smoke do fluxo crítico
curl -fsS https://$DOMAIN/health/live  # deve responder em < 100ms
# E manualmente: signup → login → criar contato pela UI.
```

---

## Comunicação

**Antes**: `🔄 Iniciando rollback de <sha-bad> → <sha-good>. Esperado: 3-5 min downtime parcial.`

**Depois**: `✅ Rollback completo. /health/version=<sha-good>. Próximos passos: investigar <sha-bad> em ambiente isolado, abrir issue.`

**Se falhou**: `🚨 Rollback falhou. Servidor ainda em <sha-bad> com problema X. Próxima ação: <plano>.` E acorda mais alguém.

---

## Se nem o rollback funciona

```bash
# Última saída: pm2 stop clow (degrada pra "system maintenance")
ssh root@$VPS_IP 'pm2 stop clow && curl -fsS http://127.0.0.1:3001/health/live; echo'
# Vai dar connection refused — esperado.

# Coloca uma página de manutenção no nginx:
sudo nano /etc/nginx/sites-available/system-clow
# Comenta o location / { proxy_pass... } e adiciona:
#   location / {
#     return 503 "System Clow temporarily unavailable. Voltamos em breve.";
#   }
sudo nginx -t && sudo nginx -s reload

# Pede ajuda. Investiga sem pressa. Quando resolver, reverte o nginx + sobe o pm2.
```

Tempo total degradado: até 1h aceitável; mais que isso, escalate pra Daniel direto.

---

## Pós-rollback (no dia seguinte)

1. **Não delete a branch ruim** — vai ser usada pra debug.
2. **Reverte o commit no histórico do git** com `git revert <sha-bad> --no-edit && git push` — assim a próxima deploy não regride por engano.
3. **Issue aberto** descrevendo: o sintoma, o sha que quebrou, o sha bom, hipótese de causa.
4. **Adiciona teste** que pegaria essa regression — antes de mergear o fix definitivo.
5. **Atualiza este runbook** se aprendeu algo (passo desnecessário? caso novo?). Faz parte do trabalho.
