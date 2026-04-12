# Clow vs Claude Code — Audit Report
Generated: Sat Apr 11 14:13:24     2026

## 1. Line Count Comparison

| Module | Claude Code (lines) | Clow (lines) | Ratio |
|--------|---------------------|--------------|-------|
| Query Engine | 3026 | 489 | 0 |
| Tool Interface | 793 | 128 | 0 |
| Tool Registry | 390 | 93 | 0 |
| Bash Tool | 1144 | 277 | 0 |
| Permissions | 1487 | 248 | 0 |
| Session Storage | 5106 | 313 | 0 |
| Compact System | 3220 | 457 | 0 |
| Agent Tool | 2500 | 228 | 0 |
| MCP Client | 1000 | 612 | 0 |
| Context Assembly | 800 | 408 | 0 |
| Retry/Recovery | 200 | 195 | 0 |
| HTTP Server | 500 | 932 | 0 |
| WhatsApp Adapter | 0 | 360 | N/A |
| Multi-Tenant | 0 | 536 | N/A |
| DeepSeek Client | 0 | 500 | N/A |
| Bootstrap State | 1759 | 404 | 0 |
| **TOTAL** | ~50000 | **7868** | 0 |

## 2. Feature Coverage Checklist

### Query Engine (doc 01)
- [x] **submitMessage lifecycle** → `adapters/whatsapp.ts`
- [x] **while(true) query loop** → `query/QueryEngine.ts`
- [x] **USD budget enforcement** → `query/QueryEngine.ts`
- [x] **Turn budget enforcement** → `cli.ts`
- [x] **Max output recovery (3x)** → `query/QueryEngine.ts`
- [ ] **Fallback model on error** → MISSING
- [ ] **Tombstone messages** → MISSING
- [ ] **Tool result budget** → MISSING
- [ ] **Streaming tool executor** → MISSING
- [ ] **Error log watermark** → MISSING
- [ ] **Permission denial tracking** → MISSING
- [x] **AsyncGenerator communication** → `api/deepseek.ts`
- [x] **Mutable state + immutable snapshots** → `query/QueryEngine.ts`

### Tool System (doc 02)
- [x] **buildTool() factory** → `mcp/mcpToolAdapter.ts`
- [x] **isReadOnly flag** → `mcp/mcpToolAdapter.ts`
- [x] **isConcurrencySafe flag** → `mcp/mcpToolAdapter.ts`
- [x] **isDestructive flag** → `tools/Tool.ts`
- [x] **checkPermissions method** → `mcp/mcpToolAdapter.ts`
- [x] **Zod inputSchema** → `api/deepseek.ts`
- [x] **Deny rules filter** → `tools/AgentTool/AgentTool.ts`
- [x] **ToolSearch searchHint** → `tools/Tool.ts`
- [x] **Deferred loading** → `tools/Tool.ts`
- [x] **Permission matcher closure** → `tools/Tool.ts`
- [ ] **Interrupt behavior** → MISSING
- [ ] **React UI rendering** → MISSING

### Bash Engine (doc 06)
- [x] **Shell discovery (bash/zsh)** → `tools/BashTool/BashTool.ts`
- [x] **Read-only command classification** → `tools/BashTool/BashTool.ts`
- [x] **Search command set** → `tools/BashTool/BashTool.ts`
- [x] **Silent command set** → `tools/BashTool/BashTool.ts`
- [x] **runShellCommand generator** → `tools/BashTool/BashTool.ts`
- [ ] **Background execution** → MISSING
- [ ] **OS sandbox (seatbelt/bwrap)** → MISSING
- [ ] **Shell snapshot** → MISSING
- [ ] **ExtGlob security disable** → MISSING
- [ ] **Claude Code Hints protocol** → MISSING
- [ ] **Anti-symlink protection** → MISSING
- [ ] **Bare git repo attack prevention** → MISSING

### Permissions (doc 07)
- [x] **Permission pipeline function** → `utils/permissions/permissions.ts`
- [x] **Allow behavior** → `tools/BashTool/BashTool.ts`
- [x] **Deny behavior** → `query/QueryEngine.ts`
- [x] **Ask behavior** → `mcp/mcpToolAdapter.ts`
- [x] **Passthrough behavior** → `tools/Tool.ts`
- [x] **Bypass mode** → `bootstrap/state.ts`
- [x] **DontAsk mode** → `bootstrap/state.ts`
- [x] **AcceptEdits mode** → `bootstrap/state.ts`
- [x] **Plan mode tool whitelist** → `utils/permissions/permissions.ts`
- [x] **Interactive permission prompt** → `utils/permissions/permissions.ts`
- [x] **Denial tracking** → `utils/permissions/permissions.ts`
- [x] **Denial circuit breaker** → `utils/permissions/permissions.ts`
- [ ] **YOLO classifier** → MISSING
- [ ] **Shadowed rule detection** → MISSING

