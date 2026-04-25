# System Clow

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

### Planos comerciais

| | **STARTER** | **PROFISSIONAL** ⭐ | **EMPRESARIAL** |
|---|---|---|---|
| Preço/mês | R$ 347 | R$ 697 | R$ 1.297 |
| Usuários | 1 | 5 | 20 |
| Números WhatsApp | 1 | até 5 | até 10 |
| Mensagens IA/mês | 500 | 3.000 | 8.000 |
| Excedente por msg | R$ 0,20 | R$ 0,15 | R$ 0,12 |
| Fluxos N8N | 1 | 4 | 8 |
| Margem operacional | ~82% | ~61% | ~57% |

Cálculo de custo: GLM-5.1 a $1.05/M input + $3.50/M output ≈ R$ 0,06/mensagem.

---

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

```bash
# Modelo
ANTHROPIC_API_KEY=sk-clow-proxy-local       # dummy pra LiteLLM
ANTHROPIC_BASE_URL=http://127.0.0.1:4000    # LiteLLM
CLOW_MODEL=glm-5.1
OPENROUTER_API_KEY=sk-or-v1-...

# Auth
CLOW_ADMIN_USER=...                          # legacy admin
CLOW_ADMIN_PASS=...
CLOW_ADMIN_SESSION_SECRET=...                # HMAC pra admin tokens
CLOW_USER_SESSION_SECRET=...                 # HMAC pra user tokens (multi-tenant)
CLOW_CRM_SECRET=...                          # AES-256 pra credenciais

# WhatsApp Meta (canal padrão / admin)
META_WA_ACCESS_TOKEN=...                     # System User token (vitalício)
META_WA_PHONE_NUMBER_ID=REDACTED_PHONE_ID
META_WA_BUSINESS_ACCOUNT_ID=REDACTED_BUSINESS_ID
META_WA_APP_ID=REDACTED_APP_ID
META_WA_VERIFY_TOKEN=REDACTED_VERIFY_TOKEN
META_WA_ADMIN_PHONES=REDACTED_ADMIN_PHONE

# Stripe (preencher pra ativar billing)
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_STARTER=price_...
STRIPE_PRICE_PROFISSIONAL=price_...
STRIPE_PRICE_EMPRESARIAL=price_...
STRIPE_SUCCESS_URL=https://system-clow.pvcorretor01.com.br/signup/success
STRIPE_CANCEL_URL=https://system-clow.pvcorretor01.com.br/signup
```

### Deploy

```bash
ssh root@<vps-ip>
cd /opt/system-clow
git pull origin main
npm run build
pm2 restart clow --update-env
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
- Tabela de planos definida (Starter R$ 347 / Profissional R$ 697 / Empresarial R$ 1.297)
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
