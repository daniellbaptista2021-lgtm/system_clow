/**
 * permissions.ts — The Permission Pipeline
 *
 * Based on Claude Code's 7-step gauntlet (1,487 lines)
 * Simplified but architecturally faithful implementation.
 *
 * Steps: deny rules → ask rules → tool.checkPermissions → safety checks → bypass → allow rules → default ask
 */

import type { Tool, PermissionResult, CanUseToolFn } from '../../tools/Tool.js';
import {
  getPermissionMode,
  getSessionPermissionRules,
} from '../../bootstrap/state.js';
import * as readline from 'readline';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PermissionContext {
  denyRules: string[];
  allowRules: string[];
  askRules: string[];
}

// ─── Denial Tracking (Circuit Breakers) ─────────────────────────────────────

let consecutiveDenials = 0;
let totalDenials = 0;
const DENIAL_LIMITS = { maxConsecutive: 3, maxTotal: 20 };

export function resetDenialTracking(): void {
  consecutiveDenials = 0;
  totalDenials = 0;
}

// ─── Safety Paths (bypass-immune) ───────────────────────────────────────────

const SAFETY_PATHS = ['.git/', '.claude/', '.vscode/', '.env'];

function isSafetyPath(input: unknown): boolean {
  const str = JSON.stringify(input);
  return SAFETY_PATHS.some((p) => str.includes(p));
}

// ─── The Permission Pipeline ────────────────────────────────────────────────

export async function hasPermission(
  tool: Tool,
  input: unknown,
  context: PermissionContext,
): Promise<PermissionResult> {
  // Step 1a: Tool-level deny rules
  if (context.denyRules.some((rule) => matchesRule(rule, tool.name))) {
    return { behavior: 'deny', message: `Tool "${tool.name}" is denied by rule` };
  }

  // Step 1b: Tool-level ask rules
  const hasAskRule = context.askRules.some((rule) => matchesRule(rule, tool.name));

  // Step 1c: Tool-specific permission check
  let toolPermResult: PermissionResult;
  try {
    toolPermResult = await tool.checkPermissions(input, {
      cwd: process.cwd(),
      sessionId: '',
      permissionMode: getPermissionMode(),
      options: { tools: [] },
    });
  } catch {
    toolPermResult = { behavior: 'passthrough' };
  }

  // Step 1d: Tool denied
  if (toolPermResult.behavior === 'deny') {
    return toolPermResult;
  }

  // Step 1g: Safety checks (bypass-immune)
  if (isSafetyPath(input) && toolPermResult.behavior !== 'allow') {
    return { behavior: 'ask', message: `Safety check: operation on protected path` };
  }

  // Step 2a: Bypass mode
  const mode = getPermissionMode();
  if (mode === 'bypassPermissions') {
    return { behavior: 'allow' };
  }

  // Step 2b: Always-allow rules
  if (context.allowRules.some((rule) => matchesRule(rule, tool.name))) {
    return { behavior: 'allow' };
  }

  // Check session rules
  const sessionRules = getSessionPermissionRules();
  for (const rule of sessionRules) {
    if (matchesRule(rule.toolName, tool.name)) {
      if (rule.type === 'allow') return { behavior: 'allow' };
      if (rule.type === 'deny') return { behavior: 'deny', message: 'Denied by session rule' };
    }
  }

  // Tool said allow
  if (toolPermResult.behavior === 'allow') {
    return toolPermResult;
  }

  // Step 3: Default → ask
  if (hasAskRule || toolPermResult.behavior === 'ask') {
    return toolPermResult.behavior === 'ask'
      ? toolPermResult
      : { behavior: 'ask', message: `Confirm use of tool: ${tool.name}` };
  }

  // acceptEdits mode: auto-allow file edits
  if (mode === 'acceptEdits' && !tool.isReadOnly(input)) {
    const isFileOp = ['Edit', 'Write', 'FileEdit', 'FileWrite'].includes(tool.name);
    if (isFileOp) return { behavior: 'allow' };
  }

  // dontAsk mode: ask → deny
  if (mode === 'dontAsk') {
    return { behavior: 'deny', message: 'Auto-denied (dontAsk mode)' };
  }

  // Default passthrough → ask
  return { behavior: 'ask', message: `Confirm use of tool: ${tool.name}` };
}

// ─── Rule Matching ──────────────────────────────────────────────────────────

function matchesRule(rule: string, toolName: string): boolean {
  // Exact match
  if (rule === toolName) return true;
  // Wildcard
  if (rule === '*') return true;
  // Pattern: ToolName(content)
  const parenIdx = rule.indexOf('(');
  if (parenIdx > 0) {
    const ruleTool = rule.slice(0, parenIdx);
    return ruleTool === toolName;
  }
  return false;
}

// ─── Interactive Permission Prompt ──────────────────────────────────────────

export async function promptUserForPermission(
  toolName: string,
  message: string,
): Promise<'allow' | 'deny' | 'always_allow'> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  return new Promise((resolve) => {
    process.stderr.write(`\n  Permission needed: ${toolName}\n`);
    process.stderr.write(`  ${message}\n`);
    process.stderr.write(`  [y]es / [n]o / [a]lways allow > `);

    rl.on('line', (line) => {
      rl.close();
      const answer = line.trim().toLowerCase();
      if (answer === 'y' || answer === 'yes') resolve('allow');
      else if (answer === 'a' || answer === 'always') resolve('always_allow');
      else resolve('deny');
    });
  });
}

// ─── Create CanUseTool Function ─────────────────────────────────────────────

export function createCanUseTool(context: PermissionContext): CanUseToolFn {
  return async (tool, input, _toolUseId) => {
    const result = await hasPermission(tool, input, context);

    if (result.behavior === 'ask') {
      // In interactive mode, prompt the user
      const decision = await promptUserForPermission(
        tool.name,
        (result as any).message || `Use tool: ${tool.name}`,
      );

      if (decision === 'always_allow') {
        context.allowRules.push(tool.name);
        consecutiveDenials = 0;
        return { behavior: 'allow' };
      }

      if (decision === 'allow') {
        consecutiveDenials = 0;
        return { behavior: 'allow' };
      }

      consecutiveDenials++;
      totalDenials++;
      return { behavior: 'deny', message: 'User denied' };
    }

    if (result.behavior === 'allow') consecutiveDenials = 0;
    if (result.behavior === 'deny') {
      consecutiveDenials++;
      totalDenials++;
    }

    return result;
  };
}
