/**
 * messageState.ts — Mutable message history with immutable snapshots
 *
 * Key patterns from Claude Code (doc 01):
 *   - Mutable array for persistence across turns
 *   - Immutable snapshots for each query loop iteration
 *   - Tombstone system (mark as removed, don't delete)
 *   - UUID dedup via BoundedUUIDSet
 *   - Group by API round (messageId boundaries)
 */

import { randomUUID } from 'crypto';
import type { Message, AssistantMessage, TombstoneMessage, TombstoneReason } from './types.js';

// ═══════════════════════════════════════════════════════════════════════
// BoundedUUIDSet — LRU set for dedup (cap=2000 from doc 13)
// ═══════════════════════════════════════════════════════════════════════

export class BoundedUUIDSet {
  private set: Set<string> = new Set();
  private queue: string[] = [];

  constructor(private readonly cap: number) {}

  has(uuid: string): boolean { return this.set.has(uuid); }

  add(uuid: string): void {
    if (this.set.has(uuid)) return;
    this.set.add(uuid);
    this.queue.push(uuid);
    while (this.queue.length > this.cap) {
      const removed = this.queue.shift()!;
      this.set.delete(removed);
    }
  }

  size(): number { return this.set.size; }
}

// ═══════════════════════════════════════════════════════════════════════
// MessageState
// ═══════════════════════════════════════════════════════════════════════

export class MessageState {
  private mutableMessages: Message[] = [];
  private uuidIndex: Map<string, number> = new Map();
  private messageIdIndex: Map<string, string[]> = new Map(); // messageId → uuids
  private tombstoned: Set<string> = new Set();
  private boundedDedup: BoundedUUIDSet;

  constructor(initial: Message[] = []) {
    this.boundedDedup = new BoundedUUIDSet(2000);
    for (const msg of initial) {
      this.pushInternal(msg);
    }
  }

  // ── Push ──────────────────────────────────────────────────────────

  push(message: Message): void {
    if (this.uuidIndex.has(message.uuid)) {
      throw new Error(`Duplicate message uuid: ${message.uuid}`);
    }
    this.pushInternal(message);
  }

  private pushInternal(message: Message): void {
    const idx = this.mutableMessages.length;
    this.mutableMessages.push(message);
    this.uuidIndex.set(message.uuid, idx);

    if (message.type === 'assistant' && message.messageId) {
      const existing = this.messageIdIndex.get(message.messageId) ?? [];
      existing.push(message.uuid);
      this.messageIdIndex.set(message.messageId, existing);
    }
  }

  // ── Snapshot (immutable view, excludes tombstoned) ────────────────

  snapshot(): Message[] {
    return this.mutableMessages.filter(
      (m) => m.type !== 'tombstone' && !this.tombstoned.has(m.uuid),
    );
  }

  // ── Find ──────────────────────────────────────────────────────────

  findLast(predicate: (m: Message) => boolean): Message | undefined {
    for (let i = this.mutableMessages.length - 1; i >= 0; i--) {
      const m = this.mutableMessages[i];
      if (m.type === 'tombstone' || this.tombstoned.has(m.uuid)) continue;
      if (predicate(m)) return m;
    }
    return undefined;
  }

  getByUuid(uuid: string): Message | undefined {
    const idx = this.uuidIndex.get(uuid);
    return idx !== undefined ? this.mutableMessages[idx] : undefined;
  }

  // ── Tombstone ─────────────────────────────────────────────────────

  tombstone(uuid: string, reason: TombstoneReason): TombstoneMessage {
    if (!this.uuidIndex.has(uuid)) {
      throw new Error(`Cannot tombstone unknown uuid: ${uuid}`);
    }
    this.tombstoned.add(uuid);
    const ts: TombstoneMessage = {
      type: 'tombstone',
      uuid: randomUUID(),
      removedUuid: uuid,
      reason,
      timestamp: Date.now(),
    };
    this.mutableMessages.push(ts);
    return ts;
  }

  tombstoneByMessageId(messageId: string, reason: TombstoneReason): TombstoneMessage[] {
    const uuids = this.messageIdIndex.get(messageId) ?? [];
    return uuids.map((uuid) => this.tombstone(uuid, reason));
  }

  isTombstoned(uuid: string): boolean {
    return this.tombstoned.has(uuid);
  }

