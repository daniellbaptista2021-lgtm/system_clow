/**
 * QueryEngine.ts — The Brain of System Clow (Full Rewrite)
 *
 * Based on Claude Code's QueryEngine.ts (1,296 lines) + query.ts (1,730 lines)
 *
 * Now uses modular subsystems:
 *   - MessageState: mutable history + immutable snapshots + tombstone + dedup
 *   - BudgetTracker: USD / turns / tokens enforcement
 *   - FallbackHandler: model fallback + max output recovery
 *   - TombstoneSystem: orphan message removal
 *   - ErrorWatermark: turn-scoped error tracking
 *   - ToolResultBudget: cap aggregate tool output
 *
 * Core loop: while(true) AsyncGenerator — all intelligence in the LLM.
 */

import { randomUUID } from 'crypto';
import type { Tool, ToolResult, CanUseToolFn, ToolUseContext } from '../tools/Tool.js';
import type { ClovMessage, StreamChunk } from '../api/anthropic.js';
import { callModel } from '../api/anthropic.js';
import { ToolResultCache } from '../tools/toolResultCache.js';
import { findToolByName } from '../tools/tools.js';
import {
  getCwd, getSessionId, getPermissionMode, getTotalCostUSD,
  resetTurnMetrics, incrementToolUseCount, addToolDuration,
} from '../bootstrap/state.js';
import { shouldAutoCompact, getTokenWarningState } from '../utils/compact/autoCompact.js';
import { compactConversation } from '../utils/compact/compact.js';
import { classifyError, type ErrorType } from '../utils/retry/retry.js';
import type { AggregatedHookResult } from '../hooks/types.js';

// New modular subsystems
import { MessageState, BoundedUUIDSet } from './messageState.js';
import { BudgetTracker } from './budgetTracker.js';
import { FallbackHandler, FallbackTriggeredError, MAX_OUTPUT_TOKENS_RECOVERY_LIMIT } from './fallbackHandler.js';
import { TombstoneSystem } from './tombstone.js';
import { ErrorWatermark, recordError } from './errorWatermark.js';
import { ToolResultBudget } from './toolResultBudget.js';
import type {
  Message, UserMessage, AssistantMessage, SystemMessage, TombstoneMessage,
  SDKMessage, ResultSubtype, QueryEngineConfig, TokenUsage,
} from './types.js';

// Re-export for backward compat
export { MAX_OUTPUT_TOKENS_RECOVERY_LIMIT } from './fallbackHandler.js';
export const MAX_AGENT_DEPTH = 2;
export type { SDKMessage, QueryEngineConfig } from './types.js';

// ════════════════════════════════════════════════════════════════════════════
// QueryEngine Class
// ════════════════════════════════════════════════════════════════════════════

export class QueryEngine {
  private config: QueryEngineConfig;
  private state: MessageState;
  private budget: BudgetTracker;
  private fallback: FallbackHandler;
  private watermark: ErrorWatermark;
  private abortController: AbortController = new AbortController();
  private currentModel: string = process.env.CLOW_MODEL || process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
  private sessionStarted = false;
  private toolCache = new ToolResultCache();

  // Legacy compat: mutableMessages alias
  private get mutableMessages(): ClovMessage[] {
    return this.state.snapshot().map(this.toApiMessage);
  }

  /** Agent nesting depth */
  readonly depth: number;

  /** Per-instance cost tracking (for sub-agent budget) */
  private instanceCostUsd: number = 0;
  private instanceInputTokens: number = 0;
  private instanceOutputTokens: number = 0;
  private instanceTurns: number = 0;
  private instanceStartTime: number = Date.now();

  constructor(config: QueryEngineConfig) {
    this.config = config;
    this.depth = config.depth ?? 0;
    this.state = new MessageState();
    this.budget = new BudgetTracker(
      config.maxTurns,
      config.maxBudgetUsd,
      config.maxTokensPerTurn,
    );
    this.fallback = new FallbackHandler(
      process.env.CLOW_MODEL || process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
      config.fallbackModel,
    );
    this.watermark = new ErrorWatermark();
  }

  // ── Instance Metrics (for AgentTool) ────────────────────────────────
  getInstanceCostUsd(): number { return this.instanceCostUsd; }
  getInstanceInputTokens(): number { return this.instanceInputTokens; }
  getInstanceOutputTokens(): number { return this.instanceOutputTokens; }
  getInstanceTurns(): number { return this.instanceTurns; }
  getInstanceDurationMs(): number { return Date.now() - this.instanceStartTime; }

  addInstanceCost(inputTokens: number, outputTokens: number, costUsd: number): void {
    this.instanceCostUsd += costUsd;
    this.instanceInputTokens += inputTokens;
    this.instanceOutputTokens += outputTokens;
  }

  private getExecutionContext(): Pick<ToolUseContext, 'cwd' | 'sessionId' | 'permissionMode' | 'tenantId' | 'workspaceRoot'> {
    return this.config.getExecutionContext?.() || {
      cwd: getCwd(),
      sessionId: getSessionId(),
      permissionMode: getPermissionMode(),
    };
  }

  // ════════════════════════════════════════════════════════════════════
  // submitMessage — Main entry point per user message
  // ════════════════════════════════════════════════════════════════════

