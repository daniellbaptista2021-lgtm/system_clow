/**
 * anthropic.ts - Anthropic Claude API client
 *
 * Handles streaming, tool calling, cost tracking, and retry integration.
 */

import Anthropic from '@anthropic-ai/sdk';
import { addCost, addAPIDuration, setLastAPIRequestTimestamp, setLastApiCompletionTimestamp, setLastMainRequestId } from '../bootstrap/state.js';
import type { Tool } from '../tools/Tool.js';
import { withRetry } from '../utils/retry/retry.js';
import stringify from 'json-stable-stringify';

export interface AnthropicConfig {
  apiKey: string;
  model: string;
  maxOutputTokens?: number;
}

let client: Anthropic | null = null;
let config: AnthropicConfig | null = null;

const DEFAULT_MODEL = 'glm-5.1';

const PRICING: Record<string, { input_miss: number; input_hit: number; output: number }> = {
  // GLM-5.1 via OpenRouter (preco aproximado - cobrado na key OR)
  'glm-5.1': {
    input_miss: 0.30 / 1_000_000,
    input_hit: 0.03 / 1_000_000,
    output: 1.10 / 1_000_000,
  },
};

export interface ModelUsage {
  prompt_tokens: number;
  completion_tokens: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
}

export interface CacheMetrics {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  uncachedTokens: number;
  cacheHitRate: number;
  costActual: number;
  costUncached: number;
  costSaved: number;
  savedPercent: number;
}

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
  usage?: { inputTokens: number; outputTokens: number; cachedTokens?: number; uncachedTokens?: number };
  cacheMetrics?: CacheMetrics;
}

let sessionCacheMetrics = {
  totalCachedTokens: 0,
  totalUncachedTokens: 0,
  totalOutputTokens: 0,
  totalCostActual: 0,
  totalCostUncached: 0,
  turnCount: 0,
};

export function initAnthropic(cfg: AnthropicConfig): void {
  config = cfg;
  // Suporta ANTHROPIC_BASE_URL pra LiteLLM proxy (rotear pra OpenRouter/outros).
  const baseURL = process.env.ANTHROPIC_BASE_URL;
  const clientConfig: any = { apiKey: cfg.apiKey, maxRetries: 0 };
  if (baseURL && baseURL.trim()) clientConfig.baseURL = baseURL.trim();
  client = new Anthropic(clientConfig);
}

function getAnthropicClient(): Anthropic {
  if (!client) {
    throw new Error('Anthropic client not initialized. Call initAnthropic() first.');
  }
  return client;
}

function getAnthropicConfig(): AnthropicConfig {
  if (!config) {
    throw new Error('Anthropic config not initialized.');
  }
  return config;
}

function getPricing(model: string) {
  return PRICING[model] ?? PRICING[DEFAULT_MODEL];
}

function calculateCost(model: string, usage: ModelUsage): CacheMetrics {
  const p = getPricing(model);
  const cachedTokens = usage.prompt_cache_hit_tokens ?? 0;
  const uncachedTokens = usage.prompt_cache_miss_tokens ?? Math.max(usage.prompt_tokens - cachedTokens, 0);
  const outputTokens = usage.completion_tokens;
  const cacheHitRate = usage.prompt_tokens > 0 ? cachedTokens / usage.prompt_tokens : 0;

  const costActual =
    uncachedTokens * p.input_miss +
    cachedTokens * p.input_hit +
    outputTokens * p.output;

  const costUncached =
    usage.prompt_tokens * p.input_miss +
    outputTokens * p.output;

  const costSaved = costUncached - costActual;
  const savedPercent = costUncached > 0 ? (costSaved / costUncached) * 100 : 0;

  return {
    inputTokens: usage.prompt_tokens,
    outputTokens,
    cachedTokens,
    uncachedTokens,
    cacheHitRate,
    costActual,
    costUncached,
    costSaved,
    savedPercent,
  };
}

export function getSessionCacheMetrics() {
  const total = sessionCacheMetrics.totalCachedTokens + sessionCacheMetrics.totalUncachedTokens;
  return {
    ...sessionCacheMetrics,
    overallCacheHitRate: total > 0 ? sessionCacheMetrics.totalCachedTokens / total : 0,
    totalCostSaved: sessionCacheMetrics.totalCostUncached - sessionCacheMetrics.totalCostActual,
  };
}

export function resetSessionCacheMetrics(): void {
  sessionCacheMetrics = {
    totalCachedTokens: 0,
    totalUncachedTokens: 0,
    totalOutputTokens: 0,
    totalCostActual: 0,
    totalCostUncached: 0,
    turnCount: 0,
  };
}

