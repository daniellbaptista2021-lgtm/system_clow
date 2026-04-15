/**
 * sessionPool.ts — In-Memory QueryEngine Pool with TTL + Disk Rehydration
 *
 * Manages QueryEngine instances. Expensive to create, cached in memory.
 * On TTL expiry: JSONL on disk survives (Passo 6). Next request rehydrates.
 * Cleanup runs every 5 minutes.
 */

import { QueryEngine } from '../query/QueryEngine.js';
import { HookEngine } from '../hooks/HookEngine.js';
import { HookEventDispatcher } from '../hooks/HookEventDispatcher.js';
import { initMemorySystem } from '../memory/index.js';
import { PluginSystem } from '../plugins/PluginSystem.js';
import { SkillEngine } from '../skills/SkillEngine.js';
import { buildPluginRuntimeTools } from '../plugins/components/PluginRuntimeTools.js';
import { buildPluginRuntimeOutputStyles } from '../plugins/components/PluginRuntimeOutputStyles.js';
import { AgentTool } from '../tools/AgentTool/AgentTool.js';
import { CoordinatorMode } from '../coordinator/CoordinatorMode.js';
import { DEFAULT_COORDINATOR_CONFIG } from '../coordinator/types.js';
import { getTools } from '../tools/tools.js';
import { assembleFullContext } from '../utils/context/context.js';
import { createCanUseTool, type LegacyPermissionContext } from '../utils/permissions/permissions.js';
import { filterToolsForTier } from '../tenancy/quotaGuard.js';
import { registerSession, unregisterSession } from '../tenancy/tenantStore.js';
import {
  loadTranscriptFile,
  getSessionCwdFromEntries,
  getSessionFilePath,
  saveSessionMetadataForSession,
} from '../utils/session/sessionStorage.js';
import type { ClovMessage } from '../api/anthropic.js';
import type { MCPManager } from '../mcp/MCPManager.js';
import * as fs from 'fs';

// ─── Types ──────────────────────────────────────────────────────────────────

interface PoolEntry {
  engine: QueryEngine;
  lastAccess: number;
  cwd: string;
  workspaceRoot: string;
  tenantId?: string;
  mode: string;
  createdAt: number;
  messageCount: number;
}

export interface CreateSessionOptions {
  cwd?: string;
  workspaceRoot?: string;
  tenantId?: string;
  tenantTier?: string;
  mode?: 'server' | 'coordinator';
  maxTurns?: number;
  maxBudgetUsd?: number;
  systemPromptOverride?: string;
  persistSessionStart?: boolean;
  isAdmin?: boolean;
}

function getSessionModeFromEntries(entries: any[], fallback: 'server' | 'coordinator' = 'server'): 'server' | 'coordinator' {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.type === 'session_start' && entry.value && typeof entry.value === 'object') {
      const mode = (entry.value as Record<string, unknown>).mode;
      if (mode === 'coordinator' || mode === 'server') {
        return mode;
      }
    }
  }
  return fallback;
}

function transcriptEntriesToApiMessages(entries: any[]): ClovMessage[] {
  return entries.reduce<ClovMessage[]>((messages, entry) => {
    if (entry?.role === 'assistant' && typeof entry.content === 'string') {
      messages.push({ role: 'assistant', content: entry.content });
      return messages;
    }

    if (entry?.role === 'user' && typeof entry.content === 'string') {
      messages.push({ role: 'user', content: entry.content });
      return messages;
    }

    if (entry?.role === 'tool' && typeof entry.content === 'string') {
      const toolCallId = typeof entry.tool_call_id === 'string'
        ? entry.tool_call_id
        : typeof entry.toolCallId === 'string'
          ? entry.toolCallId
          : undefined;

      if (toolCallId) {
        messages.push({ role: 'tool', content: entry.content, tool_call_id: toolCallId });
      }
    }

    return messages;
  }, []);
}

// ─── The Pool ───────────────────────────────────────────────────────────────

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 min
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 min

export class SessionPool {
  private engines = new Map<string, PoolEntry>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private mcpManager: MCPManager | null = null;

  constructor(mcpManager?: MCPManager) {
    this.mcpManager = mcpManager || null;
    this.startCleanup();
  }

  // ─── Create ─────────────────────────────────────────────────────────

