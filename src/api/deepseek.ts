/**
 * deepseek.ts — DeepSeek V3.2 API Client
 *
 * Replaces Claude Code's Anthropic API integration.
 * Uses OpenAI-compatible SDK since DeepSeek follows the OpenAI API format.
 * Handles: streaming, tool calling, cost tracking, error recovery
 */

import OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';
import { addCost, addAPIDuration, setLastAPIRequestTimestamp, setLastApiCompletionTimestamp, setLastMainRequestId } from '../bootstrap/state.js';
import type { Tool } from '../tools/Tool.js';

// ─── Configuration ──────────────────────────────────────────────────────────

export interface DeepSeekConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  maxOutputTokens?: number;
}

let client: OpenAI | null = null;
let config: DeepSeekConfig | null = null;

export function initDeepSeek(cfg: DeepSeekConfig): void {
  config = cfg;
  client = new OpenAI({
    apiKey: cfg.apiKey,
    baseURL: cfg.baseURL,
  });
}

export function getDeepSeekClient(): OpenAI {
  if (!client) throw new Error('DeepSeek client not initialized. Call initDeepSeek() first.');
  return client;
}

export function getDeepSeekConfig(): DeepSeekConfig {
  if (!config) throw new Error('DeepSeek config not initialized.');
  return config;
}

// ─── Token Cost Estimation ──────────────────────────────────────────────────
// DeepSeek V3 pricing (approximate)

const COST_PER_1K_INPUT = 0.00014;   // $0.14 per 1M input tokens
const COST_PER_1K_OUTPUT = 0.00028;  // $0.28 per 1M output tokens

function estimateCost(inputTokens: number, outputTokens: number): number {
  return (inputTokens / 1000) * COST_PER_1K_INPUT +
         (outputTokens / 1000) * COST_PER_1K_OUTPUT;
}

// ─── Convert Tools to OpenAI Format ─────────────────────────────────────────

export function toolsToOpenAIFormat(tools: Tool[]): ChatCompletionTool[] {
  return tools.map((tool) => {
    // Extract JSON schema from Zod schema
    const jsonSchema = zodToJsonSchema(tool.inputSchema);

    return {
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: jsonSchema,
      },
    };
  });
}

function zodToJsonSchema(schema: any): Record<string, unknown> {
  // Simplified Zod-to-JSON-Schema conversion
  // Handles the common patterns used by our tools
  if (!schema || !schema._def) {
    return { type: 'object', properties: {} };
  }

  const def = schema._def;

  if (def.typeName === 'ZodObject') {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    const shape = schema.shape || {};

    for (const [key, value] of Object.entries(shape)) {
      const fieldDef = (value as any)?._def;
      properties[key] = zodFieldToJsonSchema(value as any);

      // Check if field is required (not optional)
      if (fieldDef?.typeName !== 'ZodOptional' && fieldDef?.typeName !== 'ZodDefault') {
        required.push(key);
      }
    }

    return {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
    };
  }

  return { type: 'object', properties: {} };
}

function zodFieldToJsonSchema(field: any): Record<string, unknown> {
  if (!field || !field._def) return { type: 'string' };

  const def = field._def;
  const description = def.description;

  switch (def.typeName) {
    case 'ZodString':
      return { type: 'string', ...(description ? { description } : {}) };
    case 'ZodNumber':
      return { type: 'number', ...(description ? { description } : {}) };
    case 'ZodBoolean':
      return { type: 'boolean', ...(description ? { description } : {}) };
    case 'ZodEnum':
      return { type: 'string', enum: def.values, ...(description ? { description } : {}) };
    case 'ZodOptional':
      return zodFieldToJsonSchema(def.innerType);
    case 'ZodDefault':
      return zodFieldToJsonSchema(def.innerType);
    case 'ZodArray':
      return {
        type: 'array',
        items: zodFieldToJsonSchema(def.type),
        ...(description ? { description } : {}),
      };
    default:
      return { type: 'string', ...(description ? { description } : {}) };
  }
}

// ─── Message Types ──────────────────────────────────────────────────────────

export interface ClovMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

export interface StreamChunk {
  type: 'text' | 'tool_call_start' | 'tool_call_delta' | 'tool_call_end' | 'done';
  content?: string;
  toolCallId?: string;
  toolName?: string;
  toolArgs?: string;
  finishReason?: string;
  usage?: { inputTokens: number; outputTokens: number };
}

// ─── Call Model (Streaming) ─────────────────────────────────────────────────