function zodToJsonSchema(schema: any): Record<string, unknown> {
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

function toolsToAnthropicFormat(tools: Tool[]): Array<{ name: string; description: string; input_schema: any }> {
  return tools.map((tool) => {
    const jsonSchema = zodToJsonSchema(tool.inputSchema);
    const stableSchema = JSON.parse(stringify(jsonSchema) || '{}');

    return {
      name: tool.name,
      description: tool.description,
        input_schema: stableSchema as any,
    };
  });
}

function normalizeToolInput(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Ignore parse failure and preserve raw input below.
  }
  return { raw };
}

function appendAnthropicMessage(
  target: any[],
  role: 'user' | 'assistant',
  content: any[] | string,
): void {
  const blocks = Array.isArray(content) ? content : [{ type: 'text', text: content }];
  const last = target[target.length - 1];
  if (last?.role === role && Array.isArray(last.content)) {
    last.content.push(...blocks);
    return;
  }
  target.push({ role, content: blocks });
}

function looksLikeToolError(content: string): boolean {
  return /^(error|permission denied|validation failed|tool error):/i.test(content.trim());
}

function convertToAnthropicMessages(messages: ClovMessage[]): any[] {
  const converted: any[] = [];
  const pendingToolUseIds = new Set<string>();

  for (const msg of messages) {
    if (msg.role === 'system') {
      continue;
    }

    if (msg.role === 'user') {
      appendAnthropicMessage(converted, 'user', msg.content);
      continue;
    }

    if (msg.role === 'tool') {
      // Ensure tool_result is added as a separate user message
      const toolResultBlock = {
        type: 'tool_result',
        tool_use_id: msg.tool_call_id || '',
        content: msg.content,
        is_error: looksLikeToolError(msg.content),
      };
      
      // Always create a new user message for tool results to ensure proper sequencing
      converted.push({
        role: 'user',
        content: [toolResultBlock],
      });
      
      if (msg.tool_call_id) {
        pendingToolUseIds.delete(msg.tool_call_id);
      }
      continue;
    }

    const blocks: any[] = [];
    if (msg.content) {
      blocks.push({ type: 'text', text: msg.content });
    }
    for (const tc of msg.tool_calls || []) {
      blocks.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input: normalizeToolInput(tc.function.arguments),
      });
      pendingToolUseIds.add(tc.id);
    }
    if (blocks.length > 0) {
      appendAnthropicMessage(converted, 'assistant', blocks);
    }
  }

  // Validate: no pending tool_use without tool_result
  if (pendingToolUseIds.size > 0) {
    console.warn(`Warning: ${pendingToolUseIds.size} tool_use(s) without corresponding tool_result: ${Array.from(pendingToolUseIds).join(', ')}`);
  }

  return converted;
}

function extractUsage(raw: any): ModelUsage {
  const promptTokens = raw?.input_tokens ?? 0;
  const cacheReadTokens = raw?.cache_read_input_tokens ?? 0;
  const cacheCreationTokens = raw?.cache_creation_input_tokens;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: raw?.output_tokens ?? 0,
    prompt_cache_hit_tokens: cacheReadTokens,
    prompt_cache_miss_tokens: cacheCreationTokens ?? Math.max(promptTokens - cacheReadTokens, 0),
  };
}

function normalizeStopReason(reason: string | null | undefined): string {
  if (!reason) return 'stop';
  if (reason === 'end_turn') return 'stop';
  // Preserve 'max_tokens' as 'length' so QueryEngine's continuation recovery works
  if (reason === 'max_tokens') return 'length';
  return reason;
}

