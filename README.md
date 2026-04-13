# System Clow

English | [README em Portugu?s](README.pt-BR.md)

System Clow is a TypeScript/Node.js coding agent with CLI, HTTP server, MCP support, plugin runtime, coordinator mode, bridge transport, and swarm tooling.

The project is designed to run as a practical coding assistant with a smaller, more modular codebase than larger agent runtimes, while still supporting real execution flows such as tool use, subagents, remote control, and multi-tenant server operation.

## Current Status

System Clow is operational.

Validated in runtime:
- CLI and `--print` execution
- HTTP server and session persistence
- Resume and session rehydration
- Tool execution: `Read`, `Write`, `Edit`, `Glob`, `Grep`, `Bash`, `WebFetch`, `TodoWrite`
- `Agent` subagent tool
- `Coordinator` mode in CLI and server
- Plugin runtime: commands, hooks, skills, MCP servers, tools, output styles
- Bridge API and `clow bridge`
- Remote control via REPL bridge
- Swarm runtime tools and permission prompts
- Multi-tenant quota enforcement and workspace isolation

## Main Capabilities

- Interactive CLI coding agent
- HTTP server for session-based execution
- MCP integration with runtime tool adaptation
- Plugin system with runtime-loaded commands, hooks, skills, tools, styles, and MCP servers
- Coordinator mode for structured delegation flows
- Swarm tools for team-style multi-agent workflows
- Bridge transport for remote execution and event streaming
- JSONL-based session persistence and transcript recovery
- Permission pipeline with interactive approvals
- Multi-tenant auth, quotas, and workspace path guards
- Sandboxed multi-tenant `Bash` using `bubblewrap` when available

## Project Structure

```text
src/
  adapters/      External adapters
  api/           Model clients and streaming
  bootstrap/     Runtime global/bootstrap state
  bridge/        Bridge runtime, session runner, remote control
  coordinator/   Coordinator mode and worker orchestration
  hooks/         Hook engine and dispatcher
  mcp/           MCP manager, client, adapters
  plugins/       Plugin discovery, loading, runtime components
  query/         Core QueryEngine and message state
  server/        HTTP API, session pool, middleware
  skills/        Skill engine and built-in skill support
  swarm/         Team, mailbox, runtime tools, spawning
  tenancy/       Path guards, tiers, quotas, tenant store
  tools/         Built-in tools and tool registry
  utils/         Context, compact, retry, permissions, sessions
```

## Requirements

- Node.js 20+
- npm 10+
- Linux recommended for production
- `bubblewrap` recommended for sandboxed multi-tenant shell execution

## Installation

```bash
npm install
npm run typecheck
npm run build
```

## Running

### CLI

```bash
npm run start
```

Development CLI:

```bash
npm run dev
```

Print mode:

```bash
node dist/cli.js --print "Say exactly OK"
```

### HTTP Server

```bash
npm run server
```

Development server:

```bash
npm run dev:server
```

Health check:

```bash
curl http://127.0.0.1:3001/health
```

### Bridge

```bash
node dist/cli.js bridge --endpoint http://127.0.0.1:3001 --api-key YOUR_KEY
```

## Environment

Common environment variables used by the project:

```bash
OPENAI_API_KEY=
DEEPSEEK_API_KEY=
PORT=3001
CLOW_ADMIN_KEY=
JWT_SECRET=
```

Depending on the features you enable, you may also need tenant, billing, or external adapter configuration.

## Built-in Tools

Core tools available in the main runtime include:

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
- Swarm runtime tools: `TeamCreate`, `TeamDelete`, `ListPeers`, `SendMessage`, `TeammateIdle`

Tool availability may be filtered by permission mode, tier, tenant, runtime mode, or server configuration.

## Permissions and Safety

System Clow includes:

- interactive permission prompts
- allow/deny session rules
- plan mode restrictions
- tier-based tool filtering
- workspace path guards
- multi-tenant quota enforcement
- sandboxed shell execution for multi-tenant server flows

## Plugins and MCP

The plugin runtime supports:

- commands
- hooks
- skills
- tools
- output styles
- MCP server registration

MCP tools are adapted into the runtime tool pool and can be filtered by tier or deny rules.

## Coordinator, Bridge, and Swarm

### Coordinator

Coordinator mode narrows the toolset and routes structured delegation through the `Agent` tool and task notifications.

### Bridge

The bridge stack supports:
- environment registration
- work polling
- event streaming
- env-less session creation
- remote prompt delivery

### Swarm

Swarm provides runtime tools for team creation, peer lookup, direct messaging, and teammate state handling.

## Known Rough Edges

The project is operational, but still has some non-blocking rough edges:

- noisy bootstrap logs in some flows
- deprecation warning around `punycode`
- plugin discovery warnings may appear depending on local plugin state
- some advanced paths still need more test coverage than the core runtime

## Development Workflow

```bash
npm run typecheck
npm run build
```

Recommended smoke checks:

```bash
node dist/cli.js --print "Say exactly OK"
curl http://127.0.0.1:3001/health
```

## License

No license file is currently present in this repository.

