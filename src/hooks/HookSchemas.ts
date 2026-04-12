/**
 * HookSchemas.ts — Zod validation schemas for hook configs and outputs
 *
 * Based on Claude Code's hookSchemas.ts (~250 lines)
 *
 * Features:
 *   - HookOutputSchema: validates hook execution output
 *   - HookConfigEntrySchema: validates individual hook config entry
 *   - HooksFileSchema: validates the hooks.json file format
 *   - parseHookOutput(): JSON-or-text output parsing
 *   - Error-tolerant parsing (graceful degradation)
 */

import { z } from 'zod';
import type { HookOutput, HookEventName } from './types.js';

// ════════════════════════════════════════════════════════════════════════════
// Hook Output Schema (returned by executors)
// ════════════════════════════════════════════════════════════════════════════

export const HookSpecificOutputSchema = z.object({
  hookEventName: z.string().optional(),
  permissionDecision: z.enum(['allow', 'deny', 'ask']).optional(),
  updatedInput: z.unknown().optional(),
  additionalContext: z.string().optional(),
}).passthrough();

export const HookOutputSchema = z.object({
  continue: z.boolean().optional(),
  decision: z.enum(['approve', 'block', 'ask']).optional(),
  reason: z.string().optional(),
  systemMessage: z.string().optional(),
  hookSpecificOutput: HookSpecificOutputSchema.optional(),
  async: z.boolean().optional(),
  asyncRewake: z.boolean().optional(),
  asyncTaskId: z.string().optional(),
}).passthrough();

// ════════════════════════════════════════════════════════════════════════════
// Hook Config Entry Schema (in hooks.json)
// ════════════════════════════════════════════════════════════════════════════

export const HookConfigSchema = z.object({
  type: z.enum(['command', 'http', 'agent']),
  // Command hook fields
  command: z.string().optional(),
  cwd: z.string().optional(),
  // HTTP hook fields
  url: z.string().optional(),
  method: z.enum(['POST', 'PUT']).optional(),
  headers: z.record(z.string()).optional(),
  // Agent hook fields
  agent: z.string().optional(),
  subagent_type: z.string().optional(),
  // Shared fields
  timeout_ms: z.number().min(100).max(300_000).optional(),
  env: z.record(z.string()).optional(),
});

export const HookConfigEntrySchema = z.object({
  /** Optional matcher pattern (e.g., "Bash(git *)" or "*") */
  matcher: z.string().optional(),
  /** Hook executor configuration */
  hook: HookConfigSchema,
  /** Whether this hook is enabled (default true) */
  enabled: z.boolean().optional().default(true),
  /** Priority (higher = runs first, default 0) */
  priority: z.number().optional().default(0),
});

// ════════════════════════════════════════════════════════════════════════════
// Hooks File Schema (hooks.json)
// ════════════════════════════════════════════════════════════════════════════

export const HooksFileSchema = z.object({
  /** Schema version */
  version: z.number().optional().default(1),
  /** Description of this hooks configuration */
  description: z.string().optional(),
  /** Map of event name → array of hook config entries */
  hooks: z.record(z.string(), z.array(HookConfigEntrySchema)),
});

// ════════════════════════════════════════════════════════════════════════════
// Output Parsing
// ════════════════════════════════════════════════════════════════════════════

/**
 * Parse hook output from a string.
 *
 * Tries to parse as JSON first. If that fails, treats the string
 * as a plain text system message.
 *
 * JSON output is validated against HookOutputSchema.
 * Invalid JSON objects are still accepted with a warning.
 */
export function parseHookOutput(raw: string): HookOutput {
  const trimmed = raw.trim();

  // Empty output = no-op
  if (!trimmed) return {};

  // Try JSON parsing
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);

      // Validate against schema
      const validation = HookOutputSchema.safeParse(parsed);
      if (validation.success) {
        return validation.data;
      }

      // Schema validation failed but JSON was valid
      // Accept it anyway with loose typing (for forward compatibility)
      return parsed as HookOutput;
    } catch {
      // JSON parse failed — fall through to plain text
    }
  }

  // Try JSON that's wrapped in markdown code blocks
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    try {
      const parsed = JSON.parse(codeBlockMatch[1].trim());
      const validation = HookOutputSchema.safeParse(parsed);
      if (validation.success) return validation.data;
      return parsed as HookOutput;
    } catch {
      // Fall through
    }
  }

  // Plain text → system message (truncate if too long)
  return {
    systemMessage: trimmed.slice(0, 50_000),
  };
}

/**
 * Validate a hooks.json file content.
 * Returns success/failure with errors.
 */
export function validateHooksFile(raw: unknown): {
  valid: boolean;
  errors: string[];
  hookCount: number;
} {
  const result = HooksFileSchema.safeParse(raw);

  if (result.success) {
    let hookCount = 0;
    for (const entries of Object.values(result.data.hooks)) {
      hookCount += entries.length;
    }
    return { valid: true, errors: [], hookCount };
  }

  return {
    valid: false,
    errors: result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`),
    hookCount: 0,
  };
}

/**
 * Validate a single hook config entry.
 */
export function validateHookEntry(entry: unknown): {
  valid: boolean;
  errors: string[];
} {
  const result = HookConfigEntrySchema.safeParse(entry);
  if (result.success) return { valid: true, errors: [] };
  return {
    valid: false,
    errors: result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`),
  };
}

/**
 * Generate a template hooks.json for a given event.
 */
export function generateHookTemplate(event: string, type: 'command' | 'http' | 'agent'): string {
  const templates: Record<string, Record<string, object>> = {
    command: {
      hook: {
        type: 'command',
        command: 'echo "Hook fired for event"',
        timeout_ms: 30000,
      },
    },
    http: {
      hook: {
        type: 'http',
        url: 'https://hooks.example.com/webhook',
        method: 'POST',
        timeout_ms: 10000,
      },
    },
    agent: {
      hook: {
        type: 'agent',
        agent: 'review-agent',
      },
    },
  };

  const config = {
    version: 1,
    hooks: {
      [event]: [
        {
          ...templates[type],
          enabled: true,
          priority: 0,
        },
      ],
    },
  };

  return JSON.stringify(config, null, 2);
}

/**
 * Merge two hook output objects (for chaining hooks).
 */
export function mergeHookOutputs(a: HookOutput, b: HookOutput): HookOutput {
  // Most restrictive decision wins
  let decision = a.decision;
  if (b.decision === 'block' || (b.decision === 'ask' && a.decision !== 'block')) {
    decision = b.decision;
  }

  // Continue: false wins over true
  const cont = (a.continue !== false && b.continue !== false) ? undefined : false;

  // System messages concatenated
  const msgs = [a.systemMessage, b.systemMessage].filter(Boolean).join('\n\n');

  // Last updatedInput wins
  const updatedInput = b.hookSpecificOutput?.updatedInput ?? a.hookSpecificOutput?.updatedInput;

  return {
    continue: cont,
    decision,
    reason: b.reason ?? a.reason,
    systemMessage: msgs || undefined,
    hookSpecificOutput: {
      hookEventName: b.hookSpecificOutput?.hookEventName ?? a.hookSpecificOutput?.hookEventName,
      permissionDecision: (b.hookSpecificOutput?.permissionDecision ?? a.hookSpecificOutput?.permissionDecision),
      updatedInput,
      additionalContext: [a.hookSpecificOutput?.additionalContext, b.hookSpecificOutput?.additionalContext].filter(Boolean).join('\n'),
    },
  };
}
