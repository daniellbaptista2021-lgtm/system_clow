#!/bin/bash
# audit-clow.sh — auditoria estrutural do Clow contra Claude Code
# Roda: bash audit-clow.sh > AUDIT_REPORT.md

set -e

SRC_DIR="${1:-./src}"
REPORT="AUDIT_REPORT.md"

echo "# Clow vs Claude Code — Audit Report" > $REPORT
echo "Generated: $(date)" >> $REPORT
echo "" >> $REPORT

# 1. Contagem de linhas por módulo
echo "## 1. Line Count Comparison" >> $REPORT
echo "" >> $REPORT
echo "| Module | Claude Code (lines) | Clow (lines) | Ratio |" >> $REPORT
echo "|--------|---------------------|--------------|-------|" >> $REPORT

count_lines_dir() {
  local dir="$1"
  if [ -d "$dir" ]; then
    find "$dir" -type f -name "*.ts" 2>/dev/null | xargs wc -l 2>/dev/null | tail -1 | awk '{print $1}'
  else
    echo "0"
  fi
}

count_lines_file() {
  local file="$1"
  if [ -f "$file" ]; then
    wc -l < "$file"
  else
    echo "0"
  fi
}

ratio() {
  local clow="$1"
  local cc="$2"
  if [ "$cc" -gt 0 ] 2>/dev/null; then
    echo "scale=2; $clow/$cc" | bc 2>/dev/null || echo "0"
  else
    echo "0"
  fi
}

CLOW_QE=$(count_lines_dir "$SRC_DIR/query")
echo "| Query Engine | 3026 | $CLOW_QE | $(ratio $CLOW_QE 3026) |" >> $REPORT

CLOW_TOOL_IF=$(count_lines_file "$SRC_DIR/tools/Tool.ts")
echo "| Tool Interface | 793 | $CLOW_TOOL_IF | $(ratio $CLOW_TOOL_IF 793) |" >> $REPORT

CLOW_TOOL_REG=$(count_lines_file "$SRC_DIR/tools/tools.ts")
echo "| Tool Registry | 390 | $CLOW_TOOL_REG | $(ratio $CLOW_TOOL_REG 390) |" >> $REPORT

CLOW_BASH=$(count_lines_dir "$SRC_DIR/tools/BashTool")
echo "| Bash Tool | 1144 | $CLOW_BASH | $(ratio $CLOW_BASH 1144) |" >> $REPORT

CLOW_PERM=$(count_lines_file "$SRC_DIR/utils/permissions/permissions.ts")
echo "| Permissions | 1487 | $CLOW_PERM | $(ratio $CLOW_PERM 1487) |" >> $REPORT

CLOW_SESS=$(count_lines_dir "$SRC_DIR/utils/session")
echo "| Session Storage | 5106 | $CLOW_SESS | $(ratio $CLOW_SESS 5106) |" >> $REPORT

CLOW_COMPACT=$(count_lines_dir "$SRC_DIR/utils/compact")
echo "| Compact System | 3220 | $CLOW_COMPACT | $(ratio $CLOW_COMPACT 3220) |" >> $REPORT

CLOW_AGENT=$(count_lines_dir "$SRC_DIR/tools/AgentTool")
echo "| Agent Tool | 2500 | $CLOW_AGENT | $(ratio $CLOW_AGENT 2500) |" >> $REPORT

CLOW_MCP=$(count_lines_dir "$SRC_DIR/mcp")
echo "| MCP Client | 1000 | $CLOW_MCP | $(ratio $CLOW_MCP 1000) |" >> $REPORT

CLOW_CTX=$(count_lines_dir "$SRC_DIR/utils/context")
echo "| Context Assembly | 800 | $CLOW_CTX | $(ratio $CLOW_CTX 800) |" >> $REPORT

CLOW_RETRY=$(count_lines_dir "$SRC_DIR/utils/retry")
echo "| Retry/Recovery | 200 | $CLOW_RETRY | $(ratio $CLOW_RETRY 200) |" >> $REPORT

CLOW_SERVER=$(count_lines_dir "$SRC_DIR/server")
echo "| HTTP Server | 500 | $CLOW_SERVER | $(ratio $CLOW_SERVER 500) |" >> $REPORT

CLOW_ADAPTER=$(count_lines_dir "$SRC_DIR/adapters")
echo "| WhatsApp Adapter | 0 | $CLOW_ADAPTER | N/A |" >> $REPORT

