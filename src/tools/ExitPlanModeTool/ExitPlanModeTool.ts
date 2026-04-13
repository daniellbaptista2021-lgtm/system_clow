/**
 * ExitPlanModeTool — Present plan for user approval and exit plan mode
 *
 * Based on Claude Code's ExitPlanModeV2Tool (doc 02)
 * Shows plan to user, asks for approval via interactive prompt.
 * On approve: restores pre-plan permission mode, agent can execute.
 * On reject: stays in plan mode, agent must revise.
 */

import { z } from 'zod';
import { buildTool, type ToolResult, type RenderOptions } from '../Tool.js';
import {
  setPermissionMode,
  getPermissionMode,
  getPrePlanPermissionMode,
  setPrePlanPermissionMode,
} from '../../bootstrap/state.js';
import * as readline from 'readline';

const ExitPlanModeInputSchema = z.object({
  plan: z.string().min(20).describe(
    'The complete plan in markdown. Include: what will change, files affected, expected outcome, risks.',
  ),
});

type ExitPlanModeInput = z.infer<typeof ExitPlanModeInputSchema>;

// ─── Interactive Approval ───────────────────────────────────────────────────

async function askPlanApproval(plan: string): Promise<'approve' | 'reject' | 'modify'> {
  // Print the plan with formatting
  process.stderr.write('\n');
  process.stderr.write('  ╔══════════════════════════════════════════╗\n');
  process.stderr.write('  ║            📋 PLAN REVIEW                ║\n');
  process.stderr.write('  ╚══════════════════════════════════════════╝\n\n');

  // Indent plan lines
  for (const line of plan.split('\n')) {
    process.stderr.write(`  ${line}\n`);
  }

  process.stderr.write('\n');
  process.stderr.write('  ─────────────────────────────────────────\n');
  process.stderr.write('  [a]pprove and execute\n');
  process.stderr.write('  [r]eject\n');
  process.stderr.write('  [m]odify plan\n');
  process.stderr.write('  ─────────────────────────────────────────\n');
  process.stderr.write('  Your choice > ');

  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
      terminal: false,
    });

    rl.on('line', (line) => {
      rl.close();
      const answer = line.trim().toLowerCase();
      if (answer === 'a' || answer === 'approve' || answer === 'yes' || answer === 'y') {
        resolve('approve');
      } else if (answer === 'm' || answer === 'modify') {
        resolve('modify');
      } else {
        resolve('reject');
      }
    });

    // Timeout: if no input for 5 minutes, reject
    setTimeout(() => {
      rl.close();
      resolve('reject');
    }, 5 * 60 * 1000);
  });
}

// ─── The Tool ───────────────────────────────────────────────────────────────

export const ExitPlanModeTool = buildTool<ExitPlanModeInput>({
  name: 'ExitPlanMode',
  searchHint: 'plan exit approve execute',
  description: `Exit plan mode by presenting your complete plan for user approval.
The user will see the plan and choose to: approve (execute), reject (stop), or modify (revise).
Your plan MUST include: what changes, which files, expected outcome, and any risks.`,
  inputSchema: ExitPlanModeInputSchema,

  userFacingName() { return 'ExitPlanMode'; },
  isReadOnly() { return true; },
  isConcurrencySafe() { return false; },
  isDestructive() { return false; },
  renderToolUseMessage(_input: ExitPlanModeInput, _opts: RenderOptions) { return '📋 Presenting plan for approval...'; },

  async checkPermissions() {
    return { behavior: 'allow' as const };
  },

  async call(input: ExitPlanModeInput, context): Promise<ToolResult> {
    const currentMode = getPermissionMode();

    if (currentMode !== 'plan') {
      return {
        output: { error: 'not_in_plan_mode' },
        outputText: 'Error: Not in plan mode. Call EnterPlanMode first.',
        isError: true,
      };
    }

    if (!process.stdin.isTTY || !process.stderr.isTTY) {
      return {
        output: {
          error: 'plan_approval_unavailable',
          sessionId: context.sessionId,
          permissionMode: context.permissionMode,
        },
        outputText: 'Error: ExitPlanMode requires an interactive terminal for plan approval. This runtime cannot approve plans via stdin/stdout.',
        isError: true,
      };
    }

    // Ask user for approval
    const decision = await askPlanApproval(input.plan);

    switch (decision) {
      case 'approve': {
        // Restore pre-plan permission mode
        const previousMode = getPrePlanPermissionMode() || 'default';
        setPermissionMode(previousMode);
        setPrePlanPermissionMode(undefined);
        return {
          output: { decision: 'approved', restoredMode: previousMode },
          outputText: 'Plan approved by user. You may now proceed with execution. Follow the plan exactly.',
        };
      }

      case 'modify': {
        // Stay in plan mode
        return {
          output: { decision: 'modify' },
          outputText: 'User wants modifications to the plan. Stay in plan mode, revise, and call ExitPlanMode again.',
        };
      }

      case 'reject':
      default: {
        // Stay in plan mode — user might give new direction
        return {
          output: { decision: 'rejected' },
          outputText: 'User rejected the plan. Stop the current approach and ask the user for new direction.',
        };
      }
    }
  },
});
