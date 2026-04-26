/**
 * InstallCounts.ts — Local install count telemetry
 *
 * Based on Claude Code's installCounts.ts (200 lines)
 *
 * Tracks:
 *   - Total installs per plugin
 *   - Install history with timestamps
 *   - Uninstall tracking
 *   - First install date
 *   - Last install date
 *   - Install source breakdown (marketplace, git, local)
 *   - Aggregate stats (total installs, unique plugins, active plugins)
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';

// ─── Types ──────────────────────────────────────────────────────────────────

interface InstallRecord {
  pluginName: string;
  totalInstalls: number;
  totalUninstalls: number;
  firstInstalledAt: number;
  lastInstalledAt: number;
  lastUninstalledAt?: number;
  currentlyInstalled: boolean;
  installHistory: Array<{
    action: 'install' | 'uninstall' | 'update';
    version: string;
    source: string;
    timestamp: number;
  }>;
}

interface InstallCountsState {
  version: number;
  records: Record<string, InstallRecord>;
  totalInstallActions: number;
  lastSavedAt: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_HISTORY_PER_PLUGIN = 50;
const STATE_VERSION = 1;

// ════════════════════════════════════════════════════════════════════════════
// InstallCounts Class
// ════════════════════════════════════════════════════════════════════════════

export class InstallCounts {
  private records = new Map<string, InstallRecord>();
  private totalActions = 0;

  constructor(private readonly filePath: string) {}

  // ─── Load / Save ──────────────────────────────────────────────────

  async load(): Promise<void> {
    if (!fs.existsSync(this.filePath)) return;
    try {
      const data = JSON.parse(await fsp.readFile(this.filePath, 'utf-8')) as InstallCountsState;
      for (const [name, record] of Object.entries(data.records ?? {})) {
        this.records.set(name, record);
      }
      this.totalActions = data.totalInstallActions ?? 0;
    } catch {}
  }

  async save(): Promise<void> {
    const state: InstallCountsState = {
      version: STATE_VERSION,
      records: Object.fromEntries(this.records),
      totalInstallActions: this.totalActions,
      lastSavedAt: Date.now(),
    };
    await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
    await fsp.writeFile(this.filePath, JSON.stringify(state, null, 2));
  }

  // ─── Record Actions ───────────────────────────────────────────────

  /**
   * Record a plugin install.
   */
  increment(pluginName: string, version: string = 'unknown', source: string = 'unknown'): void {
    const record = this.getOrCreate(pluginName);
    record.totalInstalls++;
    record.lastInstalledAt = Date.now();
    record.currentlyInstalled = true;

    record.installHistory.push({
      action: 'install',
      version,
      source,
      timestamp: Date.now(),
    });

    this.trimHistory(record);
    this.totalActions++;
  }

  /**
   * Record a plugin uninstall.
   */
  recordUninstall(pluginName: string, version: string = 'unknown'): void {
    const record = this.getOrCreate(pluginName);
    record.totalUninstalls++;
    record.lastUninstalledAt = Date.now();
    record.currentlyInstalled = false;

    record.installHistory.push({
      action: 'uninstall',
      version,
      source: 'user',
      timestamp: Date.now(),
    });

    this.trimHistory(record);
    this.totalActions++;
  }

  /**
   * Record a plugin update.
   */
  recordUpdate(pluginName: string, fromVersion: string, toVersion: string): void {
    const record = this.getOrCreate(pluginName);
    record.lastInstalledAt = Date.now();

    record.installHistory.push({
      action: 'update',
      version: `${fromVersion} → ${toVersion}`,
      source: 'auto-update',
      timestamp: Date.now(),
    });

    this.trimHistory(record);
    this.totalActions++;
  }

  // ─── Query ────────────────────────────────────────────────────────

  /**
   * Get install count for a plugin.
   */
  get(pluginName: string): number {
    return this.records.get(pluginName)?.totalInstalls ?? 0;
  }

  /**
   * Get full record for a plugin.
   */
  getRecord(pluginName: string): InstallRecord | null {
    return this.records.get(pluginName) ?? null;
  }

  /**
   * Check if a plugin is currently installed.
   */
  isCurrentlyInstalled(pluginName: string): boolean {
    return this.records.get(pluginName)?.currentlyInstalled ?? false;
  }

  /**
   * Get most installed plugins (sorted by install count).
   */
  getMostInstalled(limit: number = 20): Array<{ pluginName: string; installs: number }> {
    return [...this.records.entries()]
      .map(([name, record]) => ({ pluginName: name, installs: record.totalInstalls }))
      .sort((a, b) => b.installs - a.installs)
      .slice(0, limit);
  }

  /**
   * Get recently installed plugins.
   */
  getRecent(limit: number = 20): Array<{ pluginName: string; installedAt: number }> {
    return [...this.records.entries()]
      .filter(([, r]) => r.currentlyInstalled)
      .map(([name, r]) => ({ pluginName: name, installedAt: r.lastInstalledAt }))
      .sort((a, b) => b.installedAt - a.installedAt)
      .slice(0, limit);
  }

  // ─── Aggregate Stats ──────────────────────────────────────────────

  /**
   * Get aggregate statistics.
   */
  getStats(): {
    totalPluginsEverInstalled: number;
    currentlyInstalled: number;
    totalInstallActions: number;
    totalUninstallActions: number;
    totalUpdateActions: number;
  } {
    let currentlyInstalled = 0;
    let totalUninstalls = 0;

    for (const record of this.records.values()) {
      if (record.currentlyInstalled) currentlyInstalled++;
      totalUninstalls += record.totalUninstalls;
    }

    return {
      totalPluginsEverInstalled: this.records.size,
      currentlyInstalled,
      totalInstallActions: this.totalActions,
      totalUninstallActions: totalUninstalls,
      totalUpdateActions: this.totalActions - this.records.size - totalUninstalls,
    };
  }

  // ─── Internal ─────────────────────────────────────────────────────

  private getOrCreate(pluginName: string): InstallRecord {
    let record = this.records.get(pluginName);
    if (!record) {
      record = {
        pluginName,
        totalInstalls: 0,
        totalUninstalls: 0,
        firstInstalledAt: Date.now(),
        lastInstalledAt: 0,
        currentlyInstalled: false,
        installHistory: [],
      };
      this.records.set(pluginName, record);
    }
    return record;
  }

  private trimHistory(record: InstallRecord): void {
    if (record.installHistory.length > MAX_HISTORY_PER_PLUGIN) {
      record.installHistory = record.installHistory.slice(-MAX_HISTORY_PER_PLUGIN);
    }
  }
}
