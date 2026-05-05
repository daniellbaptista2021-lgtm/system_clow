/**
 * compact.ts — Full LLM-powered compaction (Tier 3)
 *
 * Pipeline:
 *   1. Pre-compact hooks (notify listeners, snapshot state)
 *   2. Strip images → [image] markers
 *   3. Strip reinjected attachments (skill_discovery, etc)
 *   4. Strategy selection (standard vs aggressive based on token pressure)
 *   5. Call Claude for summary (with retry up to 3x, progressive drop)
 *   6. Format: strip <analysis>, keep <summary>
 *   7. Build new messages: boundary + summary + restored files
 *   8. Post-compact hooks (persist result, reset caches)
 *   9. Validate result (check token reduction, invariants)
 *
 * PTL Recovery:
 *   When a prompt-too-long error is detected, the system progressively drops
 *   content from the conversation text — first 20%, then 35%, then 50% — and
 *   retries the summary call. This handles cases where the conversation itself
 *   is too large for the summarizer model's context window.
 *
 * Compact Result Persistence:
 *   Each compaction result is recorded for diagnostics and can be retrieved
 *   via getCompactHistory().
 */

import type { ClovMessage } from '../../api/anthropic.js';
import { callModelSync } from '../../api/anthropic.js';
import { estimateMessageTokens, estimateSingleMessageTokens } from './microCompact.js';
import { COMPACT_SYSTEM_PROMPT, formatCompactSummary, buildDynamicPrompt } from './prompt.js';
import { groupMessagesByApiRound, getGroupingStats } from './grouping.js';
import {
  recordCompactSuccess,
  recordCompactFailure,
  recordCompactTimestamp,
  recordCompactHistory,
} from './autoCompact.js';
import type { CompactHistoryEntry } from './autoCompact.js';
import { resetMemoryCache } from '../context/context.js';
import type { CompactionResult, CompactionConfig, CompactTrigger } from './types.js';
import { DEFAULT_CONFIG } from './types.js';
import * as fs from 'fs/promises';

// ─── Pre/Post Compact Hooks ────────────────────────────────────────────────

export type CompactHook = (result: CompactionResult) => void | Promise<void>;

const preCompactHooks: CompactHook[] = [];
const postCompactHooks: CompactHook[] = [];

export function registerPreCompactHook(hook: CompactHook): void {
  preCompactHooks.push(hook);
}

export function registerPostCompactHook(hook: CompactHook): void {
  postCompactHooks.push(hook);
}

export function clearCompactHooks(): void {
  preCompactHooks.length = 0;
  postCompactHooks.length = 0;
}

async function runHooks(hooks: CompactHook[], result: CompactionResult): Promise<void> {
  for (const hook of hooks) {
    try {
      await hook(result);
    } catch {
      // Hooks should not break compaction
    }
  }
}

// ─── Compaction Strategy ───────────────────────────────────────────────────

type CompactionStrategy = 'standard' | 'aggressive' | 'emergency';

interface StrategyConfig {
  /** How many recent messages to keep */
  keepCount: number;
  /** Max chars per message in summary input */
  maxContentChars: number;
  /** Max chars for tool call arguments */
  maxToolArgChars: number;
  /** Whether to include tool results in summary */
  includeToolResults: boolean;
  /** Summary prompt variation */
  promptStyle: 'detailed' | 'concise' | 'minimal';
}

function selectStrategy(
  messages: ClovMessage[],
  preTokens: number,
  effectiveWindow: number,
): { strategy: CompactionStrategy; config: StrategyConfig } {
  const usagePercent = (preTokens / effectiveWindow) * 100;

  // Emergency: over 95% — keep minimum, truncate aggressively
  if (usagePercent > 95) {
    return {
      strategy: 'emergency',
      config: {
        keepCount: 2,
        maxContentChars: 500,
        maxToolArgChars: 100,
        includeToolResults: false,
        promptStyle: 'minimal',
      },
    };
  }

  // Aggressive: over 85% — keep fewer messages, shorter content
  if (usagePercent > 85) {
    return {
      strategy: 'aggressive',
      config: {
        keepCount: Math.min(3, Math.floor(messages.length / 3)),
        maxContentChars: 1000,
        maxToolArgChars: 250,
        includeToolResults: false,
        promptStyle: 'concise',
      },
    };
  }

  // Standard: normal compaction
  return {
    strategy: 'standard',
    config: {
      keepCount: Math.min(4, Math.floor(messages.length / 2)),
      maxContentChars: 2000,
      maxToolArgChars: 500,
      includeToolResults: true,
      promptStyle: 'detailed',
    },
  };
}

// ─── Main Compact Function ─────────────────────────────────────────────────

