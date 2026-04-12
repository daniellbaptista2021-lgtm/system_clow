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
import { withRetry } from '../utils/retry/retry.js';
import stringify from 'json-stable-stringify';

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

  // Auto-detect provider from model name
  const isOpenAI = cfg.model.startsWith('gpt-');
  const baseURL = isOpenAI ? 'https://api.openai.com/v1' : cfg.baseURL;
  const apiKey = isOpenAI ? (process.env.OPENAI_API_KEY || cfg.apiKey) : cfg.apiKey;

  client = new OpenAI({
    apiKey,
    baseURL,
  });

  console.log(`  ✓ Model: ${cfg.model} (${isOpenAI ? 'OpenAI' : 'DeepSeek'})`);
}

export function getDeepSeekClient(): OpenAI {
  if (!client) throw new Error('DeepSeek client not initialized. Call initDeepSeek() first.');
  return client;
}

export function getDeepSeekConfig(): DeepSeekConfig {
  if (!config) throw new Error('DeepSeek config not initialized.');
  return config;
}

// ─── DeepSeek Pricing (REAL prices, verified April 2026) ────────────────────
// Cache hit is 10x cheaper than miss. Not 4x like Anthropic, not 2x like OpenAI. TEN times.
// Output ($0.42/1M) is cheaper than input miss ($0.28/1M).
// Clow on DeepSeek V3.2 with optimized cache costs ~30-50x less than Claude Code.

const PRICING: Record<string, { input_miss: number; input_hit: number; output: number }> = {
  'deepseek-chat': {
    input_miss: 0.28  / 1_000_000,
    input_hit:  0.028 / 1_000_000,
    output:     0.42  / 1_000_000,
  },
  'deepseek-reasoner': {
    input_miss: 0.55  / 1_000_000,
    input_hit:  0.14  / 1_000_000,
    output:     2.19  / 1_000_000,
  },
  'gpt-4o': {
    input_miss: 2.50  / 1_000_000,
    input_hit:  1.25  / 1_000_000,
    output:     10.0  / 1_000_000,
  },
  'gpt-4o-mini': {
    input_miss: 0.15  / 1_000_000,
    input_hit:  0.075 / 1_000_000,
    output:     0.60  / 1_000_000,
  },
  'gpt-4.1': {
    input_miss: 2.00  / 1_000_000,
    input_hit:  0.50  / 1_000_000,
    output:     8.00  / 1_000_000,
  },
  'gpt-4.1-mini': {
    input_miss: 0.40  / 1_000_000,
    input_hit:  0.10  / 1_000_000,
    output:     1.60  / 1_000_000,
  },
};

function getPricing(model: string) {
  return PRICING[model] ?? PRICING['deepseek-chat'];
}

export interface DeepSeekUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
}

export interface CacheMetrics {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  uncachedTokens: number;
  cacheHitRate: number;       // 0-1
  costActual: number;         // with cache discount
  costUncached: number;       // hypothetical without cache
  costSaved: number;          // difference
  savedPercent: number;       // 0-100
}

function calculateCost(model: string, usage: DeepSeekUsage): CacheMetrics {
  const p = getPricing(model);
  const cachedTokens = usage.prompt_cache_hit_tokens ?? 0;
  const uncachedTokens = usage.prompt_tokens - cachedTokens;
  const outputTokens = usage.completion_tokens;
  const cacheHitRate = usage.prompt_tokens > 0
    ? cachedTokens / usage.prompt_tokens
    : 0;

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

// ─── Session-level cache metrics accumulator ────────────────────────────────
let sessionCacheMetrics = {
  totalCachedTokens: 0,
  totalUncachedTokens: 0,
  totalOutputTokens: 0,
  totalCostActual: 0,
  totalCostUncached: 0,
  turnCount: 0,
};

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
    totalCachedTokens: 0, totalUncachedTokens: 0, totalOutputTokens: 0,
    totalCostActual: 0, totalCostUncached: 0, turnCount: 0,
  };
}

// ─── Convert Tools to OpenAI Format ─────────────────────────────────────────

/**
 * Convert tools to OpenAI format with STABLE key ordering.
 * Uses json-stable-stringify so identical tool sets produce byte-identical
 * JSON, maximizing DeepSeek's automatic prefix cache hits.
 */