### Session Persistence (doc 09)
- [x] **Append-only write** → `utils/session/sessionStorage.ts`
- [x] **JSONL format** → `server/sessionPool.ts`
- [x] **Async write queue** → `utils/session/sessionStorage.ts`
- [x] **Flush on shutdown** → `cli.ts`
- [x] **Transcript loading** → `cli.ts`
- [x] **Session listing** → `cli.ts`
- [x] **Session lockfile** → `cli.ts`
- [x] **Parent UUID chain** → `query/QueryEngine.ts`
- [ ] **Chain walk reconstruction** → MISSING
- [ ] **Interruption detection** → MISSING
- [ ] **Preserved segments** → MISSING
- [ ] **Re-append metadata to tail** → MISSING

### Compact System (doc 11)
- [x] **Auto-compact trigger** → `query/QueryEngine.ts`
- [x] **Token estimation** → `utils/compact/autoCompact.ts`
- [x] **Full compact** → `query/QueryEngine.ts`
- [x] **Circuit breaker** → `utils/compact/autoCompact.ts`
- [x] **PTL retry** → `utils/compact/compact.ts`
- [x] **Strip analysis scratchpad** → `utils/compact/compact.ts`
- [x] **API invariant preservation** → `utils/compact/compact.ts`
- [ ] **MicroCompact tier** → MISSING
- [ ] **Session memory compact tier** → MISSING
- [ ] **Compactable tool list** → MISSING
- [ ] **Post-compact file restoration** → MISSING
- [ ] **Message grouping by API round** → MISSING

### Context Assembly (doc 10)
- [x] **System prompt builder** → `utils/context/context.ts`
- [x] **Dynamic context (separated)** → `cli.ts`
- [x] **Full context assembly** → `cli.ts`
- [x] **Memory files (CLOW.md)** → `utils/context/context.ts`
- [x] **Git status memoized** → `cli.ts`
- [x] **Cache boundary** → `utils/context/context.ts`
- [ ] **Per-turn attachments** → MISSING
- [ ] **/context command** → MISSING
- [ ] **Additional working dirs** → MISSING

### Coordinator (doc 03)
- [ ] **Coordinator mode detection** → MISSING
- [ ] **XML task notifications** → MISSING
- [ ] **Coordinator user context** → MISSING
- [ ] **Internal worker tool filter** → MISSING
- [ ] **Scratchpad directory** → MISSING
- [ ] **Fork subagent optimization** → MISSING

### Agent System (doc 08)
- [x] **AgentTool** → `query/QueryEngine.ts`
- [x] **Subagent types** → `tools/AgentTool/AgentTool.ts`
- [x] **Anti-recursion depth limit** → `query/QueryEngine.ts`
- [x] **Researcher tool restriction** → `tools/AgentTool/AgentTool.ts`
- [x] **Subagent prompts** → `tools/AgentTool/AgentTool.ts`
- [ ] **Multi-agent spawn** → MISSING
- [ ] **Teammate mailbox (file IPC)** → MISSING
- [ ] **Team create tool** → MISSING
- [ ] **Tmux backend** → MISSING
- [ ] **In-process backend** → MISSING

### Hook System (doc 05)
- [ ] **PreToolUse hook** → MISSING
- [ ] **PostToolUse hook** → MISSING
- [ ] **SessionStart hook** → MISSING
- [ ] **Hook JSON protocol** → MISSING
- [ ] **Async re-wake hooks** → MISSING
- [ ] **Hook result aggregation** → MISSING
- [ ] **Workspace trust check** → MISSING
- [ ] **Exit code convention** → MISSING

### Plugin System (doc 04)
- [ ] **Plugin loader** → MISSING
- [ ] **Plugin manifest** → MISSING
- [ ] **Marketplace manager** → MISSING
- [ ] **Plugin blocklist** → MISSING
- [ ] **Dependency resolver** → MISSING
- [ ] **Zip cache** → MISSING

### Bridge System (doc 13)
- [ ] **Standalone bridge** → MISSING
- [ ] **REPL bridge** → MISSING
- [ ] **Poll-dispatch loop** → MISSING
- [ ] **FlushGate ordering** → MISSING
- [ ] **Epoch conflict resolution** → MISSING

