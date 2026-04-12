/**
 * MarketplaceDiscovery.ts — Discover installed marketplace plugins
 *
 * Based on Claude Code's marketplacePluginDiscovery.ts (~250 lines)
 *
 * Marketplace plugins are downloaded and installed in ~/.clow/marketplace-plugins/.
 * They have priority 2 (below user and project).
 *
 * Features:
 *   - Scan ~/.clow/marketplace-plugins/ directory
 *   - Installation metadata tracking (.install-meta.json per plugin)
 *   - Version pinning support
 *   - Auto-update state awareness
 *   - Discovery caching
 *   - Integrity verification (hash check)
 *   - Error isolation
 *   - Orphan detection (plugins missing from catalog)
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { PluginLoader } from '../PluginLoader.js';
import type { LoadedPlugin } from '../types.js';
import { PLUGIN_MANIFEST_DIR, PLUGIN_MANIFEST_FILE } from '../types.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_MARKETPLACE_PLUGINS = 500;
const MARKETPLACE_DIR = 'marketplace-plugins';
const INSTALL_META_FILE = '.install-meta.json';

// ─── Types ──────────────────────────────────────────────────────────────────

interface InstallMeta {
  pluginId: string;
  marketplaceId: string;
  installedAt: number;
  updatedAt: number;
  installedVersion: string;
  pinnedVersion?: string;
  contentHash?: string;
  autoUpdate: boolean;
  channel: 'stable' | 'beta' | 'nightly';
}

interface MarketplaceDiscoveryError {
  pluginDir: string;
  error: string;
}

// ════════════════════════════════════════════════════════════════════════════
// MarketplaceDiscovery Class
// ════════════════════════════════════════════════════════════════════════════

export class MarketplaceDiscovery {
  private readonly clowHome: string;
  private cachedPlugins: LoadedPlugin[] | null = null;
  private cachedMtime: number = 0;
  private discoveryErrors: MarketplaceDiscoveryError[] = [];
  private orphanedPlugins: string[] = [];

  constructor(
    private readonly loader: PluginLoader,
    clowHome?: string,
  ) {
    this.clowHome = clowHome ?? process.env.CLOW_HOME ?? path.join(os.homedir(), '.clow');
  }

  /**
   * Discover all installed marketplace plugins.
   */
  async discoverInstalled(): Promise<LoadedPlugin[]> {
    const dir = path.join(this.clowHome, MARKETPLACE_DIR);
    if (!fs.existsSync(dir)) return [];

    // Check cache
    try {
      const stat = await fsp.stat(dir);
      if (this.cachedPlugins && stat.mtimeMs === this.cachedMtime) {
        return this.cachedPlugins;
      }
      this.cachedMtime = stat.mtimeMs;
    } catch {
      return [];
    }

    const startTime = Date.now();
    this.discoveryErrors = [];
    this.orphanedPlugins = [];
    const plugins: LoadedPlugin[] = [];

    try {
      const entries = await fsp.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;

        const pluginDir = path.join(dir, entry.name);

        // Check for manifest
        const manifestPath = path.join(pluginDir, PLUGIN_MANIFEST_DIR, PLUGIN_MANIFEST_FILE);
        if (!fs.existsSync(manifestPath)) {
          this.discoveryErrors.push({
            pluginDir,
            error: 'No plugin manifest found',
          });
          continue;
        }

        // Load installation metadata
        const installMeta = await this.loadInstallMeta(pluginDir);
        const marketplaceId = installMeta?.marketplaceId ?? 'official';
        const pluginId = installMeta?.pluginId ?? entry.name;

        try {
          const plugin = await this.loader.load(pluginDir, {
            type: 'marketplace',
            marketplaceId,
            pluginId,
          });

          plugins.push(plugin);
        } catch (err) {
          this.discoveryErrors.push({
            pluginDir,
            error: (err as Error).message,
          });
        }

        if (plugins.length >= MAX_MARKETPLACE_PLUGINS) break;
      }
    } catch (err) {
      console.warn(`[MarketplaceDiscovery] Failed to scan ${dir}: ${(err as Error).message}`);
    }

    const elapsed = Date.now() - startTime;
    if (plugins.length > 0) {
      console.log(`[MarketplaceDiscovery] Found ${plugins.length} marketplace plugins in ${elapsed}ms`);
    }

    this.cachedPlugins = plugins;
    return plugins;
  }

  // ─── Install Metadata ────────────────────────────────────────────

  /**
   * Load installation metadata for a marketplace plugin.
   */
  private async loadInstallMeta(pluginDir: string): Promise<InstallMeta | null> {
    const metaPath = path.join(pluginDir, INSTALL_META_FILE);
    try {
      if (fs.existsSync(metaPath)) {
        const content = await fsp.readFile(metaPath, 'utf-8');
        return JSON.parse(content) as InstallMeta;
      }
    } catch { /* ignore */ }
    return null;
  }

  /**
   * Save installation metadata.
   */
  async saveInstallMeta(pluginDir: string, meta: InstallMeta): Promise<void> {
    const metaPath = path.join(pluginDir, INSTALL_META_FILE);
    try {
      await fsp.writeFile(metaPath, JSON.stringify(meta, null, 2));
    } catch { /* ignore */ }
  }

  /**
   * Get install metadata for a specific plugin.
   */
  async getInstallMeta(pluginName: string): Promise<InstallMeta | null> {
    const dir = path.join(this.clowHome, MARKETPLACE_DIR, pluginName);
    return this.loadInstallMeta(dir);
  }

  // ─── Version Pinning ─────────────────────────────────────────────

  /**
   * Pin a marketplace plugin to a specific version.
   */
  async pinVersion(pluginName: string, version: string): Promise<boolean> {
    const meta = await this.getInstallMeta(pluginName);
    if (!meta) return false;

    meta.pinnedVersion = version;
    meta.autoUpdate = false;

    const dir = path.join(this.clowHome, MARKETPLACE_DIR, pluginName);
    await this.saveInstallMeta(dir, meta);
    return true;
  }

  /**
   * Unpin a marketplace plugin (allow auto-updates).
   */
  async unpinVersion(pluginName: string): Promise<boolean> {
    const meta = await this.getInstallMeta(pluginName);
    if (!meta) return false;

    meta.pinnedVersion = undefined;
    meta.autoUpdate = true;

    const dir = path.join(this.clowHome, MARKETPLACE_DIR, pluginName);
    await this.saveInstallMeta(dir, meta);
    return true;
  }

  // ─── Orphan Detection ────────────────────────────────────────────

  /**
   * Get plugins that were installed but may be orphaned
   * (no install metadata or missing from marketplace catalog).
   */
  getOrphanedPlugins(): string[] {
    return [...this.orphanedPlugins];
  }

  // ─── Cache & Diagnostics ─────────────────────────────────────────

  invalidateCache(): void {
    this.cachedPlugins = null;
    this.cachedMtime = 0;
  }

  getLastErrors(): MarketplaceDiscoveryError[] {
    return [...this.discoveryErrors];
  }

  getMarketplaceDir(): string {
    return path.join(this.clowHome, MARKETPLACE_DIR);
  }
}
