/**
 * PluginTrust.ts — Plugin-specific trust management
 *
 * Based on Claude Code's workspace trust patterns (250 lines)
 *
 * Implements:
 *   - Per-plugin trust records (persisted to disk)
 *   - Version-pinned trust (re-trust needed on major version bump)
 *   - Content hash trust (detect if plugin was modified)
 *   - Trust history (audit trail)
 *   - Interactive trust prompt
 *   - Bulk trust operations with filtering
 *   - Trust expiry management
 *   - Trust migration (from old format)
 *   - Trust statistics and reporting
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import type { PluginTrustRecord } from '../types.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const TRUST_FILE_VERSION = 1;
const MAX_TRUST_HISTORY = 100;

/** Default trust expiry duration: 90 days in milliseconds */
const DEFAULT_TRUST_EXPIRY_MS = 90 * 24 * 60 * 60_000;

// ─── Trust History Entry ────────────────────────────────────────────────────

interface TrustHistoryEntry {
  pluginName: string;
  action: 'trusted' | 'revoked' | 'blocked' | 'expired' | 'migrated';
  version?: string;
  timestamp: number;
  reason?: string;
}

// ─── Legacy Trust Format ────────────────────────────────────────────────────

/**
 * Represents the v0 trust record layout that was stored before the
 * introduction of TRUST_FILE_VERSION.  Used by the migration logic.
 */
interface LegacyTrustRecord {
  name: string;
  isTrusted: boolean;
  date?: string;
  hash?: string;
  ver?: string;
}

// ─── Trust Statistics ───────────────────────────────────────────────────────

/** Aggregate statistics about the trust store */
export interface TrustStatistics {
  /** Total number of trust records on disk */
  totalRecords: number;
  /** Number of currently-trusted plugins */
  trustedCount: number;
  /** Number of revoked/untrusted records */
  revokedCount: number;
  /** Number of trust records that have expired */
  expiredCount: number;
  /** Number of history entries recorded this session */
  historyLength: number;
  /** Oldest trust timestamp (ms since epoch), or null if no records */
  oldestTrustTimestamp: number | null;
  /** Newest trust timestamp (ms since epoch), or null if no records */
  newestTrustTimestamp: number | null;
}

// ─── Bulk Filter ────────────────────────────────────────────────────────────

/** Filter criteria for bulk trust operations */
export interface TrustFilter {
  /** Only match plugins whose name contains this substring (case-insensitive) */
  nameContains?: string;
  /** Only match plugins trusted before this timestamp */
  trustedBefore?: number;
  /** Only match plugins trusted after this timestamp */
  trustedAfter?: number;
  /** Only match plugins with a specific trust state */
  trusted?: boolean;
}

// ════════════════════════════════════════════════════════════════════════════
// PluginTrust Class
// ════════════════════════════════════════════════════════════════════════════

export class PluginTrust {
  private history: TrustHistoryEntry[] = [];

  /** When non-null, trust records older than this many ms are considered expired */
  private trustExpiryMs: number | null = null;

  constructor(private readonly trustDir: string) {}

  // ─── Trust Expiry Configuration ──────────────────────────────────

  /**
   * Enable trust expiry.  After `durationMs` milliseconds a trust record
   * is considered expired and `isTrusted` will return `false`.
   *
   * @param durationMs  Expiry duration.  Pass `null` to disable expiry.
   */
  setTrustExpiry(durationMs: number | null): void {
    this.trustExpiryMs = durationMs;
  }

  /**
   * Enable trust expiry with the default duration (90 days).
   */
  enableDefaultExpiry(): void {
    this.trustExpiryMs = DEFAULT_TRUST_EXPIRY_MS;
  }

  /**
   * Check whether a trust record has expired based on the configured
   * expiry duration.  Returns `false` when expiry is disabled.
   */
  private isRecordExpired(record: PluginTrustRecord): boolean {
    if (this.trustExpiryMs === null) return false;
    if (!record.trustedAt) return false;
    return Date.now() - record.trustedAt > this.trustExpiryMs;
  }

  // ─── Trust Check ──────────────────────────────────────────────────

