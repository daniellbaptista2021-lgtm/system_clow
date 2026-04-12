/**
 * AgentTool — Spawn Isolated Sub-Agents
 *
 * Based on Claude Code's AgentTool.tsx (14 files, 235K main implementation)
 *
 * Creates a NEW QueryEngine instance with:
 *   - Zero shared conversation context (complete isolation)
 *   - Tool set restricted by subagent_type
 *   - Own budget limits (turns + USD)
 *   - Anti-recursion (MAX_AGENT_DEPTH = 2)
 *   - Per-instance cost tracking
 *
 * The parent receives ONLY the final text response — not the sub-agent's
 * internal tool calls, file reads, or exploration. This is what keeps
 * the parent's context clean.
 */

import { z } from 'zod';
import { buildTool, type ToolResult, type ToolUseContext, type Tool, type CanUseToolFn, type RenderOptions } from '../Tool.js';
import { QueryEngine, MAX_AGENT_DEPTH, type SDKMessage } from '../../query/QueryEngine.js';
import { getSubagentPrompt, type SubagentType } from '../../utils/context/subagentPrompts.js';
import { getPermissionMode, getCwd, getSessionId } from '../../bootstrap/state.js';
import { createCanUseTool, type LegacyPermissionContext } from '../../utils/permissions/permissions.js';
import { getAllBaseTools, filterToolsByDenyRules } from '../tools.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const SUBAGENT_MAX_TURNS = 50;
const SUBAGENT_MAX_BUDGET_USD = 0.50;

/** Tools that researcher sub-agents can use (read-only) */
const RESEARCHER_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Bash', 'TodoWrite',
]);

/** Tools that sub-agents can NEVER use (prevents recursion, internal-only) */
const BLOCKED_FOR_SUBAGENTS = new Set([
  'Agent',       // No sub-agent recursion at this level
]);

// ─── Input Schema ───────────────────────────────────────────────────────────

const AgentInputSchema = z.object({
  description: z.string().min(3).max(100)
    .describe('Short description for UI display (e.g., "investigating auth bug")'),
  prompt: z.string().min(10)
    .describe('Complete, self-contained instruction. Sub-agent sees NOTHING from parent context.'),
  subagent_type: z.enum(['general', 'researcher', 'implementer']).optional().default('general')
    .describe('Agent type: researcher (read-only), implementer (full tools), general (default)'),
});

type AgentInput = z.infer<typeof AgentInputSchema>;

// ─── Tool Set Builder ───────────────────────────────────────────────────────

function buildToolSet(subagentType: SubagentType, parentDepth: number): Tool[] {
  let tools = getAllBaseTools();

  // Always remove AgentTool from sub-agents at max depth
  // At depth 0→1, sub-agents CAN spawn their own sub-agents (depth 1→2)
  // At depth 1→2, we remove AgentTool entirely
  if (parentDepth + 1 >= MAX_AGENT_DEPTH) {
    tools = tools.filter((t) => !BLOCKED_FOR_SUBAGENTS.has(t.name));
  }

  // Researcher: restrict to read-only tools
  if (subagentType === 'researcher') {
    tools = tools.filter((t) => RESEARCHER_TOOLS.has(t.name));
  }

  // All types: remove AgentTool to prevent runaway spawning
  // (even general/implementer at depth 0→1 shouldn't nest further for safety)
  tools = tools.filter((t) => t.name !== 'Agent');

  // Filter by isEnabled
  tools = tools.filter((t) => t.isEnabled());

  return tools;
}

// ─── The Tool ───────────────────────────────────────────────────────────────

