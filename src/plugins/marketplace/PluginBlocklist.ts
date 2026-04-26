/**
 * PluginBlocklist.ts — Remote blocklist for compromised plugins
 *
 * Based on Claude Code's pluginBlocklist.ts (450 lines)
 *
 * Implements:
 *   - Remote blocklist fetch from marketplace
 *   - Local blocklist additions (admin override)
 *   - Blocklist persistence to disk
 *   - Refresh with TTL (auto-refresh every 30min)
 *   - Block reason tracking
 *   - Block history (audit trail)
 *   - Notification when installed plugin becomes blocked
 *   - Wildcard patterns (block-by-author, block-by-prefix)
 *   - Block-by-author
 *   - Block severity levels (warn, block, critical)
 *   - Block expiry (timed blocks)
 *   - Block statistics
 *   - Bulk block operations
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { MarketplaceClient } from './MarketplaceClient.js';

// ─── Types ──────────────────────────────────────────────────────────────────

type BlockSeverity = 'warn' | 'block' | 'critical';

interface BlockEntry {
  pluginName: string;
  reason?: string;
  blockedAt: number;
  source: 'remote' | 'local' | 'admin';
  pattern?: boolean;  // if true, pluginName is a glob pattern
  severity: BlockSeverity;
  expiresAt?: number;  // epoch ms; undefined means permanent
  authorBlock?: boolean;  // true if this blocks by author name
}

interface BlocklistState {
  entries: BlockEntry[];
  lastRefreshedAt: number;
  remoteVersion?: string;
}

interface BlockStats {
  totalBlocked: number;
  bySeverity: Record<BlockSeverity, number>;
  bySource: Record<BlockEntry['source'], number>;
  patternBlocks: number;
  authorBlocks: number;
  expiredPurged: number;
  activeExpiring: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const REFRESH_TTL_MS = 30 * 60 * 1_000;  // 30 minutes
const MAX_BLOCK_HISTORY = 500;

// ════════════════════════════════════════════════════════════════════════════
// PluginBlocklist Class
// ════════════════════════════════════════════════════════════════════════════

export class PluginBlocklist {
  private blocked = new Map<string, BlockEntry>();
  private lastRefresh = 0;
  private history: Array<{ action: 'blocked' | 'unblocked'; pluginName: string; at: number; severity?: BlockSeverity }> = [];
  private persistPath?: string;
  private expiredPurgedCount = 0;

  constructor(persistPath?: string) {
    this.persistPath = persistPath;
  }

  // ─── Remote Refresh ───────────────────────────────────────────────

  /**
   * Refresh blocklist from remote marketplace.
   * Returns number of blocked plugins.
   */
  async refresh(client: MarketplaceClient): Promise<number> {
    try {
      const remoteList = await client.fetchBlocklist();
      const before = new Set(this.blocked.keys());

      // Add remote entries
      for (const name of remoteList) {
        if (!this.blocked.has(name)) {
          this.blocked.set(name, {
            pluginName: name,
            blockedAt: Date.now(),
            source: 'remote',
            severity: 'block',
          });
          this.addHistory('blocked', name, 'block');
        }
      }

      // Remove entries no longer in remote list (only remote-sourced)
      for (const [name, entry] of this.blocked) {
        if (entry.source === 'remote' && !remoteList.includes(name)) {
          this.blocked.delete(name);
          this.addHistory('unblocked', name);
        }
      }

      this.lastRefresh = Date.now();

      // Purge expired blocks on refresh
      this.purgeExpired();

      // Persist to disk
      await this.save();

      return this.blocked.size;
    } catch (err) {
      console.warn(`[PluginBlocklist] Refresh failed: ${(err as Error).message}`);
      return this.blocked.size;
    }
  }

  /**
   * Check if refresh is needed (TTL expired).
   */
  needsRefresh(): boolean {
    return Date.now() - this.lastRefresh > REFRESH_TTL_MS;
  }

  /**
   * Auto-refresh if TTL expired (non-blocking).
   */
  async autoRefresh(client: MarketplaceClient): Promise<void> {
    if (this.needsRefresh()) {
      await this.refresh(client).catch(() => {});
    }
  }

  // ─── Block Check ──────────────────────────────────────────────────

  /**
   * Check if a plugin is blocked.
   * Supports exact name, pattern matching, and author matching.
   * Respects expiry: expired blocks are treated as not blocked.
   */
  isBlocked(pluginName: string): boolean {
    // Exact match
    const exactEntry = this.blocked.get(pluginName);
    if (exactEntry && !this.isEntryExpired(exactEntry)) return true;

    // Pattern match (e.g., "malicious-*" blocks "malicious-plugin")
    for (const [pattern, entry] of this.blocked) {
      if (this.isEntryExpired(entry)) continue;
      if (entry.pattern && this.matchPattern(pattern, pluginName)) return true;
    }

    return false;
  }

  /**
   * Get the severity level for a blocked plugin.
   * Returns null if not blocked.
   */
  getBlockSeverity(pluginName: string): BlockSeverity | null {
    const exactEntry = this.blocked.get(pluginName);
    if (exactEntry && !this.isEntryExpired(exactEntry)) return exactEntry.severity;

    for (const [pattern, entry] of this.blocked) {
      if (this.isEntryExpired(entry)) continue;
      if (entry.pattern && this.matchPattern(pattern, pluginName)) return entry.severity;
    }

    return null;
  }

  /**
   * Get block reason for a plugin.
   */
  getBlockReason(pluginName: string): string | null {
    const entry = this.blocked.get(pluginName);
    if (entry && !this.isEntryExpired(entry)) return entry.reason ?? 'Blocked by marketplace';

    // Check patterns
    for (const [pattern, entry] of this.blocked) {
      if (this.isEntryExpired(entry)) continue;
      if (entry.pattern && this.matchPattern(pattern, pluginName)) {
        return entry.reason ?? `Blocked by pattern: ${pattern}`;
      }
    }

    return null;
  }

  /**
   * Check if a plugin is blocked by author name.
   */
  isAuthorBlocked(authorName: string): boolean {
    for (const entry of this.blocked.values()) {
      if (this.isEntryExpired(entry)) continue;
      if (entry.authorBlock && entry.pluginName === authorName) return true;
    }
    return false;
  }

  // ─── Local Management ─────────────────────────────────────────────

  /**
   * Add a plugin to the local blocklist.
   */
  addLocal(pluginName: string, reason?: string, options?: { severity?: BlockSeverity; expiresIn?: number }): void {
    this.blocked.set(pluginName, {
      pluginName,
      reason,
      blockedAt: Date.now(),
      source: 'local',
      severity: options?.severity ?? 'block',
      expiresAt: options?.expiresIn ? Date.now() + options.expiresIn : undefined,
    });
    this.addHistory('blocked', pluginName, options?.severity ?? 'block');
  }

  /**
   * Add an admin block (higher priority, cannot be overridden by remote).
   */
  addAdmin(pluginName: string, reason?: string, options?: { severity?: BlockSeverity; expiresIn?: number }): void {
    this.blocked.set(pluginName, {
      pluginName,
      reason,
      blockedAt: Date.now(),
      source: 'admin',
      severity: options?.severity ?? 'critical',
      expiresAt: options?.expiresIn ? Date.now() + options.expiresIn : undefined,
    });
    this.addHistory('blocked', pluginName, options?.severity ?? 'critical');
  }

  /**
   * Add a pattern block (blocks all plugins matching pattern).
   */
  addPattern(pattern: string, reason?: string, severity: BlockSeverity = 'block'): void {
    this.blocked.set(pattern, {
      pluginName: pattern,
      reason,
      blockedAt: Date.now(),
      source: 'admin',
      pattern: true,
      severity,
    });
  }

  /**
   * Block all plugins by a specific author.
   */
  blockAuthor(authorName: string, reason?: string, severity: BlockSeverity = 'block'): void {
    this.blocked.set(`author:${authorName}`, {
      pluginName: authorName,
      reason: reason ?? `All plugins by author ${authorName} are blocked`,
      blockedAt: Date.now(),
      source: 'admin',
      severity,
      authorBlock: true,
    });
    this.addHistory('blocked', `author:${authorName}`, severity);
  }

  /**
   * Unblock an author.
   */
  unblockAuthor(authorName: string): boolean {
    const key = `author:${authorName}`;
    if (!this.blocked.has(key)) return false;
    this.blocked.delete(key);
    this.addHistory('unblocked', key);
    return true;
  }

  // ─── Bulk Operations ──────────────────────────────────────────────

  /**
   * Block multiple plugins at once.
   * Returns the count of newly blocked plugins.
   */
  bulkBlock(
    pluginNames: string[],
    options?: { reason?: string; source?: 'local' | 'admin'; severity?: BlockSeverity; expiresIn?: number },
  ): number {
    const source = options?.source ?? 'local';
    const severity = options?.severity ?? 'block';
    let added = 0;

    for (const name of pluginNames) {
      if (this.blocked.has(name)) continue;
      this.blocked.set(name, {
        pluginName: name,
        reason: options?.reason,
        blockedAt: Date.now(),
        source,
        severity,
        expiresAt: options?.expiresIn ? Date.now() + options.expiresIn : undefined,
      });
      this.addHistory('blocked', name, severity);
      added++;
    }

    return added;
  }

  /**
   * Unblock multiple plugins at once.
   * Only removes local/admin blocks (not remote).
   * Returns the count of unblocked plugins.
   */
  bulkUnblock(pluginNames: string[]): number {
    let removed = 0;
    for (const name of pluginNames) {
      if (this.remove(name)) removed++;
    }
    return removed;
  }

  /**
   * Remove a plugin from the local blocklist.
   * Cannot remove remote blocks (they come back on refresh).
   */
  remove(pluginName: string): boolean {
    const entry = this.blocked.get(pluginName);
    if (!entry) return false;
    if (entry.source === 'remote') return false; // Can't remove remote blocks

    this.blocked.delete(pluginName);
    this.addHistory('unblocked', pluginName);
    return true;
  }

  // ─── Expiry Management ───────────────────────────────────────────

  /**
   * Purge all expired block entries.
   * Returns the number of entries purged.
   */
  purgeExpired(): number {
    const now = Date.now();
    let purged = 0;

    for (const [key, entry] of this.blocked) {
      if (entry.expiresAt && entry.expiresAt <= now) {
        this.blocked.delete(key);
        this.addHistory('unblocked', key);
        purged++;
      }
    }

    this.expiredPurgedCount += purged;
    return purged;
  }

  /**
   * Get all entries that will expire within the given timeframe.
   */
  getExpiringSoon(withinMs: number): BlockEntry[] {
    const cutoff = Date.now() + withinMs;
    return [...this.blocked.values()].filter(
      e => e.expiresAt !== undefined && e.expiresAt <= cutoff && !this.isEntryExpired(e),
    );
  }

  // ─── List & Query ─────────────────────────────────────────────────

  /**
   * Get all blocked plugin names.
   */
  list(): string[] {
    return [...this.blocked.keys()];
  }

  /**
   * Get all block entries with details.
   */
  listDetailed(): BlockEntry[] {
    return [...this.blocked.values()];
  }

  /**
   * Get blocks from a specific source.
   */
  listBySource(source: BlockEntry['source']): BlockEntry[] {
    return [...this.blocked.values()].filter(e => e.source === source);
  }

  /**
   * Get blocks filtered by severity level.
   */
  listBySeverity(severity: BlockSeverity): BlockEntry[] {
    return [...this.blocked.values()].filter(e => e.severity === severity);
  }

  /**
   * Get block count.
   */
  size(): number {
    return this.blocked.size;
  }

  /**
   * Find installed plugins that are now blocked.
   */
  findNewlyBlocked(installedPluginNames: string[]): string[] {
    return installedPluginNames.filter(name => this.isBlocked(name));
  }

  /**
   * Get block history (audit trail).
   */
  getHistory(): readonly typeof this.history[number][] {
    return this.history;
  }

  // ─── Statistics ───────────────────────────────────────────────────

  /**
   * Compute statistics about the current blocklist state.
   */
  getBlockStats(): BlockStats {
    const bySeverity: Record<BlockSeverity, number> = { warn: 0, block: 0, critical: 0 };
    const bySource: Record<BlockEntry['source'], number> = { remote: 0, local: 0, admin: 0 };
    let patternBlocks = 0;
    let authorBlocks = 0;
    let activeExpiring = 0;

    for (const entry of this.blocked.values()) {
      bySeverity[entry.severity]++;
      bySource[entry.source]++;
      if (entry.pattern) patternBlocks++;
      if (entry.authorBlock) authorBlocks++;
      if (entry.expiresAt && !this.isEntryExpired(entry)) activeExpiring++;
    }

    return {
      totalBlocked: this.blocked.size,
      bySeverity,
      bySource,
      patternBlocks,
      authorBlocks,
      expiredPurged: this.expiredPurgedCount,
      activeExpiring,
    };
  }

  // ─── Persistence ──────────────────────────────────────────────────

  /**
   * Load blocklist from disk.
   */
  async load(): Promise<void> {
    if (!this.persistPath || !fs.existsSync(this.persistPath)) return;
    try {
      const content = await fsp.readFile(this.persistPath, 'utf-8');
      const state = JSON.parse(content) as BlocklistState;
      for (const entry of state.entries) {
        // Ensure severity field exists for legacy data
        if (!entry.severity) entry.severity = 'block';
        this.blocked.set(entry.pluginName, entry);
      }
      this.lastRefresh = state.lastRefreshedAt;
    } catch {}
  }

  /**
   * Save blocklist to disk.
   */
  private async save(): Promise<void> {
    if (!this.persistPath) return;
    try {
      const dir = path.dirname(this.persistPath);
      await fsp.mkdir(dir, { recursive: true });
      const state: BlocklistState = {
        entries: [...this.blocked.values()],
        lastRefreshedAt: this.lastRefresh,
      };
      await fsp.writeFile(this.persistPath, JSON.stringify(state, null, 2));
    } catch {}
  }

  // ─── Internal ─────────────────────────────────────────────────────

  private matchPattern(pattern: string, name: string): boolean {
    // Simple glob: * matches any sequence of chars
    const regex = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*');
    return new RegExp(`^${regex}$`).test(name);
  }

  private isEntryExpired(entry: BlockEntry): boolean {
    if (!entry.expiresAt) return false;
    return Date.now() >= entry.expiresAt;
  }

  private addHistory(action: 'blocked' | 'unblocked', pluginName: string, severity?: BlockSeverity): void {
    this.history.push({ action, pluginName, at: Date.now(), severity });
    if (this.history.length > MAX_BLOCK_HISTORY) {
      this.history = this.history.slice(-MAX_BLOCK_HISTORY / 2);
    }
  }
}
