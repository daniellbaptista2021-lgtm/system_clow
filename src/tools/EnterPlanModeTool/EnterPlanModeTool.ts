/**
 * EnterPlanModeTool — Switch to plan (read-only) mode
 *
 * Based on Claude Code's EnterPlanModeTool (doc 02, 07)
 * When active, only read-only tools are allowed.
 * Agent investigates freely, then calls ExitPlanMode with a plan for user approval.
 */

import { z } from 'zod';
import { buildTool, type ToolResult, type RenderOptions } from '../Tool.js';
import { setPermissionMode, setPrePlanPermissionMode, getPermissionMode } from '../../bootstrap/state.js';

const EnterPlanModeInputSchema = z.object({});

export const EnterPlanModeTool = buildTool({
  name: 'EnterPlanMode',
  searchHint: 'plan mode investigate read-only',
  description: `Switch to plan mode. Only read-only operations allowed until ExitPlanMode is called.
Use this for complex tasks that need investigation before action.
In plan mode you can: Read files, search (Glob/Grep), browse web, spawn researcher agents.
In plan mode you CANNOT: Write files, edit files, run destructive bash commands.
When your investigation is complete, call ExitPlanMode with your full plan.`,
  inputSchema: EnterPlanModeInputSchema,

  userFacingName() { return 'EnterPlanMode'; },
  isReadOnly() { return true; },
  isConcurrencySafe() { return false; },
  isDestructive() { return false; },
  renderToolUseMessage(_input: unknown, _opts: RenderOptions) { return '📋 Entering plan mode...'; },

  async checkPermissions() {
    return { behavior: 'allow' as const };
  },

  async call(): Promise<ToolResult> {
    const currentMode = getPermissionMode();

    if (currentMode === 'plan') {
      return {
        output: { alreadyInPlanMode: true },
        outputText: 'Already in plan mode. Continue investigating and call ExitPlanMode when ready.',
      };
    }

    // Save pre-plan mode for restoration after exit
    setPrePlanPermissionMode(currentMode);
    setPermissionMode('plan');

    return {
      output: { previousMode: currentMode },
      outputText: `Plan mode activated. You are now restricted to read-only operations.

Investigate freely:
- Read files to understand the codebase
- Use Glob/Grep to search
- Use WebFetch/WebSearch for external info
- Spawn researcher sub-agents

When ready, call ExitPlanMode with your complete plan in markdown.`,
    };
  },
});