  /**
   * Check if a plugin is trusted.
   * Optionally validates version and content hash.
   */
  async isTrusted(
    pluginName: string,
    options: { version?: string; contentHash?: string } = {},
  ): Promise<boolean> {
    const record = await this.loadRecord(pluginName);
    if (!record || !record.trusted) return false;

    // Expiry check
    if (this.isRecordExpired(record)) {
      this.addHistory(pluginName, 'expired', record.version, 'Trust record expired');
      return false;
    }

    // Version check: if trust was for a specific version, verify it matches
    if (options.version && record.version) {
      const trustedMajor = record.version.split('.')[0];
      const currentMajor = options.version.split('.')[0];
      // Major version bump requires re-trust
      if (trustedMajor !== currentMajor) return false;
    }

    // Content hash check: detect if plugin was modified since trust
    if (options.contentHash && record.contentHash) {
      if (record.contentHash !== options.contentHash) return false;
    }

    return true;
  }

  /**
   * Check if a plugin is explicitly blocked.
   */
  async isBlocked(pluginName: string): Promise<boolean> {
    const record = await this.loadRecord(pluginName);
    return record?.trusted === false && this.history.some(
      h => h.pluginName === pluginName && h.action === 'blocked',
    );
  }

  /**
   * Check if a specific trust record has expired.
   * Returns `false` if expiry is not enabled or no record exists.
   */
  async isExpired(pluginName: string): Promise<boolean> {
    const record = await this.loadRecord(pluginName);
    if (!record || !record.trusted) return false;
    return this.isRecordExpired(record);
  }

  // ─── Trust Management ─────────────────────────────────────────────

  /**
   * Trust a plugin. Persists to disk.
   */
  async trust(
    pluginName: string,
    options: { version?: string; contentHash?: string; reason?: string } = {},
  ): Promise<void> {
    const record: PluginTrustRecord = {
      pluginName,
      trusted: true,
      trustedAt: Date.now(),
      trustedBy: `pid:${process.pid}`,
      version: options.version,
      contentHash: options.contentHash,
    };

    await this.saveRecord(pluginName, record);
    this.addHistory(pluginName, 'trusted', options.version, options.reason);
  }

  /**
   * Revoke trust for a plugin.
   */
  async revoke(pluginName: string, reason?: string): Promise<void> {
    const record: PluginTrustRecord = {
      pluginName,
      trusted: false,
      trustedAt: Date.now(),
    };

    await this.saveRecord(pluginName, record);
    this.addHistory(pluginName, 'revoked', undefined, reason);
  }

  /**
   * Block a plugin (stronger than revoke — marks as explicitly dangerous).
   */
  async block(pluginName: string, reason?: string): Promise<void> {
    const record: PluginTrustRecord = {
      pluginName,
      trusted: false,
      trustedAt: Date.now(),
    };

    await this.saveRecord(pluginName, record);
    this.addHistory(pluginName, 'blocked', undefined, reason);
  }

  /**
   * Renew trust for a plugin whose record has (or is about to) expire.
   * This is equivalent to calling `trust` again but preserves the original
   * version and content hash when they are not re-supplied.
   */
  async renewTrust(
    pluginName: string,
    options: { version?: string; contentHash?: string } = {},
  ): Promise<boolean> {
    const existing = await this.loadRecord(pluginName);
    if (!existing) return false;

    const record: PluginTrustRecord = {
      pluginName,
      trusted: true,
      trustedAt: Date.now(),
      trustedBy: `pid:${process.pid}`,
      version: options.version ?? existing.version,
      contentHash: options.contentHash ?? existing.contentHash,
    };

    await this.saveRecord(pluginName, record);
    this.addHistory(pluginName, 'trusted', record.version, 'Trust renewed');
    return true;
  }

  // ─── Bulk Operations ──────────────────────────────────────────────

  /**
   * Trust multiple plugins at once.
   */
  async trustMany(pluginNames: string[]): Promise<void> {
    for (const name of pluginNames) {
      await this.trust(name);
    }
  }

  /**
   * Revoke trust for all plugins.
   */
  async revokeAll(): Promise<void> {
    if (!fs.existsSync(this.trustDir)) return;
    const files = await fsp.readdir(this.trustDir);
    for (const file of files) {
      if (file.endsWith('.json')) {
        try { await fsp.unlink(path.join(this.trustDir, file)); } catch {}
      }
    }
  }

  /**
   * Perform a bulk trust operation on all records matching a filter.
   * Returns the number of records affected.
   *
   * @param filter   Criteria to select which records to act on
   * @param action   The trust action to perform on matching records
   * @param reason   Optional reason recorded in the history
   */
  async bulkUpdate(
    filter: TrustFilter,
    action: 'trust' | 'revoke' | 'block',
    reason?: string,
  ): Promise<number> {
    const all = await this.listAllRecords();
    let affected = 0;

    for (const record of all) {
      if (!this.matchesFilter(record, filter)) continue;

      switch (action) {
        case 'trust':
          await this.trust(record.pluginName, { reason });
          break;
        case 'revoke':
          await this.revoke(record.pluginName, reason);
          break;
        case 'block':
          await this.block(record.pluginName, reason);
          break;
      }
      affected++;
    }

    return affected;
  }

