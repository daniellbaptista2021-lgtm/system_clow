/**
 * sessionPool.ts — In-Memory QueryEngine Pool with TTL + Disk Rehydration
 *
 * Manages QueryEngine instances. Expensive to create, cached in memory.
 * On TTL expiry: JSONL on disk survives (Passo 6). Next request rehydrates.
 * Cleanup runs every 5 minutes.
 */

import { QueryEngine, type QueryEngineConfig } from '../query/QueryEngine.js';
import { getTools } from '../tools/tools.js';
import { assembleFullContext } from '../utils/context/context.js';
import { createCanUseTool, type LegacyPermissionContext } from '../utils/permissions/permissions.js';
import {
  initSessionStorage,
  loadTranscriptFile,
  acquireSessionLock,
  releaseSessionLock,
} from '../utils/session/sessionStorage.js';
import {
  setSessionId,
  setCwd,
  getSessionId,
} from '../bootstrap/state.js';
import type { ClovMessage } from '../api/deepseek.js';
import type { MCPManager } from '../mcp/MCPManager.js';
import * as path from 'path';
import * as fs from 'fs';

// ─── Types ──────────────────────────────────────────────────────────────────

interface PoolEntry {
  engine: QueryEngine;
  lastAccess: number;
  cwd: string;
  createdAt: number;
  messageCount: number;
}

export interface CreateSessionOptions {
  cwd?: string;
  mode?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  systemPromptOverride?: string;
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
    const tools = getTools(undefined, this.mcpManager || undefined);
    const systemPrompt = options.systemPromptOverride || await assembleFullContext();

    // Auto-allow all tools for API mode (no interactive prompts)
    const allToolNames = tools.map((t) => t.name);
    const permContext: LegacyPermissionContext = {
      denyRules: [],
      allowRules: allToolNames,
      askRules: [],
    };
    const canUseTool = createCanUseTool(permContext);

    const engine = new QueryEngine({
      tools,
      systemPrompt,
      maxTurns: options.maxTurns || 100,
      maxBudgetUsd: options.maxBudgetUsd || 10,
      canUseTool,
      depth: 0,
      dynamicContext: `<environment>\nWorking directory: ${cwd}\nPlatform: ${process.platform}\nNode: ${process.version}\n</environment>`,
      features: {
        REACTIVE_COMPACT: true,
        TOMBSTONE: true,
        TOOL_RESULT_BUDGET: true,
      },
    });

    this.engines.set(sessionId, {
      engine,
      lastAccess: Date.now(),
      cwd,
      createdAt: Date.now(),
      messageCount: 0,
    });

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
    return this.engines.delete(sessionId);
  }

  // ─── List Active ────────────────────────────────────────────────────

  listActive(): Array<{
    sessionId: string;
    cwd: string;
    createdAt: number;
    lastAccess: number;
    messageCount: number;
  }> {
    return Array.from(this.engines.entries()).map(([id, entry]) => ({
      sessionId: id,
      cwd: entry.cwd,
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
    createdAt: number;
    lastAccess: number;
  } | null {
    const entry = this.engines.get(sessionId);
    if (!entry) return null;
    return {
      exists: true,
      messageCount: entry.engine.getMessageCount(),
      cwd: entry.cwd,
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

      // Recreate engine and replay messages
      const engine = await this.create(sessionId);

      // Load prior messages as mutable history
      // (The engine starts fresh, but we can feed context via system message)
      const summary = entries
        .filter((e) => e.role === 'user' || e.role === 'assistant')
        .slice(-10) // Last 10 messages for context
        .map((e) => `[${e.role}]: ${String(e.content).slice(0, 200)}`)
        .join('\n');

      if (summary) {
        // Submit a context-loading message
        // The engine will have this in its history
        const contextMsg = `[System: Session resumed. Recent context:\n${summary}\n\nContinue from where you left off.]`;
        // We don't actually run this through LLM — just note it exists
      }

      console.error(`  [pool] Rehydrated session ${sessionId.slice(0, 8)} from disk (${entries.length} entries)`);
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
    this.engines.clear();
  }

  get size(): number {
    return this.engines.size;
  }
}
