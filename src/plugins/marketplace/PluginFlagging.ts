/**
 * PluginFlagging.ts — Flag plugins for review
 *
 * Based on Claude Code's pluginFlagging.ts (200 lines)
 *
 * Implements:
 *   - Flag a plugin with reason and severity
 *   - Unflag (after review)
 *   - List flagged with filters
 *   - Flag persistence to disk
 *   - Flag categories (security, quality, broken, malicious, abandoned)
 *   - Flag count tracking per plugin
 *   - Auto-flag rules (e.g., no updates for 1 year)
 *   - Auto-flag by heuristics (low quality score, missing fields)
 *   - Flag escalation (warning -> critical)
 *   - Batch flagging from remote list
 *   - Flag statistics dashboard
 *   - Flag notification support
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';

// ─── Types ──────────────────────────────────────────────────────────────────

export type FlagCategory = 'security' | 'quality' | 'broken' | 'malicious' | 'abandoned' | 'other';
export type FlagSeverity = 'low' | 'medium' | 'high' | 'critical';

interface FlagEntry {
  pluginName: string;
  reason: string;
  category: FlagCategory;
  severity: FlagSeverity;
  flaggedAt: number;
  flaggedBy: string;
  reviewStatus: 'pending' | 'reviewed' | 'dismissed';
  reviewNote?: string;
  reviewedAt?: number;
  /** Number of times this plugin has been re-flagged. */
  escalationCount: number;
  /** History of severity escalations. */
  escalationHistory: Array<{ from: FlagSeverity; to: FlagSeverity; at: number }>;
}

/** Summary returned by the statistics dashboard. */
interface FlagStatistics {
  total: number;
  pending: number;
  reviewed: number;
  dismissed: number;
  byCategory: Record<FlagCategory, number>;
  bySeverity: Record<FlagSeverity, number>;
  escalatedCount: number;
  oldestPendingAt: number | null;
}

/** Notification payload emitted when a notable flag event occurs. */
interface FlagNotification {
  type: 'flagged' | 'escalated' | 'unflagged' | 'batch_flagged';
  pluginName: string;
  severity: FlagSeverity;
  message: string;
  timestamp: number;
}

/** Heuristic quality report for a single plugin. */
interface QualityReport {
  pluginName: string;
  score: number; // 0-100
  missingFields: string[];
  reasons: string[];
}

/** Handler invoked when a notification is emitted. */
type FlagNotificationHandler = (notification: FlagNotification) => void;

// ─── Constants ──────────────────────────────────────────────────────────────

/** Severity ordering used for escalation comparisons. */
const SEVERITY_ORDER: Record<FlagSeverity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

/** Quality score threshold below which a plugin is auto-flagged. */
const AUTO_FLAG_QUALITY_THRESHOLD = 40;

// ════════════════════════════════════════════════════════════════════════════
// PluginFlagging Class
// ════════════════════════════════════════════════════════════════════════════

export class PluginFlagging {
  private flags = new Map<string, FlagEntry>();
  private persistPath?: string;
  private notificationHandlers: FlagNotificationHandler[] = [];

  constructor(persistPath?: string) {
    this.persistPath = persistPath;
  }

  // ─── Notification Registration ──────────────────────────────────

  /**
   * Register a handler that will be called for every notable flag event.
   */
  onNotification(handler: FlagNotificationHandler): void {
    this.notificationHandlers.push(handler);
  }

  // ─── Flag Operations ──────────────────────────────────────────────

  /**
   * Flag a plugin for review.
   */
  flag(
    pluginName: string,
    reason: string,
    options: {
      category?: FlagCategory;
      severity?: FlagSeverity;
      flaggedBy?: string;
    } = {},
  ): void {
    const existing = this.flags.get(pluginName);
    const entry: FlagEntry = {
      pluginName,
      reason,
      category: options.category ?? 'other',
      severity: options.severity ?? 'medium',
      flaggedAt: Date.now(),
      flaggedBy: options.flaggedBy ?? 'user',
      reviewStatus: 'pending',
      escalationCount: existing ? existing.escalationCount + 1 : 0,
      escalationHistory: existing ? [...existing.escalationHistory] : [],
    };
    this.flags.set(pluginName, entry);
    this.emit({ type: 'flagged', pluginName, severity: entry.severity, message: reason, timestamp: Date.now() });
  }

