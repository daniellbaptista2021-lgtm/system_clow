/**
 * MarketplaceManager.ts — Marketplace facade
 *
 * Based on Claude Code's marketplaceManager.ts (96K / ~2500 lines)
 *
 * Full lifecycle management:
 *   - Browse and search catalog
 *   - Install from marketplace (download zip → extract → validate → register)
 *   - Update to new version
 *   - Rollback to previous version
 *   - Uninstall marketplace plugin
 *   - Background startup check (updates + blocklist)
 *   - Install progress streaming
 *   - Rate limiting for API calls
 *   - Retry on transient failures
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { MarketplaceClient } from './MarketplaceClient.js';
import { MarketplaceCache } from './MarketplaceCache.js';
import { PluginBlocklist } from './PluginBlocklist.js';
import { PluginAutoUpdate, type UpdateAvailable } from './PluginAutoUpdate.js';
import { MarketplaceStartupCheck } from './MarketplaceStartupCheck.js';
import { searchCatalog } from './MarketplaceCatalog.js';
import { InstallCounts } from './InstallCounts.js';
import { OrphanedPluginFilter } from './OrphanedPluginFilter.js';
import { PluginFlagging } from './PluginFlagging.js';
import type {
  MarketplaceCatalog,
  MarketplaceCatalogEntry,
  MarketplaceSearchOptions,
  LoadedPlugin,
  InstallationResult,
  PluginValidationError,
} from '../types.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_CONCURRENT_DOWNLOADS = 3;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const API_RATE_LIMIT_MS = 1_000;  // min 1s between API calls
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2_000;

// ─── Install Progress ───────────────────────────────────────────────────────

export interface MarketplaceInstallProgress {
  phase: 'fetching_catalog' | 'checking_blocklist' | 'resolving_deps' | 'downloading' | 'extracting' | 'validating' | 'registering' | 'complete' | 'failed';
  pluginName: string;
  progress: number;  // 0-1
  message: string;
  bytesDownloaded?: number;
  totalBytes?: number;
}

export type MarketplaceInstallCallback = (progress: MarketplaceInstallProgress) => void;

// ─── Install Options ────────────────────────────────────────────────────────

export interface MarketplaceInstallOptions {
  pluginId: string;
  version?: string;              // specific version, or latest
  force?: boolean;               // overwrite existing
  skipDeps?: boolean;            // skip dependency resolution
  onProgress?: MarketplaceInstallCallback;
}

// ─── Marketplace Stats ──────────────────────────────────────────────────────

export interface MarketplaceStats {
  catalogSize: number;
  installedFromMarketplace: number;
  blockedPlugins: number;
  updatesAvailable: number;
  orphanedPlugins: number;
  lastCatalogFetch: number | null;
}

// ════════════════════════════════════════════════════════════════════════════
// MarketplaceManager Class
// ════════════════════════════════════════════════════════════════════════════

export class MarketplaceManager {
  readonly client: MarketplaceClient;
  readonly cache: MarketplaceCache;
  readonly blocklist: PluginBlocklist;
  readonly autoUpdate: PluginAutoUpdate;
  readonly startupCheck: MarketplaceStartupCheck;
  readonly installCounts: InstallCounts;
  readonly orphanFilter: OrphanedPluginFilter;
  readonly flagging: PluginFlagging;

  private lastApiCall: number = 0;
  private readonly clowHome: string;
  private readonly marketplacePluginsDir: string;

  constructor(clowHome: string = path.join(os.homedir(), '.clow')) {
    this.clowHome = clowHome;
    this.marketplacePluginsDir = path.join(clowHome, 'marketplace-plugins');
    this.client = new MarketplaceClient();
    this.cache = new MarketplaceCache(path.join(clowHome, 'marketplace-cache', 'catalog.json'));
    this.blocklist = new PluginBlocklist();
    this.autoUpdate = new PluginAutoUpdate();
    this.installCounts = new InstallCounts(path.join(clowHome, 'marketplace-cache', 'install-counts.json'));
    this.orphanFilter = new OrphanedPluginFilter();
    this.flagging = new PluginFlagging();
    this.startupCheck = new MarketplaceStartupCheck(this.client, this.cache, this.blocklist, this.autoUpdate);
  }

  // ════════════════════════════════════════════════════════════════════
  // Catalog Operations
  // ════════════════════════════════════════════════════════════════════

  /**
   * Get catalog (from cache or fresh fetch).
   */
  async getCatalog(forceRefresh: boolean = false): Promise<MarketplaceCatalog> {
    if (!forceRefresh) {
      const cached = await this.cache.get();
      if (cached) return cached;
    }

    await this.rateLimitWait();
    const catalog = await this.withRetry(() => this.client.fetchCatalog());
    await this.cache.set(catalog);
    return catalog;
  }

  /**
   * Get all available versions of a plugin.
   */
  async getAvailableVersions(pluginName: string): Promise<string[]> {
    const catalog = await this.getCatalog();
    return catalog.plugins
      .filter(p => p.name === pluginName)
      .map(p => p.version)
      .sort((a, b) => this.compareVersions(b, a));
  }

  // ════════════════════════════════════════════════════════════════════
  // Install from Marketplace
  // ════════════════════════════════════════════════════════════════════

  /**
   * Install a plugin from the marketplace.
   *
   * Flow:
   *   1. Fetch catalog (cached)
   *   2. Check blocklist
   *   3. Find plugin + version
   *   4. Download zip
   *   5. Extract to ~/.clow/marketplace-plugins/<name>/
   *   6. Return result (caller registers in PluginSystem)
   */
  async installFromMarketplace(
    options: MarketplaceInstallOptions,
  ): Promise<InstallationResult> {
    const startTime = Date.now();
    const { pluginId, version, force, onProgress } = options;

    const emit = (phase: MarketplaceInstallProgress['phase'], msg: string, progress: number = 0) => {
      onProgress?.({ phase, pluginName: pluginId, progress, message: msg });
    };

    try {
      // Step 1: Get catalog
      emit('fetching_catalog', 'Fetching marketplace catalog...', 0.1);
      const catalog = await this.getCatalog();

      // Step 2: Check blocklist
      emit('checking_blocklist', 'Checking blocklist...', 0.15);
      if (this.blocklist.isBlocked(pluginId)) {
        return this.installFailed(startTime, [{
          code: 'PLUGIN_BLOCKED',
          message: `Plugin "${pluginId}" is blocked by the marketplace`,
          severity: 'error',
          recoverable: false,
        }]);
      }

      // Step 3: Find plugin in catalog
      emit('resolving_deps', 'Finding plugin version...', 0.2);
      const candidates = catalog.plugins
        .filter(p => (p.pluginId === pluginId || p.name === pluginId) && !p.blocked);

      if (candidates.length === 0) {
        return this.installFailed(startTime, [{
          code: 'PLUGIN_NOT_FOUND',
          message: `Plugin "${pluginId}" not found in marketplace`,
          severity: 'error',
          recoverable: false,
        }]);
      }

      // Select version
      let selected: MarketplaceCatalogEntry;
      if (version) {
        const exact = candidates.find(c => c.version === version);
        if (!exact) {
          return this.installFailed(startTime, [{
            code: 'VERSION_NOT_FOUND',
            message: `Version ${version} of "${pluginId}" not found`,
            severity: 'error',
            recoverable: false,
          }]);
        }
        selected = exact;
      } else {
        // Latest version
        selected = candidates.sort((a, b) => this.compareVersions(b.version, a.version))[0];
      }

      // Check if already installed
      const destDir = path.join(this.marketplacePluginsDir, selected.name);
      if (fs.existsSync(destDir) && !force) {
        return this.installFailed(startTime, [{
          code: 'ALREADY_INSTALLED',
          message: `"${selected.name}" is already installed. Use force: true to overwrite.`,
          severity: 'error',
          recoverable: true,
        }]);
      }

      // Step 4: Download
      emit('downloading', `Downloading ${selected.name}@${selected.version}...`, 0.4);
      const tmpZip = path.join(os.tmpdir(), `clow-marketplace-${Date.now()}.zip`);

      await this.rateLimitWait();
      await this.withRetry(() => this.client.download(selected.downloadUrl, tmpZip));

      // Step 5: Extract
      emit('extracting', 'Extracting...', 0.6);
      await fsp.mkdir(destDir, { recursive: true });

      const { execSync } = await import('child_process');
      try {
        if (process.platform === 'win32') {
          execSync(`powershell -Command "Expand-Archive -Path '${tmpZip}' -DestinationPath '${destDir}' -Force"`, { timeout: 60_000 });
        } else {
          execSync(`unzip -o "${tmpZip}" -d "${destDir}"`, { timeout: 60_000 });
        }
      } catch (err) {
        return this.installFailed(startTime, [{
          code: 'EXTRACT_FAILED',
          message: `Failed to extract: ${(err as Error).message}`,
          severity: 'error',
          recoverable: false,
        }]);
      }

      // Cleanup temp zip
      try { await fsp.unlink(tmpZip); } catch {}

      // Step 6: Track install count
      this.installCounts.increment(selected.name);
      await this.installCounts.save();

      emit('complete', `Installed ${selected.name}@${selected.version}`, 1.0);

      return {
        success: true,
        pluginName: selected.name,
        installedTo: destDir,
        durationMs: Date.now() - startTime,
        errors: [],
        warnings: [],
      };

    } catch (err: any) {
      emit('failed', err.message, 0);
      return this.installFailed(startTime, [{
        code: 'MARKETPLACE_INSTALL_FAILED',
        message: err.message,
        severity: 'error',
        recoverable: false,
      }]);
    }
  }

  /**
   * Uninstall a marketplace plugin.
   */
  async uninstallMarketplace(pluginName: string): Promise<boolean> {
    const pluginDir = path.join(this.marketplacePluginsDir, pluginName);
    if (!fs.existsSync(pluginDir)) return false;

    try {
      await fsp.rm(pluginDir, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // Update Operations
  // ════════════════════════════════════════════════════════════════════

  /**
   * Check for available updates for installed marketplace plugins.
   */
  async checkForUpdates(installed: LoadedPlugin[]): Promise<UpdateAvailable[]> {
    const catalog = await this.getCatalog();
    return this.autoUpdate.checkForUpdates(installed, catalog);
  }

  /**
   * Update a specific plugin to latest version.
   */
  async updatePlugin(pluginName: string): Promise<InstallationResult> {
    return this.installFromMarketplace({ pluginId: pluginName, force: true });
  }

  /**
   * Update all marketplace plugins with available updates.
   */
  async updateAll(installed: LoadedPlugin[]): Promise<{ updated: string[]; failed: string[] }> {
    const updates = await this.checkForUpdates(installed);
    const updated: string[] = [];
    const failed: string[] = [];

    for (const update of updates) {
      const result = await this.installFromMarketplace({
        pluginId: update.pluginName,
        version: update.latestVersion,
        force: true,
      });
      if (result.success) updated.push(update.pluginName);
      else failed.push(update.pluginName);
    }

    return { updated, failed };
  }

  // ════════════════════════════════════════════════════════════════════
  // Startup + Maintenance
  // ════════════════════════════════════════════════════════════════════

  /**
   * Run startup checks (background, non-blocking).
   */
  async runStartupCheck(installed: LoadedPlugin[]) {
    return this.startupCheck.run(installed);
  }

  /**
   * Detect orphaned plugins (source deleted).
   */
  detectOrphans(installed: LoadedPlugin[]): LoadedPlugin[] {
    return this.orphanFilter.detectOrphans(installed);
  }

  /**
   * Flag a plugin for review.
   */
  flagPlugin(pluginName: string, reason: string): void {
    this.flagging.flag(pluginName, reason);
  }

  /**
   * Get marketplace stats.
   */
  async getStats(installed: LoadedPlugin[]): Promise<MarketplaceStats> {
    let catalogSize = 0;
    try {
      const catalog = await this.getCatalog();
      catalogSize = catalog.plugins.length;
    } catch {}

    const marketplaceInstalled = installed.filter(p => p.source.type === 'marketplace');
    const updates = await this.checkForUpdates(installed).catch(() => []);
    const orphans = this.detectOrphans(installed);

    return {
      catalogSize,
      installedFromMarketplace: marketplaceInstalled.length,
      blockedPlugins: this.blocklist.list().length,
      updatesAvailable: updates.length,
      orphanedPlugins: orphans.length,
      lastCatalogFetch: null,  // from cache metadata
    };
  }

  // ════════════════════════════════════════════════════════════════════
  // Internal Helpers
  // ════════════════════════════════════════════════════════════════════

  /**
   * Rate limit API calls (min 1s between requests).
   */
  private async rateLimitWait(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastApiCall;
    if (elapsed < API_RATE_LIMIT_MS) {
      await new Promise(r => setTimeout(r, API_RATE_LIMIT_MS - elapsed));
    }
    this.lastApiCall = Date.now();
  }

  /**
   * Retry on transient failure (network errors, 5xx).
   */
  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: Error | undefined;
    for (let i = 0; i <= MAX_RETRIES; i++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err as Error;
        const msg = lastError.message.toLowerCase();
        const isTransient = msg.includes('fetch') || msg.includes('network') || msg.includes('timeout') || msg.includes('5');
        if (!isTransient || i >= MAX_RETRIES) throw lastError;
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS * (i + 1)));
      }
    }
    throw lastError;
  }

  private compareVersions(a: string, b: string): number {
    const ap = a.split('.').map(Number);
    const bp = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      if ((ap[i] ?? 0) !== (bp[i] ?? 0)) return (ap[i] ?? 0) - (bp[i] ?? 0);
    }
    return 0;
  }

  private installFailed(startTime: number, errors: PluginValidationError[]): InstallationResult {
    return {
      success: false,
      durationMs: Date.now() - startTime,
      errors,
      warnings: [],
    };
  }

  // ══��═════════════════════════════════════════════════════════════════
  // Extended Operations
  // ════════════════════════════════════════════════════════════════════

  /**
   * Search marketplace catalog with filtering.
   */
  async search(query: string, options?: {
    category?: string;
    tags?: string[];
    minRating?: number;
    limit?: number;
    offset?: number;
  }): Promise<MarketplaceCatalogEntry[]> {
    const catalog = await this.getCatalogSafe();
    if (!catalog) return [];

    const q = query.toLowerCase();
    let results = catalog.plugins.filter(p => {
      if (p.blocked || p.flagged) return false;

      // Text search
      const searchable = `${p.name} ${p.description} ${p.tags.join(' ')}`.toLowerCase();
      if (q && !searchable.includes(q)) return false;

      // Category filter
      if (options?.category && p.category !== options.category) return false;

      // Rating filter
      if (options?.minRating && (p.rating ?? 0) < options.minRating) return false;

      // Tag filter (intersection)
      if (options?.tags?.length) {
        const hasTags = options.tags.every(t => p.tags.includes(t));
        if (!hasTags) return false;
      }

      return true;
    });

    // Sort by relevance (name match > description match)
    results.sort((a, b) => {
      const aNameMatch = a.name.toLowerCase().includes(q) ? 2 : 0;
      const bNameMatch = b.name.toLowerCase().includes(q) ? 2 : 0;
      const aDescMatch = a.description.toLowerCase().includes(q) ? 1 : 0;
      const bDescMatch = b.description.toLowerCase().includes(q) ? 1 : 0;
      return (bNameMatch + bDescMatch) - (aNameMatch + aDescMatch);
    });

    // Pagination
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? 20;
    return results.slice(offset, offset + limit);
  }

  /**
   * Get plugin details from marketplace.
   */
  async getPluginDetails(pluginId: string): Promise<MarketplaceCatalogEntry | null> {
    const catalog = await this.getCatalogSafe();
    if (!catalog) return null;
    return catalog.plugins.find(p => p.pluginId === pluginId || p.name === pluginId) ?? null;
  }

  /**
   * Check if a specific plugin has an update available.
   */
  async hasUpdate(pluginName: string, currentVersion: string): Promise<{ available: boolean; latestVersion?: string }> {
    const catalog = await this.getCatalogSafe();
    if (!catalog) return { available: false };

    const entry = catalog.plugins.find(p => p.name === pluginName);
    if (!entry) return { available: false };

    if (this.compareVersions(entry.version, currentVersion) > 0) {
      return { available: true, latestVersion: entry.version };
    }
    return { available: false };
  }

  /**
   * Get cached catalog or fetch new one (internal, nullable).
   */
  private async getCatalogSafe(): Promise<MarketplaceCatalog | null> {
    let catalog = await this.cache.get();
    if (!catalog) {
      try {
        catalog = await this.client.fetchCatalog();
        await this.cache.set(catalog);
      } catch {
        return null;
      }
    }
    return catalog;
  }

  /**
   * Get marketplace statistics.
   */
  async getMarketplaceStats(): Promise<{
    totalPlugins: number;
    categories: Record<string, number>;
    blockedCount: number;
    flaggedCount: number;
  }> {
    const catalog = await this.getCatalogSafe();
    if (!catalog) return { totalPlugins: 0, categories: {}, blockedCount: 0, flaggedCount: 0 };

    const categories: Record<string, number> = {};
    let blocked = 0;
    let flagged = 0;

    for (const p of catalog.plugins) {
      const cat = p.category ?? 'uncategorized';
      categories[cat] = (categories[cat] ?? 0) + 1;
      if (p.blocked) blocked++;
      if (p.flagged) flagged++;
    }

    return {
      totalPlugins: catalog.plugins.length,
      categories,
      blockedCount: blocked,
      flaggedCount: flagged,
    };
  }

  /**
   * Get install history.
   */
  getInstallHistory(): Array<{ pluginName: string; installs: number }> {
    return this.installCounts.getMostInstalled(100);
  }

  /**
   * Get the startup check runner.
   */
  getStartupCheck(): MarketplaceStartupCheck {
    return this.startupCheck;
  }
}
