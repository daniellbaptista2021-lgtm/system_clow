/**
 * AgentTool ? Spawn Isolated Sub-Agents
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
 * The parent receives ONLY the final text response ? not the sub-agent's
 * internal tool calls, file reads, or exploration. This is what keeps
 * the parent's context clean.
 */

import { randomUUID } from 'crypto';
import { z } from 'zod';
import { buildTool, type ToolResult, type ToolUseContext, type Tool, type RenderOptions } from '../Tool.js';
import { QueryEngine, MAX_AGENT_DEPTH } from '../../query/QueryEngine.js';
import { getSubagentPrompt, type SubagentType } from '../../utils/context/subagentPrompts.js';
import { getPermissionMode } from '../../bootstrap/state.js';
import { createCanUseTool, type LegacyPermissionContext } from '../../utils/permissions/permissions.js';
import { getAllBaseTools } from '../tools.js';
import { TaskNotificationParser } from '../../coordinator/taskNotificationParser.js';
import type { WorkerSpawnResult } from '../../coordinator/types.js';

const SUBAGENT_MAX_TURNS = 50;
const SUBAGENT_MAX_BUDGET_USD = 0.50;

const RESEARCHER_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Bash', 'TodoWrite',
]);

const VERIFIER_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'Bash', 'TodoWrite', 'WebFetch', 'WebSearch',
]);

const BLOCKED_FOR_SUBAGENTS = new Set([
  'Agent',
]);

const AgentInputSchema = z.object({
  description: z.string().min(3).max(100)
    .describe('Short description for UI display (e.g., "investigating auth bug")'),
  prompt: z.string().min(10)
    .describe('Complete, self-contained instruction. Sub-agent sees NOTHING from parent context.'),
  subagent_type: z.enum(['general', 'researcher', 'implementer', 'verifier']).optional().default('general')
    .describe('Agent type: researcher, implementer, verifier, or general'),
  budgetUsd: z.number().positive().max(10).optional()
    .describe('Optional override for sub-agent budget in USD'),
  maxTurns: z.number().int().positive().max(200).optional()
    .describe('Optional override for max conversation turns'),
  allowedTools: z.array(z.string().min(1)).optional()
    .describe('Optional whitelist of tools allowed for this sub-agent'),
});

type AgentInput = z.infer<typeof AgentInputSchema>;

function normalizeAllowedTools(tools: string[] | undefined): Set<string> | null {
  if (!tools || tools.length === 0 || tools.includes('*')) {
    return null;
  }
  return new Set(tools);
}

function buildToolSet(subagentType: SubagentType, parentDepth: number, allowedTools?: string[]): Tool[] {
  let tools = getAllBaseTools();

  if (parentDepth + 1 >= MAX_AGENT_DEPTH) {
    tools = tools.filter((t) => !BLOCKED_FOR_SUBAGENTS.has(t.name));
  }

  if (subagentType === 'researcher') {
    tools = tools.filter((t) => RESEARCHER_TOOLS.has(t.name));
  }

  if (subagentType === 'verifier') {
    tools = tools.filter((t) => VERIFIER_TOOLS.has(t.name));
  }

  tools = tools.filter((t) => t.name !== 'Agent');
  tools = tools.filter((t) => t.isEnabled());

  const allowed = normalizeAllowedTools(allowedTools);
  if (allowed) {
    tools = tools.filter((t) => allowed.has(t.name));
  }

  return tools;
}