  /**
   * Unflag a plugin (after review).
   */
  unflag(pluginName: string, reviewNote?: string): void {
    const entry = this.flags.get(pluginName);
    if (entry) {
      entry.reviewStatus = 'reviewed';
      entry.reviewNote = reviewNote;
      entry.reviewedAt = Date.now();
      this.emit({ type: 'unflagged', pluginName, severity: entry.severity, message: reviewNote ?? '', timestamp: Date.now() });
    }
  }

  /**
   * Dismiss a flag (reviewed, not an issue).
   */
  dismiss(pluginName: string, reason?: string): void {
    const entry = this.flags.get(pluginName);
    if (entry) {
      entry.reviewStatus = 'dismissed';
      entry.reviewNote = reason;
      entry.reviewedAt = Date.now();
    }
  }

  /**
   * Remove a flag entirely.
   */
  remove(pluginName: string): boolean {
    return this.flags.delete(pluginName);
  }

  // ─── Flag Escalation ────────────────────────────────────────────

  /**
   * Escalate the severity of an existing flag.  If the plugin has not been
   * flagged yet the call is a no-op.
   *
   * @returns `true` if the severity was actually raised.
   */
  escalate(pluginName: string, newSeverity: FlagSeverity): boolean {
    const entry = this.flags.get(pluginName);
    if (!entry) return false;

    const oldOrder = SEVERITY_ORDER[entry.severity];
    const newOrder = SEVERITY_ORDER[newSeverity];
    if (newOrder <= oldOrder) return false;

    entry.escalationHistory.push({ from: entry.severity, to: newSeverity, at: Date.now() });
    entry.severity = newSeverity;
    entry.escalationCount++;

    this.emit({
      type: 'escalated',
      pluginName,
      severity: newSeverity,
      message: `Escalated from ${entry.escalationHistory[entry.escalationHistory.length - 1].from}`,
      timestamp: Date.now(),
    });
    return true;
  }

  // ─── Batch Flagging ─────────────────────────────────────────────

  /**
   * Apply flags from a remote list in a single operation.
   * Each item in `entries` must provide the plugin name, reason,
   * and optionally category and severity.
   *
   * @returns The list of plugin names that were newly flagged.
   */
  batchFlag(
    entries: Array<{ pluginName: string; reason: string; category?: FlagCategory; severity?: FlagSeverity }>,
    flaggedBy: string = 'remote',
  ): string[] {
    const flagged: string[] = [];
    for (const item of entries) {
      if (!this.flags.has(item.pluginName) || this.flags.get(item.pluginName)!.reviewStatus !== 'pending') {
        this.flag(item.pluginName, item.reason, {
          category: item.category,
          severity: item.severity,
          flaggedBy,
        });
        flagged.push(item.pluginName);
      }
    }

    if (flagged.length > 0) {
      this.emit({
        type: 'batch_flagged',
        pluginName: flagged.join(', '),
        severity: 'medium',
        message: `${flagged.length} plugins flagged from remote list`,
        timestamp: Date.now(),
      });
    }

    return flagged;
  }

  // ─── Query ────────────────────────────────────────────────────────

  isFlagged(pluginName: string): boolean {
    const entry = this.flags.get(pluginName);
    return entry ? entry.reviewStatus === 'pending' : false;
  }

  getFlagReason(pluginName: string): string | null {
    return this.flags.get(pluginName)?.reason ?? null;
  }

  getFlag(pluginName: string): FlagEntry | null {
    return this.flags.get(pluginName) ?? null;
  }

  list(filter?: { category?: FlagCategory; severity?: FlagSeverity; status?: FlagEntry['reviewStatus'] }): FlagEntry[] {
    let entries = [...this.flags.values()];
    if (filter?.category) entries = entries.filter(e => e.category === filter.category);
    if (filter?.severity) entries = entries.filter(e => e.severity === filter.severity);
    if (filter?.status) entries = entries.filter(e => e.reviewStatus === filter.status);
    return entries.sort((a, b) => b.flaggedAt - a.flaggedAt);
  }

  listPending(): FlagEntry[] {
    return this.list({ status: 'pending' });
  }

  size(): number {
    return [...this.flags.values()].filter(e => e.reviewStatus === 'pending').length;
  }

  // ─── Auto-Flag Rules ──────────────────────────────────────────────

  /**
   * Auto-flag plugins that haven't been updated in a long time.
   */
  autoFlagAbandoned(
    plugins: Array<{ name: string; updatedAt: number }>,
    thresholdDays: number = 365,
  ): string[] {
    const cutoff = Date.now() - thresholdDays * 86400_000;
    const flagged: string[] = [];

    for (const p of plugins) {
      if (p.updatedAt < cutoff && !this.flags.has(p.name)) {
        this.flag(p.name, `No updates in ${thresholdDays}+ days`, {
          category: 'abandoned',
          severity: 'low',
          flaggedBy: 'auto',
        });
        flagged.push(p.name);
      }
    }

    return flagged;
  }

