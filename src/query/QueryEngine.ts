/**
 * QueryEngine.ts — The Brain of System Clow
 *
 * Based on Claude Code's QueryEngine.ts (1,296 lines)
 * Central orchestrator: owns conversation state, manages the LLM query loop,
 * handles streaming, tracks costs, coordinates tool execution.
 *
 * Two layers with distinct lifetimes:
 * - QueryEngine (per conversation): session state, message history, cumulative usage
 * - query() (per user message): API loop, tool execution, budget enforcement
 *
 * Core loop in query() is a deliberately simple while(true) AsyncGenerator.
 * All intelligence lives in the LLM, the scaffold is intentionally "dumb."
 */

import { randomUUID } from 'crypto';
import type { Tool, ToolResult, CanUseToolFn, ToolUseContext } from '../tools/Tool.js';
import type { ClovMessage, StreamChunk } from '../api/deepseek.js';
import { callModel } from '../api/deepseek.js';
import { findToolByName } from '../tools/tools.js';
import {
  getCwd,
  getSessionId,
  getTotalCostUSD,
  resetTurnMetrics,
  incrementToolUseCount,
  addToolDuration,
} from '../bootstrap/state.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface QueryEngineConfig {
  tools: Tool[];
  systemPrompt: string;
  maxTurns: number;
  maxBudgetUsd?: number;
  canUseTool: CanUseToolFn;
  onText?: (text: string) => void;
  onToolUse?: (toolName: string, input: unknown) => void;
  onToolResult?: (toolName: string, result: ToolResult) => void;
  onTurnComplete?: (turnCount: number) => void;
}

export interface SDKMessage {
  type: 'assistant' | 'user' | 'progress' | 'result' | 'system';
  subtype?: string;
  content?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: ToolResult;
  uuid?: string;
  parentUuid?: string;
}

// ─── QueryEngine Class ──────────────────────────────────────────────────────

export class QueryEngine {
  private config: QueryEngineConfig;
  private mutableMessages: ClovMessage[] = [];
  private abortController: AbortController = new AbortController();

  constructor(config: QueryEngineConfig) {
    this.config = config;
  }

  /**
   * submitMessage — The main entry point per user message
   * Phase 1: Input processing
   * Phase 2: Context assembly (system prompt already provided)
   * Phase 3: query() loop
   * Phase 4: Result extraction
   */
  async *submitMessage(prompt: string): AsyncGenerator<SDKMessage> {
    // Phase 1: Push user message to history
    const userUuid = randomUUID();
    this.mutableMessages.push({
      role: 'user',
      content: prompt,
    });

    yield {
      type: 'user',
      content: prompt,
      uuid: userUuid,
    };

    // Phase 3: Run the query loop
    const messages = [...this.mutableMessages]; // Snapshot (immutable for loop)

    for await (const message of this.query(messages)) {
      yield message;

      // Push assistant/tool messages back to mutable history
      if (message.type === 'assistant' && message.content) {
        // Already handled inside query()
      }
    }
  }

