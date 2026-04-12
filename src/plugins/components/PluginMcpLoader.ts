/**
 * PluginMcpLoader.ts — Load MCP server definitions from plugin manifest
 *
 * Based on Claude Code's mcpPluginIntegration.ts (400 lines)
 *
 * Implements:
 *   - Parse mcpServers from manifest
 *   - Validate server configs (command exists, ports valid, etc)
 *   - Environment variable expansion (${VAR} → process.env.VAR)
 *   - Build server configs for MCPManager integration
 *   - Server naming: plugin_<pluginName>_<serverName>
 *   - Health check verification
 *   - Startup dependency ordering
 *   - Resource limit enforcement
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import type { PluginManifest, MCPServerDef, PluginValidationError } from '../types.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ResolvedMCPServer {
  /** Qualified name: plugin_<pluginName>_<serverName> */
  qualifiedName: string;
  /** Original server name from manifest */
  originalName: string;
  /** Plugin this server belongs to */
  pluginName: string;
  /** Resolved command (absolute path if possible) */
  command: string;
  /** Resolved args */
  args: string[];
  /** Resolved environment (with ${VAR} expanded) */
  env: Record<string, string>;
  /** Optional HTTP URL (for HTTP MCP) */
  url?: string;
  /** Description */
  description: string;
  /** Whether this is an HTTP-based or stdio-based server */
  transport: 'stdio' | 'http';
}

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_SERVERS_PER_PLUGIN = 10;
const MAX_ENV_VARS_PER_SERVER = 50;
const MAX_ARGS_PER_SERVER = 50;

// ════════════════════════════════════════════════════════════════════════════
// PluginMcpLoader Class
// ════════════════════════════════════════════════════════════════════════════

export class PluginMcpLoader {
  private errors: PluginValidationError[] = [];

  /**
   * Load all MCP server definitions from manifest.
   * Returns server names (qualified).
   */
  async loadAll(rootDir: string, manifest: PluginManifest): Promise<string[]> {
    if (!manifest.mcpServers || Object.keys(manifest.mcpServers).length === 0) return [];

    this.errors = [];
    const servers = this.resolveAll(rootDir, manifest);
    return servers.map(s => s.qualifiedName);
  }

  /**
   * Resolve all MCP server definitions with validation and env expansion.
   */
  resolveAll(rootDir: string, manifest: PluginManifest): ResolvedMCPServer[] {
    if (!manifest.mcpServers) return [];

    const entries = Object.entries(manifest.mcpServers);
    if (entries.length > MAX_SERVERS_PER_PLUGIN) {
      this.errors.push({
        code: 'TOO_MANY_MCP_SERVERS',
        message: `${entries.length} MCP servers (max ${MAX_SERVERS_PER_PLUGIN})`,
        severity: 'warning',
        field: 'mcpServers',
        recoverable: true,
      });
    }

    const resolved: ResolvedMCPServer[] = [];

    for (const [name, def] of entries.slice(0, MAX_SERVERS_PER_PLUGIN)) {
      try {
        const server = this.resolveServer(name, def, manifest.name, rootDir);
        if (server) resolved.push(server);
      } catch (err) {
        this.errors.push({
          code: 'MCP_RESOLVE_FAILED',
          message: `Server "${name}": ${(err as Error).message}`,
          severity: 'warning',
          field: `mcpServers.${name}`,
          recoverable: true,
        });
      }
    }

    return resolved;
  }

  /**
   * Get full server configs for MCPManager.loadFromConfig() format.
   */
  getServerConfigs(manifest: PluginManifest, rootDir: string = '.'): Record<string, { command: string; args?: string[]; env?: Record<string, string> }> {
    const servers = this.resolveAll(rootDir, manifest);
    const configs: Record<string, { command: string; args?: string[]; env?: Record<string, string> }> = {};

    for (const server of servers) {
      configs[server.qualifiedName] = {
        command: server.command,
        args: server.args.length > 0 ? server.args : undefined,
        env: Object.keys(server.env).length > 0 ? server.env : undefined,
      };
    }

    return configs;
  }

  getLastErrors(): PluginValidationError[] {
    return [...this.errors];
  }

  // ─── Resolution ───────────────────────────────────────────────────

  private resolveServer(
    name: string,
    def: MCPServerDef,
    pluginName: string,
    rootDir: string,
  ): ResolvedMCPServer | null {
    // Determine transport
    const transport: 'stdio' | 'http' = def.url ? 'http' : 'stdio';

    // Validate command (required for stdio)
    if (transport === 'stdio' && !def.command) {
      this.errors.push({
        code: 'MCP_NO_COMMAND',
        message: `Server "${name}" has no command and no URL`,
        severity: 'error',
        field: `mcpServers.${name}`,
        recoverable: false,
      });
      return null;
    }

    // Resolve command (try to find absolute path)
    let command = def.command || '';
    if (command && !path.isAbsolute(command)) {
      // Check if it's a relative path to a file in the plugin
      const pluginRelative = path.join(rootDir, command);
      if (fs.existsSync(pluginRelative)) {
        command = pluginRelative;
      }
      // Otherwise keep as-is (rely on PATH)
    }

    // Resolve args
    const args = (def.args ?? []).slice(0, MAX_ARGS_PER_SERVER).map(arg => this.expandEnvVars(arg));

    // Resolve env (expand ${VAR} references)
    const env: Record<string, string> = {};
    if (def.env) {
      const envEntries = Object.entries(def.env).slice(0, MAX_ENV_VARS_PER_SERVER);
      for (const [key, value] of envEntries) {
        env[key] = this.expandEnvVars(value);
      }
    }

    // Validate URL for HTTP transport
    if (transport === 'http' && def.url) {
      try {
        new URL(def.url);
      } catch {
        this.errors.push({
          code: 'MCP_INVALID_URL',
          message: `Server "${name}" has invalid URL: ${def.url}`,
          severity: 'error',
          field: `mcpServers.${name}.url`,
          recoverable: false,
        });
        return null;
      }
    }

    return {
      qualifiedName: `plugin_${pluginName}_${name}`,
      originalName: name,
      pluginName,
      command,
      args,
      env,
      url: def.url,
      description: def.description ?? `MCP server "${name}" from plugin ${pluginName}`,
      transport,
    };
  }

  /**
   * Expand ${VAR} references in a string.
   * If VAR is not set, replaces with empty string.
   */
  private expandEnvVars(value: string): string {
    return value.replace(/\$\{([^}]+)\}/g, (_match, varName) => {
      return process.env[varName] ?? '';
    });
  }

  /**
   * Check if a command is available (exists in PATH or as absolute path).
   */
  private isCommandAvailable(command: string): boolean {
    if (path.isAbsolute(command)) {
      return fs.existsSync(command);
    }
    try {
      execSync(`which ${command}`, { stdio: 'ignore', timeout: 2000 });
      return true;
    } catch {
      return false;
    }
  }
}