  /**
   * Auto-flag plugins by quality heuristics.
   *
   * The heuristic assigns a quality score (0-100) based on the
   * presence of key manifest fields.  Plugins scoring below
   * {@link AUTO_FLAG_QUALITY_THRESHOLD} are flagged.
   *
   * @returns Array of quality reports for every evaluated plugin.
   */
  autoFlagByQuality(
    manifests: Array<{ name: string; description?: string; author?: { name: string }; license?: string; repository?: string; homepage?: string; version?: string }>,
  ): QualityReport[] {
    const reports: QualityReport[] = [];

    for (const m of manifests) {
      const missing: string[] = [];
      const reasons: string[] = [];
      let score = 100;

      if (!m.description || m.description.length < 10) { missing.push('description'); score -= 20; reasons.push('Missing or very short description'); }
      if (!m.author) { missing.push('author'); score -= 15; reasons.push('Missing author'); }
      if (!m.license) { missing.push('license'); score -= 10; reasons.push('Missing license'); }
      if (!m.repository) { missing.push('repository'); score -= 10; reasons.push('Missing repository URL'); }
      if (!m.homepage) { missing.push('homepage'); score -= 5; reasons.push('Missing homepage'); }
      if (!m.version) { missing.push('version'); score -= 20; reasons.push('Missing version'); }

      score = Math.max(0, score);
      reports.push({ pluginName: m.name, score, missingFields: missing, reasons });

      if (score < AUTO_FLAG_QUALITY_THRESHOLD && !this.flags.has(m.name)) {
        this.flag(m.name, `Low quality score (${score}/100): ${reasons.join('; ')}`, {
          category: 'quality',
          severity: 'low',
          flaggedBy: 'auto-quality',
        });
      }
    }

    return reports;
  }

  // ─── Statistics Dashboard ───────────────────────────────────────

  /**
   * Compute aggregated flag statistics across all tracked plugins.
   */
  getStatistics(): FlagStatistics {
    const all = [...this.flags.values()];

    const byCategory: Record<FlagCategory, number> = {
      security: 0, quality: 0, broken: 0, malicious: 0, abandoned: 0, other: 0,
    };
    const bySeverity: Record<FlagSeverity, number> = {
      low: 0, medium: 0, high: 0, critical: 0,
    };

    let pending = 0;
    let reviewed = 0;
    let dismissed = 0;
    let escalatedCount = 0;
    let oldestPendingAt: number | null = null;

    for (const entry of all) {
      byCategory[entry.category]++;
      bySeverity[entry.severity]++;

      if (entry.reviewStatus === 'pending') {
        pending++;
        if (oldestPendingAt === null || entry.flaggedAt < oldestPendingAt) {
          oldestPendingAt = entry.flaggedAt;
        }
      } else if (entry.reviewStatus === 'reviewed') {
        reviewed++;
      } else {
        dismissed++;
      }

      if (entry.escalationCount > 0) escalatedCount++;
    }

    return {
      total: all.length,
      pending,
      reviewed,
      dismissed,
      byCategory,
      bySeverity,
      escalatedCount,
      oldestPendingAt,
    };
  }

  // ─── Persistence ──────────────────────────────────────────────────

  async load(): Promise<void> {
    if (!this.persistPath || !fs.existsSync(this.persistPath)) return;
    try {
      const data = JSON.parse(await fsp.readFile(this.persistPath, 'utf-8'));
      for (const entry of data.flags ?? []) {
        // Ensure backward-compatible defaults for new fields
        if (entry.escalationCount === undefined) entry.escalationCount = 0;
        if (!Array.isArray(entry.escalationHistory)) entry.escalationHistory = [];
        this.flags.set(entry.pluginName, entry);
      }
    } catch {}
  }

  async save(): Promise<void> {
    if (!this.persistPath) return;
    try {
      await fsp.mkdir(path.dirname(this.persistPath), { recursive: true });
      await fsp.writeFile(this.persistPath, JSON.stringify({ flags: [...this.flags.values()] }, null, 2));
    } catch {}
  }

  // ─── Internal Notification Helpers ──────────────────────────────

  private emit(notification: FlagNotification): void {
    for (const handler of this.notificationHandlers) {
      try {
        handler(notification);
      } catch { /* swallow handler errors */ }
    }
  }
}
