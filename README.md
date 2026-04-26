# System Clow

[![CI](https://github.com/daniellbaptista2021-lgtm/system_clow/actions/workflows/ci.yml/badge.svg)](https://github.com/daniellbaptista2021-lgtm/system_clow/actions/workflows/ci.yml)

> Plataforma SaaS premium que une **Agente IA via WhatsApp** + **CRM completo** + **automações n8n** num único produto. Cada cliente assinante recebe seu workspace isolado com pipeline de vendas, atendimento por WhatsApp e IA que opera o CRM por comando natural.

**Live:** https://system-clow.pvcorretor01.com.br
**Stack:** Node 22 + TypeScript + Hono + better-sqlite3 + GLM-5.1 (via LiteLLM/OpenRouter)

---

## ⚙️ Arquitetura

```
┌──────────────────────────────────────────────────────────────────┐
│                      System Clow Workspace                       │
│  https://system-clow.pvcorretor01.com.br                         │
│                                                                  │
│  ┌────────────────┐         ┌──────────────────────────────┐    │
│  │ Agente IA      │ ◄──────►│ CRM Clow (modal in-app)      │    │
│  │ (chat + tools) │         │  /crm/                       │    │
│  └───────┬────────┘         │                              │    │
│          │                  │  • Pipeline Kanban           │    │
│          │ tools            │  • Contatos                  │    │
│          │ (10 crm_*)       │  • Canais WhatsApp           │    │
│          │                  │  • Equipe                    │    │
│  ┌───────▼────────┐         │  • Produtos                  │    │
│  │ LiteLLM proxy  │         │  • Stats                     │    │
│  │ → OpenRouter   │         │  • Automações                │    │
│  │ → GLM-5.1      │         │  • Mensalidades              │    │
│  └────────────────┘         └──────────────────────────────┘    │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
        ▲                              ▲
        │                              │
   WhatsApp Meta              Webhook (Meta + Z-API)
   (cliente fala)             (msgs chegam)
```

### Multi-tenant (SaaS-ready)

- Cada **cliente assinante** = 1 `tenant`
- Login email + senha per-tenant (bcrypt)
- Token de sessão HMAC com `tenantId` propagado pelo sistema todo
- Todas as 12 tabelas do CRM têm `tenant_id` — isolamento garantido na camada de DB
- Telefone WhatsApp do cliente = único autorizado a invocar a IA dele
- Cada cliente conecta sua própria conta WhatsApp Meta ou Z-API ao CRM dele

---

## 🤖 Motor de IA

Single-engine, propositalmente:

| Camada | Provedor | Uso |
|---|---|---|
| **Chat / agente / tool use** | **GLM-5.1** (Z-AI) via OpenRouter, roteado por LiteLLM proxy local | 100% das conversas IA, raciocínio, chamadas de tool |
| Transcrição de áudio | OpenAI **Whisper-1** | Áudios recebidos no WhatsApp |
| Visão / OCR de PDF/imagem | OpenAI **GPT-4o-mini** | Anexos enviados pelo cliente |
| Web Push | VAPID local | Notificações no PWA |

> ⚠️ **Não há fallback para Claude/Anthropic, GPT-4 chat, ou DeepSeek.** O LiteLLM (`/opt/litellm/config.yaml`) mapeia qualquer alias `claude-*` para `openrouter/z-ai/glm-5.1` — isso preserva compatibilidade do SDK Anthropic sem trocar provedor real.

Arquivos relevantes:
- `/opt/litellm/config.yaml` — mapeamento de modelos
- `/opt/litellm/.env` — `OPENROUTER_API_KEY` (mode 600)
- `/opt/system-clow/.env` — `OPENAI_API_KEY` (Whisper + visão), `ANTHROPIC_BASE_URL=http://127.0.0.1:4000`

---

## 🚀 Funcionalidades

### Agente IA (System Clow)

- Conversa via WhatsApp com cliente final usando GLM-5.1
- **10 ferramentas CRM** que a IA opera por comando natural:
  - `crm_find_or_create_contact` · `crm_create_card` · `crm_move_card`
  - `crm_add_note` · `crm_send_whatsapp` · `crm_search`
  - `crm_pipeline` · `crm_get_contact` · `crm_create_reminder` · `crm_dashboard`
- Sessão persistente por número de telefone (memória cross-conversation)
- Workspace isolado por número em `~/.clow/sessions/`

### CRM Clow

| Módulo | Capacidades |
|---|---|
| **Pipeline Kanban** | Boards customizáveis, drag-and-drop, cores, colunas terminais (Ganho/Perdido) |
| **Contatos** | Cadastro completo, busca em tempo real, tags, histórico unificado |
| **Canais WhatsApp** | Suporte Meta Cloud API + Z-API, credenciais criptografadas (AES-256-GCM), webhook URL pronto pra colar |
| **Side Panel** | Conversação inline com bubble UI, envio de texto/áudio (gravação MediaRecorder)/imagem/PDF |
| **Equipe** | Agentes com papéis (owner/admin/agent/viewer), atribuição automática (round-robin/load-balanced/manual) |
| **Produtos (estoque)** | SKU, preço, estoque, vinculação a cards (line items), baixa automática ao ganhar |
| **Mensalidades** | Cobrança recorrente (weekly/monthly/quarterly/yearly), lembretes T-3/T-1/T-0 via WhatsApp, marcar como pago |
| **Automações** | 6 triggers × 9 conditions × 8 actions, 5 templates one-click, scheduler 60s |
| **Stats** | Forecast ponderado, métricas por agente (cards/valor/tempo de resposta) |
| **Real-time** | SSE pub/sub, UI atualiza sem polling |

### Multi-tenant SaaS

- **Signup** (`POST /auth/signup`): valida CPF, telefone E.164, email único, hash bcrypt
- **Login** (`POST /auth/login`): retorna `usr.{payload}.{sig}` token (30d TTL)
- **Mesmo login → mesmo CRM**: clica botão CRM → exchange → entra direto sem nova senha
- **Phone whitelist**: só telefones cadastrados podem invocar a IA do tenant
- **Stripe Checkout** (esqueleto): `POST /api/billing/checkout` cria session, webhook auto-cria tenant
- **Status do tenant** controlado por Stripe events (active/past_due/cancelled)

## 📁 Estrutura

```
src/
├── adapters/         WhatsApp Meta + Z-API integration (agente)
├── api/              Anthropic SDK wrapper (rota pra LiteLLM)
├── auth/             ★ Signup/Login multi-user + tokens HMAC
├── billing/          ★ Stripe Checkout + webhooks
├── bootstrap/        Initialization
├── bridge/           External integration (Clow ↔ System Clow)
├── cli/ + cli.ts     Standalone CLI
├── coordinator/      Agent orchestration
├── crm/              ★ CRM module completo (12 tabelas, REST, webhooks, automations, billing)
│   ├── channels/     Meta + Z-API send/receive
│   ├── automations.ts  Engine (triggers/conditions/actions) + 5 templates
│   ├── billing.ts    Subscriptions runtime (charge + reminders)
│   ├── assignment.ts Round-robin/load-balanced agent assignment
│   ├── lineItems.ts  Card↔inventory link + auto stock decrement
│   ├── events.ts     SSE pub/sub
│   ├── inbox.ts      Inbound orchestrator (idempotent + auto-card)
│   ├── webhooks.ts   /webhooks/crm/{meta|zapi}/:secret
│   ├── routes.ts     50+ REST endpoints under /v1/crm
│   ├── store.ts      Data access layer (~1500 LOC)
│   ├── schema.ts     SQLite migrations (WAL, FK on)
│   └── types.ts      TypeScript types
├── hooks/            Lifecycle hooks
├── mcp/              MCP server support
├── memory/           Persistent memory per tenant
├── plugins/          Plugin system (4 discovery sources)
├── query/            QueryEngine (orchestrator de tools)
├── server/           Hono server + middleware (tenantAuth, sessionPool)
├── skills/           Skills system
├── swarm/            Multi-agent
├── tenancy/          ★ Tenant store (JSON-backed) + license + quotas
├── tools/            18 base tools + ★ 10 CRM tools (CrmTool/)
└── utils/            Compaction, logging, paths

public/
├── index.html        Shell System Clow (login + chat + sidebar + CRM modal)
├── crm/              ★ CRM SPA
│   ├── index.html    App shell (auto-loader, no manual API key prompt)
│   ├── crm.css       Dark theme + nav 3D + brand SVG
│   ├── crm.js        ~37KB vanilla JS (kanban + side panel + edit modals)
│   └── crm-extras.js Automations + Subscriptions UI
└── sw.js             Service worker v100 (bypass /crm/ /v1/ /auth/)

~/.clow/             (state, fora do repo)
├── crm.sqlite3       12 tabelas CRM
├── crm-media/{tenant}/{date}/  Mídia recebida
├── memory/{tenant}.sqlite3     Memória persistente do agente
├── sessions/{uuid}.jsonl       Sessions do agente
├── tenants.json      Tenants + users + api_keys
└── audit/            Logs JSONL
```

---

## 🔌 API REST (resumo)

### Auth (multi-tenant SaaS)
```
POST   /auth/signup                {email,password,full_name,cpf,birth_date,phone,plan_tier}
POST   /auth/login                 {email,password}             → user_session token
GET    /auth/me                    Bearer user_session          → user info
POST   /auth/change-password
POST   /auth/authorized-phones     {phones:[...]}
```

### Billing (Stripe)
```
POST   /api/billing/checkout       {plan,email,full_name,cpf,phone}  → Stripe URL
POST   /webhooks/stripe            (Stripe → server)
GET    /signup/success             Landing após pagamento
```

### CRM (todas em /v1/crm)
```
POST   /init
GET    /boards · POST · GET/PATCH/DELETE /:id · GET /:id/pipeline
GET/POST /boards/:id/columns · PATCH/DELETE /columns/:id
POST   /cards · GET/PATCH/DELETE /:id · POST /:id/move
POST   /cards/:id/items · GET · DELETE /:cardId/items/:itemId
GET/POST /contacts · GET /search · GET/PATCH/DELETE /:id
POST   /activities
GET/POST /agents · PATCH/DELETE /:id · GET /metrics · GET /:id/metrics
GET    /settings/assignment-strategy · PUT
GET/POST /channels · GET/PATCH/DELETE /:id · POST /:id/send
GET/POST /subscriptions · PATCH /:id · POST /:id/mark-paid
GET/POST /inventory · POST /:id/stock
GET/POST /automations · GET /templates · POST /install-template · PATCH/DELETE /:id
POST   /reminders
POST   /media/upload · GET /media/:tenantId/:date/:file
GET    /events                     (SSE)
GET    /stats
POST   /auth/exchange              (System Clow session → CRM api_key)
```

### Webhooks (públicos, secret-validated)
```
GET/POST  /webhooks/crm/meta/:secret    Meta verification + ingest
POST      /webhooks/crm/zapi/:secret    Z-API ingest
POST      /webhooks/meta                Legacy agent endpoint (forward-target)
POST      /webhooks/stripe              Stripe events
```

---

## 🔐 Segurança

- **Bcrypt** (cost 10) pra senhas
- **HMAC SHA-256** pra session tokens (admin + user)
- **AES-256-GCM** pra credenciais de canal WhatsApp (scrypt KDF)
- **CLOW_CRM_SECRET** + **CLOW_USER_SESSION_SECRET** + **STRIPE_WEBHOOK_SECRET** em env vars
- Server escuta só em `127.0.0.1:3001` (nginx faz o terminate TLS público)
- CSP `frame-ancestors 'self'` no CRM (não embarcável fora do System Clow)
- Webhook signature verification opcional (Meta `X-Hub-Signature-256`, Stripe assinatura)
- Phone whitelist no agente (impede uso por terceiros)
- Path traversal guard no media handler

---

## 🤖 CI / Continuous Integration

GitHub Actions roda em todo `push` e `pull_request` para a branch `main`/`master`. 4 jobs em paralelo:

| Job | O que faz |
|---|---|
| **TypeScript typecheck** | `tsc --noEmit` |
| **Unit tests (vitest)** | `npm test` |
| **Secrets scan (gitleaks)** | varre todo o histórico do git contra `.gitleaks.toml` |
| **Build** | `tsc` + verifica artefatos em `dist/` |

Workflow em [`.github/workflows/ci.yml`](.github/workflows/ci.yml).

### 🔒 Branch protection — ATIVAR MANUALMENTE

Pra bloquear merge na `main` quando o CI falhar (não dá pra automatizar via repo — precisa ser feito 1x na UI do GitHub):

1. Abra: https://github.com/daniellbaptista2021-lgtm/system_clow/settings/branches
2. Clique em **"Add branch protection rule"** (ou edite a regra existente da `main`)
3. **Branch name pattern**: `main`
4. Marque:
   - ✅ **Require a pull request before merging** (opcional mas recomendado)
   - ✅ **Require status checks to pass before merging**
     - ✅ **Require branches to be up to date before merging**
     - No campo de busca **"Search for status checks"**, selecione (depois do primeiro CI rodar):
       - `TypeScript typecheck`
       - `Unit tests (vitest)`
       - `Secrets scan (gitleaks)`
       - `Build (tsc → dist/)`
   - ✅ **Do not allow bypassing the above settings** (recomendado)
5. Clique **"Create"** ou **"Save changes"**

> ⚠️ Os checks só aparecem na lista depois que o CI rodar **pelo menos uma vez** na branch. Faça um push qualquer pra `main` (ou abra um PR) e depois volte a essa tela.

Repita o processo pra `master` se você usa essa branch também.

---

## 💾 Backup & Restore

Sistema de snapshot **online (WAL-safe)** dos bancos SQLite — usa o comando `.backup` do `sqlite3`, **não** `cp`. Tudo local na VPS, sem serviço externo.

### O que é coberto

| DB | Caminho | Backup |
|---|---|---|
| CRM | `~/.clow/crm.sqlite3` | ✅ |
| Memória por tenant | `~/.clow/memory/*.sqlite3` | ✅ |

### Onde os snapshots ficam

```
~/.clow/backups/YYYY-MM-DD-HH/
  ├── crm.sqlite3
  └── memory/{tenant}.sqlite3
~/.clow/backups/cron.log     ← stdout/stderr do cron
```

### Retenção (rotação automática a cada hora)

| Tier | Janela | Política |
|---|---|---|
| **Hourly** | últimas 24h | mantém todos os snapshots |
| **Daily** | 24h–7d | mantém o mais recente de cada dia |
| **Weekly** | 7d–28d | mantém o mais recente de cada semana ISO |
| Older | >28d | apagado |

### Comandos

```bash
# Tirar um backup agora (manual)
./scripts/backup-sqlite.sh

# Validar o snapshot mais recente (PRAGMA integrity_check)
./scripts/verify-backup.sh

# Validar um snapshot específico
./scripts/verify-backup.sh 2026-04-26-14

# Restaurar do snapshot mais recente
./scripts/restore-sqlite.sh latest

# Restaurar de um snapshot específico
./scripts/restore-sqlite.sh 2026-04-26-14

# Preview do restore sem mexer em nada
./scripts/restore-sqlite.sh latest --dry-run

# Instalar cron (a cada hora :00 backup, :30 verify)
./scripts/setup-cron.sh
```

### Garantias do restore

1. Se o DB ao vivo já existe, ele é **renomeado** para `<nome>.pre-restore.<unix-ts>` antes de ser substituído (restore reversível).
2. Sidecars `-wal` e `-shm` antigos são removidos (snapshot é um arquivo único consistente).
3. `--dry-run` mostra o que seria feito sem tocar em nada.

### Setup na VPS

```bash
ssh root@<VPS_IP>
cd /opt/system-clow
./scripts/setup-cron.sh           # instala backup hourly + verify hourly
crontab -l                         # confere as duas linhas

# primeiro backup imediato
./scripts/backup-sqlite.sh
./scripts/verify-backup.sh
ls ~/.clow/backups/
```

### Cobertura de testes

`tests/integration/backupRestore.test.ts` exercita:

- Snapshot **enquanto há writer concorrente** (proova WAL-safety)
- Snapshot **sobrevive a corrupção** do DB ao vivo + `PRAGMA integrity_check`
- Script `backup-sqlite.sh` cria a pasta `YYYY-MM-DD-HH` com CRM + memory
- Script `verify-backup.sh` retorna 0 em snapshot saudável, ≠0 quando corrompido
- Script `restore-sqlite.sh latest` recupera dados após corrupção do DB ao vivo
- `restore-sqlite.sh latest --dry-run` não modifica nada

Os 4 últimos casos rodam só onde `bash` + `sqlite3` estão no PATH (Linux/macOS); no Windows são `skipped` pelo vitest automaticamente.

---

## 📡 Monitoring

Endpoints públicos pra monitoramento externo (UptimeRobot, Better Stack, Pingdom, k8s liveness/readiness probes). **Sem autenticação** — protegidos por rate limit de **60 req/min por IP** pra não virar vetor de DDoS.

| Endpoint | Status | Quando 200 | Quando ≠200 |
|---|---|---|---|
| `GET /health/live` | sempre 200 | processo Node respondendo | (só ≠200 se o processo morreu) |
| `GET /health/ready` | 200 / 503 | SQLite + Redis + LiteLLM ok **e** disco `~/.clow/` < 85% | 503 com JSON detalhado por dependência |
| `GET /health/version` | 200 | sempre | — |

### Exemplos de resposta

`/health/live`:
```json
{ "status": "ok" }
```

`/health/ready` (saudável):
```json
{
  "status": "ok",
  "checks": {
    "sqlite":  { "ok": true,  "latency_ms": 1 },
    "redis":   { "ok": true,  "latency_ms": 3 },
    "litellm": { "ok": true,  "latency_ms": 12, "details": "HTTP 200" },
    "disk":    { "ok": true,  "latency_ms": 4,  "details": "37% used (threshold 85%)" }
  }
}
```

`/health/ready` (degraded — HTTP 503):
```json
{
  "status": "degraded",
  "checks": {
    "sqlite":  { "ok": true },
    "redis":   { "ok": false, "details": "ECONNREFUSED 127.0.0.1:6379" },
    "litellm": { "ok": true },
    "disk":    { "ok": false, "details": "92% used (threshold 85%)" }
  }
}
```

`/health/version`:
```json
{
  "commit_sha": "70980eea63...",
  "build_time": "2026-04-26T18:22:11.000Z",
  "node_version": "v22.22.2",
  "uptime_seconds": 4827
}
```

### Configurando UptimeRobot

1. **New Monitor** → **HTTP(s)**
2. **URL**: `https://system-clow.pvcorretor01.com.br/health/ready`
3. **Monitoring Interval**: 5 minutes
4. **Advanced Settings → Custom HTTP Statuses**: aceitar `200` apenas (UptimeRobot dispara alerta em 503)
5. **Alert Contacts**: e-mail do oncall + canal Slack/Telegram via webhook

Adicione um monitor extra **HTTP(s)** apontando pra `/health/live` com intervalo de **1 min** — esse é o canário da liveness (se o processo morreu, alerta em 1 min).

### Configurando Better Stack

1. **Monitors → Create monitor → HTTP**
2. **URL**: `https://system-clow.pvcorretor01.com.br/health/ready`
3. **Check frequency**: `30s`
4. **Request timeout**: `5s` (o `/health/ready` faz 4 probes em paralelo — fica em ~50–500ms tipicamente)
5. **Expected status code**: `200`
6. **Recovery time**: `2 confirmations` (evita alerta com flap único do LiteLLM)
7. **Escalation policy**: oncall on-duty + Slack `#alerts-system-clow`

### Rate-limit headers

Resposta `429` (excedeu 60 req/min/IP):
```http
HTTP/1.1 429 Too Many Requests
Retry-After: 47
Content-Type: application/json

{ "error": "rate_limit_exceeded", "limit": 60, "window_seconds": 60, "retry_after_seconds": 47 }
```

UptimeRobot e Better Stack respeitam `Retry-After` automaticamente. Se você roda múltiplos serviços de monitoring atrás do mesmo IP NAT, suba o limite editando `HEALTH_RATE_LIMIT_PER_MIN` em [src/server/health.ts](src/server/health.ts).

### Trazendo o commit_sha em produção

Em build local, `/health/version` lê o SHA via `git rev-parse HEAD`. Em deploy via CI/Docker (sem `.git/`), exporte uma das envs:

```bash
GIT_COMMIT_SHA=$(git rev-parse HEAD)   # ou
GITHUB_SHA=$GITHUB_SHA                 # se vem do GitHub Actions
BUILD_SHA=...                          # qualquer pipeline custom
CLOW_COMMIT_SHA=...                    # PM2 ecosystem.config
```

A primeira env definida vence (ordem: `GIT_COMMIT_SHA` → `GITHUB_SHA` → `BUILD_SHA` → `CLOW_COMMIT_SHA` → `git rev-parse` → `"unknown"`).

---

## 📈 Metrics & Monitoring (Prometheus)

Endpoint **`/metrics`** em formato Prometheus — token-protected. Configure `METRICS_TOKEN` no `.env`:

```bash
METRICS_TOKEN=$(openssl rand -hex 32)
```

Sem `METRICS_TOKEN` setado → endpoint retorna **503** (proteção contra exposição acidental).

### Métricas expostas

| Nome | Tipo | Labels | Descrição |
|---|---|---|---|
| `clow_http_requests_total` | counter | `route`, `method`, `status` | total de requests HTTP por rota/método/status |
| `clow_http_request_duration_seconds` | histogram | `route`, `method` | latência por rota (buckets: 5ms-10s) |
| `clow_errors_total` | counter | `route`, `status` | só responses 5xx |
| `clow_ai_messages_total` | counter | `tenant_id`, `plan` | mensagens IA processadas (incrementa em `/v1/sessions/:id/messages`) |
| `clow_webhooks_received_total` | counter | `channel` | webhooks `meta` / `zapi` / `stripe` |
| `clow_tenants_active` | gauge | — | tenants em status `active` ou `trial` (coletado on-scrape) |
| `clow_db_size_bytes` | gauge | — | tamanho de `~/.clow/crm.sqlite3` (coletado on-scrape) |
| `clow_node_*` | mixed | — | métricas Node.js padrão (CPU, mem, event loop lag, GC) |

### Scrape

```bash
curl -H "Authorization: Bearer $METRICS_TOKEN" \
  https://system-clow.pvcorretor01.com.br/metrics
```

### Apontando Grafana Cloud free tier

1. Cria conta gratuita em [grafana.com](https://grafana.com) → tier free dá 10k métricas + 50GB logs.
2. **My Account → Connections → Add new connection → Prometheus**.
3. Cola a URL do remote-write do seu stack Grafana Cloud (vai estar em `https://prometheus-prod-XX-prod-us-east-Y.grafana.net/api/prom/push`).
4. Configura `prometheus.yml` em uma VM auxiliar:

```yaml
global:
  scrape_interval: 30s
  external_labels:
    cluster: system-clow-prod

scrape_configs:
  - job_name: 'system-clow'
    metrics_path: /metrics
    bearer_token: <METRICS_TOKEN_VALUE>
    static_configs:
      - targets: ['system-clow.pvcorretor01.com.br:443']
        labels:
          env: production
    scheme: https

remote_write:
  - url: https://prometheus-prod-XX-prod-us-east-Y.grafana.net/api/prom/push
    basic_auth:
      username: <GRAFANA_CLOUD_USER>
      password: <GRAFANA_CLOUD_API_KEY>
```

### Self-hosted Prometheus

Mesma config sem o `remote_write`. Roda em qualquer VM (até a própria VPS):

```bash
docker run -d --name prometheus \
  -p 9090:9090 \
  -v /etc/prometheus/prometheus.yml:/etc/prometheus/prometheus.yml \
  prom/prometheus
```

E aponta o Grafana local pra `http://localhost:9090`.

### Dashboards sugeridos

- **Throughput**: `rate(clow_http_requests_total[5m])` agrupado por route
- **Latência p95**: `histogram_quantile(0.95, rate(clow_http_request_duration_seconds_bucket[5m]))`
- **Error rate**: `rate(clow_errors_total[5m]) / rate(clow_http_requests_total[5m])`
- **MAU por plano**: `clow_tenants_active` (atual) + `increase(clow_ai_messages_total[30d])` (mensagens/mês por plano)
- **DB growth**: `clow_db_size_bytes` (alarmar quando passar de 1GB)
- **Webhook health**: `rate(clow_webhooks_received_total[1m])` — queda abrupta = canal Z-API/Meta caído

### Alertas críticos

```yaml
- alert: HighErrorRate
  expr: rate(clow_errors_total[5m]) / rate(clow_http_requests_total[5m]) > 0.01
  for: 5m
  labels: { severity: page }
  annotations: { summary: "5xx rate > 1% por 5min" }

- alert: DBGrowingTooFast
  expr: deriv(clow_db_size_bytes[1h]) > 10*1024*1024
  for: 30m
  annotations: { summary: "CRM SQLite cresceu >10MB/h por 30min" }

- alert: WebhooksDown
  expr: rate(clow_webhooks_received_total{channel="zapi"}[10m]) == 0
  for: 15m
  annotations: { summary: "Z-API webhooks parados há 15min" }
```

---

## 🐛 Sentry — Error tracking

Captura automática de erros não tratados, com **filtragem de dados sensíveis** já wired in. **Sem `SENTRY_DSN` no `.env`, vira no-op** — código não envia nada e não trava.

### Setup (5 min, free tier)

1. Cria conta em [sentry.io](https://sentry.io) — free tier dá **5k events/mês**, suficiente pra começar.
2. **Create Project → Node.js → "system-clow"**.
3. Copia o DSN (formato `https://<key>@<org>.ingest.sentry.io/<projectId>`).
4. Adiciona no `.env` (modo 600, dono root):
   ```bash
   SENTRY_DSN=https://abc123@o4501234567.ingest.sentry.io/4509876543
   ```
5. `pm2 reload clow --update-env` — Sentry inicializa no boot e começa a enviar.

### O que Sentry captura automaticamente

- **Uncaught exceptions** (`process.on('uncaughtException')`)
- **Unhandled promise rejections**
- **Hono error middleware** — qualquer rota que jogue 500
- **Action errors em automations** — quando uma action de automação falha (Z-API down, URL inválida, etc)
- **Webhook errors** — falhas de signature, parsing, processamento

### Auto-tagging (zero boilerplate no call site)

Cada evento Sentry leva tags do request context (que vem do AsyncLocalStorage do logger):

| Tag | Origem |
|---|---|
| `tenant_id` | `c.get('tenantId')` (set pelo `tenantAuth`) |
| `user_id` | `c.get('userId')` |
| `request_id` | header `x-request-id` (preservado ou gerado) |
| `plan` | quando passado em `captureException(err, { plan: ... })` |
| `environment` | `NODE_ENV` |
| `release` | `GIT_COMMIT_SHA` ou `GITHUB_SHA` se setado |
| `app` | sempre `system-clow` |

### Filtragem de dados sensíveis (`beforeSend` hook)

**Body do request é stripado em rotas sensíveis:**
- `/auth/*` (signup/login → senhas)
- `/webhooks/stripe*` (signing secrets, customer IDs)
- `/v1/crm/channels/:id/credentials*` (Z-API tokens, Meta tokens)

**Headers stripados em TODA rota:**
- `Authorization`, `Cookie`, `x-api-key`
- `stripe-signature`, `x-hub-signature`, `x-hub-signature-256`

**Chaves stripadas em qualquer payload (regex em key name):**
- `password`, `password_hash`
- `api_key`, `access_token`, `refresh_token`, `client_secret`
- `stripe_customer_id`, `stripe_subscription_id`, `stripe_secret_key`, `stripe_webhook_secret`
- `credentials_encrypted`, `webhook_secret`

A regra: **se em dúvida, filtra**. Adicione mais nomes em `SENSITIVE_KEY_RX` em [src/utils/sentry.ts](src/utils/sentry.ts) se aparecer algo novo.

### Verificando que tá funcionando

Forçar um erro de teste em prod:

```bash
curl -i https://system-clow.pvcorretor01.com.br/v1/crm/contacts/__sentry_test_force_500__ \
     -H "Authorization: Bearer <api_key_inválida>"
```

Espera 401 (auth falha). Mas se você quiser ver um evento real no Sentry, edita um endpoint pra `throw new Error('sentry-test')` numa branch, deploya, faz a request, depois reverte. Em ~30s o evento aparece no dashboard com `tenant_id`, `request_id`, route — sem nenhum dado sensível.

---

## 🛠️ Operação

### Stack rodando

```
PM2:
  clow      Node + Hono em 127.0.0.1:3001
  litellm   LiteLLM proxy em 127.0.0.1:4000

Nginx: TLS público em 443 → proxy pro 3001
Redis: 127.0.0.1:6379 (cache de sessões)
SQLite WAL: ~/.clow/crm.sqlite3
```

### Env vars principais

> Veja `.env.example` para a lista completa. **Nunca commite o `.env`.**

```bash
# ─── Gateway IA (LiteLLM proxy local → OpenRouter → GLM-5.1) ────────────
ANTHROPIC_API_KEY=sk-clow-proxy-local        # placeholder para o SDK Anthropic; tráfego vai pro LiteLLM
ANTHROPIC_BASE_URL=http://127.0.0.1:4000     # LiteLLM proxy local
CLOW_MODEL=glm-5.1
OPENROUTER_API_KEY=                          # ← obrigatória (https://openrouter.ai/keys)

# ─── OpenAI (apenas Whisper + visão, NÃO chat) ──────────────────────────
OPENAI_API_KEY=                              # transcrição de áudio + OCR de PDF/imagem
OPENAI_WHISPER_MODEL=whisper-1
OPENAI_VISION_MODEL=gpt-4o-mini

# ─── Auth ───────────────────────────────────────────────────────────────
CLOW_ADMIN_USER=                             # usuário admin
CLOW_ADMIN_PASS=                             # senha admin (forte)
CLOW_ADMIN_KEY=                              # API key admin
CLOW_ADMIN_SESSION_SECRET=                   # HMAC pra admin tokens (32+ chars random)
CLOW_USER_SESSION_SECRET=                    # HMAC pra user tokens (multi-tenant)
CLOW_CRM_SECRET=                             # AES-256 pra credenciais de canais
CLOW_ADMIN_BASH_PASSWORD=                    # senha pra destravar Bash em sessões admin

# ─── WhatsApp Meta Cloud API ────────────────────────────────────────────
META_WA_ACCESS_TOKEN=                        # System User token
META_WA_PHONE_NUMBER_ID=                     # ID do número conectado
META_WA_BUSINESS_ACCOUNT_ID=
META_WA_APP_ID=
META_WA_PAGE_ID=
META_WA_VERIFY_TOKEN=                        # token aleatório pra validar webhook
META_WA_ADMIN_PHONES=                        # E.164, separado por vírgula
META_WA_API_VERSION=v22.0

# ─── Stripe (billing) ───────────────────────────────────────────────────
STRIPE_PUBLISHABLE_KEY=
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_PRICE_STARTER=                        # price ID do plano R$ 347
STRIPE_PRICE_PROFISSIONAL=                   # price ID do plano R$ 697
STRIPE_PRICE_EMPRESARIAL=                    # price ID do plano R$ 1.297
STRIPE_PRICE_WHATSAPP_ADDON=                 # price ID do add-on Z-API R$ 100/nº
STRIPE_SUCCESS_URL=https://seu-dominio.com.br/signup/success
STRIPE_CANCEL_URL=https://seu-dominio.com.br/signup

# ─── Web Push (PWA) ─────────────────────────────────────────────────────
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=mailto:admin@seu-dominio.com.br

# ─── Server ─────────────────────────────────────────────────────────────
PORT=3001
CLOW_PUBLIC_BASE_URL=https://seu-dominio.com.br
CLOW_ALLOWED_ORIGINS=https://seu-dominio.com.br
```

> Os IDs do Meta WhatsApp, telefones admin, price IDs do Stripe e qualquer
> token real ficam **somente** no `.env` (modo `600`, dono `root`) e em
> `/opt/litellm/.env`. **Não copie valores reais para este README.**

### Deploy (zero-downtime — PM2 cluster mode)

A partir do Comando 12 o `clow` roda em **PM2 cluster com 2 workers**. `pm2 reload` substitui workers **um de cada vez**, mantendo `/health/live` respondendo durante todo o swap.

```bash
ssh root@<VPS_IP>
cd /opt/system-clow
./scripts/deploy.sh
```

O `deploy.sh` faz:
1. `git fetch && git reset --hard origin/<branch>`
2. `npm ci --no-audit --no-fund`
3. `npm run build` (tsc + copy migrations/*.sql)
4. `npm run db:migrate` (idempotente — só aplica novas)
5. `npm test` (paranoia local antes de tocar prod)
6. `pm2 reload clow --update-env`
7. Confirma o `commit_sha` em `/health/version` bate com o do git

Variáveis de ambiente do script:
- `SKIP_TESTS=1` — pula testes (modo hotfix; só use com algo já validado local)
- `SKIP_MIGRATE=1` — pula migrations
- `CLOW_INSTANCES=max` — usa todos os cores (default: 2)

#### Verificando que o reload foi zero-downtime

Em outro shell, antes de rodar `deploy.sh`:

```bash
while true; do
  curl -s -o /dev/null -w "%{http_code} %{time_total}s\n" \
    https://system-clow.pvcorretor01.com.br/health/live
  sleep 0.2
done | grep -v "^200 "
```

Esse comando **não deve imprimir nada** durante o reload. Se aparecer `502`, `503` ou `connection refused`, o reload **não foi zero-downtime** e algum worker derrubou tráfego sozinho.

#### Sobre cluster mode (limitações conhecidas)

**Funciona corretamente com 2+ workers:**
- `getCrmDb()` — better-sqlite3 abre conexão por worker, WAL permite multi-reader
- `migrator` — idempotente (skipa migrações já aplicadas em outros workers)
- `queryCache` — já usa Redis (`REDIS_URL`), invalidação cluster-wide
- `health.ts` `/health/version` — `commit_sha` igual em todos os workers

**Mitigado via `NODE_APP_INSTANCE === '0'`:**
- `scheduler.ts` — só roda no worker 0 (evita reminders disparados N vezes, billing tick duplicado, quota rotation 2×, email-marketing 2×). Force em outros workers via `CLOW_FORCE_SCHEDULER=1` (testes).

**Estados in-memory que foram migrados pra cluster-safe:**
- `src/server/rateLimiter.ts` — atomic `INCR + EXPIRE` via `clusterStore` (Redis se `REDIS_URL`, fallback Map)
- `src/server/health.ts` — IP rate limit por `clusterStore`
- `src/billing/quotaGuard.ts` — read+check+increment dentro de file lock em `tenants.json` (`proper-lockfile.lockSync`)
- `src/tenancy/tenantStore.ts` `activeSessions` — Redis SET (`SADD/SREM/SCARD`) via `clusterStore`
- `src/crm/automations.ts` `_runningEvents` — `SET key NX EX 5` via `clusterStore`

**⚠️ Único item ainda worker-local (precisa sticky session OU Redis):**
- `src/server/sessionPool.ts` — a engine de cada sessão fica em memória do worker que a criou. Se o nginx/load balancer mandar a continuação pro outro worker, ele 404 a sessão. **Solução**: sticky cookies no nginx (config abaixo). Migration completa pra Redis seria refator pesado — só vale fazer se a contagem de workers passar de 4.

```nginx
# /etc/nginx/sites-available/system-clow
upstream clow_cluster {
    # ip_hash garante que o mesmo IP cliente sempre cai no mesmo worker.
    # Para sticky por session_id no path/header, usar nginx-plus ou um
    # módulo extra (e.g. ngx_http_upstream_jvm_route_module) — esse é o
    # caminho correto se PM2 reload mover IPs entre workers.
    ip_hash;
    server 127.0.0.1:3001;
}

server {
    listen 443 ssl http2;
    server_name system-clow.pvcorretor01.com.br;
    location / {
        proxy_pass http://clow_cluster;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

Sem isso, sessões que duram mais de 1 turno (que é o caso típico — usuário faz pergunta, espera resposta, faz follow-up) podem cair em workers diferentes e perder contexto. **Configure isso ANTES de aumentar `CLOW_INSTANCES`.**

#### Fallback: deploy modo antigo (com downtime)

Se o reload em cluster falhar e for emergência:
```bash
pm2 restart clow --update-env   # 15-30s downtime
```

---

## 📌 Estado atual (2026-04-23)

✅ Concluído
- 11 ondas do CRM (do schema até UI completa + automações + SSE + UI extras)
- Integração CRM como modal in-app no System Clow
- Auto-login via session token (zero fricção)
- Multi-tenant signup/login (bcrypt + HMAC tokens)
- Phone whitelist por tenant (proteção contra hijack)
- Webhook do CRM forwarda pro agente (IA continua respondendo)
- Stripe Checkout esqueleto + webhook handler
- 26 commits hoje, todos no GitHub

⏭️ Próximas etapas
- UI de signup (landing com seletor de plano + formulário)
- Conectar Stripe ao vivo (precisa price IDs + secret key)
- Email transacional (envio da senha temp)
- Rate limit enforcement por plano (quotas: msgs IA/mês, fluxos n8n)
- N8N integration (1/4/8 fluxos por plano)
- White-label tenant config (logo + cores customizáveis)

---

## 📞 Suporte

GitHub: https://github.com/daniellbaptista2021-lgtm/system_clow
Owner: Daniel Baptista (daniellbaptista2021@gmail.com)