  async *submitMessage(prompt: string): AsyncGenerator<SDKMessage> {
    const isFirstMessage = this.state.size() === 0;
    const baseMessageContent = isFirstMessage && this.config.dynamicContext
      ? `${this.config.dynamicContext}\n\n${prompt}`
      : prompt;

    const userMsg: UserMessage = {
      type: 'user',
      uuid: randomUUID(),
      content: baseMessageContent,
      turnNumber: this.budget.getTurnCount(),
      timestamp: Date.now(),
      source: 'user',
    };

    if (this.config.hookDispatcher) {
      if (!this.sessionStarted) {
        this.sessionStarted = true;
        this.config.onSessionStart?.();
        for (const event of this.applyHookResult(await this.config.hookDispatcher.fireSessionStart())) {
          yield event;
        }
        for (const event of this.applyHookResult(await this.config.hookDispatcher.fireSetup())) {
          yield event;
        }
      }

      for (const event of this.applyHookResult(await this.config.hookDispatcher.fireUserPromptSubmit(prompt, userMsg.uuid))) {
        yield event;
      }
    }

    if (this.config.skillEngine) {
      const execCtx = this.getExecutionContext();
      const skillResult = await this.config.skillEngine.matchForMessage({
        message: prompt,
        sessionId: execCtx.sessionId,
        cwd: execCtx.cwd,
        workspaceRoot: execCtx.workspaceRoot || execCtx.cwd,
        isFirstMessage,
        tier: undefined,
      });
      for (const event of this.applySkillResult(skillResult.systemMessageAddition)) {
        yield event;
      }
    }

    if (this.state.isDuplicate(userMsg.uuid)) return;
    this.state.markSeen(userMsg.uuid);
    this.state.push(userMsg);

    yield { type: 'user', content: prompt, uuid: userMsg.uuid };

    yield* this.queryLoop();
  }

  // ════════════════════════════════════════════════════════════════════
  // queryLoop — The while(true) core
  // ════════════════════════════════════════════════════════════════════

