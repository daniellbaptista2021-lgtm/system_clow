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

// ─── The Registry ───────────────────────────────────────────────────────────

export function getAllBaseTools(): Tools {
  return [
    BashTool,
    FileReadTool,
    FileEditTool,
    FileWriteTool,
    GlobTool,
    GrepTool,
    TodoWriteTool,
  ];
}

// ─── Assembly Pipeline ──────────────────────────────────────────────────────

export function getTools(denyList?: string[]): Tools {
  let tools = getAllBaseTools();

  // Stage 1: Deny rules
  if (denyList && denyList.length > 0) {
    tools = filterToolsByDenyRules(tools, denyList);
  }

  // Stage 2: isEnabled() check
  tools = tools.filter((tool) => tool.isEnabled());

  // Stage 3: Sort for cache stability (built-in prefix)
  tools.sort((a, b) => a.name.localeCompare(b.name));

  return tools;
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
