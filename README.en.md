# System Clow

[README em Português](README.md) | English

> Premium SaaS platform combining a **WhatsApp AI agent** + **complete CRM** +
> **n8n automations** in a single product. Each subscriber gets an isolated
> workspace with sales pipeline, WhatsApp customer service, and an AI that
> operates the CRM through natural language commands.

**Live:** https://system-clow.pvcorretor01.com.br
**Stack:** Node 22 + TypeScript + Hono + better-sqlite3 + GLM-5.1 (via LiteLLM/OpenRouter)

---

## 🤖 AI Engine

Single-engine, by design:

| Layer | Provider | Use |
|---|---|---|
| **Chat / agent / tool use** | **GLM-5.1** (Z-AI) via OpenRouter, routed through a local LiteLLM proxy | 100% of AI conversations, reasoning, tool calls |
| Audio transcription | OpenAI **Whisper-1** | Audio messages received on WhatsApp |
| Vision / PDF & image OCR | OpenAI **GPT-4o-mini** | Attachments sent by the customer |
| Web Push | local VAPID | PWA notifications |

> ⚠️ **There is no fallback to Claude/Anthropic, GPT-4 chat, or DeepSeek.**
> The LiteLLM config (`/opt/litellm/config.yaml`) maps every `claude-*` alias
> to `openrouter/z-ai/glm-5.1` — this preserves Anthropic-SDK compatibility
> without changing the actual provider.

---

## 🚀 Features

### AI Agent
- WhatsApp conversations driven by GLM-5.1
- 10 native CRM tools the AI invokes via natural language:
  `crm_find_or_create_contact`, `crm_create_card`, `crm_move_card`,
  `crm_add_note`, `crm_send_whatsapp`, `crm_search`, `crm_pipeline`,
  `crm_get_contact`, `crm_create_reminder`, `crm_dashboard`
- Per-phone persistent session (cross-conversation memory)
- Per-number isolated workspace at `~/.clow/sessions/`

### Clow CRM

| Module | Capabilities |
|---|---|
| Kanban Pipeline | Custom boards, drag-and-drop, terminal columns (Won/Lost) |
| Contacts | Full record, real-time search, tags, unified history |
| WhatsApp Channels | Meta Cloud API + Z-API, AES-256-GCM encrypted credentials |
| Side Panel | Inline conversation with bubble UI, text/audio/image/PDF |
| Team | Agents with roles (owner/admin/agent/viewer), auto assignment |
| Inventory | SKU, price, stock, line items, auto-reduce on Win |
| Subscriptions | Recurring billing, T-3/T-1/T-0 WhatsApp reminders, mark paid |
| Automations | 6 triggers × 9 conditions × 8 actions, 5 one-click templates |
| Stats | Weighted forecast, per-agent metrics |
| Real-time | SSE pub/sub, no polling |

### Multi-tenant SaaS

- Signup (`POST /auth/signup`) with CPF, E.164 phone, unique e-mail, bcrypt
- Login (`POST /auth/login`) returns `usr.{payload}.{sig}` token (30-day TTL)
- Phone whitelist per tenant (anti-hijack)
- Stripe Checkout: `POST /api/billing/checkout` creates a session,
  webhook auto-creates the tenant
- Tenant status driven by Stripe events (active / past_due / cancelled)

### Commercial Plans

| | **STARTER** | **PROFISSIONAL** ⭐ | **EMPRESARIAL** |
|---|---|---|---|
| Monthly price | R$ 347 | R$ 697 | R$ 1,297 |
| Users | 1 | 5 | 20 |
| WhatsApp numbers | 1 | up to 5 | up to 10 |
| AI messages/month | 500 | 3,000 | 8,000 |
| Overage per msg | R$ 0.20 | R$ 0.15 | R$ 0.12 |
| n8n flows | 1 | 4 | 8 |

Cost basis: GLM-5.1 at $1.05/M input + $3.50/M output ≈ R$ 0.06/message.

---

## 🛠️ Installation