  private async *queryLoop(): AsyncGenerator<SDKMessage> {
    let attemptWithFallback = false;
    let maxOutputRetries = 0;
    let toolRounds = 0;
    const MAX_TOOL_ROUNDS_DEFAULT = 50;
    const MAX_TOOL_ROUNDS = this.config.maxTurns >= 9999 ? 999 : MAX_TOOL_ROUNDS_DEFAULT;

    while (true) {
      // ── Guard: max tool rounds to prevent infinite loops ──────────
      if (toolRounds >= MAX_TOOL_ROUNDS) {
        yield { type: 'result', subtype: 'error_max_turns' as any, content: `Limite de ${MAX_TOOL_ROUNDS} rodadas de ferramentas atingido. Encerrando para evitar custo excessivo.` };
        return;
      }
      // ── Pre-processing: tool result budget ──────────────────────────
      const budgetResult = ToolResultBudget.apply(this.state.snapshot() as Message[]);
      if (budgetResult.truncatedCount > 0) {
        yield {
          type: 'system',
          subtype: 'tool_result_truncated',
          content: `Truncated ${budgetResult.truncatedCount} old tool results to save context`,
        };
      }

      // ── Pre-processing: auto-compact ───────────────────────────────
      const apiMessages = this.state.snapshot().map(this.toApiMessage);
      const compactCheck = shouldAutoCompact(apiMessages);
      if (compactCheck.shouldCompact) {
        yield { type: 'system', subtype: 'compacting', content: `Context ${compactCheck.percentUsed.toFixed(0)}% full. Compacting...` };
        const compactResult = await compactConversation(apiMessages);
        if (compactResult.success) {
          this.replaceMessagesFromApi(compactResult.newMessages);
          this.config.onCompact?.(compactResult.preCompactTokens, compactResult.postCompactTokens);
          yield { type: 'system', subtype: 'compact_complete', content: `Compacted: ${compactResult.preCompactTokens} → ${compactResult.postCompactTokens} tokens` };
        } else {
          yield { type: 'system', subtype: 'compact_failed', content: `Compaction failed: ${compactResult.failureReason}` };
        }
      } else {
        const warning = getTokenWarningState(apiMessages);
        if (warning.isAboveWarningThreshold && !warning.isAboveAutoCompactThreshold) {
          this.config.onContextWarning?.(warning.percentLeft);
        }
      }

      // ── Budget check ───────────────────────────────────────────────
      const effectiveCost = this.depth > 0 ? this.instanceCostUsd : getTotalCostUSD();
      const budgetExceeded = this.budget.checkBeforeTurn();
      if (budgetExceeded) {
        yield { type: 'result', subtype: budgetExceeded, content: `Budget exceeded`, cost: effectiveCost };
        return;
      }

      // Also check per-instance budget for sub-agents
      if (this.config.maxBudgetUsd !== undefined && effectiveCost >= this.config.maxBudgetUsd) {
        yield { type: 'result', subtype: 'error_max_budget_usd', content: `Budget $${effectiveCost.toFixed(4)} >= $${this.config.maxBudgetUsd}` };
        return;
      }

      resetTurnMetrics();
      this.watermark.begin();

      // ── Call API ───────────────────────────────────────────────────
      let assistantText = '';
      const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
      let finishReason = 'stop';
      let turnUsage: { inputTokens: number; outputTokens: number } = { inputTokens: 0, outputTokens: 0 };

      try {
        const currentMessages = this.state.snapshot().map(this.toApiMessage);

        for await (const chunk of callModel(
          currentMessages,
          this.config.tools,
          this.config.systemPrompt,
          this.abortController.signal,
        )) {
          switch (chunk.type) {
            case 'text':
              assistantText += chunk.content || '';
              this.config.onText?.(chunk.content || '');
              break;

            case 'tool_call_end':
              toolCalls.push({
                id: chunk.toolCallId!,
                name: chunk.toolName!,
                arguments: chunk.toolArgs || '{}',
              });
              break;

            case 'done':
              finishReason = chunk.finishReason || 'stop';
              if (chunk.usage) {
                turnUsage = {
                  inputTokens: chunk.usage.inputTokens || 0,
                  outputTokens: chunk.usage.outputTokens || 0,
                };
              }
              // Track per-instance cost
              if (chunk.cacheMetrics) {
                this.addInstanceCost(
                  chunk.cacheMetrics.inputTokens,
                  chunk.cacheMetrics.outputTokens,
                  chunk.cacheMetrics.costActual,
                );
                this.budget.addCost(chunk.cacheMetrics.costActual);
              } else if (chunk.usage) {
                const cost = turnUsage.inputTokens * 0.00000028 + turnUsage.outputTokens * 0.00000042;
                this.addInstanceCost(turnUsage.inputTokens, turnUsage.outputTokens, cost);
                this.budget.addCost(cost);
              }
              break;
          }
        }
      } catch (error: any) {
        recordError(error);
        const errorType: ErrorType = classifyError(error);

        // Context overflow → reactive compact
        if (errorType === 'context_overflow') {
          yield { type: 'system', subtype: 'compacting', content: 'Context overflow. Compacting...' };
          const currentMessages = this.state.snapshot().map(this.toApiMessage);
          const cr = await compactConversation(currentMessages);
          if (cr.success) {
            this.replaceMessagesFromApi(cr.newMessages);
            this.config.onCompact?.(cr.preCompactTokens, cr.postCompactTokens);
            yield { type: 'system', subtype: 'compact_complete', content: `Reactive compact: ${cr.preCompactTokens} → ${cr.postCompactTokens}` };
            continue; // Retry same turn
          }
          yield { type: 'result', subtype: 'error_during_execution', content: `Context overflow + compaction failed` };
          return;
        }

        // Fallback model
        const fallbackTrigger = this.fallback.shouldFallback(error);
        if (fallbackTrigger && !attemptWithFallback) {
          yield { type: 'system', subtype: 'fallback_triggered' as any, content: `Switching to fallback model` };
          attemptWithFallback = true;
          continue;
        }

        if (errorType === 'fatal') {
          yield { type: 'result', subtype: 'error_during_execution', content: `Fatal: ${error.message}` };
          return;
        }

        yield { type: 'result', subtype: 'error_during_execution', content: `Failed after retries: ${error.message}` };
        return;
      }

      // ── Push assistant message to state ────────────────────────────
      // Preserve the real stop reason so continuation recovery works when model hits max_tokens
      const realStopReason = toolCalls.length > 0 ? 'tool_use' : (finishReason === 'length' ? 'max_tokens' : 'end_turn');
      const assistantMsg: AssistantMessage = {
        type: 'assistant',
        uuid: randomUUID(),
        messageId: randomUUID(),
        content: assistantText || '',
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        turnNumber: this.budget.getTurnCount(),
        timestamp: Date.now(),
        stopReason: realStopReason,
        usage: { input_tokens: turnUsage.inputTokens, output_tokens: turnUsage.outputTokens },
        model: this.currentModel,
      };
      this.state.push(assistantMsg);

      if (assistantText) {
        yield { type: 'assistant', content: assistantText, uuid: assistantMsg.uuid, messageId: assistantMsg.messageId };
      }

      // ── No tool calls → done ───────────────────────────────────────
      if (toolCalls.length === 0) {
        // Max tokens recovery
        if (finishReason === 'length' && maxOutputRetries < MAX_OUTPUT_TOKENS_RECOVERY_LIMIT) {
          if (this.fallback.injectContinuation(this.state, this.budget.getTurnCount(), maxOutputRetries)) {
            maxOutputRetries++;
            continue;
          }
        }

        this.budget.recordTurn(this.instanceCostUsd);
        this.instanceTurns = this.budget.getTurnCount();
        yield { type: 'result', subtype: 'success', content: assistantText, cost: this.budget.getTotalCost() };
        return;
      }

      // ── Execute tools ──────────────────────────────────────────────
      const deferredSystemMessages: Array<{ subtype: SystemMessage['subtype']; content: string }> = [];
      for (const toolCall of toolCalls) {
        const tool = findToolByName(this.config.tools, toolCall.name);

        if (!tool) {
          this.pushToolResult(toolCall.id, `Error: Unknown tool "${toolCall.name}"`, true);
          continue;
        }

        let parsedInput: unknown;
        try {
          parsedInput = JSON.parse(toolCall.arguments);
        } catch {
          this.pushToolResult(toolCall.id, `Error: Invalid JSON in tool arguments`, true);
          continue;
        }

        const parseResult = tool.inputSchema.safeParse(parsedInput);
        if (!parseResult.success) {
          this.pushToolResult(toolCall.id, `Error: Invalid input: ${parseResult.error.message}`, true);
          continue;
        }
        let validInput = parseResult.data;

        if (this.config.hookDispatcher) {
          const preToolResult = await this.config.hookDispatcher.firePreToolUse(
            tool.name,
            validInput,
            toolCall.id,
            this.getExecutionContext().permissionMode,
          );
          if (preToolResult.updatedInput !== undefined) {
            const reparsed = tool.inputSchema.safeParse(preToolResult.updatedInput);
            if (!reparsed.success) {
              this.pushToolResult(toolCall.id, `Error: Hook produced invalid input: ${reparsed.error.message}`, true);
              continue;
            }
            validInput = reparsed.data;
          }
          for (const event of this.previewHookResult(preToolResult, deferredSystemMessages)) {
            yield event;
          }
          if (preToolResult.blocked || preToolResult.finalDecision === 'deny' || preToolResult.finalDecision === 'ask' || preToolResult.preventContinuation) {
            this.pushToolResult(toolCall.id, `Permission denied: ${preToolResult.reasons.join('; ') || 'Blocked by hook'}`, true);
            yield { type: 'system', subtype: 'permission_denied', content: `${tool.name}: blocked by hook` };
            continue;
          }
        }

        const permResult = await this.config.canUseTool(tool, validInput, toolCall.id);
        if (permResult.behavior === 'deny' || permResult.behavior === 'ask') {
          if (this.config.hookDispatcher) {
            const permissionHookResult = permResult.behavior === 'deny'
              ? await this.config.hookDispatcher.firePermissionDenied(tool.name, validInput, permResult.message || 'denied')
              : await this.config.hookDispatcher.firePermissionRequest(tool.name, validInput, permResult.behavior);
            for (const event of this.previewHookResult(permissionHookResult, deferredSystemMessages)) {
              yield event;
            }
          }
          this.pushToolResult(toolCall.id, `Permission denied: ${permResult.message || 'Tool use denied'}`, true);
          yield { type: 'system', subtype: 'permission_denied', content: `${tool.name}: ${permResult.message || 'denied'}` };
          continue;
        }

        if (tool.validateInput) {
          const execCtx = this.getExecutionContext();
          const ctx: ToolUseContext = {
            cwd: execCtx.cwd,
            sessionId: execCtx.sessionId,
            tenantId: execCtx.tenantId,
            workspaceRoot: execCtx.workspaceRoot,
            permissionMode: execCtx.permissionMode,
            options: { tools: this.config.tools },
          };
          const validation = await tool.validateInput(validInput, ctx);
          if (!validation.valid) {
            this.pushToolResult(toolCall.id, `Validation failed: ${validation.message}`, true);
            continue;
          }
        }

        // Execute
        this.config.onToolUse?.(tool.name, validInput);
        yield { type: 'progress', toolName: tool.name, toolInput: validInput };

        const toolStartTime = Date.now();
        incrementToolUseCount();

        let toolResult: ToolResult;
        try {
          const execCtx = this.getExecutionContext();
          const ctx: ToolUseContext & { depth: number } = {
            cwd: execCtx.cwd,
            sessionId: execCtx.sessionId,
            tenantId: execCtx.tenantId,
            workspaceRoot: execCtx.workspaceRoot,
            abortSignal: this.abortController.signal,
            permissionMode: execCtx.permissionMode,
            options: { tools: this.config.tools },
            depth: this.depth,
          };
          // Check tool cache for read-only tools
          const cached = this.toolCache.get(tool.name, validInput);
          if (cached) {
            toolResult = cached as ToolResult;
          } else {
            toolResult = await tool.call(validInput, ctx, this.config.canUseTool, toolCall.id);
            // Cache the result for read-only tools
            this.toolCache.set(tool.name, validInput, toolResult);
          }
          // Invalidate cache after write operations
          this.toolCache.invalidate(tool.name, validInput);
        } catch (error: any) {
          recordError(error);
          toolResult = { output: null, outputText: `Tool error: ${error.message}`, isError: true };
        }

        const toolDurationMs = Date.now() - toolStartTime;
        addToolDuration(toolDurationMs);
        this.config.onToolResult?.(tool.name, toolResult);

        if (this.config.hookDispatcher) {
          const postToolResult = toolResult.isError
            ? await this.config.hookDispatcher.firePostToolUseFailure(tool.name, validInput, toolResult.outputText, toolCall.id)
            : await this.config.hookDispatcher.firePostToolUse(tool.name, validInput, toolResult.output, toolCall.id, toolDurationMs);
          for (const event of this.previewHookResult(postToolResult, deferredSystemMessages)) {
            yield event;
          }
        }

        if (this.config.skillEngine) {
          const execCtx = this.getExecutionContext();
          const skillResult = await this.config.skillEngine.matchForToolUse({
            toolName: tool.name,
            toolInput: validInput,
            sessionId: execCtx.sessionId,
            cwd: execCtx.cwd,
            workspaceRoot: execCtx.workspaceRoot || execCtx.cwd,
            tier: undefined,
          });
          for (const event of this.applySkillResult(skillResult.systemMessageAddition)) {
            yield event;
          }
        }

        this.pushToolResult(toolCall.id, toolResult.outputText, toolResult.isError);
        yield { type: 'tool_result', toolName: tool.name, toolUseId: toolCall.id, isError: toolResult.isError || false };
      }

      for (const deferred of deferredSystemMessages) {
        this.pushSystemMessage(deferred.subtype, deferred.content);
        yield { type: 'system', subtype: deferred.subtype, content: deferred.content };
      }

      // Safety net: garantir pushToolResult pra TODO tool_call emitido.
      // Se por qualquer motivo (excecao em hook/skill, yield abort, etc.)
      // algum tool_call ficou orfao, a gente pusha error aqui pra manter
      // pareamento tool_use <-> tool_result (Anthropic API rejeita mismatch
      // e GLM-5.1 entra em loop re-emitindo os mesmos tool_uses).
      const resolvedToolIds = new Set<string>();
      const snapshot = this.state.snapshot();
      for (let i = snapshot.length - 1; i >= 0; i--) {
        const m = snapshot[i];
        if ((m as any).type !== 'user') continue;
        const tcid = (m as any).toolCallId;
        if (tcid) resolvedToolIds.add(tcid);
        else break;
      }
      for (const tc of toolCalls) {
        if (!resolvedToolIds.has(tc.id)) {
          console.warn('[safety-net] tool_use ' + tc.id + ' (' + tc.name + ') sem result — pushing error placeholder');
          this.pushToolResult(tc.id, 'Error: tool execution did not produce a result (safety net)', true);
        }
      }

      toolRounds++;
      this.budget.recordTurn(0);
      this.instanceTurns = this.budget.getTurnCount();
      this.config.onTurnComplete?.(this.budget.getTurnCount());

      // Reset for next iteration
      attemptWithFallback = false;
      maxOutputRetries = 0;
    }
  }