CLOW_TENANT=$(count_lines_dir "$SRC_DIR/tenancy")
echo "| Multi-Tenant | 0 | $CLOW_TENANT | N/A |" >> $REPORT

CLOW_API=$(count_lines_dir "$SRC_DIR/api")
echo "| Anthropic Client | 0 | $CLOW_API | N/A |" >> $REPORT

CLOW_BOOT=$(count_lines_dir "$SRC_DIR/bootstrap")
echo "| Bootstrap State | 1759 | $CLOW_BOOT | $(ratio $CLOW_BOOT 1759) |" >> $REPORT

# Total
CLOW_TOTAL=$(find "$SRC_DIR" -name "*.ts" -type f 2>/dev/null | xargs wc -l 2>/dev/null | tail -1 | awk '{print $1}')
echo "| **TOTAL** | ~50000 | **$CLOW_TOTAL** | $(ratio $CLOW_TOTAL 50000) |" >> $REPORT

echo "" >> $REPORT

# 2. Feature checklist
echo "## 2. Feature Coverage Checklist" >> $REPORT
echo "" >> $REPORT

check_feature() {
  local feature="$1"
  local label="${2:-$1}"
  local found=$(grep -r "$feature" "$SRC_DIR" --include="*.ts" -l 2>/dev/null | head -1)
  if [ -n "$found" ]; then
    echo "- [x] **$label** → \`$(echo $found | sed "s|$SRC_DIR/||")\`" >> $REPORT
  else
    echo "- [ ] **$label** → MISSING" >> $REPORT
  fi
}

echo "### Query Engine (doc 01)" >> $REPORT
check_feature "submitMessage" "submitMessage lifecycle"
check_feature "while.*true" "while(true) query loop"
check_feature "maxBudgetUsd" "USD budget enforcement"
check_feature "maxTurns" "Turn budget enforcement"
check_feature "MAX_OUTPUT_TOKENS_RECOVERY" "Max output recovery (3x)"
check_feature "FallbackTriggeredError" "Fallback model on error"
check_feature "tombstone" "Tombstone messages"
check_feature "applyToolResultBudget" "Tool result budget"
check_feature "StreamingToolExecutor" "Streaming tool executor"
check_feature "errorLogWatermark" "Error log watermark"
check_feature "permissionDenials" "Permission denial tracking"
check_feature "AsyncGenerator" "AsyncGenerator communication"
check_feature "mutableMessages" "Mutable state + immutable snapshots"

echo "" >> $REPORT
echo "### Tool System (doc 02)" >> $REPORT
check_feature "buildTool" "buildTool() factory"
check_feature "isReadOnly" "isReadOnly flag"
check_feature "isConcurrencySafe" "isConcurrencySafe flag"
check_feature "isDestructive" "isDestructive flag"
check_feature "checkPermissions" "checkPermissions method"
check_feature "inputSchema" "Zod inputSchema"
check_feature "filterToolsByDenyRules" "Deny rules filter"
check_feature "searchHint" "ToolSearch searchHint"
check_feature "shouldDefer" "Deferred loading"
check_feature "preparePermissionMatcher" "Permission matcher closure"
check_feature "interruptBehavior" "Interrupt behavior"
check_feature "renderToolUseMessage" "React UI rendering"

echo "" >> $REPORT
echo "### Bash Engine (doc 06)" >> $REPORT
check_feature "findShell" "Shell discovery (bash/zsh)"
check_feature "isReadOnlyCommand" "Read-only command classification"
check_feature "BASH_SEARCH_COMMANDS" "Search command set"
check_feature "BASH_SILENT_COMMANDS" "Silent command set"
check_feature "runShellCommand" "runShellCommand generator"
check_feature "run_in_background" "Background execution"
check_feature "sandboxManager" "OS sandbox (seatbelt/bwrap)"
check_feature "shellSnapshot" "Shell snapshot"
check_feature "extglob" "ExtGlob security disable"
check_feature "claudeCodeHints" "Claude Code Hints protocol"
check_feature "O_NOFOLLOW" "Anti-symlink protection"
check_feature "bareGitRepo" "Bare git repo attack prevention"