export const AgentTool = buildTool<AgentInput>({
  name: 'Agent',
  aliases: ['AgentTool'],
  searchHint: 'subagent spawn delegate parallel worker',
  description: `Launch an isolated sub-agent to handle a task. The sub-agent gets its own context
window (~128K tokens) and cannot see your conversation. Use for:
- Tasks requiring extensive exploration (many file reads, searches)
- Research that would clutter your context
- Specific subtasks with clear "done" criteria

The prompt MUST be self-contained ? include file paths, context, what "done" looks like.
Sub-agent types:
- researcher: read-only, for investigation and analysis
- implementer: full tools, for executing coding tasks
- verifier: verification-first, for tests and independent review
- general: full tools, for mixed work

Do NOT use for trivial tasks ? the overhead isn't worth it for 1-2 tool calls.`,
  inputSchema: AgentInputSchema,

  userFacingName(input?: AgentInput) {
    return input ? `Agent(${input.description.slice(0, 30)})` : 'Agent';
  },
  isReadOnly() { return false; },
  isConcurrencySafe() { return true; },
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

  async call(input: AgentInput, context: ToolUseContext): Promise<ToolResult> {
    const subagentType: SubagentType = input.subagent_type || 'general';
    const parentDepth = (context as any).depth ?? 0;

    if (parentDepth >= MAX_AGENT_DEPTH) {
      return {
        output: null,
        outputText: `Error: Max agent depth reached (${MAX_AGENT_DEPTH}). Sub-agents cannot spawn sub-agents beyond depth ${MAX_AGENT_DEPTH}.`,
        isError: true,
      };
    }

    const workerId = `worker_${randomUUID().slice(0, 8)}`;
    const subTools = buildToolSet(subagentType, parentDepth, input.allowedTools);

    const mode = getPermissionMode();
    const permContext: LegacyPermissionContext = {
      denyRules: [],
      allowRules: mode === 'bypassPermissions' || input.allowedTools?.length || subagentType === 'researcher' || subagentType === 'verifier'
        ? subTools.map((t) => t.name)
        : ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite'],
      askRules: [],
    };

    const canUseTool = createCanUseTool(permContext, false);
    const systemPrompt = getSubagentPrompt(subagentType);

    const subEngine = new QueryEngine({
      tools: subTools,
      systemPrompt,
      maxTurns: input.maxTurns ?? SUBAGENT_MAX_TURNS,
      maxBudgetUsd: input.budgetUsd ?? SUBAGENT_MAX_BUDGET_USD,
      canUseTool,
      depth: parentDepth + 1,
      getExecutionContext: () => ({
        cwd: context.cwd,
        sessionId: `${context.sessionId}:${workerId}`,
        workspaceRoot: context.workspaceRoot,
        tenantId: context.tenantId,
        permissionMode: context.permissionMode,
      }),
      onText: undefined,
      onToolUse: undefined,
      onToolResult: undefined,
    });

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

    const durationMs = subEngine.getInstanceDurationMs();
    const turnsUsed = subEngine.getInstanceTurns();
    const costUsd = subEngine.getInstanceCostUsd();
    const tokensUsed = subEngine.getInstanceInputTokens() + subEngine.getInstanceOutputTokens();

    const workerResult: WorkerSpawnResult = {
      workerId,
      startedAt: Date.now() - durationMs,
      status: errorOccurred ? 'failed' : 'completed',
      result: finalResult,
      tokensUsed,
      costUsd,
      durationMs,
      toolUseCount: 0,
      workerType: subagentType === 'verifier' ? 'verifier' : (subagentType as WorkerSpawnResult['workerType']),
    };

    const isCoordinatorParent = process.env.CLOW_COORDINATOR_MODE === '1' && !process.env.CLOW_WORKER_TYPE;
    const formattedResult = isCoordinatorParent
      ? TaskNotificationParser.buildNotification(workerResult)
      : `<agent_result>
Task: ${input.description}
Type: ${subagentType}
Worker: ${workerId}
Duration: ${durationMs}ms | Turns: ${turnsUsed} | Tokens: ${tokensUsed} | Cost: $${costUsd.toFixed(4)}

${finalResult}
</agent_result>`;

    return {
      output: {
        worker_id: workerId,
        result: finalResult,
        turns_used: turnsUsed,
        tokens_used: tokensUsed,
        cost_usd: costUsd,
        duration_ms: durationMs,
        subagent_type: subagentType,
        allowed_tools: input.allowedTools ?? null,
        error: errorOccurred,
      },
      outputText: formattedResult,
      isError: errorOccurred,
    };
  },
});
