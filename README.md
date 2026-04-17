<div align="center">

<img src="public/assets/logo-official-full.png" width="400" alt="System Clow">

# System Clow

**Agente de codigo AI de nivel enterprise — clone arquitetural do Claude Code**

[![TypeScript](https://img.shields.io/badge/TypeScript-69K_linhas-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-22+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Claude](https://img.shields.io/badge/Claude-Sonnet_4-blueviolet?logo=anthropic&logoColor=white)](#)
[![Status](https://img.shields.io/badge/Status-Producao-brightgreen)](#)
[![Memory](https://img.shields.io/badge/Memoria-Persistente-blue)](#memoria-persistente)
[![Security](https://img.shields.io/badge/Security-Hardened-green)](#seguranca-multi-tenant-2000-usuarios)

*Inteligencia Infinita . Possibilidades Premium*

</div>

---

## O que e o System Clow?

System Clow e um **agente de codigo AI completo** que executa tarefas de engenharia de software de forma autonoma — le arquivos, escreve codigo, executa comandos, clona sites, acessa APIs, cria documentos, gerencia projetos e orquestra sub-agentes — tudo via chat, terminal ou API.

Construido como **clone arquitetural do Claude Code**, o System Clow implementa **16 subsistemas** em **69.000+ linhas de TypeScript**, rodando como produto SaaS multi-tenant pronto para producao com 2000+ usuarios.

## Por que System Clow?

| | Claude Code | ChatGPT | System Clow |
|---|---|---|---|
| **Executa codigo** | Sim | Nao | Sim |
| **Le/edita arquivos** | Sim | Nao | Sim |
| **Sub-agentes** | Sim | Nao | Sim |
| **Plugins** | Sim | Sim | Sim |
| **Clona sites** | Via skill | Nao | Nativo (pixel-perfect) |
| **Memoria persistente** | Plugin externo | Nao | Nativo (SQLite + FTS5) |
| **Multi-tenant SaaS** | Nao | Nao | Sim (2000+ usuarios) |
| **Auto-hospedado** | Nao | Nao | Sim |
| **Multi-modelo** | Nao | Nao | Sim (Claude, GPT, DeepSeek) |
| **WhatsApp** | Nao | Nao | Sim |
| **PWA Mobile** | Nao | Nao | Sim |
| **Rate Limiting** | N/A | N/A | Per-tenant sliding window |
| **Audit Log** | Nao | Nao | JSONL append-only |
| **API Docs** | Nao | Nao | OpenAPI 3.1 + Swagger UI |
| **Custo** | $200/mes fixo | $200/mes fixo | Seu servidor, seus custos |

## Memoria Persistente

O System Clow **lembra o que fez** entre sessoes:

- **Captura automatica** — Cada uso de ferramenta grava uma observacao no SQLite
- **Resumo por sessao** — Ao final, gera resumo via LLM (request, investigated, learned, completed)
- **Injecao de contexto** — Ao iniciar nova sessao, injeta memorias relevantes no system prompt
- **Busca full-text** — FTS5 para buscar em observacoes e resumos
- **Deduplicacao** — SHA256 content hash com janela de 30s
- **Multi-tenant** — Cada tenant tem seu proprio banco SQLite isolado

### API de Memoria

| Metodo | Rota | Descricao |
|--------|------|-----------|
| GET | `/v1/memory/search?q=...` | Busca full-text em memorias |
| GET | `/v1/memory/sessions` | Lista sessoes com resumos |
| GET | `/v1/memory/sessions/:id/timeline` | Timeline de observacoes |
| DELETE | `/v1/memory/sessions/:id` | Deleta sessao (GDPR) |
| GET | `/v1/memory/stats` | Estatisticas do banco |

## Clone de Sites (Skill Nativa)

Clonagem pixel-perfect de qualquer site via Browser MCP:

```
"clone o site https://exemplo.com"
```

Pipeline de 5 fases: Reconhecimento, Fundacao, Specs+Dispatch, Assembly, QA Visual. Stack: Next.js 16 + React 19 + shadcn/ui + Tailwind CSS v4.

## 17 Ferramentas Nativas

| Ferramenta | Funcao |
|---|---|
| `Read` | Ler arquivos com numeracao de linhas |
| `Write` | Criar novos arquivos |
| `Edit` | Editar arquivos existentes (diff-based) |
| `Bash` | Executar comandos shell |
| `Glob` | Buscar arquivos por padrao |
| `Grep` | Pesquisar conteudo no codigo |
| `WebFetch` | Acessar URLs e APIs |
| `Agent` | Spawnar sub-agentes isolados |
| `TodoWrite` | Gerenciar lista de tarefas |
| `Download` | Publicar arquivos para download |
| `TeamCreate` | Criar equipe multi-agente |
| `TeamDelete` | Deletar equipe |
| `SendMessage` | Enviar mensagens entre agentes |
| `ListPeers` | Listar membros da equipe |
| `TeammateIdle` | Notificar ociosidade |
| `EnterPlanMode` | Modo planejamento (read-only) |
| `ExitPlanMode` | Sair do modo planejamento |

## 16 Subsistemas Integrados

```
src/
  plugins/        18.600 linhas  Plugin system + marketplace publico
  hooks/           5.261 linhas  Pre/Post tool hooks (24 eventos)
  session/         5.557 linhas  Persistencia JSONL append-only
  bridge/          5.502 linhas  Remote control via SSE/WebSocket
  swarm/           5.170 linhas  Multi-agent com file-based mailbox
  server/          6.200 linhas  HTTP API + SSO + Redis sessions + dashboard
  query/           3.400 linhas  Query engine com budget enforcement
  tools/           3.700 linhas  17 ferramentas + tool result cache
  compact/         3.320 linhas  3-tier compaction (micro/session/full)
  skills/          2.772 linhas  Auto-injecao por contexto + clone-website
  tenancy/         3.100 linhas  Multi-tenant + PostgreSQL + rate limiter + audit
  coordinator/     1.960 linhas  Orchestracao de workers
  bootstrap/       1.892 linhas  Estado global + integrity check
  memory/          1.600 linhas  Memoria persistente + RAG embeddings
  mcp/               615 linhas  Model Context Protocol client
```

## Seguranca Multi-Tenant (2000+ usuarios)

### Isolamento
- **Session Ownership Guard** — Tenant A nao acessa sessoes do Tenant B
- **Workspace Isolation** — Cada tenant em diretorio isolado
- **Memoria isolada** — SQLite separado por tenant
- **System Prompt bifurcado** — Admin tem acesso total, regular tem sandbox

### Rate Limiting Per-Tenant
| Tier | Limite |
|------|--------|
| ONE | 20 req/min |
| SMART | 60 req/min |
| PROFISSIONAL | 120 req/min |
| BUSINESS | 300 req/min |
| ADMIN | Ilimitado |

### Bash Sandbox
- Regular users: whitelist de comandos seguros
- Bloqueio: pm2, sudo, .env, system files
- Admin: sem restricoes

### Audit Logger
- Todas as acoes em `~/.clow/audit/YYYY-MM-DD.jsonl`
- Login, sessao, rate limit, comandos bloqueados, violacoes

### Licenciamento
- Validacao RSA-256 de tokens de licenca
- Origin tracking e integrity check

## Observabilidade

- **Logger estruturado** — JSON logs com severity, component tagging
- **Metricas de latencia** — p95/p99, media, por componente e por tenant
- **Admin Dashboard** — `/admin/dashboard` com metricas visuais
- **Deep Health Check** — `/health/deep` verifica API + DB + queue
- **Endpoint de metricas** — `GET /v1/metrics`

## Documentacao da API

- **Swagger UI**: `/docs`
- **OpenAPI JSON**: `/openapi.json`
- Endpoints: Auth, Sessions, Memory, System, Metrics

## Testes Automatizados

```bash
npm test              # Executar testes
npm run test:watch    # Modo watch
npm run test:coverage # Com cobertura
```

## Otimizacoes de Performance

- **Prompt Cache** — cache_control ephemeral (~90% economia em input tokens)
- **Tool Result Cache** — LRU 5min para Read/Glob/Grep com invalidacao automatica
- **Request Queue** — Concorrencia controlada (configuravel via env)
- **3-Tier Compaction** — MicroCompact, SessionMemory, FullLLM

## Multi-Modelo

| Modelo | Uso |
|--------|-----|
| **Claude Sonnet 4** | Motor principal (max performance) |
| **Claude Haiku 4.5** | Rapido e economico |
| **GPT-4o** | Alternativa OpenAI |
| **GPT-4o-mini** | Ultra economico |
| **DeepSeek V3** | Custo minimo |

## Multi-Tenant SaaS

- 4 tiers: ONE, SMART, PROFISSIONAL, BUSINESS
- Quotas por plano (mensagens, custo, sessoes)
- Billing webhook (Asaas)
- Banco de memoria isolado por tenant

## Acesso Multiplataforma

- **Web** — Interface responsiva com chat, sidebar, tools, downloads
- **PWA** — Instalavel no celular como app nativo
- **Terminal** — CLI interativo com streaming
- **API REST** — Integracao com qualquer sistema
- **WhatsApp** — Atendimento automatico via Z-API
- **Iframe** — Embutivel dentro de outros produtos

## Quick Start

```bash
git clone https://github.com/daniellbaptista2021-lgtm/system_clow.git
cd system_clow
npm install
cp .env.example .env
npm run build
node dist/cli.js
```

## Servidor HTTP

```bash
node dist/server/server.js
```

## Docker

```bash
docker build -t system-clow .
docker run -p 3001:3001 --env-file .env system-clow
```

## Arquitetura

```
                    Usuario
                  (CLI/Web/API)
                       |
                  Query Engine
                  (orquestrador)
                       |
     +------+------+------+------+------+
     |      |      |      |      |      |
  Tools   Hooks  Skills Memory  MCP   Security
 (17nat) (24evt) (clone) (SQLite)(ext) (sandbox)
     |
  Providers
  Claude Sonnet . GPT . DeepSeek
```

## Stack Tecnica

| Componente | Tecnologia |
|---|---|
| Runtime | Node.js 22 + TypeScript 5 |
| AI Model | Claude Sonnet 4 (principal) |
| Server | Hono + @hono/node-server |
| LLM SDK | Anthropic SDK / OpenAI SDK |
| Protocolo | MCP (Model Context Protocol) |
| Persistencia | JSONL + SQLite (memoria) |
| Busca | FTS5 full-text search |
| Cache | Prompt cache + Tool result LRU |
| Auth | JWT + API keys + RSA license |
| Security | Sandbox + Rate limit + Audit |
| Testes | Vitest + V8 Coverage |
| API Docs | OpenAPI 3.1 + Swagger UI |
| Observabilidade | Logger JSON + Metricas p95/p99 |
| Process | PM2 |
| SSL | Lets Encrypt + Nginx |
| PWA | Service Worker + manifest.json |

## Performance

| Metrica | Valor |
|---|---|
| Linhas de codigo | 68.991 |
| Arquivos TypeScript | 269 |
| Subsistemas | 16 + marketplace |
| Ferramentas nativas | 17 |
| Skills nativas | 13 (inclui clone-website) |
| Eventos de hook | 24 |
| Modelos suportados | 5+ |
| Testes automatizados | 65+ |
| Usuarios suportados | 2000+ |
| Paridade com Claude Code | ~99% |

## Roadmap

- [x] CLI interativo com streaming
- [x] 17 ferramentas nativas
- [x] Plugin system com marketplace
- [x] Hook system (24 eventos)
- [x] Skill system com auto-injecao
- [x] Clone de sites pixel-perfect
- [x] Coordinator mode (multi-agent)
- [x] Swarm system (multi-processo)
- [x] Bridge system (remote control)
- [x] Multi-tenant SaaS (2000+ usuarios)
- [x] PWA mobile
- [x] Multi-modelo (Claude Sonnet, GPT, DeepSeek)
- [x] Memoria persistente (SQLite + FTS5)
- [x] Resumo automatico de sessoes via LLM
- [x] Testes automatizados (Vitest + V8 Coverage)
- [x] Observabilidade (Logger JSON + Metricas p95/p99)
- [x] Documentacao API (OpenAPI 3.1 + Swagger UI)
- [x] Admin Dashboard com metricas visuais
- [x] Prompt cache optimization (~90% economia)
- [x] Tool result cache (LRU 5min)
- [x] Request queue (concorrencia controlada)
- [x] Rate limiting per-tenant
- [x] Bash sandbox para usuarios regulares
- [x] Audit log (JSONL append-only)
- [x] Session ownership guard
- [x] License validator (RSA-256)
- [x] Deep health check (API + DB + queue)
- [x] Iframe embedding (produto dentro de produto)
- [x] RAG com embeddings vetoriais (TF-IDF 256-dim + cosine similarity)
- [x] Marketplace de plugins publico (8 oficiais + install/rate/review)
- [x] SSO entre Clow e System Clow (HMAC-SHA256 token exchange)
- [x] PostgreSQL adapter para tenants (Supabase compativel)
- [x] Redis session store distribuido (fallback in-memory)

---

<div align="center">

**System Clow** — Construido para quem precisa de um agente AI que realmente executa.

*69.000+ linhas de TypeScript . 16 subsistemas . 17 ferramentas . RAG + Marketplace + SSO . Claude Sonnet 4 . Producao 24/7*

</div>

## Escalabilidade

### PostgreSQL para Tenants
Adapter para migrar de JSON para PostgreSQL/Supabase:
```env
CLOW_DB_URL=postgresql://user:pass@host:5432/clow
```
Schema auto-migra na primeira conexao. Fallback para JSON quando nao configurado.

### Redis para Sessoes Distribuidas
Session store distribuido com TTL:
```env
CLOW_REDIS_URL=redis://host:6379
```
Fallback para in-memory Map quando Redis nao disponivel.

### SSO (Single Sign-On)
Token HMAC-SHA256 compartilhado entre Clow e System Clow:
- `POST /auth/sso` — troca token SSO por sessao
- `GET /auth/sso/verify` — verifica validade
- Gate `hasSystemClow` para controlar acesso premium

### RAG com Embeddings Vetoriais
Busca semantica na memoria persistente:
- Embeddings TF-IDF de 256 dimensoes (local, sem API externa)
- Cosine similarity para ranking por relevancia
- `GET /v1/memory/semantic?q=...` — busca semantica
- Auto-indexa cada observacao gravada

### Plugin Marketplace
Registro publico de plugins instaláveis:
- 8 plugins oficiais (clone-website, meta-ads, whatsapp-bot, etc)
- Browse, install, uninstall, rate, review
- `GET /v1/marketplace/plugins` — listar plugins
- `POST /v1/marketplace/plugins/:slug/install` — instalar
- Per-tenant tracking de instalacoes