  /**
   * query() — The core while(true) loop
   *
   * 1. Call API: stream response
   * 2. Post-process: execute tools, handle errors
   * 3. Decision: continue (tool_use) or terminate (end_turn)
   */
  private async *query(messages: ClovMessage[]): AsyncGenerator<SDKMessage> {
    let turnCount = 0;
    const MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3;
    let recoveryAttempts = 0;

    while (true) {
      // Budget check: USD
      if (this.config.maxBudgetUsd !== undefined && getTotalCostUSD() >= this.config.maxBudgetUsd) {
        yield {
          type: 'result',
          subtype: 'error_max_budget_usd',
          content: `Budget limit reached: $${getTotalCostUSD().toFixed(4)} >= $${this.config.maxBudgetUsd}`,
        };
        return;
      }

      // Budget check: turns
      if (turnCount >= this.config.maxTurns) {
        yield {
          type: 'result',
          subtype: 'error_max_turns',
          content: `Maximum turns reached: ${turnCount}`,
        };
        return;
      }

      resetTurnMetrics();

      // ─── Call the API ─────────────────────────────────────────────────
      let assistantText = '';
      const toolCalls: Array<{
        id: string;
        name: string;
        arguments: string;
      }> = [];
      let finishReason = 'stop';

      try {
        for await (const chunk of callModel(
          messages,
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
              break;
          }
        }
      } catch (error: any) {
        yield {
          type: 'result',
          subtype: 'error_during_execution',
          content: `API error: ${error.message}`,
        };
        return;
      }

      // ─── Push assistant message to history ────────────────────────────
      const assistantMessage: ClovMessage = {
        role: 'assistant',
        content: assistantText || undefined as any,
        tool_calls: toolCalls.length > 0
          ? toolCalls.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: { name: tc.name, arguments: tc.arguments },
            }))
          : undefined,
      };

      messages.push(assistantMessage);
      this.mutableMessages.push(assistantMessage);

      // Yield assistant text
      if (assistantText) {
        yield {
          type: 'assistant',
          content: assistantText,
          uuid: randomUUID(),
        };
      }

      // ─── No tool calls? We're done ────────────────────────────────────
      if (toolCalls.length === 0) {
        yield {
          type: 'result',
          subtype: 'success',
          content: assistantText,
        };
        return;
      }

      // ─── Execute tools ────────────────────────────────────────────────
      for (const toolCall of toolCalls) {
        const tool = findToolByName(this.config.tools, toolCall.name);

        if (!tool) {
          // Unknown tool
          const errorResult: ClovMessage = {
            role: 'tool',
            content: `Error: Unknown tool "${toolCall.name}"`,
            tool_call_id: toolCall.id,
          };
          messages.push(errorResult);
          this.mutableMessages.push(errorResult);
          continue;
        }

        // Parse arguments
        let parsedInput: unknown;
        try {
          parsedInput = JSON.parse(toolCall.arguments);
        } catch {
          const errorResult: ClovMessage = {
            role: 'tool',
            content: `Error: Invalid JSON in tool arguments: ${toolCall.arguments}`,
            tool_call_id: toolCall.id,
          };
          messages.push(errorResult);
          this.mutableMessages.push(errorResult);
          continue;
        }

        // Validate with Zod schema
        const parseResult = tool.inputSchema.safeParse(parsedInput);
        if (!parseResult.success) {
          const errorResult: ClovMessage = {
            role: 'tool',
            content: `Error: Invalid input for tool ${tool.name}: ${parseResult.error.message}`,
            tool_call_id: toolCall.id,
          };
          messages.push(errorResult);
          this.mutableMessages.push(errorResult);
          continue;
        }

        const validInput = parseResult.data;

        // Permission check
        const permResult = await this.config.canUseTool(tool, validInput, toolCall.id);
        if (permResult.behavior === 'deny') {
          const denyResult: ClovMessage = {
            role: 'tool',
            content: `Permission denied: ${(permResult as any).message || 'Tool use was denied'}`,
            tool_call_id: toolCall.id,
          };
          messages.push(denyResult);
          this.mutableMessages.push(denyResult);
          continue;
        }

        // Execute the tool
        this.config.onToolUse?.(tool.name, validInput);
        yield {
          type: 'progress',
          toolName: tool.name,
          toolInput: validInput,
        };

        const toolStartTime = Date.now();
        incrementToolUseCount();

        let toolResult: ToolResult;
        try {
          const context: ToolUseContext = {
            cwd: getCwd(),
            sessionId: getSessionId(),
            abortSignal: this.abortController.signal,
            permissionMode: 'default',
            options: { tools: this.config.tools },
          };

          toolResult = await tool.call(validInput, context, this.config.canUseTool, toolCall.id);
        } catch (error: any) {
          toolResult = {
            output: null,
            outputText: `Tool execution error: ${error.message}`,
            isError: true,
          };
        }

        addToolDuration(Date.now() - toolStartTime);
        this.config.onToolResult?.(tool.name, toolResult);

        // Push tool result to history
        const toolResultMessage: ClovMessage = {
          role: 'tool',
          content: toolResult.outputText,
          tool_call_id: toolCall.id,
        };
        messages.push(toolResultMessage);
        this.mutableMessages.push(toolResultMessage);
      }

      turnCount++;
      this.config.onTurnComplete?.(turnCount);
    }
  }

  /**
   * Abort the current query
   */
  abort(): void {
    this.abortController.abort();
    this.abortController = new AbortController();
  }

  /**
   * Get the full conversation history
   */
  getMessages(): ReadonlyArray<ClovMessage> {
    return this.mutableMessages;
  }

  /**
   * Get message count
   */
  getMessageCount(): number {
    return this.mutableMessages.length;
  }
}