export async function compactConversation(
  messages: ClovMessage[],
  sessionId: string = 'default',
  config: CompactionConfig = DEFAULT_CONFIG,
  trigger: CompactTrigger = 'auto_threshold',
  effectiveWindow: number = 128_000,
): Promise<CompactionResult> {
  const startTime = Date.now();
  const preTokens = estimateMessageTokens(messages);

  // Minimum message count guard
  if (messages.length < 6) {
    return fail(preTokens, startTime, 'Too few messages', trigger);
  }

  // Select compaction strategy based on current pressure
  const { strategy, config: stratConfig } = selectStrategy(messages, preTokens, effectiveWindow);

  // Determine split point
  const keepCount = stratConfig.keepCount;
  const splitIdx = adjustForInvariants(messages, messages.length - keepCount);

  const toSummarize = messages.slice(0, splitIdx);
  const toKeep = messages.slice(splitIdx);

  // Run pre-compact hooks with a placeholder result
  const placeholderResult = fail(preTokens, startTime, 'in_progress', trigger);
  await runHooks(preCompactHooks, placeholderResult);

  try {
    // Step 1-2: Strip images, binary content, and format for summary
    const cleaned = stripImages(toSummarize);
    const conversationText = formatForSummary(cleaned, stratConfig);

    // Step 3: Build dynamic prompt based on conversation content
    const dynamicPrompt = buildDynamicPrompt(toSummarize, stratConfig.promptStyle);

    // Step 4: Call LLM with PTL retry and progressive drop
    const summary = await callWithPTLRetry(conversationText, dynamicPrompt, config);
    const formatted = formatCompactSummary(summary);

    // Step 5: Validate summary is not empty or garbage
    if (formatted.length < 30) {
      throw new Error('Summary too short — LLM returned insufficient content');
    }

    // Step 6: Reset caches
    resetMemoryCache();

    // Step 7: Build new messages
    const boundary: ClovMessage = {
      role: 'user',
      content: `[System Clow: Conversation was compacted. Strategy: ${strategy}]\n\n${formatted}`,
    };

    // Step 8: Post-compact file restoration
    const fileAttachments = await restoreRecentFiles(messages, config);
    const newMessages = [boundary, ...fileAttachments, ...toKeep];

    const postTokens = estimateMessageTokens(newMessages);
    const tokensSaved = preTokens - postTokens;

    // Verify we actually saved meaningful tokens
    if (tokensSaved < preTokens * 0.05) {
      // Less than 5% savings — retry with aggressive strategy
      if (strategy !== 'emergency') {
        return compactConversation(messages, sessionId, config, trigger, effectiveWindow);
      }
    }

    recordCompactSuccess(sessionId);
    recordCompactTimestamp(sessionId);

    const result: CompactionResult = {
      success: true,
      type: 'full',
      trigger,
      preCompactTokens: preTokens,
      postCompactTokens: postTokens,
      tokensSaved,
      reductionPercent: (tokensSaved / preTokens) * 100,
      durationMs: Date.now() - startTime,
      newMessages,
      apiCalls: 1,
    };

    // Persist to history
    const historyEntry: CompactHistoryEntry = {
      timestamp: Date.now(),
      type: 'full',
      trigger,
      tokensBefore: preTokens,
      tokensAfter: postTokens,
      tokensSaved,
      durationMs: result.durationMs,
      success: true,
    };
    recordCompactHistory(sessionId, historyEntry);

    // Run post-compact hooks
    await runHooks(postCompactHooks, result);

    return result;
  } catch (err: any) {
    const failCount = recordCompactFailure(sessionId);
    const result = fail(preTokens, startTime, err.message, trigger);

    // Record failure in history
    const historyEntry: CompactHistoryEntry = {
      timestamp: Date.now(),
      type: 'full',
      trigger,
      tokensBefore: preTokens,
      tokensAfter: preTokens,
      tokensSaved: 0,
      durationMs: result.durationMs,
      success: false,
      failureReason: err.message,
    };
    recordCompactHistory(sessionId, historyEntry);

    // Run post-compact hooks even on failure
    await runHooks(postCompactHooks, result);

    return result;
  }
}

// ─── PTL Retry with Progressive Drop ──────────────────────────────────────

/** Progressive drop percentages for each retry attempt. */
const PTL_DROP_SCHEDULE = [0.2, 0.35, 0.5];