  async create(
    sessionId: string,
    options: CreateSessionOptions = {},
  ): Promise<QueryEngine> {
    const cwd = options.cwd || process.cwd();
    const workspaceRoot = options.workspaceRoot || cwd;
    const tenantId = options.tenantId;
    const tenantTier = options.tenantTier;
    const mode = options.mode || 'server';
    const baseToolPool = tenantTier
      ? filterToolsForTier(getTools(undefined, this.mcpManager || undefined), tenantTier)
      : getTools(undefined, this.mcpManager || undefined);
    // Plan-mode approval depends on interactive stdin/stdout, which does not exist
    // for HTTP/SSE sessions. Excluding these tools prevents dead-end loops in the web UI.
    const baseTools = baseToolPool.filter((tool) => (
      tool.name !== 'EnterPlanMode' && tool.name !== 'ExitPlanMode'
    ));
    const pluginSystem = new PluginSystem();
    await pluginSystem.initialize(workspaceRoot);
    const pluginRuntimeTools = await buildPluginRuntimeTools(pluginSystem);
    const pluginOutputStyles = await buildPluginRuntimeOutputStyles(pluginSystem);
    const fullTools = [...baseTools, ...pluginRuntimeTools];
    let tools = fullTools;
    let coordinatorMode: CoordinatorMode | undefined;
    if (mode === 'coordinator') {
      const coordinatorExecutor = {
        execute: async (params: {
          description: string;
          prompt: string;
          subagent_type: string;
          budgetUsd: number;
          maxTurns: number;
          allowedTools: string[];
        }) => {
          const result = await AgentTool.call({
            description: params.description,
            prompt: params.prompt,
            subagent_type: params.subagent_type as any,
            budgetUsd: params.budgetUsd,
            maxTurns: params.maxTurns,
            allowedTools: params.allowedTools,
          }, {
            cwd,
            sessionId,
            workspaceRoot,
            tenantId,
            permissionMode: 'default',
            options: { tools: fullTools },
            depth: 0,
          }, async () => ({ behavior: 'allow' as const }), `server-coordinator:${params.description}`);

          const output = (result.output || {}) as any;
          return {
            success: !result.isError,
            result: typeof output.result === 'string' ? output.result : result.outputText,
            tokensUsed: Number(output.tokens_used || 0),
            costUsd: Number(output.cost_usd || 0),
            toolUseCount: 0,
          };
        },
      };

      coordinatorMode = new CoordinatorMode({
        ...DEFAULT_COORDINATOR_CONFIG,
        enabled: true,
        scratchpadDir: `${workspaceRoot}/.clow/scratchpad`,
      }, coordinatorExecutor);
      await coordinatorMode.initialize();
      tools = coordinatorMode.filterCoordinatorTools(fullTools) as typeof fullTools;
    }

    const toolRegistry = new Map(tools.map((tool) => [tool.name, tool]));
    const hookEngine = new HookEngine({
      toolRegistry,
      spawnSubagent: async () => 'ok',
    });
    await hookEngine.initialize(workspaceRoot, false);
    for (const pluginHook of pluginSystem.getHooks()) {
      hookEngine.addHook(pluginHook);
    }
    // Initialize persistent memory hooks (SQLite-backed)
    await initMemorySystem(hookEngine, tenantId || 'default');
    const hookDispatcher = new HookEventDispatcher(hookEngine, {
      sessionId,
      transcriptPath: getSessionFilePath(sessionId),
      cwd,
      workspaceRoot,
      tenantId,
      tier: tenantTier,
      agentDepth: 0,
    });
    const skillEngine = new SkillEngine();
    await skillEngine.initialize(workspaceRoot);
    for (const plugin of pluginSystem.registry.listEnabled()) {
      await skillEngine.addPluginSkills(plugin.rootDir);
    }
    const baseSystemPrompt = options.systemPromptOverride || (
      coordinatorMode
        ? coordinatorMode.buildSystemPrompt({
            workspaceRoot,
            mcpServerNames: this.mcpManager?.getServerNames?.() || [],
          })
        : await assembleFullContext(tenantId, options.isAdmin ?? false)
    );

    const systemPrompt = pluginOutputStyles.systemPromptAddition
      ? `${baseSystemPrompt}\n\n${pluginOutputStyles.systemPromptAddition}`
      : baseSystemPrompt;

    // Auto-allow all tools for API mode (no interactive prompts)
    const allToolNames = tools.map((t) => t.name);
    const permContext: LegacyPermissionContext = {
      denyRules: [],
      allowRules: allToolNames,
      askRules: [],
    };
    const canUseTool = createCanUseTool(permContext, false, () => ({
      sessionId,
      cwd,
      permissionMode: 'default',
    }));

    const engine = new QueryEngine({
      tools,
      systemPrompt,
      maxTurns: options.maxTurns || (options.isAdmin ? 9999 : 30),
      maxBudgetUsd: options.maxBudgetUsd || (options.isAdmin ? 999 : 1),
      canUseTool,
      getExecutionContext: () => ({
        cwd,
        sessionId,
        tenantId,
        workspaceRoot,
        permissionMode: 'default',
      }),
      depth: 0,
      dynamicContext: `<environment>\nWorking directory: ${cwd}\nPlatform: ${process.platform}\nNode: ${process.version}\n</environment>`,
      features: {
        REACTIVE_COMPACT: true,
        TOMBSTONE: true,
        TOOL_RESULT_BUDGET: true,
      },
      hookDispatcher,
      skillEngine,
    });

    if (options.persistSessionStart !== false && !fs.existsSync(getSessionFilePath(sessionId))) {
      await saveSessionMetadataForSession(sessionId, 'session_start', {
        cwd,
        mode: options.mode || 'server',
        createdAt: Date.now(),
      });
    }

    this.engines.set(sessionId, {
      engine,
      lastAccess: Date.now(),
      cwd,
      workspaceRoot,
      tenantId,
      mode,
      createdAt: Date.now(),
      messageCount: 0,
    });

    if (tenantId) {
      registerSession(tenantId, sessionId);
    }

    return engine;
  }