echo "" >> $REPORT
echo "### Permissions (doc 07)" >> $REPORT
check_feature "hasPermission" "Permission pipeline function"
check_feature "behavior.*allow" "Allow behavior"
check_feature "behavior.*deny" "Deny behavior"
check_feature "behavior.*ask" "Ask behavior"
check_feature "behavior.*passthrough" "Passthrough behavior"
check_feature "bypassPermissions" "Bypass mode"
check_feature "dontAsk" "DontAsk mode"
check_feature "acceptEdits" "AcceptEdits mode"
check_feature "PLAN_MODE_ALLOWED" "Plan mode tool whitelist"
check_feature "promptUserForPermission" "Interactive permission prompt"
check_feature "consecutiveDenials" "Denial tracking"
check_feature "DENIAL_LIMITS" "Denial circuit breaker"
check_feature "classifierDecision" "YOLO classifier"
check_feature "shadowedRuleDetection" "Shadowed rule detection"

echo "" >> $REPORT
echo "### Session Persistence (doc 09)" >> $REPORT
check_feature "appendEntry" "Append-only write"
check_feature "JSONL\|jsonl" "JSONL format"
check_feature "drainWriteQueue" "Async write queue"
check_feature "flushSession" "Flush on shutdown"
check_feature "loadTranscriptFile" "Transcript loading"
check_feature "listSessions" "Session listing"
check_feature "acquireSessionLock" "Session lockfile"
check_feature "parentUuid" "Parent UUID chain"
check_feature "buildConversationChain" "Chain walk reconstruction"
check_feature "detectTurnInterruption" "Interruption detection"
check_feature "preservedSegment" "Preserved segments"
check_feature "reAppendSessionMetadata" "Re-append metadata to tail"

echo "" >> $REPORT
echo "### Compact System (doc 11)" >> $REPORT
check_feature "shouldAutoCompact" "Auto-compact trigger"
check_feature "estimateMessageTokens" "Token estimation"
check_feature "compactConversation" "Full compact"
check_feature "circuitBroken\|CONSECUTIVE_FAILURES" "Circuit breaker"
check_feature "MAX_PTL_RETRIES\|PROMPT_TOO_LONG" "PTL retry"
check_feature "stripAnalysisScratchpad" "Strip analysis scratchpad"
check_feature "adjustForAPIInvariants" "API invariant preservation"
check_feature "microcompact\|MicroCompact" "MicroCompact tier"
check_feature "sessionMemoryCompact\|SessionMemory" "Session memory compact tier"
check_feature "COMPACTABLE_TOOLS" "Compactable tool list"
check_feature "POST_COMPACT_MAX_FILES" "Post-compact file restoration"
check_feature "groupMessagesByApiRound" "Message grouping by API round"

echo "" >> $REPORT
echo "### Context Assembly (doc 10)" >> $REPORT
check_feature "getSystemPrompt" "System prompt builder"
check_feature "getDynamicContext" "Dynamic context (separated)"
check_feature "assembleFullContext" "Full context assembly"
check_feature "getMemoryPrompt\|loadMemoryFiles" "Memory files (CLOW.md)"
check_feature "getGitStatus" "Git status memoized"
check_feature "DYNAMIC_BOUNDARY\|_staticPromptCache" "Cache boundary"
check_feature "getAttachments" "Per-turn attachments"
check_feature "analyzeContext" "/context command"
check_feature "additionalWorkingDirectories" "Additional working dirs"

echo "" >> $REPORT
echo "### Coordinator (doc 03)" >> $REPORT
check_feature "isCoordinatorMode" "Coordinator mode detection"
check_feature "task-notification" "XML task notifications"
check_feature "getCoordinatorUserContext" "Coordinator user context"
check_feature "INTERNAL_WORKER_TOOLS" "Internal worker tool filter"
check_feature "scratchpadDir" "Scratchpad directory"
check_feature "forkSubagent" "Fork subagent optimization"

echo "" >> $REPORT
echo "### Agent System (doc 08)" >> $REPORT
check_feature "AgentTool" "AgentTool"
check_feature "SubagentType\|subagent_type" "Subagent types"
check_feature "MAX_AGENT_DEPTH" "Anti-recursion depth limit"
check_feature "RESEARCHER_TOOLS" "Researcher tool restriction"
check_feature "getSubagentPrompt" "Subagent prompts"
check_feature "spawnMultiAgent" "Multi-agent spawn"
check_feature "teammateMailbox" "Teammate mailbox (file IPC)"
check_feature "TeamCreateTool" "Team create tool"
check_feature "tmuxBackend\|TmuxBackend" "Tmux backend"
check_feature "InProcessBackend" "In-process backend"

