/**
 * MCPManager.ts ? Multi-Server MCP Manager
 *
 * Manages N MCPClient instances. Reads config from ~/.clow/mcp.json
 * (compatible with Claude Desktop format for community config reuse).
 *
 * Features:
 *   - Load config with ${ENV_VAR} substitution
 *   - Connect all servers in parallel
 *   - Aggregate tools from all servers
 *   - Route callTool to correct server
 *   - Clean disconnect on shutdown
 */

import * as fs from 'fs/promises';
import { MCPClient, type MCPTool } from './MCPClient.js';

// ??? Config Types ???????????????????????????????????????????????????????????

export interface MCPServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface MCPConfig {
  mcpServers: Record<string, MCPServerConfig>;
}

// ??? MCPManager Class ???????????????????????????????????????????????????????

export class MCPManager {
  private clients: Map<string, MCPClient> = new Map();

  // ??? Config Loading ???????????????????????????????????????????????????

  async loadFromConfig(configPath: string): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(configPath, 'utf-8');
    } catch (err: any) {
      if (err.code === 'ENOENT') return; // No config file ? that's fine
      throw new Error(`Failed to read MCP config at ${configPath}: ${err.message}`);
    }

    let config: MCPConfig;
    try {
      config = JSON.parse(raw);
    } catch (err: any) {
      throw new Error(`Invalid JSON in MCP config ${configPath}: ${err.message}`);
    }

    if (!config.mcpServers || typeof config.mcpServers !== 'object') {
      return; // Empty config
    }

    this.registerServers(config.mcpServers);
  }

  registerServer(name: string, serverCfg: MCPServerConfig): void {
    if (!serverCfg.command) {
      console.error(`[mcp] Server "${name}" has no command ? skipping`);
      return;
    }

    const expandedEnv: Record<string, string> = {};
    if (serverCfg.env) {
      for (const [key, value] of Object.entries(serverCfg.env)) {
        expandedEnv[key] = expandEnvVars(value);
      }
    }

    const client = new MCPClient(
      name,
      serverCfg.command,
      serverCfg.args || [],
      expandedEnv,
    );

    this.clients.set(name, client);
  }

  registerServers(servers: Record<string, MCPServerConfig>): void {
    for (const [name, serverCfg] of Object.entries(servers)) {
      this.registerServer(name, serverCfg);
    }
  }

  // ??? Connection Management ????????????????????????????????????????????

  async connectAll(): Promise<void> {
    await Promise.allSettled(
      Array.from(this.clients.entries()).map(async ([name, client]) => {
        try {
          await client.connect();
          const info = client.getServerInfo();
          console.error(
            `  [mcp] ? ${name}: ${client.toolCount} tools` +
            (info ? ` (${info.name} ${info.version})` : ''),
          );
        } catch (err: any) {
          console.error(`  [mcp] ? ${name}: ${err.message}`);
          this.clients.delete(name); // Remove failed server
        }
      }),
    );
  }

  async disconnectAll(): Promise<void> {
    await Promise.allSettled(
      Array.from(this.clients.values()).map((c) => c.disconnect()),
    );
    this.clients.clear();
  }

  // ??? Tool Aggregation ?????????????????????????????????????????????????

  getAllTools(): Array<{ serverName: string; tool: MCPTool }> {
    const result: Array<{ serverName: string; tool: MCPTool }> = [];

    for (const [name, client] of this.clients) {
      if (!client.isConnected) continue;
      for (const tool of client.listTools()) {
        result.push({ serverName: name, tool });
      }
    }

    return result;
  }

  // ??? Tool Execution ???????????????????????????????????????????????????

  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ content: string; isError: boolean }> {
    const client = this.clients.get(serverName);
    if (!client) {
      return {
        content: `Error: MCP server "${serverName}" not found`,
        isError: true,
      };
    }
    if (!client.isConnected) {
      return {
        content: `Error: MCP server "${serverName}" is not connected`,
        isError: true,
      };
    }

    const result = await client.callTool(toolName, args);

    const text = result.content
      .map((c) => {
        if (c.type === 'text' && c.text) return c.text;
        if (c.type === 'image') return '[image content]';
        if (c.type === 'resource') return `[resource: ${c.uri || 'unknown'}]`;
        return JSON.stringify(c);
      })
      .join('\n');

    return {
      content: text,
      isError: result.isError || false,
    };
  }

  // ??? Introspection ????????????????????????????????????????????????????

  get serverCount(): number { return this.clients.size; }

  getServerNames(): string[] {
    return Array.from(this.clients.keys());
  }

  getClient(name: string): MCPClient | undefined {
    return this.clients.get(name);
  }
}

// ??? Env Var Expansion ??????????????????????????????????????????????????????

function expandEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_match, varName) => {
    return process.env[varName] || '';
  });
}