  // ── Helper: push tool result as user message ──────────────────────

  private pushToolResult(toolCallId: string, content: string, isError?: boolean): void {
    const msg: UserMessage = {
      type: 'user',
      uuid: randomUUID(),
      content: content,
      turnNumber: this.budget.getTurnCount(),
      timestamp: Date.now(),
      source: 'tool_result',
      toolCallId,
    };
    this.state.push(msg);
  }

  private applyHookResult(result: AggregatedHookResult): SDKMessage[] {
    const events: SDKMessage[] = [];

    if (result.systemMessages) {
      this.pushSystemMessage('hook_message', result.systemMessages);
      events.push({ type: 'system', subtype: 'hook_message', content: result.systemMessages });
    }

    if (result.additionalContexts) {
      const content = `[Hook Context] ${result.additionalContexts}`;
      this.pushSystemMessage('hook_message', content);
      events.push({ type: 'system', subtype: 'hook_message', content });
    }

    return events;
  }


  private previewHookResult(
    result: AggregatedHookResult,
    deferred: Array<{ subtype: SystemMessage['subtype']; content: string }>,
  ): SDKMessage[] {
    const events: SDKMessage[] = [];

    if (result.systemMessages) {
      deferred.push({ subtype: 'hook_message', content: result.systemMessages });
      events.push({ type: 'system', subtype: 'hook_message', content: result.systemMessages });
    }

    if (result.additionalContexts) {
      const content = `[Hook Context] ${result.additionalContexts}`;
      deferred.push({ subtype: 'hook_message', content });
      events.push({ type: 'system', subtype: 'hook_message', content });
    }

    return events;
  }

