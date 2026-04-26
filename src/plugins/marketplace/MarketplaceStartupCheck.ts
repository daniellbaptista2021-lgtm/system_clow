/**
 * MarketplaceStartupCheck.ts — Check for updates on startup (background)
 *
 * Based on Claude Code's marketplaceStartupCheck.ts (~300 lines)
 *
 * Features:
 *   - Background startup check (non-blocking)
 *   - Catalog caching (avoid redundant fetches)
 *   - Blocklist refresh
 *   - Update detection
 *   - Flagged plugin detection
 *   - Startup timing and statistics
 *   - Graceful timeout (don't delay startup)
 *   - Rate limiting (max 1 check per hour)
 *   - Result caching for repeated queries
 */

import { MarketplaceClient } from './MarketplaceClient.js';
import { MarketplaceCache } from './MarketplaceCache.js';
import { PluginBlocklist } from './PluginBlocklist.js';
import { PluginAutoUpdate, type UpdateAvailable } from './PluginAutoUpdate.js';
import type { LoadedPlugin, MarketplaceCatalog } from '../types.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const STARTUP_CHECK_TIMEOUT_MS = 15_000;
const MIN_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

// ─── Types ──────────────────────────────────────────────────────────────────

export interface StartupCheckResult {
  updatesAvailable: UpdateAvailable[];
  newlyBlocked: string[];
  flaggedPlugins: string[];
  checkDurationMs: number;
  fromCache: boolean;
  catalogAge?: number;
}

interface StartupCheckStats {
  totalChecks: number;
  lastCheckAt: number;
  lastDurationMs: number;
  lastResultCached: boolean;
  totalUpdatesFound: number;
  totalBlockedFound: number;
}

// ════════════════════════════════════════════════════════════════════════════
// MarketplaceStartupCheck Class
// ════════════════════════════════════════════════════════════════════════════

export class MarketplaceStartupCheck {
  private stats: StartupCheckStats = {
    totalChecks: 0,
    lastCheckAt: 0,
    lastDurationMs: 0,
    lastResultCached: false,
    totalUpdatesFound: 0,
    totalBlockedFound: 0,
  };

  private lastResult: StartupCheckResult | null = null;
  private running = false;

  constructor(
    private readonly client: MarketplaceClient,
    private readonly cache: MarketplaceCache,
    private readonly blocklist: PluginBlocklist,
    private readonly autoUpdate: PluginAutoUpdate,
  ) {}

  /**
   * Run the startup check.
   * Returns updates, blocked plugins, and flagged plugins.
   * Times out gracefully after STARTUP_CHECK_TIMEOUT_MS.
   */
  async run(installed: LoadedPlugin[]): Promise<StartupCheckResult> {
    // Rate limiting
    if (Date.now() - this.stats.lastCheckAt < MIN_CHECK_INTERVAL_MS && this.lastResult) {
      return this.lastResult;
    }

    // Prevent concurrent runs
    if (this.running && this.lastResult) {
      return this.lastResult;
    }

    this.running = true;
    const startTime = Date.now();

    try {
      const result = await Promise.race([
        this.doCheck(installed),
        this.timeout(),
      ]);

      this.lastResult = result;
      this.stats.totalChecks++;
      this.stats.lastCheckAt = Date.now();
      this.stats.lastDurationMs = Date.now() - startTime;
      this.stats.lastResultCached = result.fromCache;
      this.stats.totalUpdatesFound += result.updatesAvailable.length;
      this.stats.totalBlockedFound += result.newlyBlocked.length;

      return result;

    } catch (err) {
      // Startup check should never crash the application
      console.warn(`[MarketplaceStartupCheck] Error: ${(err as Error).message}`);
      return this.emptyResult(Date.now() - startTime);
    } finally {
      this.running = false;
    }
  }

  /**
   * Run the check in the background (fire-and-forget).
   */
  runBackground(installed: LoadedPlugin[]): void {
    this.run(installed).catch(err => {
      console.warn(`[MarketplaceStartupCheck] Background check failed: ${(err as Error).message}`);
    });
  }

  // ─── Core Check ──────────────────────────────────────────────────

  private async doCheck(installed: LoadedPlugin[]): Promise<StartupCheckResult> {
    const startTime = Date.now();
    let fromCache = false;

    // Step 1: Get catalog (from cache or fetch)
    let catalog = await this.cache.get();
    let catalogAge: number | undefined;

    if (catalog) {
      fromCache = true;
      catalogAge = Date.now() - (catalog as any).fetchedAt;
    } else {
      try {
        catalog = await this.client.fetchCatalog();
        await this.cache.set(catalog);
      } catch (err) {
        console.warn(`[MarketplaceStartupCheck] Failed to fetch catalog: ${(err as Error).message}`);
        return this.emptyResult(Date.now() - startTime);
      }
    }

    // Step 2: Refresh blocklist
    const newlyBlocked: string[] = [];
    try {
      await this.blocklist.refresh(this.client);
      for (const plugin of installed) {
        if (this.blocklist.isBlocked(plugin.manifest.name)) {
          newlyBlocked.push(plugin.manifest.name);
        }
      }
    } catch (err) {
      console.warn(`[MarketplaceStartupCheck] Blocklist refresh failed: ${(err as Error).message}`);
    }

    // Step 3: Check for updates
    let updatesAvailable: UpdateAvailable[] = [];
    try {
      updatesAvailable = this.autoUpdate.checkForUpdates(installed, catalog);
    } catch (err) {
      console.warn(`[MarketplaceStartupCheck] Update check failed: ${(err as Error).message}`);
    }

    // Step 4: Check for flagged plugins
    const flaggedPlugins: string[] = [];
    try {
      const flagged = await this.client.fetchFlagged();
      for (const plugin of installed) {
        if (flagged.includes(plugin.manifest.name)) {
          flaggedPlugins.push(plugin.manifest.name);
        }
      }
    } catch {
      // Flagged list is optional — don't warn
    }

    return {
      updatesAvailable,
      newlyBlocked,
      flaggedPlugins,
      checkDurationMs: Date.now() - startTime,
      fromCache,
      catalogAge,
    };
  }

  // ─── Timeout ─────────────────────────────────────────────────────

  private timeout(): Promise<StartupCheckResult> {
    return new Promise((resolve) => {
      setTimeout(() => {
        console.warn(`[MarketplaceStartupCheck] Timeout after ${STARTUP_CHECK_TIMEOUT_MS}ms`);
        resolve(this.emptyResult(STARTUP_CHECK_TIMEOUT_MS));
      }, STARTUP_CHECK_TIMEOUT_MS);
    });
  }

  // ─── Results ─────────────────────────────────────────────────────

  private emptyResult(durationMs: number): StartupCheckResult {
    return {
      updatesAvailable: [],
      newlyBlocked: [],
      flaggedPlugins: [],
      checkDurationMs: durationMs,
      fromCache: false,
    };
  }

  getLastResult(): StartupCheckResult | null {
    return this.lastResult;
  }

  getStats(): StartupCheckStats {
    return { ...this.stats };
  }

  isRunning(): boolean {
    return this.running;
  }
}