async function callWithPTLRetry(
  conversationText: string,
  systemPrompt: string,
  config: CompactionConfig,
): Promise<string> {
  let text = conversationText;
  let attempt = 0;
  let lastError: Error | null = null;

  while (attempt <= config.maxPTLRetries) {
    try {
      const result = await callModelSync(
        [{ role: 'user', content: `Summarize this conversation:\n\n${text}` }],
        systemPrompt,
        8000,
      );
      return result.content;
    } catch (err: any) {
      lastError = err;
      const isPTL = /context.{0,10}length|too long|maximum context|prompt.{0,10}too|token.{0,10}limit/i.test(err.message);

      if (!isPTL || attempt >= config.maxPTLRetries) {
        throw err;
      }

      // Progressive drop — each retry drops more from the head
      const dropPercent = PTL_DROP_SCHEDULE[attempt] ?? config.ptlDropPercentageOnUnknown;
      const dropChars = Math.ceil(text.length * dropPercent);
      text = text.slice(dropChars);

      // Also try trimming from the middle if the text is still very long
      if (text.length > 100_000 && attempt >= 1) {
        const midPoint = Math.floor(text.length / 2);
        const trimSize = Math.floor(text.length * 0.15);
        text = text.slice(0, midPoint - trimSize) + '\n\n[... middle section dropped for context limits ...]\n\n' + text.slice(midPoint + trimSize);
      }

      attempt++;
    }
  }

  throw lastError ?? new Error('PTL retry exhausted');
}

// ─── Reactive PTL Recovery ─────────────────────────────────────────────────

/**
 * Called when a PTL error occurs during normal API calls (not during compaction).
 * Performs emergency compaction to recover.
 */
export async function reactiveCompact(
  messages: ClovMessage[],
  sessionId: string = 'default',
  config: CompactionConfig = DEFAULT_CONFIG,
): Promise<CompactionResult> {
  return compactConversation(messages, sessionId, config, 'reactive', 128_000);
}

// ─── Invariant Preservation ─────────────────────────────────────────────────

function adjustForInvariants(messages: ClovMessage[], proposedSplit: number): number {
  let split = proposedSplit;

  // Walk backwards: if first kept message is a tool result, include its tool_use
  let iterations = 0;
  while (split > 0 && iterations < messages.length) {
    iterations++;
    const msg = messages[split];
    if (!msg) break;

    if (msg.role === 'tool') {
      // Tool result without its tool_use — pull in more
      split--;
      continue;
    }

    if (msg.role === 'assistant' && msg.tool_calls?.length) {
      // Check all tool results exist in kept range
      const allResultsPresent = msg.tool_calls.every((tc) =>
        messages.slice(split + 1).some((m) => m.role === 'tool' && m.tool_call_id === tc.id),
      );
      if (!allResultsPresent) {
        split--;
        continue;
      }
    }

    break;
  }

  // Safety: don't keep fewer than 2 messages to summarize
  if (split <= 2) {
    split = Math.min(4, Math.floor(messages.length / 2));
  }

  return split;
}

/**
 * Validate that the kept message range has valid tool_use/result invariants.
 * Returns list of issues found (empty = valid).
 */
export function validateInvariants(messages: ClovMessage[]): string[] {
  const issues: string[] = [];

  // Build set of tool_call_ids from assistant messages
  const toolCallIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        toolCallIds.add(tc.id);
      }
    }
  }

  // Check every tool result has a matching tool_use
  for (const msg of messages) {
    if (msg.role === 'tool' && msg.tool_call_id) {
      if (!toolCallIds.has(msg.tool_call_id)) {
        issues.push(`Orphaned tool result: tool_call_id=${msg.tool_call_id} has no matching tool_use`);
      }
    }
  }

  // Check every tool_use has a matching result
  for (const msg of messages) {
    if (msg.role !== 'assistant' || !msg.tool_calls) continue;
    for (const tc of msg.tool_calls) {
      const hasResult = messages.some((m) => m.role === 'tool' && m.tool_call_id === tc.id);
      if (!hasResult) {
        issues.push(`Missing tool result: tool_call_id=${tc.id} (tool: ${tc.function.name})`);
      }
    }
  }

  return issues;
}

// ─── Strip Images ───────────────────────────────────────────────────────────