  private applySkillResult(systemMessageAddition: string): SDKMessage[] {
    if (!systemMessageAddition) {
      return [];
    }

    this.pushSystemMessage('skill_message', systemMessageAddition);
    return [{ type: 'system', subtype: 'skill_message', content: systemMessageAddition }];
  }

  private previewSkillResult(
    systemMessageAddition: string,
    deferred: Array<{ subtype: SystemMessage['subtype']; content: string }>,
  ): SDKMessage[] {
    if (!systemMessageAddition) {
      return [];
    }

    deferred.push({ subtype: 'skill_message', content: systemMessageAddition });
    return [{ type: 'system', subtype: 'skill_message', content: systemMessageAddition }];
  }

  private pushSystemMessage(subtype: SystemMessage['subtype'], content: string): void {
    this.state.push({
      type: 'system',
      uuid: randomUUID(),
      subtype,
      content,
      turnNumber: this.budget.getTurnCount(),
      timestamp: Date.now(),
    });
  }

  // ── Convert internal Message → ClovMessage (API format) ───────────

  private toApiMessage(msg: Message): ClovMessage {
    if (msg.type === 'assistant') {
      const am = msg as AssistantMessage;
      return {
        role: 'assistant',
        content: am.content || undefined as any,
        tool_calls: am.toolCalls?.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: tc.arguments },
        })),
      };
    }
    if (msg.type === 'user' && (msg as UserMessage).toolCallId) {
      return {
        role: 'tool',
        content: (msg as UserMessage).content,
        tool_call_id: (msg as UserMessage).toolCallId,
      };
    }
    if (msg.type === 'user') {
      return { role: 'user', content: (msg as UserMessage).content };
    }
    if (msg.type === 'system') {
      return { role: 'user', content: `[System: ${(msg as SystemMessage).content}]` };
    }
    // Tombstone, progress → skip (shouldn't be in API messages)
    return { role: 'user', content: '' };
  }

  // ── Replace messages from API format (after compaction) ───────────

  private replaceMessagesFromApi(apiMessages: ClovMessage[]): void {
    const newMsgs: Message[] = apiMessages.map((m, i) => {
      if (m.role === 'assistant') {
        return {
          type: 'assistant' as const,
          uuid: randomUUID(),
          messageId: randomUUID(),
          content: m.content || '',
          toolCalls: m.tool_calls?.map((tc) => ({ id: tc.id, name: tc.function.name, arguments: tc.function.arguments })),
          turnNumber: i,
          timestamp: Date.now(),
          model: this.currentModel,
        };
      }
      if (m.role === 'tool') {
        return {
          type: 'user' as const,
          uuid: randomUUID(),
          content: m.content,
          turnNumber: i,
          timestamp: Date.now(),
          source: 'tool_result' as const,
          toolCallId: m.tool_call_id,
        };
      }
      return {
        type: 'user' as const,
        uuid: randomUUID(),
        content: m.content,
        turnNumber: i,
        timestamp: Date.now(),
        source: 'user' as const,
      };
    });
    this.state.replace(newMsgs);
  }

  // ── Public API (backward compat) ──────────────────────────────────

  abort(): void {
    this.abortController.abort();
    this.abortController = new AbortController();
  }

  getMessages(): readonly ClovMessage[] {
    return this.state.snapshot().map(this.toApiMessage);
  }

  hydrateFromApiMessages(apiMessages: readonly ClovMessage[]): void {
    if (apiMessages.length === 0) return;
    this.replaceMessagesFromApi(Array.from(apiMessages));
  }

  getMessageCount(): number {
    return this.state.size();
  }

  getMessageState(): MessageState {
    return this.state;
  }

  getBudget(): BudgetTracker {
    return this.budget;
  }

  // ── Extended Query API ────────────────────────────────────────────

  /**
   * Get comprehensive query statistics.
   */
  getQueryStats(): {
    turnCount: number;
    totalCostUsd: number;
    messageCount: number;
    toolCallCount: number;
    uniqueToolsUsed: string[];
    estimatedTokens: number;
    budgetUsedPercent?: number;
    budgetRemaining?: number;
  } {
    return {
      turnCount: this.budget.getTurnCount(),
      totalCostUsd: this.budget.getTotalCost(),
      messageCount: this.state.size(),
      toolCallCount: this.state.countToolCalls(),
      uniqueToolsUsed: this.state.getToolsUsed(),
      estimatedTokens: this.state.estimateTokens(),
      budgetUsedPercent: this.budget.getBudgetUsedPercent(),
      budgetRemaining: this.budget.getRemainingBudget(),
    };
  }

  /**
   * Get a summary of the current conversation.
   */
  getConversationSummary(): {
    roleBreakdown: { user: number; assistant: number; system: number; other: number };
    apiRounds: number;
    tombstonedCount: number;
    lastAssistantContent?: string;
    lastUserContent?: string;
  } {
    const breakdown = this.state.countByRole();
    const lastAssistant = this.state.getLastAssistantMessage();
    const lastUser = this.state.getLastUserMessage();

    return {
      roleBreakdown: breakdown,
      apiRounds: this.state.groupByApiRound().length,
      tombstonedCount: this.state.tombstonedCount(),
      lastAssistantContent: lastAssistant?.content?.slice(0, 200),
      lastUserContent: lastUser?.type === 'user' ? lastUser.content?.slice(0, 200) : undefined,
    };
  }

  /**
   * Reset the engine state for a new conversation.
   * Keeps configuration, resets messages and budget.
   */
  resetState(): void {
    this.state = new MessageState();
    this.budget = new BudgetTracker(
      this.config.maxTurns,
      this.config.maxBudgetUsd,
      this.config.maxTokensPerTurn,
    );
    this.abortController = new AbortController();
  }

  /**
   * Get the current model being used.
   */
  getModel(): string {
    return this.currentModel ?? 'claude-sonnet-4-6';
  }

  /**
   * Set a different model for subsequent turns.
   */
  setModel(model: string): void {
    this.currentModel = model;
  }

  /**
   * Check if the engine is currently running a query.
   */
  isRunning(): boolean {
    return !this.abortController.signal.aborted;
  }

  /**
   * Get the engine configuration.
   */
  getConfig(): Readonly<QueryEngineConfig> {
    return this.config;
  }

  /**
   * Get the list of available tools.
   */
  getToolNames(): string[] {
    return this.config.tools.map(t => t.name);
  }

  /**
   * Get the system prompt.
   */
  getSystemPrompt(): string {
    return this.config.systemPrompt;
  }

  /**
   * Estimate tokens for the current conversation state.
   */
  estimateCurrentTokens(): number {
    // System prompt tokens (rough estimate)
    const systemTokens = Math.ceil(this.config.systemPrompt.length / 4);
    // Dynamic context tokens
    const dynamicTokens = this.config.dynamicContext ? Math.ceil(this.config.dynamicContext.length / 4) : 0;
    // Message tokens
    const messageTokens = this.state.estimateTokens();
    // Tool definitions (rough estimate: ~50 tokens per tool)
    const toolTokens = this.config.tools.length * 50;

    return systemTokens + dynamicTokens + messageTokens + toolTokens;
  }

  /**
   * Get context window usage information.
   */
  getContextInfo(): {
    estimatedTokens: number;
    maxContextTokens: number;
    usagePercent: number;
    remaining: number;
    inWarningZone: boolean;
  } {
    const maxContext = 200_000; // Claude Sonnet context window
    const estimated = this.estimateCurrentTokens();
    const remaining = Math.max(0, maxContext - estimated);
    const usagePercent = (estimated / maxContext) * 100;

    return {
      estimatedTokens: estimated,
      maxContextTokens: maxContext,
      usagePercent,
      remaining,
      inWarningZone: remaining < 20_000,
    };
  }

  /**
   * Get the turn history (cost per turn).
   */
  getTurnHistory(): ReadonlyArray<{ turnNumber: number; costUsd: number; model: string; timestamp: number }> {
    return this.budget.getCostHistory();
  }

  /**
   * Get the fallback handler.
   */
  getFallback(): FallbackHandler {
    return this.fallback;
  }

  /**
   * Format a status line for the terminal.
   */
  formatStatusLine(): string {
    const stats = this.getQueryStats();
    const parts: string[] = [];
    parts.push(`T${stats.turnCount}`);
    parts.push(`$${stats.totalCostUsd.toFixed(3)}`);
    parts.push(`${stats.messageCount} msgs`);
    if (stats.toolCallCount > 0) parts.push(`${stats.toolCallCount} tools`);
    const ctx = this.getContextInfo();
    parts.push(`${ctx.usagePercent.toFixed(0)}% ctx`);
    return parts.join(' | ');
  }

  // ════════════════════════════════════════════════════════════════════
  // Retry API Call with Exponential Backoff
  // ════════════════════════════════════════════════════════════════════

  /**
   * Retry an API call with exponential backoff and jitter.
   * Used internally when transient errors occur during model calls.
   *
   * @param fn - The async function to retry
   * @param maxRetries - Maximum number of retry attempts (default: 3)
   * @param baseDelayMs - Base delay in milliseconds (default: 1000)
   * @param maxDelayMs - Maximum delay cap in milliseconds (default: 30000)
   * @returns The result of the function call
   * @throws The last error if all retries are exhausted
   */
  async retryApiCall<T>(
    fn: () => Promise<T>,
    maxRetries: number = 3,
    baseDelayMs: number = 1000,
    maxDelayMs: number = 30000,
  ): Promise<T> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error: any) {
        lastError = error;
        const errorType = classifyError(error);

        // Don't retry fatal or context overflow errors
        if (errorType === 'fatal' || errorType === 'context_overflow') {
          throw error;
        }

        // Don't retry if we've exhausted attempts
        if (attempt >= maxRetries) {
          throw error;
        }

        // Calculate delay with exponential backoff + jitter
        const exponentialDelay = baseDelayMs * Math.pow(2, attempt);
        const jitter = Math.random() * baseDelayMs * 0.5;
        const delay = Math.min(exponentialDelay + jitter, maxDelayMs);

        // Check abort signal before sleeping
        if (this.abortController.signal.aborted) {
          throw new Error('Query aborted during retry backoff');
        }

        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, delay);
          const onAbort = () => {
            clearTimeout(timer);
            reject(new Error('Query aborted during retry backoff'));
          };
          this.abortController.signal.addEventListener('abort', onAbort, { once: true });
        });
      }
    }
    throw lastError ?? new Error('Retry exhausted with no error captured');
  }

  // ════════════════════════════════════════════════════════════════════
  // Context Window Monitoring with Auto-Compact Trigger
  // ════════════════════════════════════════════════════════════════════

  /**
   * Monitor context window usage and trigger compaction if needed.
   * Returns a status object describing the current context health.
   *
   * @param warningThresholdPercent - Percent usage that triggers a warning (default: 75)
   * @param criticalThresholdPercent - Percent usage that triggers auto-compact (default: 90)
   */
  monitorContextWindow(
    warningThresholdPercent: number = 75,
    criticalThresholdPercent: number = 90,
  ): {
    status: 'healthy' | 'warning' | 'critical' | 'overflow';
    usagePercent: number;
    estimatedTokens: number;
    maxTokens: number;
    remainingTokens: number;
    shouldCompact: boolean;
    recommendation: string;
  } {
    const info = this.getContextInfo();
    const usagePercent = info.usagePercent;

    let status: 'healthy' | 'warning' | 'critical' | 'overflow';
    let shouldCompact = false;
    let recommendation: string;

    if (usagePercent >= 100) {
      status = 'overflow';
      shouldCompact = true;
      recommendation = 'Context window exceeded. Immediate compaction required.';
    } else if (usagePercent >= criticalThresholdPercent) {
      status = 'critical';
      shouldCompact = true;
      recommendation = `Context at ${usagePercent.toFixed(1)}%. Auto-compaction recommended.`;
    } else if (usagePercent >= warningThresholdPercent) {
      status = 'warning';
      shouldCompact = false;
      recommendation = `Context at ${usagePercent.toFixed(1)}%. Consider wrapping up or compacting.`;
    } else {
      status = 'healthy';
      shouldCompact = false;
      recommendation = `Context healthy at ${usagePercent.toFixed(1)}%.`;
    }

    return {
      status,
      usagePercent,
      estimatedTokens: info.estimatedTokens,
      maxTokens: info.maxContextTokens,
      remainingTokens: info.remaining,
      shouldCompact,
      recommendation,
    };
  }

  // ════════════════════════════════════════════════════════════════════
  // Detailed Turn Tracking with Per-Turn Cost/Token Recording
  // ════════════════════════════════════════════════════════════════════

  /** Per-turn detailed records */
  private turnRecords: Array<{
    turnNumber: number;
    model: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    toolCalls: string[];
    durationMs: number;
    timestamp: number;
    finishReason: string;
  }> = [];

  /**
   * Record detailed metrics for a completed turn.
   * Called internally after each API round.
   */
  recordTurnDetails(details: {
    model: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    toolCalls: string[];
    durationMs: number;
    finishReason: string;
  }): void {
    this.turnRecords.push({
      turnNumber: this.budget.getTurnCount(),
      model: details.model,
      inputTokens: details.inputTokens,
      outputTokens: details.outputTokens,
      costUsd: details.costUsd,
      toolCalls: details.toolCalls,
      durationMs: details.durationMs,
      timestamp: Date.now(),
      finishReason: details.finishReason,
    });
  }

  /**
   * Get all recorded turn details.
   */
  getTurnRecords(): ReadonlyArray<{
    turnNumber: number;
    model: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    toolCalls: string[];
    durationMs: number;
    timestamp: number;
    finishReason: string;
  }> {
    return this.turnRecords;
  }

  /**
   * Get average tokens per turn.
   */
  getAverageTokensPerTurn(): { avgInput: number; avgOutput: number } {
    if (this.turnRecords.length === 0) return { avgInput: 0, avgOutput: 0 };
    const totalInput = this.turnRecords.reduce((sum, t) => sum + t.inputTokens, 0);
    const totalOutput = this.turnRecords.reduce((sum, t) => sum + t.outputTokens, 0);
    return {
      avgInput: Math.round(totalInput / this.turnRecords.length),
      avgOutput: Math.round(totalOutput / this.turnRecords.length),
    };
  }

  /**
   * Get the most expensive turn by cost.
   */
  getMostExpensiveTurn(): { turnNumber: number; costUsd: number } | null {
    if (this.turnRecords.length === 0) return null;
    let max = this.turnRecords[0];
    for (const t of this.turnRecords) {
      if (t.costUsd > max.costUsd) max = t;
    }
    return { turnNumber: max.turnNumber, costUsd: max.costUsd };
  }

  // ════════════════════════════════════════════════════════════════════
  // Graceful Shutdown
  // ════════════════════════════════════════════════════════════════════

  /** Whether shutdown has been initiated */
  private shutdownInitiated: boolean = false;

  /**
   * Initiate graceful shutdown of the query engine.
   * Aborts any running query, records final metrics, and cleans up resources.
   *
   * @param reason - Human-readable reason for shutdown
   * @returns Final session summary
   */
  async gracefulShutdown(reason: string = 'user_requested'): Promise<{
    reason: string;
    totalTurns: number;
    totalCostUsd: number;
    totalMessages: number;
    sessionDurationMs: number;
    turnRecordCount: number;
  }> {
    if (this.shutdownInitiated) {
      return {
        reason: 'already_shutdown',
        totalTurns: this.budget.getTurnCount(),
        totalCostUsd: this.budget.getTotalCost(),
        totalMessages: this.state.size(),
        sessionDurationMs: Date.now() - this.instanceStartTime,
        turnRecordCount: this.turnRecords.length,
      };
    }

    this.shutdownInitiated = true;

    // Abort any running query
    this.abortController.abort();

    if (this.config.hookDispatcher) {
      this.config.hookDispatcher.fireSessionEnd();
    }

    // Fire session end callback
    this.config.onSessionEnd?.(reason);

    return {
      reason,
      totalTurns: this.budget.getTurnCount(),
      totalCostUsd: this.budget.getTotalCost(),
      totalMessages: this.state.size(),
      sessionDurationMs: Date.now() - this.instanceStartTime,
      turnRecordCount: this.turnRecords.length,
    };
  }

  /**
   * Check if shutdown has been initiated.
   */
  isShutdown(): boolean {
    return this.shutdownInitiated;
  }

  // ════════════════════════════════════════════════════════════════════
  // Error and Tool Helpers
  // ════════════════════════════════════════════════════════════════════

  /** Last error encountered during execution */
  private lastError: Error | null = null;
  /** Last tool name that was executed */
  private lastToolName: string | null = null;

  /**
   * Get the last error encountered during query execution.
   * Useful for debugging and error reporting after a query completes.
   */
  getLastError(): Error | null {
    return this.lastError;
  }

  /**
   * Get the name of the last tool that was executed.
   * Returns null if no tools have been executed yet.
   */
  getLastTool(): string | null {
    return this.lastToolName;
  }

  /**
   * Clear the last error and tool tracking state.
   */
  clearLastState(): void {
    this.lastError = null;
    this.lastToolName = null;
  }

  /**
   * Get a diagnostic snapshot of the engine for debugging.
   * Includes all relevant state without sensitive data.
   */
  getDiagnosticSnapshot(): {
    model: string;
    depth: number;
    turnCount: number;
    messageCount: number;
    costUsd: number;
    contextUsagePercent: number;
    isRunning: boolean;
    isShutdown: boolean;
    lastError: string | null;
    lastTool: string | null;
    turnRecordCount: number;
    toolNames: string[];
    uptime: number;
  } {
    const ctx = this.getContextInfo();
    return {
      model: this.getModel(),
      depth: this.depth,
      turnCount: this.budget.getTurnCount(),
      messageCount: this.state.size(),
      costUsd: this.budget.getTotalCost(),
      contextUsagePercent: ctx.usagePercent,
      isRunning: this.isRunning(),
      isShutdown: this.shutdownInitiated,
      lastError: this.lastError?.message ?? null,
      lastTool: this.lastToolName,
      turnRecordCount: this.turnRecords.length,
      toolNames: this.getToolNames(),
      uptime: Date.now() - this.instanceStartTime,
    };
  }
}