  /**
   * Renew trust for all records that will expire within the given
   * `withinMs` window.  Returns the number of records renewed.
   */
  async renewExpiring(withinMs: number): Promise<number> {
    if (this.trustExpiryMs === null) return 0;

    const all = await this.listAllRecords();
    let renewed = 0;

    for (const record of all) {
      if (!record.trusted || !record.trustedAt) continue;
      const age = Date.now() - record.trustedAt;
      const remaining = this.trustExpiryMs - age;
      if (remaining > 0 && remaining <= withinMs) {
        await this.renewTrust(record.pluginName);
        renewed++;
      }
    }

    return renewed;
  }

  /**
   * Test whether a trust record matches a TrustFilter.
   */
  private matchesFilter(record: PluginTrustRecord, filter: TrustFilter): boolean {
    if (filter.nameContains !== undefined) {
      if (!record.pluginName.toLowerCase().includes(filter.nameContains.toLowerCase())) {
        return false;
      }
    }
    if (filter.trusted !== undefined && record.trusted !== filter.trusted) {
      return false;
    }
    if (filter.trustedBefore !== undefined && record.trustedAt !== undefined) {
      if (record.trustedAt >= filter.trustedBefore) return false;
    }
    if (filter.trustedAfter !== undefined && record.trustedAt !== undefined) {
      if (record.trustedAt <= filter.trustedAfter) return false;
    }
    return true;
  }

  // ─── List & Query ─────────────────────────────────────────────────

