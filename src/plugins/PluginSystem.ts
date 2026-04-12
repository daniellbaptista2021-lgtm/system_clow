/**
 * PluginSystem.ts — Top-level orchestrator for the plugin ecosystem
 *
 * Based on Claude Code's pluginSystem.ts (~400 lines)
 *
 * This is the main entry point for the plugin system.
 * All other components (Registry, Discovery, Installer, Validator)
 * are managed through this class.
 *
 * Features:
 *   - Initialize: discover + load all plugins
 *   - Install/Uninstall/Reinstall plugins
 *   - Enable/Disable individual plugins
 *   - Hot-reload (re-load single plugin without restart)
 *   - Lifecycle events (pre/post init, install, etc.)
 *   - Component aggregation (commands, hooks, agents, etc.)
 *   - Statistics and health check
 *   - Configuration management
 */

import * as path from 'path';
import * as os from 'os';
import { PluginRegistry } from './PluginRegistry.js';
import { PluginValidator } from './PluginValidator.js';
import { PluginLoader } from './PluginLoader.js';
import { PluginDiscovery } from './discovery/PluginDiscovery.js';
import { PluginInstaller } from './installation/PluginInstaller.js';
import type { LoadedPlugin, InstallationRequest, InstallationResult, PluginCommand, PluginAgentDef } from './types.js';
import type { ConfiguredHook } from '../hooks/types.js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface PluginSystemStats {
  initialized: boolean;
  pluginCount: number;
  enabledCount: number;
  commandCount: number;
  agentCount: number;
  hookCount: number;
  mcpServerCount: number;
  initDurationMs: number;
  lastInitAt: number;
  errorsCount: number;
}

type LifecycleEvent = 'pre-init' | 'post-init' | 'pre-install' | 'post-install' | 'pre-uninstall' | 'post-uninstall' | 'plugin-loaded' | 'plugin-unloaded';

type LifecycleHandler = (event: LifecycleEvent, data?: Record<string, unknown>) => void;

// ════════════════════════════════════════════════════════════════════════════
// PluginSystem Class
// ════════════════════════════════════════════════════════════════════════════

export class PluginSystem {
  readonly registry = new PluginRegistry();
  private readonly validator = new PluginValidator();
  private readonly loader = new PluginLoader();
  private readonly discovery: PluginDiscovery;
  private readonly installer: PluginInstaller;

  private initialized = false;
  private initDurationMs = 0;
  private lastInitAt = 0;
  private workspaceRoot: string = '';
  private lifecycleHandlers: LifecycleHandler[] = [];

  constructor(private readonly clowHome?: string) {
    const home = clowHome ?? path.join(os.homedir(), '.clow');
    this.discovery = new PluginDiscovery(this.loader, home);
    this.installer = new PluginInstaller(this.registry, home);
  }

  // ─── Initialization ──────────────────────────────────────────────

  /**
   * Initialize the plugin system: discover and load all plugins.
   */
  async initialize(workspaceRoot: string): Promise<{ loaded: number; errors: number }> {
    this.workspaceRoot = workspaceRoot;
    this.emitLifecycle('pre-init', { workspaceRoot });

    const startTime = Date.now();
    let errors = 0;

    try {
      const plugins = await this.discovery.discoverAll(workspaceRoot);

      for (const plugin of plugins) {
        this.registry.add(plugin);
        if (plugin.validationErrors.length > 0) errors++;
        this.emitLifecycle('plugin-loaded', { name: plugin.manifest.name });
      }

      this.initialized = true;
      this.initDurationMs = Date.now() - startTime;
      this.lastInitAt = Date.now();

      this.emitLifecycle('post-init', {
        loaded: plugins.length,
        errors,
        durationMs: this.initDurationMs,
      });

      return { loaded: plugins.length, errors };
    } catch (err) {
      this.initialized = true; // Mark as initialized even on error (partial state)
      this.initDurationMs = Date.now() - startTime;
      throw err;
    }
  }

  /**
   * Re-initialize: clear and re-discover all plugins.
   */
  async reinitialize(): Promise<{ loaded: number; errors: number }> {
    this.registry.clear();
    this.initialized = false;
    return this.initialize(this.workspaceRoot);
  }

