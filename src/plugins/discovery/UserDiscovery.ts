/**
 * UserDiscovery.ts — Discover plugins in ~/.clow/plugins/
 *
 * Based on Claude Code's userPluginDiscovery.ts (~250 lines)
 *
 * User-level plugins are shared across all projects.
 * They have priority 3 (below project, above marketplace/builtin).
 *
 * Features:
 *   - Scan ~/.clow/plugins/ directory
 *   - Support for custom CLOW_HOME environment variable
 *   - Plugin enable/disable via ~/.clow/plugin-state.json
 *   - Discovery caching
 *   - Symlink resolution
 *   - Error isolation
 *   - Plugin state persistence
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { PluginLoader } from '../PluginLoader.js';
import type { LoadedPlugin } from '../types.js';
import { PLUGIN_MANIFEST_DIR, PLUGIN_MANIFEST_FILE } from '../types.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_USER_PLUGINS = 200;
const PLUGIN_STATE_FILE = 'plugin-state.json';

// ─── Types ──────────────────────────────────────────────────────────────────

interface PluginState {
  disabled: string[];
  lastScanAt: number;
  pluginOrder?: string[];
}

interface UserDiscoveryError {
  pluginDir: string;
  error: string;
}

// ════════════════════════════════════════════════════════════════════════════
// UserDiscovery Class
// ════════════════════════════════════════════════════════════════════════════

export class UserDiscovery {
  private readonly clowHome: string;
  private cachedPlugins: LoadedPlugin[] | null = null;
  private cachedMtime: number = 0;
  private discoveryErrors: UserDiscoveryError[] = [];
  private pluginState: PluginState | null = null;

  constructor(
    private readonly loader: PluginLoader,
    clowHome?: string,
  ) {
    this.clowHome = clowHome ?? process.env.CLOW_HOME ?? path.join(os.homedir(), '.clow');
  }

  /**
   * Discover all user-level plugins.
   */
  async discover(): Promise<LoadedPlugin[]> {
    const dir = path.join(this.clowHome, 'plugins');
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

    // Load plugin state
    await this.loadPluginState();

    const plugins: LoadedPlugin[] = [];

    try {
      const entries = await fsp.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;

        const pluginDir = path.join(dir, entry.name);

        // Resolve symlinks
        let resolvedDir = pluginDir;
        try {
          const realPath = await fsp.realpath(pluginDir);
          if (realPath !== pluginDir) resolvedDir = realPath;
        } catch { /* keep original */ }

        // Check for manifest
        const manifestPath = path.join(resolvedDir, PLUGIN_MANIFEST_DIR, PLUGIN_MANIFEST_FILE);
        if (!fs.existsSync(manifestPath)) {
          this.discoveryErrors.push({
            pluginDir: resolvedDir,
            error: 'No plugin manifest found',
          });
          continue;
        }

        try {
          const plugin = await this.loader.load(resolvedDir, {
            type: 'user',
            path: resolvedDir,
          });

          // Apply disabled state
          if (this.isPluginDisabled(plugin.manifest.name)) {
            plugin.enabled = false;
          }

          plugins.push(plugin);
        } catch (err) {
          this.discoveryErrors.push({
            pluginDir: resolvedDir,
            error: (err as Error).message,
          });
        }

        if (plugins.length >= MAX_USER_PLUGINS) break;
      }
    } catch (err) {
      console.warn(`[UserDiscovery] Failed to scan ${dir}: ${(err as Error).message}`);
    }

    const elapsed = Date.now() - startTime;
    if (plugins.length > 0) {
      console.log(`[UserDiscovery] Found ${plugins.length} user plugins in ${elapsed}ms`);
    }

    // Update scan timestamp
    await this.updateScanTimestamp();

    this.cachedPlugins = plugins;
    return plugins;
  }

  // ─── Plugin State ────────────────────────────────────────────────

  /**
   * Load plugin enable/disable state from disk.
   */
  private async loadPluginState(): Promise<void> {
    const statePath = path.join(this.clowHome, PLUGIN_STATE_FILE);
    try {
      if (fs.existsSync(statePath)) {
        const content = await fsp.readFile(statePath, 'utf-8');
        this.pluginState = JSON.parse(content);
      }
    } catch {
      this.pluginState = null;
    }
  }

  /**
   * Check if a plugin is disabled.
   */
  private isPluginDisabled(name: string): boolean {
    return this.pluginState?.disabled?.includes(name) ?? false;
  }

  /**
   * Disable a user plugin.
   */
  async disablePlugin(name: string): Promise<void> {
    await this.loadPluginState();
    const state = this.pluginState ?? { disabled: [], lastScanAt: 0 };
    if (!state.disabled.includes(name)) {
      state.disabled.push(name);
    }
    await this.savePluginState(state);
    this.invalidateCache();
  }

  /**
   * Enable a user plugin.
   */
  async enablePlugin(name: string): Promise<void> {
    await this.loadPluginState();
    const state = this.pluginState ?? { disabled: [], lastScanAt: 0 };
    state.disabled = state.disabled.filter(n => n !== name);
    await this.savePluginState(state);
    this.invalidateCache();
  }

  /**
   * Update last scan timestamp.
   */
  private async updateScanTimestamp(): Promise<void> {
    const state = this.pluginState ?? { disabled: [], lastScanAt: 0 };
    state.lastScanAt = Date.now();
    await this.savePluginState(state);
  }

  /**
   * Save plugin state to disk.
   */
  private async savePluginState(state: PluginState): Promise<void> {
    const statePath = path.join(this.clowHome, PLUGIN_STATE_FILE);
    try {
      await fsp.mkdir(this.clowHome, { recursive: true });
      await fsp.writeFile(statePath, JSON.stringify(state, null, 2));
      this.pluginState = state;
    } catch { /* skip */ }
  }

  // ─── Cache ───────────────────────────────────────────────────────

  invalidateCache(): void {
    this.cachedPlugins = null;
    this.cachedMtime = 0;
  }

  getLastErrors(): UserDiscoveryError[] {
    return [...this.discoveryErrors];
  }

  getClowHome(): string {
    return this.clowHome;
  }
}
