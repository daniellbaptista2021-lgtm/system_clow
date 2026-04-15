<div align="center">

<img src="public/assets/logo-new.png" width="400" alt="System Clow">

# System Clow

**Agente de codigo AI de nivel enterprise — com paridade arquitetural ao Claude Code**

[![TypeScript](https://img.shields.io/badge/TypeScript-64.7K_linhas-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-22+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Status](https://img.shields.io/badge/Status-Producao-brightgreen)](#)

*Inteligencia Infinita . Possibilidades Premium*

</div>

---

## O que e o System Clow?

System Clow e um **agente de codigo AI completo** que executa tarefas de engenharia de software de forma autonoma — le arquivos, escreve codigo, executa comandos, navega na web, cria documentos, gerencia projetos e orquestra sub-agentes — tudo via chat, terminal ou API.

Construido com **paridade arquitetural ao Claude Code**, o System Clow implementa os mesmos 13 subsistemas em **64.700+ linhas de TypeScript**, rodando como produto SaaS multi-tenant pronto para producao.

## Por que System Clow?

| | Claude Code | ChatGPT | System Clow |
|---|---|---|---|
| **Executa codigo** | Sim | Nao | Sim |
| **Le/edita arquivos** | Sim | Nao | Sim |
| **Sub-agentes** | Sim | Nao | Sim |
| **Plugins** | Sim | Sim | Sim |
| **Multi-tenant SaaS** | Nao | Nao | Sim |
| **Auto-hospedado** | Nao | Nao | Sim |
| **Multi-modelo** | Nao | Nao | Sim (Claude, GPT, DeepSeek) |
| **WhatsApp** | Nao | Nao | Sim |
| **PWA Mobile** | Nao | Nao | Sim |
| **Custo** | $20/mes fixo | $20/mes fixo | Seu servidor, seus custos |

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

## 13 Subsistemas Integrados

```
src/
  plugins/        18.194 linhas  Plugin system completo com marketplace
  hooks/           5.261 linhas  Pre/Post tool hooks (20+ eventos)
  session/         5.557 linhas  Persistencia JSONL append-only
  bridge/          5.502 linhas  Remote control via SSE/WebSocket
  swarm/           5.170 linhas  Multi-agent com file-based mailbox
  query/           3.373 linhas  Query engine com budget enforcement
  tools/           3.565 linhas  17 ferramentas com Zod schemas
  compact/         3.320 linhas  3-tier compaction (micro/session/full)
  skills/          2.772 linhas  Auto-injecao por contexto (12 skills)
  coordinator/     1.960 linhas  Orchestracao de workers
  bootstrap/       1.892 linhas  Estado global singleton
  mcp/               615 linhas  Model Context Protocol client
  server/          5.290 linhas  HTTP API multi-tenant
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

- Autenticacao por API key e sessao admin
- Isolamento de workspace por tenant
- Quotas por plano (mensagens, custo, sessoes)
- Billing webhook para gateway de pagamento
- 4 tiers: Starter, Pro, Business, Enterprise

## Acesso Multiplataforma

- **Terminal** — CLI interativo com streaming e tool blocks visiveis
- **Web** — Interface responsiva com login, chat e downloads
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
                    Usuari
                  (CLI/Web/API)
                       |
                  Query Engine
                  (orquestrador)
                       |
         +-------------+-------------+
         |             |             |
      Tools         Hooks         Skills
    (17 nativas)   (20 evt)      (12 auto)
         |
      Providers
  Claude . GPT . DeepSeek . MCP
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

## Performance

| Metrica | Valor |
|---|---|
| Linhas de codigo | 64.739 |
| Arquivos TypeScript | 245 |
| Subsistemas | 13 |
| Ferramentas nativas | 17 |
| Skills auto-injetaveis | 12 |
| Eventos de hook | 20+ |
| Modelos suportados | 5+ |
| Paridade com Claude Code | ~95% |

## Stack Tecnica

| Componente | Tecnologia |
|---|---|
| Runtime | Node.js 22 + TypeScript 5 |
| CLI | Commander.js + REPL |
| Server | Hono + @hono/node-server |
| LLM | Anthropic SDK / OpenAI SDK |
| Protocolo | MCP (Model Context Protocol) |
| Persistencia | JSONL append-only |
| Auth | JWT + API keys |
| Process | PM2 |
| SSL | Let's Encrypt + Nginx |
| PWA | Service Worker + manifest.json |

## Roadmap

- [x] CLI interativo com streaming
- [x] 17 ferramentas nativas
- [x] Plugin system com marketplace
- [x] Hook system (20+ eventos)
- [x] Skill system com auto-injecao
- [x] Coordinator mode (multi-agent)
- [x] Swarm system (multi-processo)
- [x] Bridge system (remote control)
- [x] Multi-tenant SaaS
- [x] PWA mobile
- [x] Multi-modelo (Claude, GPT, DeepSeek)

---

<div align="center">

**System Clow** — Construido para quem precisa de um agente AI que realmente executa.

*64.700+ linhas de TypeScript . 13 subsistemas . 17 ferramentas . Producao 24/7*

</div>