export const AgentTool = buildTool<AgentInput>({
  name: 'Agent',
  aliases: ['AgentTool'],
  searchHint: 'subagent spawn delegate parallel worker',
  description: `Launch an isolated sub-agent to handle a task. The sub-agent gets its own context
window (~128K tokens) and cannot see your conversation. Use for:
- Tasks requiring extensive exploration (many file reads, searches)
- Research that would clutter your context
- Specific subtasks with clear "done" criteria

The prompt MUST be self-contained — include file paths, context, what "done" looks like.
Sub-agent types:
- researcher: read-only, for investigation and analysis
- implementer: full tools, for executing coding tasks
- general: full tools, for mixed work

Do NOT use for trivial tasks — the overhead isn't worth it for 1-2 tool calls.`,
  inputSchema: AgentInputSchema,

  userFacingName(input?: AgentInput) {
    return input ? `Agent(${input.description.slice(0, 30)})` : 'Agent';
  },
  isReadOnly() { return false; },
  isConcurrencySafe() { return true; }, // Enables parallel agent spawning
  isDestructive() { return false; },
  interruptBehavior() { return 'cancel' as const; },
  toAutoClassifierInput(input: AgentInput) { return `${input.subagent_type}: ${input.description}`; },
  renderToolUseMessage(input: AgentInput, _opts: RenderOptions) {
    return `Agent [${input.subagent_type || 'general'}]: ${input.description}`;
  },

  async checkPermissions(input: AgentInput) {
    return {
      behavior: 'ask' as const,
      message: `Spawn ${input.subagent_type || 'general'} agent: ${input.description}`,
    };
  },

  async call(
    input: AgentInput,
    context: ToolUseContext,
  ): Promise<ToolResult> {
    const subagentType: SubagentType = input.subagent_type || 'general';

    // ── Anti-recursion: check depth ─────────────────────────────────────
    // context doesn't carry depth directly, so we extract from the parent
    // engine. For the tools.ts level call, depth comes from the ToolUseContext
    // extension. We check MAX_AGENT_DEPTH as a hard limit.
    const parentDepth = (context as any).depth ?? 0;

    if (parentDepth >= MAX_AGENT_DEPTH) {
      return {
        output: null,
        outputText: `Error: Max agent depth reached (${MAX_AGENT_DEPTH}). Sub-agents cannot spawn sub-agents beyond depth ${MAX_AGENT_DEPTH}.`,
        isError: true,
      };
    }

    // ── Build tool set for sub-agent ────────────────────────────────────
    const subTools = buildToolSet(subagentType, parentDepth);

    // ── Build permission context ────────────────────────────────────────
    // Inherit parent's permission mode
    const mode = getPermissionMode();
    const permContext: LegacyPermissionContext = {
      denyRules: [],
      allowRules: mode === 'bypassPermissions'
        ? subTools.map((t) => t.name)  // bypass → allow all
        : ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite'], // read-only auto-allowed
      askRules: [],
    };

    // For researcher type: auto-allow all their tools (all read-only)
    if (subagentType === 'researcher') {
      permContext.allowRules = subTools.map((t) => t.name);
    }

    const canUseTool = createCanUseTool(permContext, false); // non-interactive (sub-agent)

    // ── Build system prompt ─────────────────────────────────────────────
    const systemPrompt = getSubagentPrompt(subagentType);

    // ── Create isolated QueryEngine ─────────────────────────────────────
    const subEngine = new QueryEngine({
      tools: subTools,
      systemPrompt,
      maxTurns: SUBAGENT_MAX_TURNS,
      maxBudgetUsd: SUBAGENT_MAX_BUDGET_USD,
      canUseTool,
      depth: parentDepth + 1,
      // Sub-agents are silent — no streaming to terminal
      onText: undefined,
      onToolUse: undefined,
      onToolResult: undefined,
    });

    // ── Run the sub-agent ───────────────────────────────────────────────
    let finalResult = '';
    let lastAssistantText = '';
    let errorOccurred = false;

    try {
      for await (const msg of subEngine.submitMessage(input.prompt)) {
        switch (msg.type) {
          case 'assistant':
            if (msg.content) {
              lastAssistantText = msg.content;
            }
            break;

          case 'result':
            if (msg.subtype?.startsWith('error')) {
              finalResult = `Agent error: ${msg.content}`;
              errorOccurred = true;
            } else {
              finalResult = msg.content || lastAssistantText;
            }
            break;
        }
      }
    } catch (err: any) {
      finalResult = `Agent crashed: ${err.message}`;
      errorOccurred = true;
    }

    // ── Collect metrics ─────────────────────────────────────────────────
    const durationMs = subEngine.getInstanceDurationMs();
    const turnsUsed = subEngine.getInstanceTurns();
    const costUsd = subEngine.getInstanceCostUsd();
    const tokensUsed = subEngine.getInstanceInputTokens() + subEngine.getInstanceOutputTokens();

    // ── Format result for parent ────────────────────────────────────────
    const formattedResult = `<agent_result>
Task: ${input.description}
Type: ${subagentType}
Duration: ${durationMs}ms | Turns: ${turnsUsed} | Tokens: ${tokensUsed} | Cost: $${costUsd.toFixed(4)}

${finalResult}
</agent_result>`;

    return {
      output: {
        result: finalResult,
        turns_used: turnsUsed,
        tokens_used: tokensUsed,
        cost_usd: costUsd,
        duration_ms: durationMs,
        subagent_type: subagentType,
        error: errorOccurred,
      },
      outputText: formattedResult,
      isError: errorOccurred,
    };
  },
});
