/**
 * tools.ts — The Tool Registry
 *
 * All tools registered via getAllBaseTools().
 * Returns a flat array — NOT a plugin registry, not a map, not a DI container.
 * Intentionally simple.
 *
 * Based on Claude Code's tools.ts (390 lines)
 * Assembly pipeline: getAllBaseTools() → deny filter → mode filter → sort
 */

import type { Tool, Tools } from './Tool.js';
import { BashTool } from './BashTool/BashTool.js';
import { FileReadTool } from './FileReadTool/FileReadTool.js';
import { FileEditTool } from './FileEditTool/FileEditTool.js';
import { FileWriteTool } from './FileWriteTool/FileWriteTool.js';
import { GlobTool } from './GlobTool/GlobTool.js';
import { GrepTool } from './GrepTool/GrepTool.js';
import { TodoWriteTool } from './TodoWriteTool/TodoWriteTool.js';
import { WebFetchTool } from './WebFetchTool/WebFetchTool.js';
import { WebSearchTool } from './WebSearchTool/WebSearchTool.js';
import { AgentTool } from './AgentTool/AgentTool.js';
import { DownloadTool } from './DownloadTool/DownloadTool.js';
import { EnterPlanModeTool } from './EnterPlanModeTool/EnterPlanModeTool.js';
import { ExitPlanModeTool } from './ExitPlanModeTool/ExitPlanModeTool.js';
import { CrmTools } from './CrmTool/CrmTool.js';
import { getSwarmRuntimeTools } from '../swarm/tools/runtimeTools.js';
import type { MCPManager } from '../mcp/MCPManager.js';
import { adaptAllMCPTools } from '../mcp/mcpToolAdapter.js';

// ─── The Registry ───────────────────────────────────────────────────────────

export function getAllBaseTools(): Tools {
  return [
    AgentTool,
    DownloadTool,
    BashTool,
    EnterPlanModeTool,
    ExitPlanModeTool,
    FileReadTool,
    FileEditTool,
    FileWriteTool,
    GlobTool,
    GrepTool,
    TodoWriteTool,
    WebFetchTool,
    WebSearchTool,
    ...getSwarmRuntimeTools(),
    ...CrmTools,
  ];
}

// ─── Assembly Pipeline ──────────────────────────────────────────────────────

/**
 * assembleToolPool — Built-in prefix + MCP suffix (cache stability pattern from doc 02)
 * Adding/removing an MCP server doesn't invalidate cache for built-in tools.
 */
export function getTools(denyList?: string[], mcpManager?: MCPManager): Tools {
  let builtIn = getAllBaseTools();

  // Stage 1: Deny rules
  if (denyList && denyList.length > 0) {
    builtIn = filterToolsByDenyRules(builtIn, denyList);
  }

  // Stage 2: isEnabled() check
  builtIn = builtIn.filter((tool) => tool.isEnabled());

  // Stage 3: Sort built-in for cache stability
  builtIn.sort((a, b) => a.name.localeCompare(b.name));

  // Stage 4: Merge MCP tools as suffix
  if (mcpManager && mcpManager.serverCount > 0) {
    let mcpTools = adaptAllMCPTools(mcpManager);
    if (denyList && denyList.length > 0) {
      mcpTools = filterToolsByDenyRules(mcpTools, denyList);
    }
    mcpTools.sort((a, b) => a.name.localeCompare(b.name));
    return [...builtIn, ...mcpTools];
  }

  return builtIn;
}

export function filterToolsByDenyRules(tools: Tools, denyList: string[]): Tools {
  const denySet = new Set(denyList.map((d) => d.toLowerCase()));
  return tools.filter((tool) => !denySet.has(tool.name.toLowerCase()));
}

// ─── Tool Lookup ────────────────────────────────────────────────────────────

export function findToolByName(tools: Tools, name: string): Tool | undefined {
  return tools.find(
    (t) =>
      t.name === name ||
      t.aliases?.includes(name),
  );
}
