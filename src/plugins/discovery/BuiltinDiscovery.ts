/**
 * BuiltinDiscovery.ts — Discover built-in plugins bundled with Clow
 *
 * Based on Claude Code's builtinPluginDiscovery.ts (~200 lines)
 *
 * Built-in plugins live in <clow-root>/plugins-builtin/.
 * They have the highest trust level and don't need user approval.
 *
 * Features:
 *   - Scan plugins-builtin/ directory
 *   - Validate each plugin has manifest
 *   - Load with 'builtin' source type (trust level: managed)
 *   - Symlink resolution for development
 *   - Caching of discovered list (invalidate on directory mtime change)
 *   - Error isolation (one bad plugin doesn't stop others)
 *   - Discovery logging with timing
 *   - Plugin metadata extraction
 *   - Cache statistics tracking
 *   - Development mode detection
 *   - Hot-reload support for development
 *   - Diagnostic reporting
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { PluginLoader } from '../PluginLoader.js';
import type { LoadedPlugin } from '../types.js';
import { PLUGIN_MANIFEST_DIR, PLUGIN_MANIFEST_FILE } from '../types.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_BUILTIN_PLUGINS = 50;

/**
 * Interval in ms between hot-reload checks in development mode.
 * Defaults to 2 seconds for responsive reloading.
 */
const HOT_RELOAD_INTERVAL_MS = 2000;

/**
 * Maximum number of hot-reload cycles before the watcher
 * is automatically disabled to prevent runaway polling.
 */
const MAX_HOT_RELOAD_CYCLES = 500;

// ─── Types ──────────────────────────────────────────────────────────────────

/** Describes an error encountered while discovering a single built-in plugin. */
interface BuiltinDiscoveryError {
  pluginDir: string;
  error: string;
}

/**
 * Metadata extracted from a discovered built-in plugin,
 * useful for debugging and inventory reporting.
 */
interface PluginMetadataEntry {
  /** Plugin name from manifest */
  name: string;
  /** Plugin version from manifest */
  version: string;
  /** Absolute path on disk */
  directory: string;
  /** Whether the directory is a symlink (dev mode) */
  isSymlink: boolean;
  /** Timestamp of the manifest file */
  manifestMtime: number;
  /** Number of declared components (commands + agents + skills + ...) */
  componentCount: number;
}

/** Aggregated cache statistics for monitoring and diagnostics. */
interface CacheStatistics {
  /** Total number of cache hits since construction */
  hits: number;
  /** Total number of cache misses (full rescan) */
  misses: number;
  /** Timestamp of the last successful cache population */
  lastPopulatedAt: number;
  /** Duration in ms of the last full scan */
  lastScanDurationMs: number;
  /** Number of plugins in the cache */
  cachedPluginCount: number;
}

/** Complete diagnostic snapshot returned by {@link BuiltinDiscovery.getDiagnostics}. */
interface DiagnosticReport {
  builtinDir: string;
  dirExists: boolean;
  pluginCount: number;
  errorCount: number;
  devMode: boolean;
  hotReloadActive: boolean;
  cacheStats: CacheStatistics;
  errors: BuiltinDiscoveryError[];
  metadata: PluginMetadataEntry[];
}

// ════════════════════════════════════════════════════════════════════════════
// BuiltinDiscovery Class
// ════════════════════════════════════════════════════════════════════════════

export class BuiltinDiscovery {
  private cachedPlugins: LoadedPlugin[] | null = null;
  private cachedMtime: number = 0;
  private discoveryErrors: BuiltinDiscoveryError[] = [];
  private pluginMetadata: PluginMetadataEntry[] = [];

  /** Whether we are currently operating in development mode. */
  private devMode: boolean = false;
  /** Handle returned by setInterval for the hot-reload watcher. */
  private hotReloadTimer: ReturnType<typeof setInterval> | null = null;
  /** Number of hot-reload cycles executed so far. */
  private hotReloadCycles: number = 0;

  /** Aggregated cache statistics. */
  private cacheStats: CacheStatistics = {
    hits: 0,
    misses: 0,
    lastPopulatedAt: 0,
    lastScanDurationMs: 0,
    cachedPluginCount: 0,
  };

