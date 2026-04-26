/**
 * PluginLoader.ts — Full plugin loading with retry, progress, hot-reload, config
 *
 * Based on Claude Code's pluginLoader.ts (113K / ~3500 lines)
 * This is the second-largest file in the plugin system.
 *
 * Loading pipeline:
 *   1. Read manifest from .clow-plugin/plugin.json
 *   2. Validate manifest schema (Zod)
 *   3. Multi-pass validation (consistency, security, permissions)
 *   4. Load config (user overrides from ~/.clow/plugin-configs/<name>.json)
 *   5. Load all 7 component types IN PARALLEL with error isolation
 *   6. Merge validation errors from all stages
 *   7. Apply trust state from trust store
 *   8. Register in plugin registry
 *
 * Error isolation: one component failing does NOT prevent others from loading.
 * Each component load is wrapped in try/catch, errors collected, plugin still usable.
 *
 * Hot-reload: when a plugin's files change on disk, the loader can reload
 * individual components without restarting the entire plugin system.
 *
 * Retry: if a component load fails transiently (e.g., file locked), retry up to 3 times.
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { PluginValidator, type ValidationResult } from './PluginValidator.js';
import { validatePluginManifest } from './PluginManifestSchema.js';
import { PluginCommandLoader } from './components/PluginCommandLoader.js';
import { PluginAgentLoader } from './components/PluginAgentLoader.js';
import { PluginHookLoader } from './components/PluginHookLoader.js';
import { PluginSkillLoader } from './components/PluginSkillLoader.js';
import { PluginMcpLoader } from './components/PluginMcpLoader.js';
import { PluginOutputStyleLoader } from './components/PluginOutputStyleLoader.js';
import { PluginToolLoader } from './components/PluginToolLoader.js';
import { PLUGIN_MANIFEST_DIR, PLUGIN_MANIFEST_FILE } from './types.js';
import type {
  LoadedPlugin,
  PluginSource,
  PluginManifest,
  PluginValidationError,
  PluginCommand,
  PluginAgentDef,
  PluginTrustState,
} from './types.js';
import type { ConfiguredHook } from '../hooks/types.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_COMPONENT_LOAD_RETRIES = 3;
const COMPONENT_RETRY_DELAY_MS = 200;
const MAX_MANIFEST_SIZE_BYTES = 1_000_000; // 1MB
const MAX_COMPONENT_FILES = 100; // per component type

// ─── Load Progress ──────────────────────────────────────────────────────────

export interface LoadProgress {
  phase: 'reading_manifest' | 'validating' | 'loading_config' | 'loading_components' | 'finalizing';
  component?: string;
  progress: number; // 0-1
  message: string;
}

export type LoadProgressCallback = (progress: LoadProgress) => void;

// ─── Component Load Result ──────────────────────────────────────────────────

interface ComponentLoadResult<T> {
  value: T[] | null;
  errors: PluginValidationError[];
  warnings: PluginValidationError[];
  durationMs: number;
  retries: number;
}

// ─── Plugin Config (user overrides) ─────────────────────────────────────────

interface PluginConfig {
  enabled?: boolean;
  config?: Record<string, unknown>;
  trustState?: PluginTrustState;
}

// ════════════════════════════════════════════════════════════════════════════
// PluginLoader Class
// ════════════════════════════════════════════════════════════════════════════

export class PluginLoader {
  private validator = new PluginValidator();
  private cmdLoader = new PluginCommandLoader();
  private agentLoader = new PluginAgentLoader();
  private hookLoader = new PluginHookLoader();
  private skillLoader = new PluginSkillLoader();
  private mcpLoader = new PluginMcpLoader();
  private styleLoader = new PluginOutputStyleLoader();
  private toolLoader = new PluginToolLoader();
  private clowHome: string;

  constructor(clowHome?: string) {
    this.clowHome = clowHome ?? path.join(os.homedir(), '.clow');
  }

  // ════════════════════════════════════════════════════════════════════
  // Main load method
  // ════════════════════════════════════════════════════════════════════

  /**
   * Load a plugin from a directory.
   *
   * NEVER throws — always returns a LoadedPlugin, even if loading failed.
   * Check validationErrors to see if the plugin is usable.
   *
   * @param rootDir - Absolute path to plugin root directory
   * @param source - Where this plugin came from (builtin, user, project, etc)
   * @param onProgress - Optional callback for UI progress reporting
   */
  async load(
    rootDir: string,
    source: PluginSource,
    onProgress?: LoadProgressCallback,
  ): Promise<LoadedPlugin> {
    const startTime = Date.now();
    const allErrors: PluginValidationError[] = [];
    const allWarnings: PluginValidationError[] = [];

    // ── Phase 1: Read manifest ──────────────────────────────────────
    onProgress?.({ phase: 'reading_manifest', progress: 0.1, message: 'Reading manifest...' });

    const manifestPath = path.join(rootDir, PLUGIN_MANIFEST_DIR, PLUGIN_MANIFEST_FILE);

    if (!fs.existsSync(manifestPath)) {
      return this.failedPlugin(rootDir, source, [{
        code: 'MANIFEST_NOT_FOUND',
        message: `Plugin manifest not found at ${manifestPath}`,
        severity: 'error',
        filePath: manifestPath,
        recoverable: false,
      }]);
    }

    // Check manifest size (prevent DoS via huge JSON)
    let manifestStat: fs.Stats;
    try {
      manifestStat = await fsp.stat(manifestPath);
      if (manifestStat.size > MAX_MANIFEST_SIZE_BYTES) {
        return this.failedPlugin(rootDir, source, [{
          code: 'MANIFEST_TOO_LARGE',
          message: `Manifest is ${manifestStat.size} bytes (max ${MAX_MANIFEST_SIZE_BYTES})`,
          severity: 'error',
          recoverable: false,
        }]);
      }
    } catch (err) {
      return this.failedPlugin(rootDir, source, [{
        code: 'MANIFEST_STAT_FAILED',
        message: `Cannot stat manifest: ${(err as Error).message}`,
        severity: 'error',
        recoverable: false,
      }]);
    }

    // Read and parse JSON
    let rawManifest: unknown;
    try {
      const content = await fsp.readFile(manifestPath, 'utf-8');
      rawManifest = JSON.parse(content);
    } catch (err) {
      return this.failedPlugin(rootDir, source, [{
        code: 'MANIFEST_PARSE_FAILED',
        message: `Cannot parse manifest: ${(err as Error).message}`,
        severity: 'error',
        filePath: manifestPath,
        recoverable: false,
      }]);
    }

    // ── Phase 2: Schema validation ──────────────────────────────────
    onProgress?.({ phase: 'validating', progress: 0.2, message: 'Validating manifest...' });

    const schemaResult = validatePluginManifest(rawManifest);
    if (!schemaResult.valid) {
      return this.failedPlugin(rootDir, source, schemaResult.errors);
    }
    const manifest = schemaResult.data;

    // ── Phase 3: Multi-pass validation ──────────────────────────────
    onProgress?.({ phase: 'validating', progress: 0.3, message: 'Running validation passes...' });

    const validation = await this.validator.validate(manifest, rootDir);
    allErrors.push(...validation.errors);
    allWarnings.push(...validation.warnings);

    // If critical errors, still load but mark as disabled
    const hasCriticalErrors = validation.errors.some(
      e => e.severity === 'error' && !e.recoverable,
    );

    // ── Phase 4: Load user config ─���─────────────────────────────────
    onProgress?.({ phase: 'loading_config', progress: 0.4, message: 'Loading config...' });

    const userConfig = await this.loadUserConfig(manifest.name);

    // ── Phase 5: Load all components in parallel ────────────────────
    onProgress?.({ phase: 'loading_components', progress: 0.5, message: 'Loading components...' });

    const componentResults = await this.loadAllComponents(rootDir, manifest, onProgress);

    // Collect all component errors
    for (const [componentName, result] of Object.entries(componentResults)) {
      for (const err of result.errors) {
        allErrors.push({ ...err, field: componentName });
      }
      for (const warn of result.warnings) {
        allWarnings.push({ ...warn, field: componentName });
      }
    }

    // ── Phase 6: Build LoadedPlugin ─────────────────────────────────
    onProgress?.({ phase: 'finalizing', progress: 0.9, message: 'Finalizing...' });

    // Determine trust state
    let trustState: PluginTrustState;
    if (source.type === 'builtin') {
      trustState = 'trusted';
    } else if (userConfig?.trustState) {
      trustState = userConfig.trustState;
    } else {
      trustState = 'pending_review';
    }

    // Determine enabled state
    const enabled = !hasCriticalErrors && (userConfig?.enabled !== false);

    const loadedPlugin: LoadedPlugin = {
      manifest,
      rootDir,
      installPath: rootDir,
      source,
      installedAt: Date.now(),
      enabled,
      loadedCommands: componentResults.commands.value ?? [],
      loadedAgents: componentResults.agents.value ?? [],
      loadedSkills: componentResults.skills.value ?? [],
      loadedHooks: componentResults.hooks.value ?? [],
      loadedMcpServers: componentResults.mcp.value ?? [],
      loadedTools: componentResults.tools.value ?? [],
      loadedOutputStyles: componentResults.styles.value ?? [],
      config: {
        ...manifest.defaultConfig,
        ...userConfig?.config,
      },
      trustState,
      validationErrors: allErrors,
      validationWarnings: allWarnings,
    };

    onProgress?.({ phase: 'finalizing', progress: 1.0, message: 'Done' });

    // Log summary
    const duration = Date.now() - startTime;
    const componentCount = this.countComponents(loadedPlugin);
    if (allErrors.length > 0) {
      console.warn(
        `[PluginLoader] ${manifest.name}@${manifest.version}: loaded ${componentCount} components with ${allErrors.length} error(s) in ${duration}ms`,
      );
    }

    return loadedPlugin;
  }

  // ═════════════════════════════════════════════════════════════��══════
  // Component Loading (parallel, isolated, with retry)
  // ════════════════════════════════════════════════════════════════════

  private async loadAllComponents(
    rootDir: string,
    manifest: PluginManifest,
    onProgress?: LoadProgressCallback,
  ): Promise<{
    commands: ComponentLoadResult<PluginCommand>;
    agents: ComponentLoadResult<PluginAgentDef>;
    hooks: ComponentLoadResult<ConfiguredHook>;
    skills: ComponentLoadResult<string>;
    mcp: ComponentLoadResult<string>;
    tools: ComponentLoadResult<string>;
    styles: ComponentLoadResult<string>;
  }> {
    // Load all in parallel — each isolated
    const [commands, agents, hooks, skills, mcp, tools, styles] = await Promise.all([
      this.loadComponentWithRetry('commands', () => this.cmdLoader.loadAll(rootDir, manifest), onProgress),
      this.loadComponentWithRetry('agents', () => this.agentLoader.loadAll(rootDir, manifest), onProgress),
      this.loadComponentWithRetry('hooks', () => this.hookLoader.loadAll(rootDir, manifest), onProgress),
      this.loadComponentWithRetry('skills', () => this.skillLoader.loadAll(rootDir, manifest), onProgress),
      this.loadComponentWithRetry('mcp', () => this.mcpLoader.loadAll(rootDir, manifest), onProgress),
      this.loadComponentWithRetry('tools', () => this.toolLoader.loadAll(rootDir, manifest), onProgress),
      this.loadComponentWithRetry('styles', () => this.styleLoader.loadAll(rootDir, manifest), onProgress),
    ]);

    return { commands, agents, hooks, skills, mcp, tools, styles };
  }

  /**
   * Load a single component type with retry on transient failure.
   * Up to MAX_COMPONENT_LOAD_RETRIES attempts with delay between.
   */
  private async loadComponentWithRetry<T>(
    componentName: string,
    loader: () => Promise<T[]>,
    onProgress?: LoadProgressCallback,
  ): Promise<ComponentLoadResult<T>> {
    const startTime = Date.now();
    let lastError: Error | undefined;
    let retries = 0;

    for (let attempt = 0; attempt <= MAX_COMPONENT_LOAD_RETRIES; attempt++) {
      try {
        onProgress?.({
          phase: 'loading_components',
          component: componentName,
          progress: 0.5 + (0.35 * attempt / MAX_COMPONENT_LOAD_RETRIES),
          message: `Loading ${componentName}${attempt > 0 ? ` (retry ${attempt})` : ''}...`,
        });

        const value = await loader();

        // Validate count
        if (value.length > MAX_COMPONENT_FILES) {
          return {
            value: value.slice(0, MAX_COMPONENT_FILES),
            errors: [],
            warnings: [{
              code: 'TOO_MANY_COMPONENTS',
              message: `${componentName} has ${value.length} items (max ${MAX_COMPONENT_FILES}), truncated`,
              severity: 'warning',
              field: componentName,
              recoverable: true,
            }],
            durationMs: Date.now() - startTime,
            retries: attempt,
          };
        }

        return {
          value,
          errors: [],
          warnings: [],
          durationMs: Date.now() - startTime,
          retries: attempt,
        };
      } catch (err) {
        lastError = err as Error;
        retries = attempt;

        // Only retry on transient errors
        const isTransient = this.isTransientError(err as Error);
        if (!isTransient || attempt >= MAX_COMPONENT_LOAD_RETRIES) {
          break;
        }

        // Wait before retry (exponential backoff)
        await new Promise(r => setTimeout(r, COMPONENT_RETRY_DELAY_MS * Math.pow(2, attempt)));
      }
    }

    // All retries exhausted
    return {
      value: null,
      errors: [{
        code: 'COMPONENT_LOAD_FAILED',
        message: `${componentName}: ${lastError?.message ?? 'unknown error'}${retries > 0 ? ` (after ${retries} retries)` : ''}`,
        severity: 'error',
        field: componentName,
        recoverable: true,
      }],
      warnings: [],
      durationMs: Date.now() - startTime,
      retries,
    };
  }

  /**
   * Detect transient errors that are worth retrying.
   * File locked, EBUSY, EAGAIN, etc.
   */
  private isTransientError(err: Error): boolean {
    const code = (err as any).code;
    const transientCodes = new Set(['EBUSY', 'EAGAIN', 'EACCES', 'EPERM', 'EMFILE', 'ENFILE']);
    if (code && transientCodes.has(code)) return true;

    const msg = err.message.toLowerCase();
    if (msg.includes('locked') || msg.includes('busy') || msg.includes('too many open')) return true;

    return false;
  }

  // ════════════════════════════════════════════════════════════════════
  // User Config Loading
  // ════════════════════════════════════════════════════════════════════

  /**
   * Load user config overrides from ~/.clow/plugin-configs/<name>.json
   */
  private async loadUserConfig(pluginName: string): Promise<PluginConfig | null> {
    const configPath = path.join(this.clowHome, 'plugin-configs', `${pluginName}.json`);
    if (!fs.existsSync(configPath)) return null;

    try {
      const content = await fsp.readFile(configPath, 'utf-8');
      return JSON.parse(content) as PluginConfig;
    } catch {
      return null;
    }
  }

  /**
   * Save user config overrides.
   */
  async saveUserConfig(pluginName: string, config: PluginConfig): Promise<void> {
    const configDir = path.join(this.clowHome, 'plugin-configs');
    await fsp.mkdir(configDir, { recursive: true });
    const configPath = path.join(configDir, `${pluginName}.json`);
    await fsp.writeFile(configPath, JSON.stringify(config, null, 2));
  }

  // ════════════════════════════════════════════════════════════════════
  // Hot Reload
  // ════════════════════════════════════════════════════════════════════

  /**
   * Reload a specific component type without reloading the entire plugin.
   * Used when a plugin's files change on disk.
   */
  async reloadComponent(
    plugin: LoadedPlugin,
    componentName: string,
  ): Promise<LoadedPlugin> {
    const rootDir = plugin.rootDir;
    const manifest = plugin.manifest;

    switch (componentName) {
      case 'commands': {
        const result = await this.loadComponentWithRetry('commands', () => this.cmdLoader.loadAll(rootDir, manifest));
        return { ...plugin, loadedCommands: result.value ?? plugin.loadedCommands };
      }
      case 'agents': {
        const result = await this.loadComponentWithRetry('agents', () => this.agentLoader.loadAll(rootDir, manifest));
        return { ...plugin, loadedAgents: result.value ?? plugin.loadedAgents };
      }
      case 'hooks': {
        const result = await this.loadComponentWithRetry('hooks', () => this.hookLoader.loadAll(rootDir, manifest));
        return { ...plugin, loadedHooks: result.value ?? plugin.loadedHooks };
      }
      case 'skills': {
        const result = await this.loadComponentWithRetry('skills', () => this.skillLoader.loadAll(rootDir, manifest));
        return { ...plugin, loadedSkills: result.value ?? plugin.loadedSkills };
      }
      default:
        return plugin;
    }
  }

  /**
   * Full reload of a plugin (re-read manifest, re-validate, re-load all components).
   */
  async fullReload(plugin: LoadedPlugin): Promise<LoadedPlugin> {
    return this.load(plugin.rootDir, plugin.source);
  }

  // ════════════════════════════════════════════════════════════════════
  // Helpers
  // ════════════════════════════════════════════════════════════════════

  /**
   * Build a failed plugin skeleton.
   * Never throws — always returns a LoadedPlugin with errors populated.
   */
  private failedPlugin(
    rootDir: string,
    source: PluginSource,
    errors: PluginValidationError[],
  ): LoadedPlugin {
    return {
      manifest: {
        name: 'unknown',
        version: '0.0.0',
        description: 'Failed to load',
      } as PluginManifest,
      rootDir,
      installPath: rootDir,
      source,
      installedAt: Date.now(),
      enabled: false,
      loadedCommands: [],
      loadedAgents: [],
      loadedSkills: [],
      loadedHooks: [],
      loadedMcpServers: [],
      loadedTools: [],
      loadedOutputStyles: [],
      trustState: 'untrusted',
      validationErrors: errors,
      validationWarnings: [],
    };
  }

  /**
   * Count total loaded components across all types.
   */
  private countComponents(plugin: LoadedPlugin): number {
    return (
      plugin.loadedCommands.length +
      plugin.loadedAgents.length +
      plugin.loadedSkills.length +
      plugin.loadedHooks.length +
      plugin.loadedMcpServers.length +
      plugin.loadedTools.length +
      plugin.loadedOutputStyles.length
    );
  }

  /**
   * Get a summary string for logging.
   */
  summarize(plugin: LoadedPlugin): string {
    const parts: string[] = [];
    if (plugin.loadedCommands.length) parts.push(`${plugin.loadedCommands.length} commands`);
    if (plugin.loadedAgents.length) parts.push(`${plugin.loadedAgents.length} agents`);
    if (plugin.loadedSkills.length) parts.push(`${plugin.loadedSkills.length} skills`);
    if (plugin.loadedHooks.length) parts.push(`${plugin.loadedHooks.length} hooks`);
    if (plugin.loadedMcpServers.length) parts.push(`${plugin.loadedMcpServers.length} MCP servers`);
    if (plugin.loadedTools.length) parts.push(`${plugin.loadedTools.length} tools`);
    if (plugin.loadedOutputStyles.length) parts.push(`${plugin.loadedOutputStyles.length} styles`);

    const errCount = plugin.validationErrors.length;
    const warnCount = plugin.validationWarnings.length;

    return [
      `${plugin.manifest.name}@${plugin.manifest.version}`,
      parts.length > 0 ? `(${parts.join(', ')})` : '(no components)',
      errCount > 0 ? `[${errCount} errors]` : '',
      warnCount > 0 ? `[${warnCount} warnings]` : '',
      plugin.enabled ? '' : '[DISABLED]',
    ].filter(Boolean).join(' ');
  }

  // ════════════════════════════════════════════════════════════════════
  // Hot-Reload Support
  // ════════════════════════════════════════════════════════════════════

  /**
   * Hot-reload a single component type for a plugin.
   * Returns the new component list without reloading everything.
   */
  async hotReloadComponent(
    plugin: LoadedPlugin,
    componentType: 'commands' | 'agents' | 'skills' | 'hooks' | 'mcpServers' | 'tools' | 'outputStyles',
  ): Promise<{ success: boolean; error?: string }> {
    try {
      switch (componentType) {
        case 'commands':
          plugin.loadedCommands = await this.cmdLoader.loadAll(plugin.rootDir, plugin.manifest);
          break;
        case 'agents':
          plugin.loadedAgents = await this.agentLoader.loadAll(plugin.rootDir, plugin.manifest);
          break;
        case 'skills':
          plugin.loadedSkills = await this.skillLoader.loadAll(plugin.rootDir, plugin.manifest);
          break;
        case 'hooks':
          plugin.loadedHooks = await this.hookLoader.loadAll(plugin.rootDir, plugin.manifest);
          break;
        case 'mcpServers':
          plugin.loadedMcpServers = await this.mcpLoader.loadAll(plugin.rootDir, plugin.manifest);
          break;
        case 'tools':
          plugin.loadedTools = await this.toolLoader.loadAll(plugin.rootDir, plugin.manifest);
          break;
        case 'outputStyles':
          plugin.loadedOutputStyles = await this.styleLoader.loadAll(plugin.rootDir, plugin.manifest);
          break;
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  /**
   * Full hot-reload: re-read manifest and all components from disk.
   */
  async hotReloadFull(plugin: LoadedPlugin): Promise<LoadedPlugin> {
    return this.load(plugin.rootDir, plugin.source);
  }

  // ════════════════════════════════════════════════════════════════════
  // Diagnostic & Validation
  // ════════════════════════════════════════════════════════════════════

  /**
   * Validate a plugin directory without fully loading it.
   * Returns manifest + validation errors.
   */
  async validateOnly(rootDir: string): Promise<{
    manifest: PluginManifest | null;
    errors: PluginValidationError[];
    warnings: PluginValidationError[];
  }> {
    const manifestPath = path.join(rootDir, PLUGIN_MANIFEST_DIR, PLUGIN_MANIFEST_FILE);
    if (!fs.existsSync(manifestPath)) {
      return {
        manifest: null,
        errors: [{ code: 'NO_MANIFEST', message: 'No plugin manifest found', severity: 'error', recoverable: false }],
        warnings: [],
      };
    }

    try {
      const raw = JSON.parse(await fsp.readFile(manifestPath, 'utf-8'));
      const result = validatePluginManifest(raw);
      if (!result.valid) {
        return { manifest: null, errors: result.errors, warnings: [] };
      }
      return { manifest: result.data, errors: [], warnings: [] };
    } catch (err) {
      return {
        manifest: null,
        errors: [{ code: 'MANIFEST_PARSE_ERROR', message: (err as Error).message, severity: 'error', recoverable: false }],
        warnings: [],
      };
    }
  }

  /**
   * Merge user config with plugin defaults.
   */
  mergeConfig(defaults: Record<string, unknown>, userConfig: Record<string, unknown>): Record<string, unknown> {
    return { ...defaults, ...userConfig };
  }
}