  // ─── Installation ────────────────────────────────────────────────

  /**
   * Install a plugin from any source.
   */
  async install(request: InstallationRequest): Promise<InstallationResult> {
    this.emitLifecycle('pre-install', { source: request.source.type });

    const result = await this.installer.install(request);

    if (result.success && result.installedTo && result.pluginName) {
      // If installer didn't register it, do it now
      if (!this.registry.has(result.pluginName)) {
        try {
          const plugin = await this.loader.load(result.installedTo, request.source);
          this.registry.add(plugin);
          this.emitLifecycle('plugin-loaded', { name: plugin.manifest.name });
        } catch { /* logged in installer */ }
      }
    }

    this.emitLifecycle('post-install', {
      success: result.success,
      pluginName: result.pluginName,
    });

    return result;
  }

  /**
   * Uninstall a plugin by name.
   */
  async uninstall(name: string): Promise<boolean> {
    this.emitLifecycle('pre-uninstall', { name });
    const result = this.registry.remove(name);
    this.emitLifecycle('post-uninstall', { name, success: result });
    return result;
  }

  // ─── Enable/Disable ──────────────────────────────────────────────

  enable(name: string): boolean {
    return this.registry.enable(name);
  }

  disable(name: string): boolean {
    return this.registry.disable(name);
  }

  // ─── Hot Reload ──────────────────────────────────────────────────

  /**
   * Hot-reload a single plugin (re-read from disk).
   */
  async hotReload(pluginName: string): Promise<{ success: boolean; error?: string }> {
    const existing = this.registry.get(pluginName);
    if (!existing) return { success: false, error: 'Plugin not found' };

    try {
      const reloaded = await this.loader.load(existing.rootDir, existing.source);
      this.registry.add(reloaded);
      this.emitLifecycle('plugin-loaded', { name: pluginName, hotReload: true });
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  // ─── Component Aggregation ───────────────────────────────────────

  getCommands(): Array<{ plugin: string; command: PluginCommand }> {
    return this.registry.getAllCommands();
  }

  getHooks(): ConfiguredHook[] {
    return this.registry.getAllHooks();
  }

  getAgents(): PluginAgentDef[] {
    return this.registry.getAllAgents();
  }

  getMcpServers(): string[] {
    return this.registry.getAllMcpServers();
  }

  getSkills(): string[] {
    return this.registry.getAllSkills();
  }

  getTools(): string[] {
    return this.registry.getAllTools();
  }

  getOutputStyles(): string[] {
    return this.registry.getAllOutputStyles();
  }

  // ─── Statistics ──────────────────────────────────────────────────

  getStats(): PluginSystemStats {
    const regStats = this.registry.getStats();
    return {
      initialized: this.initialized,
      pluginCount: regStats.total,
      enabledCount: regStats.enabled,
      commandCount: regStats.totalCommands,
      agentCount: regStats.totalAgents,
      hookCount: regStats.totalHooks,
      mcpServerCount: regStats.totalMcpServers,
      initDurationMs: this.initDurationMs,
      lastInitAt: this.lastInitAt,
      errorsCount: this.registry.list().reduce((n, p) => n + p.validationErrors.length, 0),
    };
  }

  // ─── Lifecycle Events ────────────────────────────────────────────

  onLifecycle(handler: LifecycleHandler): void {
    this.lifecycleHandlers.push(handler);
  }

  private emitLifecycle(event: LifecycleEvent, data?: Record<string, unknown>): void {
    for (const handler of this.lifecycleHandlers) {
      try { handler(event, data); } catch { /* ignore */ }
    }
  }

  // ─── Accessors ───────────────────────────────────────────────────

  getValidator(): PluginValidator { return this.validator; }
  getLoader(): PluginLoader { return this.loader; }
  getDiscovery(): PluginDiscovery { return this.discovery; }
  getInstaller(): PluginInstaller { return this.installer; }
  isInitialized(): boolean { return this.initialized; }
  getWorkspaceRoot(): string { return this.workspaceRoot; }
}