  constructor(
    private readonly loader: PluginLoader,
    private readonly builtinDir?: string,
  ) {
    this.devMode = this.detectDevMode();
  }

  /**
   * Discover all built-in plugins.
   * Results are cached and invalidated when the directory mtime changes.
   */
  async discover(): Promise<LoadedPlugin[]> {
    const dir = this.resolveBuiltinDir();
    if (!fs.existsSync(dir)) return [];

    // Check cache validity
    try {
      const stat = await fsp.stat(dir);
      if (this.cachedPlugins && stat.mtimeMs === this.cachedMtime) {
        this.cacheStats.hits++;
        return this.cachedPlugins;
      }
      this.cachedMtime = stat.mtimeMs;
      this.cacheStats.misses++;
    } catch {
      return [];
    }

    const startTime = Date.now();
    this.discoveryErrors = [];
    this.pluginMetadata = [];
    const plugins: LoadedPlugin[] = [];

    try {
      const entries = await fsp.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;

        const pluginDir = path.join(dir, entry.name);

        // Resolve symlinks (for dev environments)
        let resolvedDir = pluginDir;
        let isSymlink = false;
        try {
          const realPath = await fsp.realpath(pluginDir);
          if (realPath !== pluginDir) {
            resolvedDir = realPath;
            isSymlink = true;
          }
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
          const plugin = await this.loader.load(resolvedDir, { type: 'builtin' });
          plugins.push(plugin);

          // Extract metadata for diagnostics
          const meta = await this.extractMetadata(plugin, resolvedDir, isSymlink, manifestPath);
          this.pluginMetadata.push(meta);
        } catch (err) {
          this.discoveryErrors.push({
            pluginDir: resolvedDir,
            error: (err as Error).message,
          });
        }

        if (plugins.length >= MAX_BUILTIN_PLUGINS) break;
      }
    } catch (err) {
      console.warn(`[BuiltinDiscovery] Failed to scan ${dir}: ${(err as Error).message}`);
    }

    const elapsed = Date.now() - startTime;
    if (plugins.length > 0) {
      console.log(`[BuiltinDiscovery] Found ${plugins.length} built-in plugins in ${elapsed}ms`);
    }

