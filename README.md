<div align="center">

<img src="public/assets/logo-new.png" width="400" alt="System Clow">

# System Clow

**Agente de codigo AI de nivel enterprise — com paridade arquitetural ao Claude Code**

[![TypeScript](https://img.shields.io/badge/TypeScript-67.4K_linhas-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-22+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Status](https://img.shields.io/badge/Status-Producao-brightgreen)](#)
[![Memory](https://img.shields.io/badge/Memoria-Persistente-blueviolet)](#memoria-persistente)

*Inteligencia Infinita . Possibilidades Premium*

</div>

---

## O que e o System Clow?

System Clow e um **agente de codigo AI completo** que executa tarefas de engenharia de software de forma autonoma — le arquivos, escreve codigo, executa comandos, navega na web, cria documentos, gerencia projetos e orquestra sub-agentes — tudo via chat, terminal ou API.

Construido com **paridade arquitetural ao Claude Code**, o System Clow implementa **14 subsistemas** em **65.800+ linhas de TypeScript**, rodando como produto SaaS multi-tenant pronto para producao.

## Por que System Clow?

| | Claude Code | ChatGPT | System Clow |
|---|---|---|---|
| **Executa codigo** | Sim | Nao | Sim |
| **Le/edita arquivos** | Sim | Nao | Sim |
| **Sub-agentes** | Sim | Nao | Sim |
| **Plugins** | Sim | Sim | Sim |
| **Memoria persistente** | Plugin externo | Nao | Nativo (SQLite) |
| **Multi-tenant SaaS** | Nao | Nao | Sim |
| **Auto-hospedado** | Nao | Nao | Sim |
| **Multi-modelo** | Nao | Nao | Sim (Claude, GPT, DeepSeek) |
| **WhatsApp** | Nao | Nao | Sim |
| **PWA Mobile** | Nao | Nao | Sim |
| **Custo** | $20/mes fixo | $20/mes fixo | Seu servidor, seus custos |

## Memoria Persistente

O System Clow **lembra o que fez** entre sessoes. Inspirado no [claude-mem](https://github.com/thedotmack/claude-mem), o sistema de memoria e nativo e automatico:

- **Captura automatica** — Cada uso de ferramenta grava uma observacao no SQLite
- **Resumo por sessao** — Ao final da sessao, gera resumo via LLM (request, investigated, learned, completed)
- **Injecao de contexto** — Ao iniciar nova sessao, injeta memorias relevantes no system prompt
- **Busca full-text** — FTS5 para buscar em observacoes e resumos passados
- **Deduplicacao** — SHA256 content hash com janela de 30s evita duplicatas
- **Multi-tenant** — Cada tenant tem seu proprio banco SQLite isolado

```
SessionStart → carrega memorias → injeta no system prompt
PostToolUse  → grava observacao no SQLite (fire-and-forget)
SessionEnd   → gera resumo via LLM Haiku → salva no SQLite
```

### API de Memoria

| Metodo | Rota | Descricao |
|--------|------|-----------|
| GET | `/v1/memory/search?q=...` | Busca full-text em memorias |
| GET | `/v1/memory/sessions` | Lista sessoes recentes com resumos |
| GET | `/v1/memory/sessions/:id/timeline` | Timeline de observacoes de uma sessao |
| DELETE | `/v1/memory/sessions/:id` | Deleta sessao e dados (GDPR) |
| GET | `/v1/memory/stats` | Estatisticas do banco de memoria |

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

## 14 Subsistemas Integrados

```
src/
  plugins/        18.194 linhas  Plugin system completo com marketplace
  hooks/           5.261 linhas  Pre/Post tool hooks (24 eventos)
  session/         5.557 linhas  Persistencia JSONL append-only
  bridge/          5.502 linhas  Remote control via SSE/WebSocket
  swarm/           5.170 linhas  Multi-agent com file-based mailbox
  server/          5.290 linhas  HTTP API multi-tenant
  query/           3.373 linhas  Query engine com budget enforcement
  tools/           3.565 linhas  17 ferramentas com Zod schemas
  compact/         3.320 linhas  3-tier compaction (micro/session/full)
  skills/          2.772 linhas  Auto-injecao por contexto (12 skills)
  coordinator/     1.960 linhas  Orchestracao de workers
  bootstrap/       1.892 linhas  Estado global singleton
  memory/          1.150 linhas  Memoria persistente SQLite + FTS5
  mcp/               615 linhas  Model Context Protocol client
```

## Multi-Modelo

- **Claude Sonnet 4** — Maxima qualidade de codigo
- **Claude Haiku 4.5** — Rapido e economico
- **GPT-4o** — Alternativa OpenAI
- **GPT-4o-mini** — Ultra economico
- **DeepSeek V3** — Custo minimo

```env
CLOW_MODEL=claude-sonnet-4-6
```

## Multi-Tenant SaaS

- Autenticacao por API key e sessao admin (JWT)
- Isolamento de workspace por tenant
- Quotas por plano (mensagens, custo, sessoes)
- Billing webhook para gateway de pagamento
- 4 tiers: Starter, Pro, Business, Enterprise
- Banco de memoria isolado por tenant

## Acesso Multiplataforma

- **Terminal** — CLI interativo com streaming e tool blocks visiveis
- **Web** — Interface responsiva com login, chat, sidebar e downloads
- **PWA** — Instalavel no celular como app nativo
- **API REST** — Integracao com qualquer sistema
- **WhatsApp** — Atendimento automatico via Z-API

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
         +------+------+------+------+
         |      |      |      |      |
      Tools   Hooks  Skills Memory  MCP
    (17 nat) (24evt) (12auto)(SQLite)(ext)
         |
      Providers
  Claude . GPT . DeepSeek
```

## Roteamento Inteligente

| Padrao | Tools | Exemplo |
|---|---|---|
| Quick Answer | 0 | Perguntas de conhecimento — responde direto |
| Single File | 1 | Leitura de arquivo especifico |
| Search | 2 | Busca no codigo — Grep + Read |
| Create | 2-3 | Criacao de arquivos — Write + verificacao |
| Complex | 3-8 | Tarefas multi-step — sequencial |

## Seguranca

- Permissoes granulares — Allow/Deny/Ask por ferramenta
- Sandbox por tenant — Isolamento de workspace
- SSRF protection — Validacao de URLs
- Session locking — Prevencao de race conditions
- HTTPS — TLS via Let's Encrypt
- Auth JWT — Sessoes admin criptografadas
- Memoria isolada — SQLite separado por tenant

## Observabilidade

O System Clow inclui um sistema completo de observabilidade:

- **Logger estruturado** — JSON logs com severity (debug/info/warn/error/fatal), component tagging, session/tenant context
- **Metricas de latencia** — Coleta automatica com p95/p99, media, por componente e por tenant
- **Endpoint de metricas** — `GET /v1/metrics` retorna resumo em tempo real
- **Tracing por sessao** — Cada operacao e rastreavel por sessionId e tenantId

```json
{"ts":"2026-04-15T18:00:00Z","level":"info","component":"Memory","msg":"query completed","data":{"durationMs":12,"rows":5}}
```

## Documentacao da API

Documentacao interativa via Swagger UI:

- **Swagger UI**: `https://system-clow.pvcorretor01.com.br/docs`
- **OpenAPI JSON**: `https://system-clow.pvcorretor01.com.br/openapi.json`
- **Spec**: OpenAPI 3.1 com schemas para todos os endpoints

Todos os endpoints documentados:
- Auth (login, verify)
- Sessions (create, message, history, delete)
- Memory (search, sessions, timeline, stats, delete)
- System (health, metrics)

## Testes Automatizados

Suite de testes com Vitest:

```bash
npm test              # Executar testes
npm run test:watch    # Modo watch
npm run test:coverage # Com cobertura de codigo
```

Testes unitarios para:
- MemoryStore (schema, CRUD, deduplicacao SHA256, CASCADE delete, FTS5)
- HookEngine (registro, disparo, enable/disable, metricas, error handling)
- MemoryContextInjector (formatacao, budget de tokens, deduplicacao de arquivos)

## Performance

| Metrica | Valor |
|---|---|
| Linhas de codigo | 67.450 |
| Arquivos TypeScript | 256 |
| Subsistemas | 14 |
| Ferramentas nativas | 17 |
| Skills auto-injetaveis | 12 |
| Eventos de hook | 24 |
| Modelos suportados | 5+ |
| Testes automatizados | 25+ |
| Paridade com Claude Code | ~98% |

## Stack Tecnica

| Componente | Tecnologia |
|---|---|
| Runtime | Node.js 22 + TypeScript 5 |
| CLI | Commander.js + REPL |
| Server | Hono + @hono/node-server |
| LLM | Anthropic SDK / OpenAI SDK |
| Protocolo | MCP (Model Context Protocol) |
| Persistencia | JSONL append-only + SQLite (memoria) |
| Testes | Vitest + V8 Coverage |
| API Docs | OpenAPI 3.1 + Swagger UI |
| Observabilidade | Logger JSON + Metricas p95/p99 |
| Busca | FTS5 full-text search |
| Auth | JWT + API keys |
| Process | PM2 |
| SSL | Let's Encrypt + Nginx |
| PWA | Service Worker + manifest.json |

## Roadmap

- [x] CLI interativo com streaming
- [x] 17 ferramentas nativas
- [x] Plugin system com marketplace
- [x] Hook system (24 eventos)
- [x] Skill system com auto-injecao
- [x] Coordinator mode (multi-agent)
- [x] Swarm system (multi-processo)
- [x] Bridge system (remote control)
- [x] Multi-tenant SaaS
- [x] PWA mobile
- [x] Multi-modelo (Claude, GPT, DeepSeek)
- [x] Memoria persistente (SQLite + FTS5)
- [x] Busca full-text em memorias
- [x] Resumo automatico de sessoes via LLM
- [x] Testes automatizados (Vitest + V8 Coverage)
- [x] Observabilidade (Logger JSON + Metricas p95/p99)
- [x] Documentacao API (OpenAPI 3.1 + Swagger UI)
- [x] Frontend modular (JS separado do HTML)
- [ ] RAG com embeddings vetoriais
- [ ] Dashboard admin com metricas
- [ ] Marketplace de plugins publico

---

<div align="center">

**System Clow** — Construido para quem precisa de um agente AI que realmente executa.

*67.400+ linhas de TypeScript . 14 subsistemas . 17 ferramentas . Memoria persistente . Testes + Observabilidade . Producao 24/7*

</div>
