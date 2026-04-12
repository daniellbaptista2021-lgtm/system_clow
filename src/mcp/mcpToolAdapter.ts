/**
 * mcpToolAdapter.ts — Convert MCP tools to native Clow Tool interface
 *
 * Based on Claude Code's assembleToolPool() pattern (doc 02)
 * - MCP tools get prefixed: mcp__<server>__<toolname> (prevents collision)
 * - JSON Schema → Zod conversion for input validation
 * - Built-in tools sorted as prefix, MCP tools as suffix (cache stability)
 * - Fail-closed defaults: isReadOnly=false, isConcurrencySafe=false
 */

import { z } from 'zod';
import { buildTool, type Tool, type ToolResult } from '../tools/Tool.js';
import type { MCPTool } from './MCPClient.js';
import type { MCPManager } from './MCPManager.js';

// ─── JSON Schema → Zod Converter ────────────────────────────────────────────
// Covers 95% of real MCP server schemas: string, number, boolean, array, object, enum, required
// Falls back to z.any() for exotic types

function jsonSchemaToZod(schema: Record<string, unknown>): z.ZodType {
  if (!schema || typeof schema !== 'object') return z.any();

  const type = schema.type as string | undefined;

  switch (type) {
    case 'string': {
      let s = z.string();
      if (schema.description) s = s.describe(schema.description as string);
      if (schema.enum) return z.enum(schema.enum as [string, ...string[]]);
      return s;
    }

    case 'number':
    case 'integer': {
      let n = z.number();
      if (type === 'integer') n = n.int();
      if (schema.description) n = n.describe(schema.description as string);
      return n;
    }

    case 'boolean': {
      let b = z.boolean();
      if (schema.description) b = b.describe(schema.description as string);
      return b;
    }

    case 'array': {
      const items = schema.items as Record<string, unknown> | undefined;
      const itemSchema = items ? jsonSchemaToZod(items) : z.any();
      let arr = z.array(itemSchema);
      if (schema.description) arr = arr.describe(schema.description as string);
      return arr;
    }

    case 'object': {
      const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
      const required = new Set((schema.required as string[]) || []);

      if (!properties || Object.keys(properties).length === 0) {
        // No properties defined — accept any object
        return z.record(z.any());
      }

      const shape: Record<string, z.ZodType> = {};
      for (const [key, propSchema] of Object.entries(properties)) {
        let field = jsonSchemaToZod(propSchema);
        if (!required.has(key)) {
          field = field.optional();
        }
        shape[key] = field;
      }

      let obj = z.object(shape).passthrough(); // passthrough allows extra fields
      if (schema.description) obj = obj.describe(schema.description as string);
      return obj;
    }

    default:
      // Fallback: accept anything
      return z.any();
  }
}

// ─── Adapt Single MCP Tool ──────────────────────────────────────────────────

export function adaptMCPTool(
  serverName: string,
  mcpTool: MCPTool,
  manager: MCPManager,
): Tool {
  const qualifiedName = `mcp__${serverName}__${mcpTool.name}`;

  return buildTool({
    name: qualifiedName,
    description: mcpTool.description || `MCP tool from server "${serverName}"`,
    inputSchema: jsonSchemaToZod(mcpTool.inputSchema),

    // Fail-closed defaults — assume MCP tools can write and aren't concurrent-safe
    isReadOnly: () => false,
    isConcurrencySafe: () => false,

    async checkPermissions(input: unknown) {
      return { behavior: 'ask' as const, message: `MCP tool: ${qualifiedName}` };
    },

    async call(input: unknown): Promise<ToolResult> {
      try {
        // Parse out server name and tool name from qualified name
        const result = await manager.callTool(serverName, mcpTool.name, input as Record<string, unknown>);

        return {
          output: result,
          outputText: result.content,
          isError: result.isError,
        };
      } catch (err: any) {
        return {
          output: null,
          outputText: `MCP tool error (${qualifiedName}): ${err.message}`,
          isError: true,
        };
      }
    },
  });
}

// ─── Adapt All MCP Tools from Manager ───────────────────────────────────────

export function adaptAllMCPTools(manager: MCPManager): Tool[] {
  return manager.getAllTools().map(({ serverName, tool }) =>
    adaptMCPTool(serverName, tool, manager),
  );
}