  /**
   * List all trusted plugins.
   */
  async listTrusted(): Promise<PluginTrustRecord[]> {
    if (!fs.existsSync(this.trustDir)) return [];
    const records: PluginTrustRecord[] = [];
    const files = await fsp.readdir(this.trustDir);

    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const content = await fsp.readFile(path.join(this.trustDir, file), 'utf-8');
        const record = JSON.parse(content) as PluginTrustRecord;
        if (record.trusted) records.push(record);
      } catch {}
    }

    return records;
  }

  /**
   * List every trust record (trusted and revoked) on disk.
   */
  async listAllRecords(): Promise<PluginTrustRecord[]> {
    if (!fs.existsSync(this.trustDir)) return [];
    const records: PluginTrustRecord[] = [];
    const files = await fsp.readdir(this.trustDir);

    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const content = await fsp.readFile(path.join(this.trustDir, file), 'utf-8');
        const parsed = JSON.parse(content) as PluginTrustRecord & { _version?: number };
        records.push(parsed);
      } catch {}
    }

    return records;
  }

  /**
   * Get trust history (audit trail).
   */
  getHistory(): readonly TrustHistoryEntry[] {
    return this.history;
  }

  /**
   * Get the trust record for a specific plugin.
   */
  async getRecord(pluginName: string): Promise<PluginTrustRecord | null> {
    return this.loadRecord(pluginName);
  }

  // ─── Trust Statistics & Reporting ─────────────────────────────────

  /**
   * Compute aggregate statistics about the current trust store.
   */
  async getStatistics(): Promise<TrustStatistics> {
    const records = await this.listAllRecords();
    let trustedCount = 0;
    let revokedCount = 0;
    let expiredCount = 0;
    let oldest: number | null = null;
    let newest: number | null = null;

    for (const record of records) {
      if (record.trusted) {
        if (this.isRecordExpired(record)) {
          expiredCount++;
        } else {
          trustedCount++;
        }
      } else {
        revokedCount++;
      }

      if (record.trustedAt !== undefined) {
        if (oldest === null || record.trustedAt < oldest) oldest = record.trustedAt;
        if (newest === null || record.trustedAt > newest) newest = record.trustedAt;
      }
    }

    return {
      totalRecords: records.length,
      trustedCount,
      revokedCount,
      expiredCount,
      historyLength: this.history.length,
      oldestTrustTimestamp: oldest,
      newestTrustTimestamp: newest,
    };
  }

  /**
   * Produce a human-readable summary of the trust store for logging or
   * administrative display.
   */
  async generateReport(): Promise<string> {
    const stats = await this.getStatistics();
    const lines: string[] = [
      '=== Trust Store Report ===',
      `Generated: ${new Date().toISOString()}`,
      `Total records: ${stats.totalRecords}`,
      `  Trusted:  ${stats.trustedCount}`,
      `  Revoked:  ${stats.revokedCount}`,
      `  Expired:  ${stats.expiredCount}`,
      `History entries (session): ${stats.historyLength}`,
    ];

    if (stats.oldestTrustTimestamp !== null) {
      lines.push(`Oldest trust: ${new Date(stats.oldestTrustTimestamp).toISOString()}`);
    }
    if (stats.newestTrustTimestamp !== null) {
      lines.push(`Newest trust: ${new Date(stats.newestTrustTimestamp).toISOString()}`);
    }

    if (this.trustExpiryMs !== null) {
      const days = Math.round(this.trustExpiryMs / (24 * 60 * 60_000));
      lines.push(`Expiry policy: ${days} day(s)`);
    } else {
      lines.push('Expiry policy: disabled');
    }

    return lines.join('\n');
  }

  // ─── Trust Migration ──────────────────────────────────────────────

  /**
   * Migrate trust records from the legacy v0 format to the current format.
   * The legacy format stored records with `{ name, isTrusted, date, hash, ver }`.
   *
   * @param legacyDir  Path to the directory containing legacy trust files.
   * @returns Number of records successfully migrated.
   */
  async migrateFromLegacy(legacyDir: string): Promise<number> {
    if (!fs.existsSync(legacyDir)) return 0;

    const files = await fsp.readdir(legacyDir);
    let migrated = 0;

    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const fullPath = path.join(legacyDir, file);
      try {
        const raw = await fsp.readFile(fullPath, 'utf-8');
        const legacy = JSON.parse(raw) as Partial<LegacyTrustRecord>;

        // Skip files that already have the new format marker
        if ((legacy as Record<string, unknown>)['_version'] !== undefined) continue;

        if (!legacy.name) continue;

        const record: PluginTrustRecord = {
          pluginName: legacy.name,
          trusted: legacy.isTrusted === true,
          trustedAt: legacy.date ? new Date(legacy.date).getTime() : Date.now(),
          trustedBy: 'migration',
          version: legacy.ver,
          contentHash: legacy.hash,
        };

        await this.saveRecord(record.pluginName, record);
        this.addHistory(record.pluginName, 'migrated', record.version, 'Migrated from legacy v0 format');
        migrated++;
      } catch {
        // Skip unparseable files
      }
    }

    return migrated;
  }

  // ─── Content Hash ─────────────────────────────────────────────────

  /**
   * Compute content hash for a plugin directory.
   * Used to detect modification after trust.
   */
  static async computeContentHash(pluginDir: string): Promise<string> {
    const hash = crypto.createHash('sha256');
    const files = await PluginTrust.walkFiles(pluginDir);

    // Sort for deterministic hash
    files.sort();

    for (const file of files) {
      try {
        const content = await fsp.readFile(file);
        hash.update(file.replace(pluginDir, '')); // relative path
        hash.update(content);
      } catch {}
    }

    return hash.digest('hex').slice(0, 32);
  }

  private static async walkFiles(dir: string): Promise<string[]> {
    const results: string[] = [];
    try {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          results.push(...await PluginTrust.walkFiles(full));
        } else {
          results.push(full);
        }
      }
    } catch {}
    return results;
  }

  // ─── Persistence ──────────────────────────────────────────────────

  private async loadRecord(pluginName: string): Promise<PluginTrustRecord | null> {
    const fp = this.trustFilePath(pluginName);
    if (!fs.existsSync(fp)) return null;
    try {
      const content = await fsp.readFile(fp, 'utf-8');
      return JSON.parse(content) as PluginTrustRecord;
    } catch {
      return null;
    }
  }

  private async saveRecord(pluginName: string, record: PluginTrustRecord): Promise<void> {
    const fp = this.trustFilePath(pluginName);
    await fsp.mkdir(this.trustDir, { recursive: true });
    await fsp.writeFile(fp, JSON.stringify({ ...record, _version: TRUST_FILE_VERSION }, null, 2));
  }

  private trustFilePath(pluginName: string): string {
    const hash = crypto.createHash('sha256').update(pluginName).digest('hex').slice(0, 16);
    return path.join(this.trustDir, `${hash}.json`);
  }

  // ─── History ──────────────────────────────────────────────────────

  private addHistory(pluginName: string, action: TrustHistoryEntry['action'], version?: string, reason?: string): void {
    this.history.push({ pluginName, action, version, timestamp: Date.now(), reason });
    if (this.history.length > MAX_TRUST_HISTORY) {
      this.history = this.history.slice(-MAX_TRUST_HISTORY / 2);
    }
  }
}