echo "" >> $REPORT
echo "### Hook System (doc 05)" >> $REPORT
check_feature "PreToolUse" "PreToolUse hook"
check_feature "PostToolUse" "PostToolUse hook"
check_feature "SessionStart" "SessionStart hook"
check_feature "hookJSONOutputSchema" "Hook JSON protocol"
check_feature "asyncRewake" "Async re-wake hooks"
check_feature "aggregateHookResults" "Hook result aggregation"
check_feature "shouldSkipHookDueToTrust" "Workspace trust check"
check_feature "HOOK_EXIT_CODE" "Exit code convention"

echo "" >> $REPORT
echo "### Plugin System (doc 04)" >> $REPORT
check_feature "pluginLoader" "Plugin loader"
check_feature "pluginManifest\|plugin.json" "Plugin manifest"
check_feature "marketplaceManager" "Marketplace manager"
check_feature "pluginBlocklist" "Plugin blocklist"
check_feature "dependencyResolver" "Dependency resolver"
check_feature "zipCache" "Zip cache"

echo "" >> $REPORT
echo "### Bridge System (doc 13)" >> $REPORT
check_feature "bridgeMain" "Standalone bridge"
check_feature "replBridge" "REPL bridge"
check_feature "pollForWork" "Poll-dispatch loop"
check_feature "FlushGate" "FlushGate ordering"
check_feature "workerEpoch" "Epoch conflict resolution"

echo "" >> $REPORT
echo "### Startup (doc 12)" >> $REPORT
check_feature "preconnectAnthropicApi\|preconnect" "API preconnection"
check_feature "startupProfiler\|profileCheckpoint" "Startup profiler"
check_feature "earlyInput\|startCapturingEarlyInput" "Early input capture"
check_feature "eagerLoadSettings" "Eager settings load"
check_feature "ABLATION_BASELINE" "Ablation baseline"
check_feature "DAG.*leaf\|bootstrap.*isolation" "DAG leaf pattern"

echo "" >> $REPORT
echo "### Clow Additions (not in Claude Code)" >> $REPORT
check_feature "AnthropicConfig\|initAnthropic" "Anthropic Claude integration"
check_feature "PRICING\|input_hit\|input_miss" "Cache-aware pricing"
check_feature "CacheMetrics\|cacheHitRate" "Cache metrics tracking"
check_feature "getSessionCacheMetrics" "Session cache aggregation"
check_feature "MCPClient\|MCPManager" "MCP Client (JSON-RPC stdio)"
check_feature "adaptMCPTool" "MCP Tool adapter"
check_feature "WebFetchTool" "WebFetch tool"
check_feature "WebSearchTool" "WebSearch tool (Brave)"
check_feature "BLOCKED_HOST_PATTERNS\|isBlockedHost" "SSRF protection"
check_feature "sendWhatsAppMessage\|ZAPI" "WhatsApp Z-API adapter"
check_feature "SessionPool" "HTTP session pool with TTL"
check_feature "streamSSE" "SSE streaming API"
check_feature "tenantAuth" "Multi-tenant auth middleware"
check_feature "TierName\|TIERS" "SaaS tier system"
check_feature "PathEscapeError\|validatePath" "Workspace path isolation"
check_feature "checkQuota" "Quota enforcement"
check_feature "buildBillingRoutes\|asaas" "Billing webhook (Asaas)"
check_feature "EnterPlanModeTool" "Plan mode"
check_feature "ExitPlanModeTool" "Plan exit with approval"
check_feature "withRetry" "Retry with exponential backoff"
check_feature "classifyError" "Error classification"
check_feature "isContextOverflow" "Reactive compact on overflow"
check_feature "Dockerfile" "Docker deployment"

echo "" >> $REPORT

# 3. File inventory
echo "## 3. File Inventory" >> $REPORT
echo "" >> $REPORT
echo '```' >> $REPORT
find "$SRC_DIR" -name "*.ts" -type f | sort | while read f; do
  lines=$(wc -l < "$f")
  echo "  $lines  $f"
done >> $REPORT
echo '```' >> $REPORT

echo "" >> $REPORT

# 4. Total summary
echo "## 4. Summary" >> $REPORT
echo "" >> $REPORT
TOTAL_FILES=$(find "$SRC_DIR" -name "*.ts" -type f | wc -l)
echo "- **Total files:** $TOTAL_FILES" >> $REPORT
echo "- **Total lines:** $CLOW_TOTAL" >> $REPORT
echo "- **Tools registered:** $(grep -c 'Tool\b' "$SRC_DIR/tools/tools.ts" 2>/dev/null || echo 0) entries" >> $REPORT
echo "" >> $REPORT

echo ""
echo "✅ Audit complete. Read $REPORT"