### Startup (doc 12)
- [ ] **API preconnection** → MISSING
- [ ] **Startup profiler** → MISSING
- [ ] **Early input capture** → MISSING
- [ ] **Eager settings load** → MISSING
- [ ] **Ablation baseline** → MISSING
- [ ] **DAG leaf pattern** → MISSING

### Clow Additions (not in Claude Code)
- [x] **DeepSeek V3.2 integration** → `api/deepseek.ts`
- [x] **Cache-aware pricing** → `api/deepseek.ts`
- [x] **Cache metrics tracking** → `api/deepseek.ts`
- [x] **Session cache aggregation** → `api/deepseek.ts`
- [x] **MCP Client (JSON-RPC stdio)** → `cli.ts`
- [x] **MCP Tool adapter** → `mcp/mcpToolAdapter.ts`
- [x] **WebFetch tool** → `tools/tools.ts`
- [x] **WebSearch tool (Brave)** → `tools/tools.ts`
- [x] **SSRF protection** → `tools/WebFetchTool/WebFetchTool.ts`
- [x] **WhatsApp Z-API adapter** → `adapters/whatsapp.ts`
- [x] **HTTP session pool with TTL** → `adapters/whatsapp.ts`
- [x] **SSE streaming API** → `server/routes.ts`
- [x] **Multi-tenant auth middleware** → `server/adminRoutes.ts`
- [x] **SaaS tier system** → `server/adminRoutes.ts`
- [x] **Workspace path isolation** → `tenancy/pathGuard.ts`
- [x] **Quota enforcement** → `tenancy/quotaGuard.ts`
- [x] **Billing webhook (Asaas)** → `server/adminRoutes.ts`
- [x] **Plan mode** → `tools/EnterPlanModeTool/EnterPlanModeTool.ts`
- [x] **Plan exit with approval** → `tools/ExitPlanModeTool/ExitPlanModeTool.ts`
- [x] **Retry with exponential backoff** → `api/deepseek.ts`
- [x] **Error classification** → `query/QueryEngine.ts`
- [x] **Reactive compact on overflow** → `utils/retry/retry.ts`
- [ ] **Docker deployment** → MISSING

## 3. File Inventory

```
  360  ./src/adapters/whatsapp.ts
  500  ./src/api/deepseek.ts
  404  ./src/bootstrap/state.ts
  497  ./src/cli.ts
  294  ./src/mcp/MCPClient.ts
  185  ./src/mcp/MCPManager.ts
  133  ./src/mcp/mcpToolAdapter.ts
  489  ./src/query/QueryEngine.ts
  219  ./src/server/adminRoutes.ts
  99  ./src/server/middleware/tenantAuth.ts
  235  ./src/server/routes.ts
  135  ./src/server/server.ts
  244  ./src/server/sessionPool.ts
  68  ./src/tenancy/pathGuard.ts
  90  ./src/tenancy/quotaGuard.ts
  309  ./src/tenancy/tenantStore.ts
  69  ./src/tenancy/tiers.ts
  228  ./src/tools/AgentTool/AgentTool.ts
  277  ./src/tools/BashTool/BashTool.ts
  58  ./src/tools/EnterPlanModeTool/EnterPlanModeTool.ts
  137  ./src/tools/ExitPlanModeTool/ExitPlanModeTool.ts
  112  ./src/tools/FileEditTool/FileEditTool.ts
  89  ./src/tools/FileReadTool/FileReadTool.ts
  61  ./src/tools/FileWriteTool/FileWriteTool.ts
  81  ./src/tools/GlobTool/GlobTool.ts
  150  ./src/tools/GrepTool/GrepTool.ts
  68  ./src/tools/TodoWriteTool/TodoWriteTool.ts
  128  ./src/tools/Tool.ts
  242  ./src/tools/WebFetchTool/WebFetchTool.ts
  193  ./src/tools/WebSearchTool/WebSearchTool.ts
  93  ./src/tools/tools.ts
  162  ./src/utils/compact/autoCompact.ts
  295  ./src/utils/compact/compact.ts
  296  ./src/utils/context/context.ts
  112  ./src/utils/context/subagentPrompts.ts
  248  ./src/utils/permissions/permissions.ts
  195  ./src/utils/retry/retry.ts
  313  ./src/utils/session/sessionStorage.ts
```

## 4. Summary

- **Total files:** 38
- **Total lines:** 7868
- **Tools registered:** 28 entries