    this.cachedPlugins = plugins;
    this.cacheStats.lastPopulatedAt = Date.now();
    this.cacheStats.lastScanDurationMs = elapsed;
    this.cacheStats.cachedPluginCount = plugins.length;
    return plugins;
  }

  /**
   * Invalidate cache to force re-discovery.
   */
  invalidateCache(): void {
    this.cachedPlugins = null;
    this.cachedMtime = 0;
  }

  /**
   * Get errors from last discovery run.
   */
  getLastErrors(): BuiltinDiscoveryError[] {
    return [...this.discoveryErrors];
  }

  // ─── Plugin Metadata ────────────────────────────────────────────

  /**
   * Return metadata entries collected during the most recent scan.
   * Each entry contains the plugin name, version, directory, and
   * whether it was loaded through a symlink.
   */
  getPluginMetadata(): PluginMetadataEntry[] {
    return [...this.pluginMetadata];
  }

  // ─── Cache Statistics ───────────────────────────────────────────

  /**
   * Retrieve aggregated cache statistics.
   * Useful for monitoring the efficiency of the discovery cache layer.
   */
  getCacheStatistics(): CacheStatistics {
    return { ...this.cacheStats };
  }

  /**
   * Reset all cache statistics counters to zero.
   */
  resetCacheStatistics(): void {
    this.cacheStats = {
      hits: 0,
      misses: 0,
      lastPopulatedAt: 0,
      lastScanDurationMs: 0,
      cachedPluginCount: 0,
    };
  }

  // ─── Development Mode ───────────────────────────────────────────

  /**
   * Returns `true` when the discovery instance has detected a development
   * environment.  Detection checks for the presence of `CLOW_DEV` or
   * `NODE_ENV === 'development'`.
   */
  isDevMode(): boolean {
    return this.devMode;
  }

  // ─── Hot Reload ─────────────────────────────────────────────────

  /**
   * Start polling the builtin directory for changes and re-discover
   * automatically.  Only meaningful in development mode.
   *
   * @param onReload - callback invoked after a successful hot-reload
   *   cycle with the freshly loaded plugin list.
   */
  startHotReload(onReload?: (plugins: LoadedPlugin[]) => void): void {
    if (this.hotReloadTimer) return; // already running
    this.hotReloadCycles = 0;

    this.hotReloadTimer = setInterval(async () => {
      if (this.hotReloadCycles >= MAX_HOT_RELOAD_CYCLES) {
        this.stopHotReload();
        console.warn('[BuiltinDiscovery] Hot-reload stopped: maximum cycle count reached');
        return;
      }
      this.hotReloadCycles++;

      const dir = this.resolveBuiltinDir();
      if (!fs.existsSync(dir)) return;

      try {
        const stat = await fsp.stat(dir);
        if (stat.mtimeMs !== this.cachedMtime) {
          this.invalidateCache();
          const plugins = await this.discover();
          if (onReload) onReload(plugins);
        }
      } catch { /* ignore transient stat errors */ }
    }, HOT_RELOAD_INTERVAL_MS);
  }

  /**
   * Stop the hot-reload polling interval.
   */
  stopHotReload(): void {
    if (this.hotReloadTimer) {
      clearInterval(this.hotReloadTimer);
      this.hotReloadTimer = null;
    }
  }

  /**
   * Returns `true` if the hot-reload watcher is currently active.
   */
  isHotReloadActive(): boolean {
    return this.hotReloadTimer !== null;
  }

  // ─── Diagnostic Report ──────────────────────────────────────────

  /**
   * Produce a complete diagnostic snapshot of the discovery subsystem.
   * The report includes the resolved directory, errors, metadata entries,
   * cache statistics, and development mode flags.
   */
  getDiagnostics(): DiagnosticReport {
    const dir = this.resolveBuiltinDir();
    return {
      builtinDir: dir,
      dirExists: fs.existsSync(dir),
      pluginCount: this.cachedPlugins?.length ?? 0,
      errorCount: this.discoveryErrors.length,
      devMode: this.devMode,
      hotReloadActive: this.isHotReloadActive(),
      cacheStats: this.getCacheStatistics(),
      errors: this.getLastErrors(),
      metadata: this.getPluginMetadata(),
    };
  }

  // ─── Internal ────────────────────────────────────────────────────

  private resolveBuiltinDir(): string {
    if (this.builtinDir) return this.builtinDir;

    // Try multiple locations
    const candidates = [
      path.resolve(process.cwd(), 'plugins-builtin'),
      path.resolve(__dirname, '..', '..', '..', 'plugins-builtin'),
      path.resolve(__dirname, '..', '..', 'plugins-builtin'),
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }

    return candidates[0]; // default
  }

  /**
   * Detect development mode by inspecting common environment variables.
   */
  private detectDevMode(): boolean {
    if (process.env.CLOW_DEV === '1' || process.env.CLOW_DEV === 'true') return true;
    if (process.env.NODE_ENV === 'development') return true;
    return false;
  }

  /**
   * Extract structured metadata from a successfully loaded plugin.
   */
  private async extractMetadata(
    plugin: LoadedPlugin,
    resolvedDir: string,
    isSymlink: boolean,
    manifestPath: string,
  ): Promise<PluginMetadataEntry> {
    let manifestMtime = 0;
    try {
      const stat = await fsp.stat(manifestPath);
      manifestMtime = stat.mtimeMs;
    } catch { /* use zero */ }

    let componentCount = 0;
    componentCount += plugin.loadedCommands.length;
    componentCount += plugin.loadedAgents.length;
    componentCount += plugin.loadedSkills.length;
    componentCount += plugin.loadedHooks.length;
    componentCount += plugin.loadedMcpServers.length;
    componentCount += plugin.loadedTools.length;
    componentCount += plugin.loadedOutputStyles.length;

    return {
      name: plugin.manifest.name,
      version: plugin.manifest.version,
      directory: resolvedDir,
      isSymlink,
      manifestMtime,
      componentCount,
    };
  }
}
