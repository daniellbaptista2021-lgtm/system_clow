/**
 * PluginAutoUpdate.ts — Background auto-update detection and queueing
 *
 * Based on Claude Code's pluginAutoupdate.ts (450 lines)
 *
 * Implements:
 *   - Detect available updates for installed marketplace plugins
 *   - Queue updates for next session (don't interrupt current)
 *   - Persist update queue to disk
 *   - Version comparison (semver)
 *   - Skip updates for pinned versions
 *   - Update channel support (stable, beta, nightly)
 *   - Update notification formatting
 *   - Rollback record tracking
 *   - Rate limiting (max 1 check per hour)
 *   - Update scheduling with time windows
 *   - Update dependency chain analysis
 *   - Rollback preparation (snapshot before update)
 *   - Update dry-run mode
 *   - Update notification templates
 *   - Channel management (subscribe/unsubscribe)
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import type { LoadedPlugin, MarketplaceCatalog, MarketplaceCatalogEntry } from '../types.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface UpdateAvailable {
  pluginName: string;
  currentVersion: string;
  latestVersion: string;
  downloadUrl: string;
  channel: UpdateChannel;
  publishedAt: number;
  changelog?: string;
}

export type UpdateChannel = 'stable' | 'beta' | 'nightly';

export interface UpdateQueueEntry {
  pluginName: string;
  fromVersion: string;
  toVersion: string;
  downloadUrl: string;
  queuedAt: number;
  status: 'pending' | 'downloading' | 'complete' | 'failed';
  error?: string;
}

interface UpdateCheckState {
  lastCheckedAt: number;
  queue: UpdateQueueEntry[];
  pinnedVersions: Record<string, string>;  // pluginName → pinned version
  channelOverrides: Record<string, UpdateChannel>;  // pluginName → channel
  rollbackSnapshots: RollbackSnapshot[];
}

interface RollbackSnapshot {
  pluginName: string;
  previousVersion: string;
  updatedVersion: string;
  snapshotPath: string;
  createdAt: number;
}

interface DryRunResult {
  wouldUpdate: UpdateAvailable[];
  wouldSkipPinned: string[];
  wouldSkipNoUpdate: string[];
  dependencyConflicts: DependencyConflict[];
}

interface DependencyConflict {
  pluginName: string;
  requiredBy: string;
  requiredVersion: string;
  availableVersion: string;
}

interface UpdateScheduleConfig {
  enabled: boolean;
  allowedHoursStart: number;  // 0-23
  allowedHoursEnd: number;    // 0-23
  allowedDays: number[];      // 0=Sunday, 6=Saturday
  maxConcurrentUpdates: number;
}

interface NotificationTemplate {
  singleUpdate: string;
  multipleUpdates: string;
  updateFailed: string;
  rollbackAvailable: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const CHECK_INTERVAL_MS = 60 * 60 * 1_000;  // 1 hour minimum between checks
const MAX_QUEUE_SIZE = 50;
const MAX_ROLLBACK_SNAPSHOTS = 20;

const DEFAULT_SCHEDULE: UpdateScheduleConfig = {
  enabled: false,
  allowedHoursStart: 2,   // 2am
  allowedHoursEnd: 5,     // 5am
  allowedDays: [0, 1, 2, 3, 4, 5, 6],  // all days
  maxConcurrentUpdates: 3,
};

const DEFAULT_TEMPLATES: NotificationTemplate = {
  singleUpdate: '{pluginName}: {currentVersion} -> {latestVersion}',
  multipleUpdates: '{count} plugin update(s) available',
  updateFailed: 'Failed to update {pluginName}: {error}',
  rollbackAvailable: 'Rollback available for {pluginName} to {previousVersion}',
};

// ════════════════════════════════════════════════════════════════════════════
// PluginAutoUpdate Class
// ════════════════════════════════════════════════════════════════════════════

export class PluginAutoUpdate {
  private state: UpdateCheckState = {
    lastCheckedAt: 0,
    queue: [],
    pinnedVersions: {},
    channelOverrides: {},
    rollbackSnapshots: [],
  };
  private statePath?: string;
  private schedule: UpdateScheduleConfig = { ...DEFAULT_SCHEDULE };
  private templates: NotificationTemplate = { ...DEFAULT_TEMPLATES };

  constructor(clowHome?: string) {
    if (clowHome) {
      this.statePath = path.join(clowHome, 'marketplace-cache', 'auto-update-state.json');
    }
  }

  // ─── Check for Updates ────────────────────────────────────────────

  /**
   * Check for available updates for installed marketplace plugins.
   * Returns list of available updates.
   */
  checkForUpdates(
    installed: LoadedPlugin[],
    catalog: MarketplaceCatalog,
    options: { channel?: UpdateChannel; force?: boolean } = {},
  ): UpdateAvailable[] {
    const updates: UpdateAvailable[] = [];

    for (const plugin of installed) {
      // Only check marketplace plugins
      if (plugin.source.type !== 'marketplace') continue;

      // Skip pinned plugins
      const pinnedVersion = this.state.pinnedVersions[plugin.manifest.name];
      if (pinnedVersion && pinnedVersion === plugin.manifest.version) continue;

      // Get effective channel for this plugin
      const channel = this.getEffectiveChannel(plugin.manifest.name, options.channel);

      // Find latest version in catalog
      const candidates = catalog.plugins
        .filter(c => c.name === plugin.manifest.name && !c.blocked)
        .filter(c => this.matchesChannel(c.version, channel));

      if (candidates.length === 0) continue;

      // Sort by version (newest first)
      const sorted = candidates.sort((a, b) => this.compareVersions(b.version, a.version));
      const latest = sorted[0];

      // Check if newer
      if (this.compareVersions(latest.version, plugin.manifest.version) > 0) {
        updates.push({
          pluginName: plugin.manifest.name,
          currentVersion: plugin.manifest.version,
          latestVersion: latest.version,
          downloadUrl: latest.downloadUrl,
          channel,
          publishedAt: latest.publishedAt,
        });
      }
    }

    return updates;
  }

  /**
   * Should we check for updates? (rate limiting)
   */
  shouldCheck(force: boolean = false): boolean {
    if (force) return true;
    return Date.now() - this.state.lastCheckedAt > CHECK_INTERVAL_MS;
  }

  /**
   * Record that we checked for updates.
   */
  recordCheck(): void {
    this.state.lastCheckedAt = Date.now();
  }

  // ─── Dry Run ─────────────────────────────────────────────────────

  /**
   * Perform a dry-run update check without actually queuing anything.
   * Returns what would happen if updates were applied.
   */
  dryRun(
    installed: LoadedPlugin[],
    catalog: MarketplaceCatalog,
    options: { channel?: UpdateChannel } = {},
  ): DryRunResult {
    const wouldUpdate: UpdateAvailable[] = [];
    const wouldSkipPinned: string[] = [];
    const wouldSkipNoUpdate: string[] = [];
    const dependencyConflicts: DependencyConflict[] = [];

    for (const plugin of installed) {
      if (plugin.source.type !== 'marketplace') continue;

      const pinnedVersion = this.state.pinnedVersions[plugin.manifest.name];
      if (pinnedVersion && pinnedVersion === plugin.manifest.version) {
        wouldSkipPinned.push(plugin.manifest.name);
        continue;
      }

      const channel = this.getEffectiveChannel(plugin.manifest.name, options.channel);
      const candidates = catalog.plugins
        .filter(c => c.name === plugin.manifest.name && !c.blocked)
        .filter(c => this.matchesChannel(c.version, channel));

      if (candidates.length === 0) {
        wouldSkipNoUpdate.push(plugin.manifest.name);
        continue;
      }

      const sorted = candidates.sort((a, b) => this.compareVersions(b.version, a.version));
      const latest = sorted[0];

      if (this.compareVersions(latest.version, plugin.manifest.version) > 0) {
        wouldUpdate.push({
          pluginName: plugin.manifest.name,
          currentVersion: plugin.manifest.version,
          latestVersion: latest.version,
          downloadUrl: latest.downloadUrl,
          channel,
          publishedAt: latest.publishedAt,
        });
      } else {
        wouldSkipNoUpdate.push(plugin.manifest.name);
      }
    }

    return { wouldUpdate, wouldSkipPinned, wouldSkipNoUpdate, dependencyConflicts };
  }

  // ─── Dependency Chain Analysis ────────────────────────────────────

  /**
   * Analyze update dependencies to determine the correct order of updates.
   * Returns plugin names in the order they should be updated.
   */
  analyzeUpdateOrder(
    updates: UpdateAvailable[],
    installed: LoadedPlugin[],
  ): string[] {
    // Build dependency graph from installed plugins
    const deps = new Map<string, string[]>();
    for (const plugin of installed) {
      const pluginDeps = plugin.manifest.dependencies
        ? Object.keys(plugin.manifest.dependencies)
        : [];
      deps.set(plugin.manifest.name, pluginDeps);
    }

    const updateNames = new Set(updates.map(u => u.pluginName));
    const ordered: string[] = [];
    const visited = new Set<string>();

    const visit = (name: string): void => {
      if (visited.has(name)) return;
      visited.add(name);

      // Visit dependencies first
      const pluginDeps = deps.get(name) ?? [];
      for (const dep of pluginDeps) {
        if (updateNames.has(dep)) visit(dep);
      }

      if (updateNames.has(name)) ordered.push(name);
    };

    for (const update of updates) {
      visit(update.pluginName);
    }

    return ordered;
  }

  // ─── Update Queue ─────────────────────────────────────────────────

  /**
   * Add an update to the queue (will be applied next session).
   */
  queueUpdate(update: UpdateAvailable): void {
    // Remove existing queue entry for same plugin
    this.state.queue = this.state.queue.filter(q => q.pluginName !== update.pluginName);

    this.state.queue.push({
      pluginName: update.pluginName,
      fromVersion: update.currentVersion,
      toVersion: update.latestVersion,
      downloadUrl: update.downloadUrl,
      queuedAt: Date.now(),
      status: 'pending',
    });

    // Enforce max queue size
    if (this.state.queue.length > MAX_QUEUE_SIZE) {
      this.state.queue = this.state.queue.slice(-MAX_QUEUE_SIZE);
    }
  }

  /**
   * Get pending updates in queue.
   */
  getPendingUpdates(): UpdateQueueEntry[] {
    return this.state.queue.filter(q => q.status === 'pending');
  }

  /**
   * Mark a queued update as complete.
   */
  markComplete(pluginName: string): void {
    const entry = this.state.queue.find(q => q.pluginName === pluginName);
    if (entry) entry.status = 'complete';
  }

  /**
   * Mark a queued update as failed.
   */
  markFailed(pluginName: string, error: string): void {
    const entry = this.state.queue.find(q => q.pluginName === pluginName);
    if (entry) { entry.status = 'failed'; entry.error = error; }
  }

  /**
   * Clear completed and failed entries from queue.
   */
  clearCompleted(): void {
    this.state.queue = this.state.queue.filter(q => q.status === 'pending' || q.status === 'downloading');
  }

  // ─── Rollback Preparation ────────────────────────────────────────

  /**
   * Record a rollback snapshot before applying an update.
   * The caller is responsible for creating the actual snapshot file.
   */
  recordRollbackSnapshot(pluginName: string, previousVersion: string, updatedVersion: string, snapshotPath: string): void {
    this.state.rollbackSnapshots.push({
      pluginName,
      previousVersion,
      updatedVersion,
      snapshotPath,
      createdAt: Date.now(),
    });

    // Enforce max snapshots
    if (this.state.rollbackSnapshots.length > MAX_ROLLBACK_SNAPSHOTS) {
      this.state.rollbackSnapshots = this.state.rollbackSnapshots.slice(-MAX_ROLLBACK_SNAPSHOTS);
    }
  }

  /**
   * Get available rollback snapshot for a plugin.
   */
  getRollbackSnapshot(pluginName: string): RollbackSnapshot | null {
    const snapshots = this.state.rollbackSnapshots
      .filter(s => s.pluginName === pluginName)
      .sort((a, b) => b.createdAt - a.createdAt);
    return snapshots[0] ?? null;
  }

  /**
   * List all rollback snapshots.
   */
  listRollbackSnapshots(): RollbackSnapshot[] {
    return [...this.state.rollbackSnapshots];
  }

  // ─── Version Pinning ──────────────────────────────────────────────

  /**
   * Pin a plugin to a specific version (skip auto-updates for it).
   */
  pinVersion(pluginName: string, version: string): void {
    this.state.pinnedVersions[pluginName] = version;
  }

  /**
   * Unpin a plugin (resume auto-updates).
   */
  unpinVersion(pluginName: string): void {
    delete this.state.pinnedVersions[pluginName];
  }

  /**
   * Check if a plugin is pinned.
   */
  isPinned(pluginName: string): boolean {
    return pluginName in this.state.pinnedVersions;
  }

  /**
   * Get pinned version for a plugin.
   */
  getPinnedVersion(pluginName: string): string | null {
    return this.state.pinnedVersions[pluginName] ?? null;
  }

  // ─── Channel Management ──────────────────────────────────────────

  /**
   * Set the update channel for a specific plugin.
   */
  setPluginChannel(pluginName: string, channel: UpdateChannel): void {
    this.state.channelOverrides[pluginName] = channel;
  }

  /**
   * Remove the channel override for a plugin (revert to default).
   */
  clearPluginChannel(pluginName: string): void {
    delete this.state.channelOverrides[pluginName];
  }

  /**
   * Get the effective channel for a plugin, considering overrides.
   */
  getEffectiveChannel(pluginName: string, defaultChannel?: UpdateChannel): UpdateChannel {
    return this.state.channelOverrides[pluginName] ?? defaultChannel ?? 'stable';
  }

  /**
   * List all channel overrides.
   */
  listChannelOverrides(): Record<string, UpdateChannel> {
    return { ...this.state.channelOverrides };
  }

  // ─── Update Scheduling ───────────────────────────────────────────

  /**
   * Configure the update schedule.
   */
  setSchedule(config: Partial<UpdateScheduleConfig>): void {
    Object.assign(this.schedule, config);
  }

  /**
   * Get the current schedule configuration.
   */
  getSchedule(): Readonly<UpdateScheduleConfig> {
    return { ...this.schedule };
  }

  /**
   * Check whether the current time falls within the allowed update window.
   */
  isWithinUpdateWindow(): boolean {
    if (!this.schedule.enabled) return true; // No schedule = always allowed

    const now = new Date();
    const hour = now.getHours();
    const day = now.getDay();

    if (!this.schedule.allowedDays.includes(day)) return false;

    if (this.schedule.allowedHoursStart <= this.schedule.allowedHoursEnd) {
      return hour >= this.schedule.allowedHoursStart && hour < this.schedule.allowedHoursEnd;
    }
    // Wraps around midnight (e.g., 22-05)
    return hour >= this.schedule.allowedHoursStart || hour < this.schedule.allowedHoursEnd;
  }

  // ─── Notification Formatting ──────────────────────────────────────

  /**
   * Set custom notification templates.
   */
  setNotificationTemplates(templates: Partial<NotificationTemplate>): void {
    Object.assign(this.templates, templates);
  }

  /**
   * Format update notification for display.
   */
  formatUpdateNotification(updates: UpdateAvailable[]): string {
    if (updates.length === 0) return '';

    const lines: string[] = [
      this.templates.multipleUpdates.replace('{count}', String(updates.length)) + ':\n',
    ];
    for (const u of updates) {
      lines.push(
        '  ' + this.templates.singleUpdate
          .replace('{pluginName}', u.pluginName)
          .replace('{currentVersion}', u.currentVersion)
          .replace('{latestVersion}', u.latestVersion),
      );
    }
    lines.push('\nUpdates will be applied on next restart, or run: clow plugins update');
    return lines.join('\n');
  }

  /**
   * Format a failure notification.
   */
  formatFailureNotification(pluginName: string, error: string): string {
    return this.templates.updateFailed
      .replace('{pluginName}', pluginName)
      .replace('{error}', error);
  }

  /**
   * Format a rollback availability notification.
   */
  formatRollbackNotification(pluginName: string, previousVersion: string): string {
    return this.templates.rollbackAvailable
      .replace('{pluginName}', pluginName)
      .replace('{previousVersion}', previousVersion);
  }

  // ─── Persistence ──────────────────────────────────────────────────

  /**
   * Load state from disk.
   */
  async loadState(): Promise<void> {
    if (!this.statePath || !fs.existsSync(this.statePath)) return;
    try {
      const content = await fsp.readFile(this.statePath, 'utf-8');
      const parsed = JSON.parse(content) as UpdateCheckState;
      this.state = {
        lastCheckedAt: parsed.lastCheckedAt ?? 0,
        queue: parsed.queue ?? [],
        pinnedVersions: parsed.pinnedVersions ?? {},
        channelOverrides: parsed.channelOverrides ?? {},
        rollbackSnapshots: parsed.rollbackSnapshots ?? [],
      };
    } catch {}
  }

  /**
   * Save state to disk.
   */
  async saveState(): Promise<void> {
    if (!this.statePath) return;
    try {
      await fsp.mkdir(path.dirname(this.statePath), { recursive: true });
      await fsp.writeFile(this.statePath, JSON.stringify(this.state, null, 2));
    } catch {}
  }

  // ─── Internal ─────────────────────────────────────────────────────

  /**
   * Check if a version matches the requested channel.
   * - stable: no pre-release tag
   * - beta: includes -beta, -rc
   * - nightly: includes -nightly, -dev, -alpha
   */
  private matchesChannel(version: string, channel: UpdateChannel): boolean {
    const hasPrerelease = /-/.test(version);

    switch (channel) {
      case 'stable':
        return !hasPrerelease;
      case 'beta':
        return !hasPrerelease || /-(beta|rc)/.test(version);
      case 'nightly':
        return true; // All versions
    }
  }

  /**
   * Compare two semver versions.
   */
  private compareVersions(a: string, b: string): number {
    const aParts = a.replace(/-.*$/, '').split('.').map(Number);
    const bParts = b.replace(/-.*$/, '').split('.').map(Number);

    for (let i = 0; i < 3; i++) {
      const diff = (aParts[i] ?? 0) - (bParts[i] ?? 0);
      if (diff !== 0) return diff;
    }

    // Pre-release < release
    const aHasPre = /-/.test(a);
    const bHasPre = /-/.test(b);
    if (aHasPre && !bHasPre) return -1;
    if (!aHasPre && bHasPre) return 1;

    return 0;
  }
}