export function toolsToOpenAIFormat(tools: Tool[]): ChatCompletionTool[] {
  return tools.map((tool) => {
    const jsonSchema = zodToJsonSchema(tool.inputSchema);
    // Stabilize key order via round-trip through json-stable-stringify
    const stableSchema = JSON.parse(stringify(jsonSchema) || '{}');

    return {
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: stableSchema,
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
  usage?: { inputTokens: number; outputTokens: number; cachedTokens?: number; uncachedTokens?: number };
  cacheMetrics?: CacheMetrics;
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
    // Stream opening is wrapped with withRetry — retries the HTTP request
    // on 429/500/network errors. Once streaming starts, chunks are consumed
    // without retry (mid-stream recovery is a separate concern).
    const stream = await withRetry(
      () => api.chat.completions.create({
        model: cfg.model,
        messages: apiMessages,
        tools: openaiTools,
        tool_choice: openaiTools ? 'auto' : undefined,
        max_tokens: cfg.maxOutputTokens || 8192,
        temperature: 0,
        frequency_penalty: 0.3,
        presence_penalty: 0.1,
        stream: true,
        stream_options: { include_usage: true },
      }, { signal }),
      { signal },
    );

    let currentToolCalls: Map<number, { id: string; name: string; args: string }> = new Map();
    let textContent = '';
    let finishReason: string | null = null;
    let usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, uncachedTokens: 0 };

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
        const u = chunk.usage as any;
        usage = {
          inputTokens: u.prompt_tokens || 0,
          outputTokens: u.completion_tokens || 0,
          cachedTokens: u.prompt_cache_hit_tokens || 0,
          uncachedTokens: u.prompt_cache_miss_tokens || (u.prompt_tokens || 0),
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

    // Track cost with cache-aware pricing
    const durationMs = Date.now() - startTime;
    addAPIDuration(durationMs);
    setLastApiCompletionTimestamp(Date.now());

    const dsUsage: DeepSeekUsage = {
      prompt_tokens: usage.inputTokens,
      completion_tokens: usage.outputTokens,
      prompt_cache_hit_tokens: usage.cachedTokens,
      prompt_cache_miss_tokens: usage.uncachedTokens,
    };
    const metrics = calculateCost(cfg.model, dsUsage);

    // Cache metrics tracked internally (not displayed to user)

    // Accumulate session-level metrics
    sessionCacheMetrics.totalCachedTokens += metrics.cachedTokens;
    sessionCacheMetrics.totalUncachedTokens += metrics.uncachedTokens;
    sessionCacheMetrics.totalOutputTokens += metrics.outputTokens;
    sessionCacheMetrics.totalCostActual += metrics.costActual;
    sessionCacheMetrics.totalCostUncached += metrics.costUncached;
    sessionCacheMetrics.turnCount++;

    addCost({
      model: cfg.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd: metrics.costActual,
      timestamp: Date.now(),
    });

    yield {
      type: 'done',
      finishReason: finishReason || 'stop',
      usage,
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

  const response = await withRetry(
    () => api.chat.completions.create({
      model: cfg.model,
      messages: apiMessages,
      max_tokens: maxTokens || 4096,
      stream: false,
    }),
  );

  const content = response.choices[0]?.message?.content || '';
  const rawUsage = response.usage as any;
  const dsUsage: DeepSeekUsage = {
    prompt_tokens: rawUsage?.prompt_tokens || 0,
    completion_tokens: rawUsage?.completion_tokens || 0,
    prompt_cache_hit_tokens: rawUsage?.prompt_cache_hit_tokens || 0,
    prompt_cache_miss_tokens: rawUsage?.prompt_cache_miss_tokens,
  };
  const metrics = calculateCost(cfg.model, dsUsage);
  const usage = { inputTokens: dsUsage.prompt_tokens, outputTokens: dsUsage.completion_tokens };

  sessionCacheMetrics.totalCachedTokens += metrics.cachedTokens;
  sessionCacheMetrics.totalUncachedTokens += metrics.uncachedTokens;
  sessionCacheMetrics.totalOutputTokens += metrics.outputTokens;
  sessionCacheMetrics.totalCostActual += metrics.costActual;
  sessionCacheMetrics.totalCostUncached += metrics.costUncached;
  sessionCacheMetrics.turnCount++;

  addCost({
    model: cfg.model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costUsd: metrics.costActual,
    timestamp: Date.now(),
  });

  return { content, usage };
}