```bash
npm install
npm run typecheck
npm run build
```

### Run the HTTP server

```bash
npm run server
```

Health check:

```bash
curl http://127.0.0.1:3001/health
```

### LiteLLM gateway (separate process)

See `deploy/GATEWAY.md` and `deploy/litellm-config.example.yaml`.
Run with `pm2 start ecosystem.config.cjs`.

---

## ⚙️ Required environment variables

See `.env.example` for the full list. **Never commit `.env`.**

```bash
# AI gateway (LiteLLM → OpenRouter → GLM-5.1)
ANTHROPIC_API_KEY=sk-clow-proxy-local        # placeholder for the SDK
ANTHROPIC_BASE_URL=http://127.0.0.1:4000
CLOW_MODEL=glm-5.1
OPENROUTER_API_KEY=                          # required

# OpenAI (Whisper + vision only, NOT chat)
OPENAI_API_KEY=

# Auth
CLOW_ADMIN_USER=
CLOW_ADMIN_PASS=
CLOW_ADMIN_SESSION_SECRET=
CLOW_USER_SESSION_SECRET=
CLOW_CRM_SECRET=

# Meta WhatsApp Cloud API (per-tenant configurable too)
META_WA_ACCESS_TOKEN=
META_WA_PHONE_NUMBER_ID=
META_WA_BUSINESS_ACCOUNT_ID=
META_WA_VERIFY_TOKEN=
META_WA_ADMIN_PHONES=

# Stripe billing
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_PRICE_STARTER=
STRIPE_PRICE_PROFISSIONAL=
STRIPE_PRICE_EMPRESARIAL=
STRIPE_PRICE_WHATSAPP_ADDON=

# Web Push
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=
```

> Real Meta WhatsApp IDs, admin phone numbers, Stripe price IDs and any
> real token must live **only** in `.env` (mode `600`, owner `root`) and
> in `/opt/litellm/.env`. **Do not copy real values into this README.**

---

## 🔒 Security

- Bcrypt (cost 10) for passwords
- HMAC SHA-256 for session tokens (admin + user)
- AES-256-GCM for channel credentials at rest
- Per-tenant phone whitelist
- Webhook signature validation (Meta + Z-API)
- Rate limiting (in-memory, per-tenant)
- Audit log for sensitive operations
- LGPD: consent, retention policies, data portability, right to erasure

See `SECURITY.md` and `SECURITY_HARDENING_COMMAND.md` for hardening
checklist.

---

## 📂 Project structure

```text
src/
  adapters/      External adapters (WhatsApp Meta, Z-API)
  api/           Anthropic SDK wrapper (routed to LiteLLM)
  auth/          ★ Multi-user signup/login + HMAC tokens
  billing/       Stripe routes, n8n routes, quota guard
  crm/           ★ ~50 modules (CRM core)
    routes.ts        REST API
    store.ts         SQLite store
    channels/        meta.ts + zapi.ts
    webhooks.ts      /webhooks/crm/{meta|zapi}/:secret
    ...
  memory/        Persistent agent memory + RAG
  notifications/ mailer, openaiMedia (Whisper/vision), whatsapper
  server/        HTTP API, session pool, middleware
  tenancy/       Path guards, tiers, quotas, tenant store
  tools/         Native tools + registry
  ...
public/
  index.html         App shell (auto-loader)
  crm/               CRM SPA
  pricing.html       Public pricing page
  signup.html        Signup form
```

Persistent data lives in `~/.clow/`:
- `crm.sqlite3` (CRM data)
- `memory/*.sqlite3` (agent memory)
- `crm-media/{tenant}/{date}/` (WhatsApp attachments)
- `tenants.json` (tenants + api_keys)

---

## 🚦 Operational health

```
GET /health → 200 OK in <10ms
PM2: clow + litellm + pm2-logrotate
Node: --max-old-space-size=1024, max_memory_restart 1G
```

See `ecosystem.config.cjs` for PM2 settings.

---

## License

No license file is currently present in this repository.