  // ── Group by API Round ────────────────────────────────────────────

  groupByApiRound(): Message[][] {
    const groups: Message[][] = [];
    let current: Message[] = [];
    let currentMessageId: string | undefined;

    for (const msg of this.snapshot()) {
      if (msg.type === 'assistant') {
        const am = msg as AssistantMessage;
        if (am.messageId !== currentMessageId) {
          if (current.length > 0) groups.push(current);
          current = [];
          currentMessageId = am.messageId;
        }
      }
      current.push(msg);
    }
    if (current.length > 0) groups.push(current);
    return groups;
  }

  // ── Replace (compaction) ──────────────────────────────────────────

  replace(newMessages: Message[]): void {
    this.mutableMessages = [];
    this.uuidIndex.clear();
    this.messageIdIndex.clear();
    this.tombstoned.clear();
    for (const msg of newMessages) {
      this.pushInternal(msg);
    }
  }

  // ── Dedup ─────────────────────────────────────────────────────────

  isDuplicate(uuid: string): boolean { return this.boundedDedup.has(uuid); }
  markSeen(uuid: string): void { this.boundedDedup.add(uuid); }

  // ── Size ──────────────────────────────────────────────────────────

  size(): number {
    return this.mutableMessages.length - this.tombstoned.size;
  }

  rawSize(): number {
    return this.mutableMessages.length;
  }

  tombstonedCount(): number {
    return this.tombstoned.size;
  }

  isEmpty(): boolean {
    return this.size() === 0;
  }

  // ── Token Estimation ─────────────────────────────────────────────

  /**
   * Estimate total token count across all active messages.
   * Uses a simple char/4 heuristic.
   */
  estimateTokens(): number {
    let totalChars = 0;
    for (const msg of this.snapshot()) {
      if (msg.type === 'user' || msg.type === 'assistant' || msg.type === 'system') {
        totalChars += (msg.content?.length ?? 0);
      }
    }
    return Math.ceil(totalChars / 4);
  }

