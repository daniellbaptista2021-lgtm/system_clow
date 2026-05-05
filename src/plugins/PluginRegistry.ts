/**
 * PluginRegistry.ts — Global registry of loaded plugins
 *
 * Based on Claude Code's pluginRegistry.ts (~300 lines)
 *
 * The single source of truth for all loaded plugins in the system.
 *
 * Features:
 *   - Add/get/list/remove/enable/disable plugins
 *   - Source-based filtering (builtin, user, project, marketplace)
 *   - Component aggregation (commands, hooks, agents, skills, MCP servers)
 *   - Event emission on plugin state changes
 *   - Statistics and diagnostics
 *   - Plugin search (by name, tag, category)
 *   - Snapshot for serialization
 */

import type { LoadedPlugin, PluginSource, PluginCommand, PluginAgentDef, PluginCategory } from './types.js';
import type { ConfiguredHook } from '../hooks/types.js';

// ─── Types ──────────────────────────────────────────────────────────────────

type RegistryEventType = 'added' | 'removed' | 'enabled' | 'disabled' | 'updated';

interface RegistryEvent {
  type: RegistryEventType;
  pluginName: string;
  timestamp: number;
}

type RegistryEventHandler = (event: RegistryEvent) => void;

interface RegistryStats {
  total: number;
  enabled: number;
  disabled: number;
  bySource: Record<string, number>;
  totalCommands: number;
  totalAgents: number;
  totalHooks: number;
  totalMcpServers: number;
  totalSkills: number;
  totalTools: number;
}

// ════════════════════════════════════════════════════════════════════════════
// PluginRegistry Class
// ════════════════════════════════════════════════════════════════════════════

export class PluginRegistry {
  private plugins = new Map<string, LoadedPlugin>();
  private eventHandlers: RegistryEventHandler[] = [];
  private eventHistory: RegistryEvent[] = [];

  // ─── CRUD Operations ─────────────────────────────────────────────

  /**
   * Add or replace a plugin in the registry.
   */
  add(plugin: LoadedPlugin): void {
    const isUpdate = this.plugins.has(plugin.manifest.name);
    this.plugins.set(plugin.manifest.name, plugin);
    this.emit(isUpdate ? 'updated' : 'added', plugin.manifest.name);
  }

  /**
   * Get a plugin by name.
   */
  get(name: string): LoadedPlugin | null {
    return this.plugins.get(name) ?? null;
  }

  /**
   * Remove a plugin from the registry.
   */
  remove(name: string): boolean {
    const removed = this.plugins.delete(name);
    if (removed) this.emit('removed', name);
    return removed;
  }

  /**
   * Check if a plugin exists in the registry.
   */
  has(name: string): boolean {
    return this.plugins.has(name);
  }

  // ─── Listing ─────────────────────────────────────────────────────

  /**
   * List all plugins.
   */
  list(): LoadedPlugin[] {
    return [...this.plugins.values()];
  }

  /**
   * List only enabled plugins.
   */
  listEnabled(): LoadedPlugin[] {
    return this.list().filter(p => p.enabled);
  }

  /**
   * List only disabled plugins.
   */
  listDisabled(): LoadedPlugin[] {
    return this.list().filter(p => !p.enabled);
  }

  /**
   * List plugins from a specific source type.
   */
  listBySource(type: PluginSource['type']): LoadedPlugin[] {
    return this.list().filter(p => p.source.type === type);
  }

  /**
   * List plugins by category.
   */
  listByCategory(category: PluginCategory): LoadedPlugin[] {
    return this.list().filter(p => p.manifest.category === category);
  }

  /**
   * Search plugins by name or tag.
   */
  search(query: string): LoadedPlugin[] {
    const q = query.toLowerCase();
    return this.list().filter(p => {
      if (p.manifest.name.toLowerCase().includes(q)) return true;
      if (p.manifest.description.toLowerCase().includes(q)) return true;
      if (p.manifest.tags?.some(t => t.toLowerCase().includes(q))) return true;
      if (p.manifest.keywords?.some(k => k.toLowerCase().includes(q))) return true;
      return false;
    });
  }

  // ─── Enable/Disable ──────────────────────────────────────────────

  enable(name: string): boolean {
    const p = this.plugins.get(name);
    if (!p) return false;
    p.enabled = true;
    this.emit('enabled', name);
    return true;
  }

  disable(name: string): boolean {
    const p = this.plugins.get(name);
    if (!p) return false;
    p.enabled = false;
    this.emit('disabled', name);
    return true;
  }

  isEnabled(name: string): boolean {
    return this.plugins.get(name)?.enabled ?? false;
  }

  // ─── Component Aggregation ───────────────────────────────────────