export async function* callModel(
  messages: ClovMessage[],
  tools: Tool[],
  systemPrompt: string,
  signal?: AbortSignal,
): AsyncGenerator<StreamChunk> {
  const cfg = getAnthropicConfig();
  const api = getAnthropicClient();
  const anthropicMessages = convertToAnthropicMessages(messages);
  const anthropicTools = tools.length > 0 ? toolsToAnthropicFormat(tools) : undefined;

  const startTime = Date.now();
  setLastAPIRequestTimestamp(startTime);

  try {
    // GLM-5.1 via LiteLLM — sem cache_control (Anthropic-only, GLM rejeita)
    const stream = await withRetry(
      () => api.messages.create({
        model: cfg.model,
        system: systemPrompt,
        messages: anthropicMessages,
        tools: anthropicTools,
        max_tokens: cfg.maxOutputTokens || 16384,
        temperature: 0,
        stream: true,
      }, { signal }),
      { signal },
    );

    const toolCalls = new Map<number, {
      id: string;
      name: string;
      args: string;
      sawDelta: boolean;
      initialInput?: unknown;
    }>();
    let finishReason = 'stop';
    let usage: ModelUsage = { prompt_tokens: 0, completion_tokens: 0 };

    for await (const event of stream as any) {
      if (event.type === 'message_start') {
        setLastMainRequestId(event.message?.id);
        usage = extractUsage(event.message?.usage);
        continue;
      }

      if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
        const idx = event.index ?? 0;
        const initialInput = event.content_block.input;
        const initialArgs = initialInput && typeof initialInput === 'object'
          ? JSON.stringify(initialInput)
          : '';
        toolCalls.set(idx, {
          id: event.content_block.id,
          name: event.content_block.name,
          args: '',
          sawDelta: false,
          initialInput,
        });
        yield {
          type: 'tool_call_start',
          toolCallId: event.content_block.id,
          toolName: event.content_block.name,
        };
        if (initialArgs) {
          yield {
            type: 'tool_call_delta',
            toolCallId: event.content_block.id,
            toolArgs: initialArgs,
          };
        }
        continue;
      }

      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        if (event.delta.text) {
          yield { type: 'text', content: event.delta.text };
        }
        continue;
      }

      if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
        const idx = event.index ?? 0;
        const current = toolCalls.get(idx);
        if (current && event.delta.partial_json) {
          current.sawDelta = true;
          current.args += event.delta.partial_json;
          yield {
            type: 'tool_call_delta',
            toolCallId: current.id,
            toolArgs: event.delta.partial_json,
          };
        }
        continue;
      }

      if (event.type === 'content_block_stop') {
        const current = toolCalls.get(event.index ?? 0);
        if (current) {
          const toolArgs = current.sawDelta
            ? current.args
            : JSON.stringify(current.initialInput ?? {});
          yield {
            type: 'tool_call_end',
            toolCallId: current.id,
            toolName: current.name,
            toolArgs,
          };
        }
        continue;
      }

      if (event.type === 'message_delta') {
        finishReason = normalizeStopReason(event.delta?.stop_reason || finishReason);
        if (event.usage) {
          usage = { ...usage, ...extractUsage(event.usage) };
        }
      }
    }

    const durationMs = Date.now() - startTime;
    addAPIDuration(durationMs);
    setLastApiCompletionTimestamp(Date.now());

    const metrics = calculateCost(cfg.model, usage);
    sessionCacheMetrics.totalCachedTokens += metrics.cachedTokens;
    sessionCacheMetrics.totalUncachedTokens += metrics.uncachedTokens;
    sessionCacheMetrics.totalOutputTokens += metrics.outputTokens;
    sessionCacheMetrics.totalCostActual += metrics.costActual;
    sessionCacheMetrics.totalCostUncached += metrics.costUncached;
    sessionCacheMetrics.turnCount++;

    addCost({
      model: cfg.model,
      inputTokens: usage.prompt_tokens,
      outputTokens: usage.completion_tokens,
      costUsd: metrics.costActual,
      timestamp: Date.now(),
    });

    yield {
      type: 'done',
      finishReason,
      usage: {
        inputTokens: usage.prompt_tokens,
        outputTokens: usage.completion_tokens,
        cachedTokens: usage.prompt_cache_hit_tokens,
        uncachedTokens: usage.prompt_cache_miss_tokens,
      },
      cacheMetrics: metrics,
    };
  } catch (error: any) {
    if (error.name === 'AbortError') {
      yield { type: 'done', finishReason: 'abort' };
      return;
    }
    throw error;
  }
}

export async function callModelSync(
  messages: ClovMessage[],
  systemPrompt: string,
  maxTokens?: number,
): Promise<{ content: string; usage: { inputTokens: number; outputTokens: number } }> {
  const api = getAnthropicClient();
  const cfg = getAnthropicConfig();
  const anthropicMessages = convertToAnthropicMessages(messages);

  const response = await withRetry(
    () => api.messages.create({
      model: cfg.model,
      system: systemPrompt,
      messages: anthropicMessages,
      max_tokens: maxTokens || 4096,
      temperature: 0,
    }),
  );

  setLastMainRequestId(response.id);
  const content = response.content
    .filter((block: any) => block.type === 'text')
    .map((block: any) => block.text)
    .join('');

  const usage = extractUsage(response.usage);
  const metrics = calculateCost(cfg.model, usage);

  sessionCacheMetrics.totalCachedTokens += metrics.cachedTokens;
  sessionCacheMetrics.totalUncachedTokens += metrics.uncachedTokens;
  sessionCacheMetrics.totalOutputTokens += metrics.outputTokens;
  sessionCacheMetrics.totalCostActual += metrics.costActual;
  sessionCacheMetrics.totalCostUncached += metrics.costUncached;
  sessionCacheMetrics.turnCount++;

  addCost({
    model: cfg.model,
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    costUsd: metrics.costActual,
    timestamp: Date.now(),
  });

  return {
    content,
    usage: {
      inputTokens: usage.prompt_tokens,
      outputTokens: usage.completion_tokens,
    },
  };
}