  /**
   * Get count of messages by type.
   */
  countByType(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const msg of this.snapshot()) {
      counts[msg.type] = (counts[msg.type] ?? 0) + 1;
    }
    return counts;
  }

  /**
   * Get count of messages by role (user/assistant/system).
   */
  countByRole(): { user: number; assistant: number; system: number; other: number } {
    let user = 0, assistant = 0, system = 0, other = 0;
    for (const msg of this.snapshot()) {
      if (msg.type === 'user') user++;
      else if (msg.type === 'assistant') assistant++;
      else if (msg.type === 'system') system++;
      else other++;
    }
    return { user, assistant, system, other };
  }

  // ── Search & Filter ──────────────────────────────────────────────

  /**
   * Find all messages matching a predicate.
   */
  findAll(predicate: (m: Message) => boolean): Message[] {
    return this.snapshot().filter(predicate);
  }

  /**
   * Find the first message matching a predicate.
   */
  findFirst(predicate: (m: Message) => boolean): Message | undefined {
    for (const msg of this.snapshot()) {
      if (predicate(msg)) return msg;
    }
    return undefined;
  }

  /**
   * Get the last N messages.
   */
  tail(n: number): Message[] {
    const snap = this.snapshot();
    return snap.slice(Math.max(0, snap.length - n));
  }

  /**
   * Get the first N messages.
   */
  head(n: number): Message[] {
    return this.snapshot().slice(0, n);
  }

  /**
   * Get messages within a turn number range.
   */
  getMessagesForTurn(turnNumber: number): Message[] {
    return this.snapshot().filter(m => {
      if ('turnNumber' in m) return (m as any).turnNumber === turnNumber;
      return false;
    });
  }

  /**
   * Get the latest assistant message.
   */
  getLastAssistantMessage(): AssistantMessage | undefined {
    return this.findLast(m => m.type === 'assistant') as AssistantMessage | undefined;
  }

  /**
   * Get the latest user message.
   */
  getLastUserMessage(): Message | undefined {
    return this.findLast(m => m.type === 'user');
  }

  // ── Tool Call Tracking ───────────────────────────────────────────

  /**
   * Get all unique tool names used in the conversation.
   */
  getToolsUsed(): string[] {
    const tools = new Set<string>();
    for (const msg of this.snapshot()) {
      if (msg.type === 'assistant') {
        const am = msg as AssistantMessage;
        if (am.toolCalls) {
          for (const tc of am.toolCalls) {
            tools.add(tc.name);
          }
        }
      }
    }
    return [...tools];
  }

  /**
   * Count tool calls in the conversation.
   */
  countToolCalls(): number {
    let count = 0;
    for (const msg of this.snapshot()) {
      if (msg.type === 'assistant') {
        const am = msg as AssistantMessage;
        count += am.toolCalls?.length ?? 0;
      }
    }
    return count;
  }

  // ── Diagnostics ──────────────────────────────────────────────────

  /**
   * Get a summary of the message state for diagnostics.
   */
  getSummary(): {
    totalMessages: number;
    activeMessages: number;
    tombstonedMessages: number;
    estimatedTokens: number;
    apiRounds: number;
    toolsUsed: string[];
    roleBreakdown: Record<string, number>;
  } {
    return {
      totalMessages: this.rawSize(),
      activeMessages: this.size(),
      tombstonedMessages: this.tombstoned.size,
      estimatedTokens: this.estimateTokens(),
      apiRounds: this.groupByApiRound().length,
      toolsUsed: this.getToolsUsed(),
      roleBreakdown: this.countByRole() as unknown as Record<string, number>,
    };
  }

  // ── Serialization ────────────────────────────────────────────────

  /**
   * Serialize active messages for persistence.
   */
  serialize(): string {
    return JSON.stringify(this.snapshot().map(m => ({
      type: m.type,
      uuid: m.uuid,
      timestamp: m.timestamp,
      content: 'content' in m ? (m as any).content : undefined,
      toolCalls: 'toolCalls' in m ? (m as any).toolCalls : undefined,
    })));
  }

  /**
   * Get messages formatted for the active model API.
   */
  toApiFormat(): Array<{ role: string; content: string; tool_calls?: unknown[]; tool_call_id?: string }> {
    return this.snapshot().map(msg => {
      if (msg.type === 'assistant') {
        const am = msg as AssistantMessage;
        const result: any = { role: 'assistant', content: am.content };
        if (am.toolCalls?.length) {
          result.tool_calls = am.toolCalls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: tc.arguments },
          }));
        }
        return result;
      }
      if (msg.type === 'user' && (msg as any).source === 'tool_result') {
        return { role: 'tool', content: msg.type === 'user' ? (msg as any).content : '', tool_call_id: (msg as any).toolCallId };
      }
      if (msg.type === 'system') {
        return { role: 'user', content: `[System: ${(msg as any).subtype}] ${(msg as any).content}` };
      }
      return { role: msg.type, content: 'content' in msg ? (msg as any).content : '' };
    });
  }

  // ── Message Content Search ───────────────────────────────────────

  /**
   * Search messages by content text.
   */
  searchContent(query: string, maxResults: number = 10): Array<{ message: Message; matchIndex: number }> {
    const results: Array<{ message: Message; matchIndex: number }> = [];
    const q = query.toLowerCase();

    for (const msg of this.snapshot()) {
      if (results.length >= maxResults) break;
      const content = 'content' in msg ? String((msg as any).content ?? '') : '';
      const idx = content.toLowerCase().indexOf(q);
      if (idx !== -1) {
        results.push({ message: msg, matchIndex: idx });
      }
    }

    return results;
  }

  /**
   * Get all messages that mention a specific file path.
   */
  getMessagesAboutFile(filePath: string): Message[] {
    const normalized = filePath.replace(/\\/g, '/');
    return this.snapshot().filter(msg => {
      const content = 'content' in msg ? String((msg as any).content ?? '') : '';
      return content.includes(filePath) || content.includes(normalized);
    });
  }

  /**
   * Calculate the conversation "depth" (max nesting of tool calls).
   */
  getConversationDepth(): number {
    let maxDepth = 0;
    let currentDepth = 0;

    for (const msg of this.snapshot()) {
      if (msg.type === 'assistant') {
        const am = msg as AssistantMessage;
        if (am.toolCalls?.length) {
          currentDepth += am.toolCalls.length;
          if (currentDepth > maxDepth) maxDepth = currentDepth;
        }
      }
      if (msg.type === 'user' && (msg as any).source === 'tool_result') {
        currentDepth = Math.max(0, currentDepth - 1);
      }
    }

    return maxDepth;
  }

  /**
   * Get the most recently used tool names (for UI suggestion).
   */
  getRecentToolNames(limit: number = 5): string[] {
    const tools: string[] = [];
    const seen = new Set<string>();

    for (let i = this.mutableMessages.length - 1; i >= 0 && tools.length < limit; i--) {
      const msg = this.mutableMessages[i];
      if (msg.type === 'assistant') {
        const am = msg as AssistantMessage;
        for (const tc of am.toolCalls ?? []) {
          if (!seen.has(tc.name)) {
            seen.add(tc.name);
            tools.push(tc.name);
          }
        }
      }
    }

    return tools;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Message Compression for Long Conversations
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Compress messages by summarizing older tool results.
   * Keeps the last N messages intact and compresses older tool results
   * into shorter summaries to save context window space.
   *
   * @param keepRecentCount - Number of recent messages to keep uncompressed
   * @param maxToolResultLength - Max chars for old tool results (truncated beyond)
   * @returns Number of messages that were compressed
   */
  compressOldToolResults(keepRecentCount: number = 20, maxToolResultLength: number = 200): number {
    const snap = this.snapshot();
    if (snap.length <= keepRecentCount) return 0;

    let compressedCount = 0;
    const cutoff = snap.length - keepRecentCount;

    for (let i = 0; i < cutoff; i++) {
      const msg = snap[i];
      if (msg.type === 'user' && (msg as any).source === 'tool_result') {
        const content = (msg as any).content as string;
        if (content && content.length > maxToolResultLength) {
          const idx = this.uuidIndex.get(msg.uuid);
          if (idx !== undefined) {
            const truncated = content.slice(0, maxToolResultLength) + `\n[... ${content.length - maxToolResultLength} chars compressed ...]`;
            (this.mutableMessages[idx] as any).content = truncated;
            compressedCount++;
          }
        }
      }
    }

    return compressedCount;
  }

  /**
   * Get the total character count of all message contents.
   * Useful for monitoring conversation size growth.
   */
  getTotalContentLength(): number {
    let total = 0;
    for (const msg of this.snapshot()) {
      if ('content' in msg) {
        total += String((msg as any).content ?? '').length;
      }
    }
    return total;
  }

  /**
   * Get the compression ratio if old messages were compressed.
   * Returns the ratio of current content length to what it would be uncompressed.
   */
  getCompressionStats(): {
    currentLength: number;
    messageCount: number;
    avgMessageLength: number;
    longestMessage: { uuid: string; length: number } | null;
  } {
    const snap = this.snapshot();
    let currentLength = 0;
    let longest: { uuid: string; length: number } | null = null;

    for (const msg of snap) {
      const content = 'content' in msg ? String((msg as any).content ?? '') : '';
      const len = content.length;
      currentLength += len;
      if (!longest || len > longest.length) {
        longest = { uuid: msg.uuid, length: len };
      }
    }

    return {
      currentLength,
      messageCount: snap.length,
      avgMessageLength: snap.length > 0 ? Math.round(currentLength / snap.length) : 0,
      longestMessage: longest,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Message Priority Scoring
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Score messages by importance for context window management.
   * Higher scores indicate messages that should be kept during compaction.
   *
   * Scoring criteria:
   *   - Recent messages score higher (recency bonus)
   *   - User messages score higher than tool results
   *   - Assistant messages with tool calls score higher
   *   - System messages score based on subtype importance
   *
   * @returns Array of { uuid, score } sorted by score descending
   */
  scorePriorities(): Array<{ uuid: string; type: string; score: number; reason: string }> {
    const snap = this.snapshot();
    const results: Array<{ uuid: string; type: string; score: number; reason: string }> = [];
    const total = snap.length;

    for (let i = 0; i < snap.length; i++) {
      const msg = snap[i];
      let score = 0;
      let reason = '';

      // Recency bonus: 0-50 points based on position
      const recencyScore = Math.round((i / Math.max(1, total - 1)) * 50);
      score += recencyScore;

      // Type-based scoring
      switch (msg.type) {
        case 'user': {
          const um = msg as any;
          if (um.source === 'user') {
            score += 40;
            reason = 'user_prompt';
          } else if (um.source === 'tool_result') {
            score += 15;
            reason = 'tool_result';
          } else {
            score += 20;
            reason = `user_${um.source}`;
          }
          break;
        }
        case 'assistant': {
          const am = msg as AssistantMessage;
          if (am.toolCalls && am.toolCalls.length > 0) {
            score += 35;
            reason = 'assistant_with_tools';
          } else {
            score += 30;
            reason = 'assistant_text';
          }
          break;
        }
        case 'system': {
          score += 10;
          reason = 'system';
          break;
        }
        default: {
          score += 5;
          reason = msg.type;
        }
      }

      results.push({ uuid: msg.uuid, type: msg.type, score, reason });
    }

    return results.sort((a, b) => b.score - a.score);
  }

  /**
   * Get the least important messages (candidates for removal during compaction).
   *
   * @param count - Number of low-priority messages to return
   */
  getLeastImportant(count: number): Array<{ uuid: string; type: string; score: number }> {
    const scored = this.scorePriorities();
    return scored.slice(-count).reverse();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Conversation Threading Support
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Build conversation threads from message history.
   * Groups messages into logical threads based on user prompts
   * and their corresponding assistant responses + tool results.
   *
   * @returns Array of threads, each containing related messages
   */
  buildThreads(): Array<{
    threadId: string;
    startTimestamp: number;
    endTimestamp: number;
    messages: Message[];
    userPrompt: string;
    toolsUsed: string[];
    hasError: boolean;
  }> {
    const snap = this.snapshot();
    const threads: Array<{
      threadId: string;
      startTimestamp: number;
      endTimestamp: number;
      messages: Message[];
      userPrompt: string;
      toolsUsed: string[];
      hasError: boolean;
    }> = [];

    let currentThread: Message[] = [];
    let currentUserPrompt = '';
    let threadIndex = 0;

    for (const msg of snap) {
      // A new user message (not a tool result) starts a new thread
      if (msg.type === 'user' && (msg as any).source === 'user') {
        if (currentThread.length > 0) {
          const tools = new Set<string>();
          let hasError = false;
          for (const m of currentThread) {
            if (m.type === 'assistant') {
              for (const tc of (m as AssistantMessage).toolCalls ?? []) {
                tools.add(tc.name);
              }
            }
            if (m.type === 'user' && (m as any).source === 'tool_result') {
              const content = String((m as any).content ?? '');
              if (content.startsWith('Error:') || content.startsWith('Tool error:')) {
                hasError = true;
              }
            }
          }
          threads.push({
            threadId: `thread_${threadIndex}`,
            startTimestamp: currentThread[0].timestamp,
            endTimestamp: currentThread[currentThread.length - 1].timestamp,
            messages: currentThread,
            userPrompt: currentUserPrompt,
            toolsUsed: [...tools],
            hasError,
          });
          threadIndex++;
        }
        currentThread = [msg];
        currentUserPrompt = String((msg as any).content ?? '');
      } else {
        currentThread.push(msg);
      }
    }

    // Push the last thread
    if (currentThread.length > 0) {
      const tools = new Set<string>();
      let hasError = false;
      for (const m of currentThread) {
        if (m.type === 'assistant') {
          for (const tc of (m as AssistantMessage).toolCalls ?? []) {
            tools.add(tc.name);
          }
        }
      }
      threads.push({
        threadId: `thread_${threadIndex}`,
        startTimestamp: currentThread[0].timestamp,
        endTimestamp: currentThread[currentThread.length - 1].timestamp,
        messages: currentThread,
        userPrompt: currentUserPrompt,
        toolsUsed: [...tools],
        hasError,
      });
    }

    return threads;
  }

  /**
   * Get the current thread (messages since the last user prompt).
   */
  getCurrentThread(): Message[] {
    const snap = this.snapshot();
    const result: Message[] = [];

    for (let i = snap.length - 1; i >= 0; i--) {
      result.unshift(snap[i]);
      if (snap[i].type === 'user' && (snap[i] as any).source === 'user') {
        break;
      }
    }

    return result;
  }

  /**
   * Get a thread by its index.
   *
   * @param threadIndex - Zero-based thread index
   */
  getThreadByIndex(threadIndex: number): Message[] | null {
    const threads = this.buildThreads();
    if (threadIndex < 0 || threadIndex >= threads.length) return null;
    return threads[threadIndex].messages;
  }
}