  /**
   * Get all commands from all enabled plugins.
   */
  getAllCommands(): Array<{ plugin: string; command: PluginCommand }> {
    const cmds: Array<{ plugin: string; command: PluginCommand }> = [];
    for (const p of this.listEnabled()) {
      for (const c of p.loadedCommands) {
        cmds.push({ plugin: p.manifest.name, command: c });
      }
    }
    return cmds;
  }

  /**
   * Get a specific command by name across all plugins.
   */
  findCommand(name: string): { plugin: string; command: PluginCommand } | null {
    for (const p of this.listEnabled()) {
      for (const c of p.loadedCommands) {
        if (c.name === name) return { plugin: p.manifest.name, command: c };
        // Check aliases
        if (c.frontmatter.aliases?.includes(name)) return { plugin: p.manifest.name, command: c };
      }
    }
    return null;
  }

  /**
   * Get all hooks from all enabled plugins.
   */
  getAllHooks(): ConfiguredHook[] {
    return this.listEnabled().flatMap(p => p.loadedHooks);
  }

  /**
   * Get all agent definitions from all enabled plugins.
   */
  getAllAgents(): PluginAgentDef[] {
    return this.listEnabled().flatMap(p => p.loadedAgents);
  }

  /**
   * Get all MCP server names from all enabled plugins.
   */
  getAllMcpServers(): string[] {
    return this.listEnabled().flatMap(p => p.loadedMcpServers);
  }

  /**
   * Get all skill names from all enabled plugins.
   */
  getAllSkills(): string[] {
    return this.listEnabled().flatMap(p => p.loadedSkills);
  }

  /**
   * Get all tool names from all enabled plugins.
   */
  getAllTools(): string[] {
    return this.listEnabled().flatMap(p => p.loadedTools);
  }

  /**
   * Get all output style names from all enabled plugins.
   */
  getAllOutputStyles(): string[] {
    return this.listEnabled().flatMap(p => p.loadedOutputStyles);
  }

  // ─── Statistics ──────────────────────────────────────────────────

  /**
   * Get registry statistics.
   */
  getStats(): RegistryStats {
    const enabled = this.listEnabled();
    const bySource: Record<string, number> = {};

    for (const p of this.list()) {
      const type = p.source.type;
      bySource[type] = (bySource[type] ?? 0) + 1;
    }

    return {
      total: this.plugins.size,
      enabled: enabled.length,
      disabled: this.plugins.size - enabled.length,
      bySource,
      totalCommands: enabled.reduce((n, p) => n + p.loadedCommands.length, 0),
      totalAgents: enabled.reduce((n, p) => n + p.loadedAgents.length, 0),
      totalHooks: enabled.reduce((n, p) => n + p.loadedHooks.length, 0),
      totalMcpServers: enabled.reduce((n, p) => n + p.loadedMcpServers.length, 0),
      totalSkills: enabled.reduce((n, p) => n + p.loadedSkills.length, 0),
      totalTools: enabled.reduce((n, p) => n + p.loadedTools.length, 0),
    };
  }

  /**
   * Check if any plugin has validation errors.
   */
  hasErrors(): boolean {
    return this.list().some(p => p.validationErrors.length > 0);
  }

  size(): number {
    return this.plugins.size;
  }

  clear(): void {
    this.plugins.clear();
  }

  // ─── Events ──────────────────────────────────────────────────────

  onEvent(handler: RegistryEventHandler): void {
    this.eventHandlers.push(handler);
  }

  removeEventHandler(handler: RegistryEventHandler): void {
    const idx = this.eventHandlers.indexOf(handler);
    if (idx !== -1) this.eventHandlers.splice(idx, 1);
  }

  getEventHistory(): RegistryEvent[] {
    return [...this.eventHistory];
  }

  private emit(type: RegistryEventType, pluginName: string): void {
    const event: RegistryEvent = { type, pluginName, timestamp: Date.now() };
    this.eventHistory.push(event);
    if (this.eventHistory.length > 1000) this.eventHistory = this.eventHistory.slice(-500);

    for (const handler of this.eventHandlers) {
      try { handler(event); } catch { /* ignore */ }
    }
  }

  // ─── Snapshot ────────────────────────────────────────────────────

  /**
   * Create a serializable snapshot of the registry.
   */
  snapshot(): Array<{ name: string; version: string; source: string; enabled: boolean; components: Record<string, number> }> {
    return this.list().map(p => ({
      name: p.manifest.name,
      version: p.manifest.version,
      source: p.source.type,
      enabled: p.enabled,
      components: {
        commands: p.loadedCommands.length,
        agents: p.loadedAgents.length,
        hooks: p.loadedHooks.length,
        mcpServers: p.loadedMcpServers.length,
        skills: p.loadedSkills.length,
        tools: p.loadedTools.length,
        outputStyles: p.loadedOutputStyles.length,
      },
    }));
  }
}
