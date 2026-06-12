/**
 * mcpRemoteServer.ts — MCP Remote Server (HTTP)
 *
 * Exposes system-clow as an MCP server that Claude can connect to.
 * Implements MCP 2.0 protocol over HTTP (JSON-RPC).
 *
 * Claude Desktop config:
 * {
 *   "mcpServers": {
 *     "system-clow": {
 *       "url": "http://localhost:3001/mcp"
 *     }
 *   }
 * }
 */

import { Hono } from 'hono';
import type { SessionPool } from './sessionPool.js';
import type { MCPManager } from '../mcp/MCPManager.js';

interface MCPRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface MCPResponse {
  jsonrpc: '2.0';
  id?: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export function buildMCPRemoteRoutes(pool: SessionPool, mcpManager: MCPManager): Hono {
  const app = new Hono();

  /**
   * POST /mcp — MCP JSON-RPC endpoint
   * Handles: initialize, tools/list, tools/call
   */
  app.post('/mcp', async (c) => {
    try {
      const body = (await c.req.json()) as MCPRequest;
      const { jsonrpc, id, method, params } = body;

      if (jsonrpc !== '2.0') {
        return c.json({
          jsonrpc: '2.0',
          id,
          error: { code: -32600, message: 'Invalid Request' },
        } as MCPResponse);
      }

      let result: unknown;

      switch (method) {
        case 'initialize': {
          // MCP initialize handshake
          result = {
            protocolVersion: '2024-11-05',
            capabilities: {
              tools: {},
            },
            serverInfo: {
              name: 'system-clow',
              version: '1.0.0',
            },
          };
          break;
        }

        case 'tools/list': {
          // List all available tools from MCP manager + built-in Clow tools
          const mcpTools = mcpManager.getAllTools().map(({ serverName, tool }) => ({
            name: `mcp__${serverName}__${tool.name}`,
            description: tool.description || `MCP tool from server "${serverName}"`,
            inputSchema: tool.inputSchema,
          }));

          // TODO: Add built-in Clow tools (Bash, WebFetch, Download, etc)
          // For now, just expose MCP tools
          result = {
            tools: mcpTools,
          };
          break;
        }

        case 'tools/call': {
          // Call a tool
          const toolName = params?.name as string | undefined;
          const args = params?.arguments as Record<string, unknown> | undefined;

          if (!toolName) {
            return c.json({
              jsonrpc: '2.0',
              id,
              error: { code: -32602, message: 'Missing tool name' },
            } as MCPResponse);
          }

          // Parse tool name: mcp__<server>__<toolname>
          const match = toolName.match(/^mcp__([^_]+)__(.+)$/);
          if (!match) {
            return c.json({
              jsonrpc: '2.0',
              id,
              error: { code: -32602, message: `Invalid tool name format: ${toolName}` },
            } as MCPResponse);
          }

          const [, serverName, actualToolName] = match;
          try {
            const toolResult = await mcpManager.callTool(serverName, actualToolName, args || {});
            result = {
              content: [
                {
                  type: 'text',
                  text: toolResult.content,
                },
              ],
              isError: toolResult.isError,
            };
          } catch (err: any) {
            return c.json({
              jsonrpc: '2.0',
              id,
              error: {
                code: -32603,
                message: `Tool execution failed: ${err.message}`,
              },
            } as MCPResponse);
          }
          break;
        }

        case 'notifications/initialized': {
          // Client notification — no response needed
          return c.json({ jsonrpc: '2.0' });
        }

        default: {
          return c.json({
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: `Method not found: ${method}` },
          } as MCPResponse);
        }
      }

      return c.json({
        jsonrpc: '2.0',
        id,
        result,
      } as MCPResponse);
    } catch (err: any) {
      return c.json({
        jsonrpc: '2.0',
        error: { code: -32700, message: `Parse error: ${err.message}` },
      } as MCPResponse, 400);
    }
  });

  /**
   * GET /mcp/info — Server info endpoint (optional, for debugging)
   */
  app.get('/mcp/info', (c) => {
    return c.json({
      name: 'system-clow',
      version: '1.0.0',
      protocolVersion: '2024-11-05',
      mcpServersConnected: mcpManager.serverCount,
      toolsAvailable: mcpManager.getAllTools().length,
    });
  });

  return app;
}