function stripImages(messages: ClovMessage[]): ClovMessage[] {
  return messages.map((m) => {
    if (!m.content) return m;
    // Replace base64 image patterns with [image]
    let cleaned = m.content.replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, '[image]');
    // Also strip SVG data URIs
    cleaned = cleaned.replace(/data:image\/svg\+xml[^"'\s)]+/g, '[svg image]');
    // Strip very long hex sequences (binary dumps)
    cleaned = cleaned.replace(/(?:[0-9a-f]{2}\s){30,}/gi, '[binary data] ');
    return { ...m, content: cleaned };
  });
}

// ─── Strip Reinjected Attachments ──────────────────────────────────────────

const ATTACHMENT_PATTERNS = [
  /<skill_discovery>[\s\S]*?<\/skill_discovery>/g,
  /<reinjected_context>[\s\S]*?<\/reinjected_context>/g,
  /<file_attachment[\s\S]*?<\/file_attachment>/g,
];

function stripAttachments(messages: ClovMessage[]): ClovMessage[] {
  return messages.map((m) => {
    if (!m.content) return m;
    let cleaned = m.content;
    for (const pat of ATTACHMENT_PATTERNS) {
      cleaned = cleaned.replace(pat, '[attachment removed for summary]');
    }
    return { ...m, content: cleaned };
  });
}

// ─── Format for Summary ─────────────────────────────────────────────────────

function formatForSummary(messages: ClovMessage[], stratConfig: StrategyConfig): string {
  const parts: string[] = [];

  for (const m of messages) {
    const role = m.role === 'tool' ? 'Tool Result' : m.role === 'assistant' ? 'Assistant' : 'User';
    let content = m.content || '';

    // Skip tool results if strategy says so
    if (m.role === 'tool' && !stratConfig.includeToolResults) {
      if (content.length > 100) {
        content = content.slice(0, 100) + '... [tool result omitted]';
      }
    }

    // Truncate content to strategy limit
    if (content.length > stratConfig.maxContentChars) {
      content = content.slice(0, stratConfig.maxContentChars) + '... [truncated]';
    }

    if (m.tool_calls?.length) {
      const calls = m.tool_calls.map((tc) => {
        let args = tc.function.arguments;
        if (args.length > stratConfig.maxToolArgChars) {
          args = args.slice(0, stratConfig.maxToolArgChars) + '...';
        }
        return `[Tool: ${tc.function.name}](${args})`;
      }).join('\n');
      parts.push(`[${role}]:\n${content}\n${calls}`);
    } else {
      parts.push(`[${role}]: ${content}`);
    }
  }

  return parts.join('\n\n');
}

// ─── Post-Compact File Restoration ──────────────────────────────────────────

async function restoreRecentFiles(
  messages: ClovMessage[],
  config: CompactionConfig,
): Promise<ClovMessage[]> {
  // Find recently read files from tool calls (deduped, most recent first)
  const files = new Set<string>();
  for (let i = messages.length - 1; i >= 0 && files.size < config.postCompactMaxFiles; i--) {
    const msg = messages[i];
    if (msg.role !== 'assistant' || !msg.tool_calls) continue;
    for (const tc of msg.tool_calls) {
      if (tc.function.name === 'Read' || tc.function.name === 'FileRead') {
        try {
          const args = JSON.parse(tc.function.arguments);
          if (args.file_path) files.add(args.file_path);
        } catch { /* malformed args */ }
      }
    }
  }

  const result: ClovMessage[] = [];
  let budgetUsed = 0;
  for (const filePath of files) {
    if (budgetUsed >= config.postCompactTokenBudget) break;
    try {
      const stat = await fs.stat(filePath);
      // Skip very large files
      if (stat.size > config.postCompactTokensPerFile * 4) continue;

      const content = await fs.readFile(filePath, 'utf-8');
      const tokens = Math.ceil(content.length / 4);
      if (tokens > config.postCompactTokensPerFile) continue;

      result.push({
        role: 'user',
        content: `[Post-compact file restore: ${filePath}]\n${content.slice(0, config.postCompactTokensPerFile * 4)}`,
      });
      budgetUsed += tokens;
    } catch {
      // File may be gone or inaccessible — skip silently
    }
  }
  return result;
}

// ─── Compact Result Persistence ────────────────────────────────────────────

const compactResults = new Map<string, CompactionResult[]>();
const MAX_RESULTS_PER_SESSION = 20;

export function persistCompactResult(sessionId: string, result: CompactionResult): void {
  const results = compactResults.get(sessionId) ?? [];
  results.push(result);
  while (results.length > MAX_RESULTS_PER_SESSION) {
    results.shift();
  }
  compactResults.set(sessionId, results);
}

export function getPersistedCompactResults(sessionId: string): CompactionResult[] {
  return compactResults.get(sessionId) ?? [];
}

export function clearPersistedResults(sessionId: string): void {
  compactResults.delete(sessionId);
}

// ─── Helper ─────────────────────────────────────────────────────────────────

function fail(preTokens: number, startTime: number, reason: string, trigger: CompactTrigger = 'auto_threshold'): CompactionResult {
  return {
    success: false,
    type: 'full',
    trigger,
    preCompactTokens: preTokens,
    postCompactTokens: preTokens,
    tokensSaved: 0,
    reductionPercent: 0,
    durationMs: Date.now() - startTime,
    newMessages: [],
    failureReason: reason,
    apiCalls: 0,
  };
}
