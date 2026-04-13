# System Clow

[English README](README.md) | Portugu?s

System Clow ? um agente de c?digo em TypeScript/Node.js com CLI, servidor HTTP, suporte a MCP, runtime de plugins, modo coordinator, bridge e ferramentas de swarm.

O projeto foi desenhado para funcionar como um assistente de c?digo pr?tico, com uma base mais modular e mais compacta do que runtimes maiores, sem abrir m?o de fluxos reais como uso de ferramentas, subagentes, controle remoto e opera??o multi-tenant.

## Estado Atual

O System Clow est? operante.

Validado em runtime:
- execu??o via CLI e `--print`
- servidor HTTP e persist?ncia de sess?o
- resume e reidrata??o de sess?o
- execu??o de tools: `Read`, `Write`, `Edit`, `Glob`, `Grep`, `Bash`, `WebFetch`, `TodoWrite`
- tool de subagente `Agent`
- modo `Coordinator` no CLI e no servidor
- runtime de plugins: commands, hooks, skills, servidores MCP, tools e output styles
- Bridge API e `clow bridge`
- controle remoto via REPL bridge
- tools de swarm e prompts de permiss?o
- enforcement de quota multi-tenant e isolamento de workspace

## Principais Capacidades

- agente de c?digo interativo via CLI
- servidor HTTP para execu??o baseada em sess?o
- integra??o MCP com adapta??o din?mica de tools
- sistema de plugins com commands, hooks, skills, tools, styles e servidores MCP
- modo coordinator para fluxos estruturados de delega??o
- tools de swarm para fluxos multiagente em equipe
- bridge para execu??o remota e streaming de eventos
- persist?ncia de sess?o em JSONL e recupera??o de transcript
- pipeline de permiss?o com aprova??es interativas
- autentica??o multi-tenant, quotas e path guards por workspace
- `Bash` multi-tenant sandboxado com `bubblewrap` quando dispon?vel

## Estrutura do Projeto

```text
src/
  adapters/      Adaptadores externos
  api/           Clientes de modelo e streaming
  bootstrap/     Estado global de bootstrap/runtime
  bridge/        Runtime de bridge, session runner e controle remoto
  coordinator/   Modo coordinator e orquestra??o de workers
  hooks/         Hook engine e dispatcher
  mcp/           MCP manager, client e adapters
  plugins/       Descoberta, carregamento e runtime de plugins
  query/         QueryEngine central e estado de mensagens
  server/        API HTTP, session pool e middlewares
  skills/        Skill engine e suporte a skills embutidas
  swarm/         Team, mailbox, runtime tools e spawning
  tenancy/       Path guards, tiers, quotas e tenant store
  tools/         Tools nativas e registry de tools
  utils/         Contexto, compacta??o, retry, permiss?es e sess?es
```

## Requisitos

- Node.js 20+
- npm 10+
- Linux recomendado para produ??o
- `bubblewrap` recomendado para shell multi-tenant sandboxado

## Instala??o

```bash
npm install
npm run typecheck
npm run build
```

## Execu??o

### CLI

```bash
npm run start
```

CLI em desenvolvimento:

```bash
npm run dev
```

Modo print:

```bash
node dist/cli.js --print "Say exactly OK"
```

### Servidor HTTP

```bash
npm run server
```

Servidor em desenvolvimento:

```bash
npm run dev:server
```

Health check:

```bash
curl http://127.0.0.1:3001/health
```

### Bridge

```bash
node dist/cli.js bridge --endpoint http://127.0.0.1:3001 --api-key SUA_CHAVE
```

## Ambiente

Vari?veis de ambiente principais usadas pelo projeto:

```bash
OPENAI_API_KEY=
DEEPSEEK_API_KEY=
PORT=3001
CLOW_ADMIN_KEY=
JWT_SECRET=
```

Dependendo dos recursos ativados, voc? tamb?m pode precisar de configura??o de tenant, billing ou adaptadores externos.

## Tools Nativas

As tools principais dispon?veis no runtime incluem:

- `Read`
- `Write`
- `Edit`
- `Glob`
- `Grep`
- `Bash`
- `WebFetch`
- `WebSearch`
- `TodoWrite`
- `Agent`
- `EnterPlanMode`
- `ExitPlanMode`
- tools de swarm: `TeamCreate`, `TeamDelete`, `ListPeers`, `SendMessage`, `TeammateIdle`

A disponibilidade das tools pode ser filtrada por modo de permiss?o, tier, tenant, modo de runtime ou configura??o do servidor.

## Permiss?es e Seguran?a

O System Clow inclui:

- prompts interativos de permiss?o
- regras allow/deny por sess?o
- restri??es de plan mode
- filtragem de tools por tier
- path guards por workspace
- enforcement de quota multi-tenant
- execu??o de shell sandboxada para fluxos multi-tenant no servidor

## Plugins e MCP

O runtime de plugins suporta:

- commands
- hooks
- skills
- tools
- output styles
- registro de servidores MCP

As tools MCP s?o adaptadas para o pool principal de tools e podem ser filtradas por tier ou regras de deny.

## Coordinator, Bridge e Swarm

### Coordinator

O modo coordinator reduz o toolset dispon?vel e encaminha delega??o estruturada por meio da tool `Agent` e de task notifications.

### Bridge

A stack de bridge suporta:
- registro de environment
- polling de work
- streaming de eventos
- cria??o de sess?o env-less
- entrega de prompt remoto

### Swarm

O swarm fornece tools de runtime para cria??o de times, lookup de peers, envio direto de mensagens e controle de estado de teammates.

## Pontos Ainda ?speros

O projeto est? operante, mas ainda tem alguns pontos n?o bloqueadores:

- logs de bootstrap ruidosos em alguns fluxos
- warning de deprecia??o relacionado a `punycode`
- warnings de plugin discovery podem aparecer dependendo do estado local dos plugins
- alguns caminhos avan?ados ainda precisam de mais cobertura de testes do que o core

## Fluxo de Desenvolvimento

```bash
npm run typecheck
npm run build
```

Smoke checks recomendados:

```bash
node dist/cli.js --print "Say exactly OK"
curl http://127.0.0.1:3001/health
```

## Licen?a

Ainda n?o existe arquivo de licen?a neste reposit?rio.
