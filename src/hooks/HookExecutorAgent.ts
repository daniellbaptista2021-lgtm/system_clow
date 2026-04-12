/**
 * HookExecutorAgent.ts — Execute sub-agent hooks
 *
 * Based on Claude Code's hookAgentExecutor.ts (~200 lines)
 *
 * Spawns a sub-agent with a hook-specific prompt.
 * The sub-agent analyzes the tool use and returns a decision.
 *
 * Features:
 *   - Prompt construction from hook input
 *   - Sub-agent spawning via callback
 *   - Response parsing (JSON HookOutput)
 *   - Error handling
 *   - Agent type configuration
 *   - Context injection (tool info, permissions)
 *   - Decision extraction
 */

import type { AgentHookConfig, HookInput, HookOutput } from './types.js';
import { parseHookOutput } from './HookSchemas.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_PROMPT_LENGTH = 10_000;
const MAX_RESPONSE_LENGTH = 50_000;

// ════════════════════════════════════════════════════════════════════════════
// HookAgentExecutor Class
// ════════════════════════════════════════════════════════════════════════════

export class HookAgentExecutor {
  constructor(
    private readonly spawnSubagent: (config: AgentHookConfig, prompt: string) => Promise<string>,
  ) {}

  /**
   * Execute an agent hook by spawning a sub-agent with a decision prompt.
   */
  async execute(config: AgentHookConfig, input: HookInput): Promise<HookOutput> {
    try {
      // Build prompt
      const prompt = this.buildPrompt(config, input);

      // Spawn sub-agent
      const response = await this.spawnSubagent(config, prompt);

      // Parse response
      if (!response || response.length === 0) {
        return {};
      }

      if (response.length > MAX_RESPONSE_LENGTH) {
        return {
          systemMessage: `[hook agent] Response too large: ${response.length} chars`,
        };
      }

      return parseHookOutput(response);
    } catch (err: any) {
      return {
        systemMessage: `[hook agent error] ${err.message}`,
      };
    }
  }

  /**
   * Build the prompt for the sub-agent.
   * Includes event context, tool information, and expected output format.
   */
  private buildPrompt(config: AgentHookConfig, input: HookInput): string {
    const sections: string[] = [];

    sections.push(`You are a ${config.agent} hook agent for the "${input.hook_event_name}" event.`);
    sections.push('');

    // Event context
    sections.push('## Event Context');
    sections.push(`Event: ${input.hook_event_name}`);
    sections.push(`Session: ${input.session_id}`);
    sections.push(`CWD: ${input.cwd}`);
    sections.push(`Workspace: ${input.workspace_root}`);
    sections.push(`Permission Mode: ${input.permission_mode}`);

    // Tool context (if applicable)
    if (input.tool_name) {
      sections.push('');
      sections.push('## Tool Information');
      sections.push(`Tool: ${input.tool_name}`);
      if (input.tool_input) {
        const inputStr = typeof input.tool_input === 'string'
          ? input.tool_input
          : JSON.stringify(input.tool_input, null, 2);
        sections.push(`Input: ${inputStr.slice(0, 5000)}`);
      }
      if (input.tool_output) {
        const outputStr = typeof input.tool_output === 'string'
          ? input.tool_output
          : JSON.stringify(input.tool_output);
        sections.push(`Output: ${outputStr.slice(0, 2000)}`);
      }
      if (input.tool_error) {
        sections.push(`Error: ${input.tool_error}`);
      }
    }

    // User message context
    if (input.user_message) {
      sections.push('');
      sections.push('## User Message');
      sections.push(input.user_message.slice(0, 2000));
    }

    // File context
    if (input.file_path) {
      sections.push('');
      sections.push('## File');
      sections.push(`Path: ${input.file_path}`);
      if (input.file_change_type) sections.push(`Change: ${input.file_change_type}`);
    }

    // Expected output
    sections.push('');
    sections.push('## Expected Response');
    sections.push('Respond with valid JSON:');
    sections.push('```json');
    sections.push('{');
    sections.push('  "decision": "approve" | "block" | "ask",');
    sections.push('  "reason": "Brief explanation",');
    sections.push('  "hookSpecificOutput": {');
    sections.push('    "permissionDecision": "allow" | "deny" | "ask",');
    sections.push('    "additionalContext": "Optional context to add"');
    sections.push('  }');
    sections.push('}');
    sections.push('```');

    const prompt = sections.join('\n');
    return prompt.slice(0, MAX_PROMPT_LENGTH);
  }

  // ─── Statistics ──────────────────────────────────────────────────

  private executionCount = 0;
  private successCount = 0;
  private errorCount = 0;
  private totalDurationMs = 0;

  /**
   * Get agent executor statistics.
   */
  getStats(): {
    executionCount: number;
    successCount: number;
    errorCount: number;
    avgDurationMs: number;
    successRate: number;
  } {
    return {
      executionCount: this.executionCount,
      successCount: this.successCount,
      errorCount: this.errorCount,
      avgDurationMs: this.executionCount > 0 ? this.totalDurationMs / this.executionCount : 0,
      successRate: this.executionCount > 0 ? this.successCount / this.executionCount : 0,
    };
  }

  /**
   * Build a minimal decision prompt (for simple approve/deny).
   */
  buildMinimalPrompt(config: AgentHookConfig, input: HookInput): string {
    return [
      `Hook: ${config.agent} | Event: ${input.hook_event_name}`,
      input.tool_name ? `Tool: ${input.tool_name}` : '',
      `Decide: approve or block. Reply JSON: {"decision":"approve"|"block","reason":"..."}`,
    ].filter(Boolean).join('\n');
  }
}