  // ─── Get (with disk rehydration) ────────────────────────────────────

  async get(sessionId: string): Promise<QueryEngine | null> {
    const entry = this.engines.get(sessionId);
    if (entry) {
      entry.lastAccess = Date.now();
      return entry.engine;
    }

    // Try rehydrate from disk
    return this.tryRehydrate(sessionId);
  }

  // ─── Get or Create ──────────────────────────────────────────────────

  async getOrCreate(
    sessionId: string,
    options: CreateSessionOptions = {},
  ): Promise<QueryEngine> {
    const existing = await this.get(sessionId);
    if (existing) return existing;
    return this.create(sessionId, options);
  }

  // ─── Delete ─────────────────────────────────────────────────────────

  delete(sessionId: string): boolean {
    const entry = this.engines.get(sessionId);
    if (entry) {
      void entry.engine.gracefulShutdown('session_deleted');
    }
    if (entry?.tenantId) {
      unregisterSession(entry.tenantId, sessionId);
    }
    return this.engines.delete(sessionId);
  }

  // ─── List Active ────────────────────────────────────────────────────

  listActive(): Array<{
    sessionId: string;
    cwd: string;
    workspaceRoot: string;
    tenantId?: string;
    mode: string;
    createdAt: number;
    lastAccess: number;
    messageCount: number;
  }> {
    return Array.from(this.engines.entries()).map(([id, entry]) => ({
      sessionId: id,
      cwd: entry.cwd,
      workspaceRoot: entry.workspaceRoot,
      tenantId: entry.tenantId,
      mode: entry.mode,
      createdAt: entry.createdAt,
      lastAccess: entry.lastAccess,
      messageCount: entry.engine.getMessageCount(),
    }));
  }

  // ─── Metadata ───────────────────────────────────────────────────────

  getMetadata(sessionId: string): {
    exists: boolean;
    messageCount: number;
    cwd: string;
    workspaceRoot: string;
    tenantId?: string;
    mode: string;
    createdAt: number;
    lastAccess: number;
  } | null {
    const entry = this.engines.get(sessionId);
    if (!entry) return null;
    return {
      exists: true,
      messageCount: entry.engine.getMessageCount(),
      cwd: entry.cwd,
      workspaceRoot: entry.workspaceRoot,
      tenantId: entry.tenantId,
      mode: entry.mode,
      createdAt: entry.createdAt,
      lastAccess: entry.lastAccess,
    };
  }

  // ─── Increment message count (called after submitMessage) ──────────

  trackMessage(sessionId: string): void {
    const entry = this.engines.get(sessionId);
    if (entry) {
      entry.messageCount++;
      entry.lastAccess = Date.now();
    }
  }

  // ─── Disk Rehydration ───────────────────────────────────────────────

  private async tryRehydrate(sessionId: string): Promise<QueryEngine | null> {
    try {
      const entries = await loadTranscriptFile(sessionId);
      if (entries.length === 0) return null;

      const cwd = getSessionCwdFromEntries(entries, process.cwd());
      const mode = getSessionModeFromEntries(entries, 'server');
      const engine = await this.create(sessionId, {
        cwd,
        workspaceRoot: cwd,
        tenantTier: undefined,
        mode,
        persistSessionStart: false,
      });

      const historyMessages = transcriptEntriesToApiMessages(entries);
      if (historyMessages.length > 0) {
        engine.hydrateFromApiMessages(historyMessages);
      }

      const entry = this.engines.get(sessionId);
      if (entry) {
        entry.cwd = cwd;
        entry.workspaceRoot = cwd;
        entry.mode = mode;
        entry.lastAccess = Date.now();
        entry.messageCount = engine.getMessageCount();
      }

      console.error(`  [pool] Rehydrated session ${sessionId.slice(0, 8)} from disk (${historyMessages.length} messages)`);
      return engine;
    } catch {
      return null;
    }
  }

  // ─── TTL Cleanup ────────────────────────────────────────────────────

  private startCleanup(): void {
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      const expired: string[] = [];

      for (const [id, entry] of this.engines) {
        if (now - entry.lastAccess > DEFAULT_TTL_MS) {
          expired.push(id);
        }
      }

      for (const id of expired) {
        const entry = this.engines.get(id);
        if (entry?.tenantId) {
          unregisterSession(entry.tenantId, id);
        }
        console.error(`  [pool] TTL expired: session ${id.slice(0, 8)} (idle ${Math.floor((now - this.engines.get(id)!.lastAccess) / 60_000)}min)`);
        this.engines.delete(id);
      }
    }, CLEANUP_INTERVAL_MS);
  }

  // ─── Shutdown ───────────────────────────────────────────────────────

  shutdown(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    for (const [sessionId, entry] of this.engines.entries()) {
      if (entry.tenantId) {
        unregisterSession(entry.tenantId, sessionId);
      }
    }
    this.engines.clear();
  }

  get size(): number {
    return this.engines.size;
  }
}