export async function* callModel(
  messages: ClovMessage[],
  tools: Tool[],
  systemPrompt: string,
  signal?: AbortSignal,
): AsyncGenerator<StreamChunk> {
  const api = getDeepSeekClient();
  const cfg = getDeepSeekConfig();

  // Build messages for OpenAI format
  const apiMessages: ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    ...messages.map(convertToOpenAIMessage),
  ];

  const openaiTools = tools.length > 0 ? toolsToOpenAIFormat(tools) : undefined;

  const startTime = Date.now();
  setLastAPIRequestTimestamp(startTime);

  try {
    const stream = await api.chat.completions.create({
      model: cfg.model,
      messages: apiMessages,
      tools: openaiTools,
      tool_choice: openaiTools ? 'auto' : undefined,
      max_tokens: cfg.maxOutputTokens || 8192,
      stream: true,
      stream_options: { include_usage: true },
    }, { signal });

    let currentToolCalls: Map<number, { id: string; name: string; args: string }> = new Map();
    let textContent = '';
    let finishReason: string | null = null;
    let usage = { inputTokens: 0, outputTokens: 0 };

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta;
      finishReason = chunk.choices?.[0]?.finish_reason || finishReason;

      // Text content
      if (delta?.content) {
        textContent += delta.content;
        yield { type: 'text', content: delta.content };
      }

      // Tool calls
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;
          if (!currentToolCalls.has(idx)) {
            currentToolCalls.set(idx, {
              id: tc.id || `call_${idx}_${Date.now()}`,
              name: tc.function?.name || '',
              args: '',
            });
            if (tc.function?.name) {
              yield {
                type: 'tool_call_start',
                toolCallId: currentToolCalls.get(idx)!.id,
                toolName: tc.function.name,
              };
            }
          }
          if (tc.function?.arguments) {
            currentToolCalls.get(idx)!.args += tc.function.arguments;
            yield {
              type: 'tool_call_delta',
              toolCallId: currentToolCalls.get(idx)!.id,
              toolArgs: tc.function.arguments,
            };
          }
        }
      }

      // Usage (comes in the last chunk with stream_options)
      if (chunk.usage) {
        usage = {
          inputTokens: chunk.usage.prompt_tokens || 0,
          outputTokens: chunk.usage.completion_tokens || 0,
        };
      }
    }

    // Emit tool call completions
    for (const [_idx, tc] of currentToolCalls) {
      yield {
        type: 'tool_call_end',
        toolCallId: tc.id,
        toolName: tc.name,
        toolArgs: tc.args,
      };
    }

    // Track cost
    const durationMs = Date.now() - startTime;
    addAPIDuration(durationMs);
    setLastApiCompletionTimestamp(Date.now());

    const cost = estimateCost(usage.inputTokens, usage.outputTokens);
    addCost({
      model: cfg.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd: cost,
      timestamp: Date.now(),
    });

    yield {
      type: 'done',
      finishReason: finishReason || 'stop',
      usage,
    };

  } catch (error: any) {
    if (error.name === 'AbortError') {
      yield { type: 'done', finishReason: 'abort' };
      return;
    }
    throw error;
  }
}

// ─── Convert Messages ───────────────────────────────────────────────────────

function convertToOpenAIMessage(msg: ClovMessage): ChatCompletionMessageParam {
  if (msg.role === 'tool') {
    return {
      role: 'tool',
      content: msg.content,
      tool_call_id: msg.tool_call_id || '',
    };
  }

  if (msg.role === 'assistant' && msg.tool_calls) {
    return {
      role: 'assistant',
      content: msg.content || null,
      tool_calls: msg.tool_calls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      })),
    };
  }

  return {
    role: msg.role as 'system' | 'user' | 'assistant',
    content: msg.content,
  };
}

// ─── Non-Streaming Call (for compaction, side queries) ───────────────────────

export async function callModelSync(
  messages: ClovMessage[],
  systemPrompt: string,
  maxTokens?: number,
): Promise<{ content: string; usage: { inputTokens: number; outputTokens: number } }> {
  const api = getDeepSeekClient();
  const cfg = getDeepSeekConfig();

  const apiMessages: ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    ...messages.map(convertToOpenAIMessage),
  ];

  const response = await api.chat.completions.create({
    model: cfg.model,
    messages: apiMessages,
    max_tokens: maxTokens || 4096,
    stream: false,
  });

  const content = response.choices[0]?.message?.content || '';
  const usage = {
    inputTokens: response.usage?.prompt_tokens || 0,
    outputTokens: response.usage?.completion_tokens || 0,
  };

  const cost = estimateCost(usage.inputTokens, usage.outputTokens);
  addCost({
    model: cfg.model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costUsd: cost,
    timestamp: Date.now(),
  });

  return { content, usage };
}
