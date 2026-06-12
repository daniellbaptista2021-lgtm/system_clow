import { z } from 'zod';
import { buildTool, type Tool, type ToolResult, type ToolUseContext } from '../../tools/Tool.js';
import { SwarmSystem } from '../SwarmSystem.js';
import { TeamCreateTool } from './TeamCreateTool.js';
import { TeamDeleteTool } from './TeamDeleteTool.js';
import { SendMessageTool } from './SendMessageTool.js';
import { ListPeersTool } from './ListPeersTool.js';
import { TeammateIdleTool } from './TeammateIdleTool.js';

let swarmSystemPromise: Promise<SwarmSystem> | null = null;

async function getSwarmSystem(): Promise<SwarmSystem> {
  if (!swarmSystemPromise) {
    swarmSystemPromise = (async () => {
      const swarm = new SwarmSystem();
      await swarm.initialize();
      return swarm;
    })();
  }
  return swarmSystemPromise;
}

function requireAgentId(): string {
  const agentId = process.env.CLOW_AGENT_ID;
  if (!agentId) {
    throw new Error('Swarm agent context missing: CLOW_AGENT_ID is not set');
  }
  return agentId;
}

function requireTeamName(inputTeamName?: string): string {
  const teamName = inputTeamName || process.env.CLOW_TEAM;
  if (!teamName) {
    throw new Error('Swarm team context missing: provide teamName or set CLOW_TEAM');
  }
  return teamName;
}

const TeamCreateInputSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  members: z.array(z.object({
    name: z.string().min(1).max(100),
    agentType: z.string().max(100).optional(),
    prompt: z.string().min(1),
    planModeRequired: z.boolean().optional(),
    model: z.string().max(100).optional(),
  })).min(1).max(10),
});

const TeamDeleteInputSchema = z.object({
  teamName: z.string().min(1).optional(),
  force: z.boolean().optional(),
});

const ListPeersInputSchema = z.object({
  teamName: z.string().min(1).optional(),
  activeOnly: z.boolean().optional(),
});

const SendMessageInputSchema = z.object({
  to: z.string().min(1),
  messageType: z.enum([
    'direct_message', 'broadcast', 'idle_notification', 'permission_request', 'permission_response',
    'sandbox_permission_request', 'plan_approval_request', 'plan_approval_response', 'shutdown_request',
    'shutdown_approved', 'shutdown_rejected', 'task_assignment', 'task_result', 'status_update',
  ]).optional(),
  content: z.union([z.string(), z.record(z.string(), z.unknown())]),
  waitForReply: z.boolean().optional(),
  replyTimeoutMs: z.number().int().positive().optional(),
  replyToId: z.string().optional(),
});

const TeammateIdleInputSchema = z.object({
  reason: z.enum(['done', 'blocked', 'failed', 'waiting']),
  summary: z.string().optional(),
  cost: z.number().optional(),
  turnCount: z.number().int().nonnegative().optional(),
});

export const SwarmTeamCreateTool = buildTool({
  name: TeamCreateTool.name,
  description: TeamCreateTool.description,
  inputSchema: TeamCreateInputSchema,
  async call(input, context): Promise<ToolResult> {
    const swarm = await getSwarmSystem();
    const output = await TeamCreateTool.execute(input, {
      sessionId: context.sessionId,
      cwd: context.cwd,
      teamManager: swarm.teamManager,
      spawnMember: async (teamName, memberSpec) => swarm.spawnMember({
        teamName,
        memberName: memberSpec.name,
        agentType: memberSpec.agentType,
        prompt: memberSpec.prompt,
        planModeRequired: memberSpec.planModeRequired,
        model: memberSpec.model,
        customCwd: context.cwd,
      }),
    });
    return { output, outputText: JSON.stringify(output) };
  },
  userFacingName: () => TeamCreateTool.name,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  renderToolUseMessage(input) { return TeamCreateTool.renderToolUseMessage(input); },
});

export const SwarmTeamDeleteTool = buildTool({
  name: TeamDeleteTool.name,
  description: TeamDeleteTool.description,
  inputSchema: TeamDeleteInputSchema,
  async call(input): Promise<ToolResult> {
    const swarm = await getSwarmSystem();
    const teamName = requireTeamName(input.teamName);
    const backend = swarm.backendRegistry.get(swarm.getDetectedBackend());
    const output = await TeamDeleteTool.execute({ ...input, teamName }, {
      teamManager: swarm.teamManager,
      backend,
    });
    return { output, outputText: JSON.stringify(output), isError: !output.deleted };
  },
  userFacingName: () => TeamDeleteTool.name,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isDestructive: () => true,
  renderToolUseMessage(input) { return TeamDeleteTool.renderToolUseMessage({ teamName: input.teamName || process.env.CLOW_TEAM || 'current-team', force: input.force }); },
});

export const SwarmListPeersTool = buildTool({
  name: ListPeersTool.name,
  description: ListPeersTool.description,
  inputSchema: ListPeersInputSchema,
  async call(input): Promise<ToolResult> {
    const swarm = await getSwarmSystem();
    const teamName = requireTeamName(input.teamName);
    const output = await ListPeersTool.execute({ ...input, teamName }, { teamManager: swarm.teamManager });
    return { output, outputText: JSON.stringify(output) };
  },
  userFacingName: () => ListPeersTool.name,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  renderToolUseMessage(input) { return ListPeersTool.renderToolUseMessage({ teamName: input.teamName || process.env.CLOW_TEAM || 'current-team', activeOnly: input.activeOnly }); },
});

export const SwarmSendMessageTool = buildTool({
  name: SendMessageTool.name,
  description: SendMessageTool.description,
  inputSchema: SendMessageInputSchema,
  async call(input): Promise<ToolResult> {
    const swarm = await getSwarmSystem();
    const output = await SendMessageTool.execute(input, {
      agentId: requireAgentId(),
      mailbox: swarm.mailbox,
    });
    return { output, outputText: JSON.stringify(output), isError: !output.delivered };
  },
  userFacingName: () => SendMessageTool.name,
  isReadOnly: () => false,
  isConcurrencySafe: () => true,
  renderToolUseMessage(input) { return SendMessageTool.renderToolUseMessage(input); },
});

export const SwarmTeammateIdleTool = buildTool({
  name: TeammateIdleTool.name,
  description: TeammateIdleTool.description,
  inputSchema: TeammateIdleInputSchema,
  async call(input): Promise<ToolResult> {
    const swarm = await getSwarmSystem();
    const agentId = requireAgentId();
    const teamName = requireTeamName();
    const team = await swarm.teamManager.get(teamName);
    if (!team) {
      return {
        output: null,
        outputText: `Team not found: ${teamName}`,
        isError: true,
      };
    }
    const output = await TeammateIdleTool.execute(input, {
      agentId,
      leaderAgentId: team.leadAgentId,
      mailbox: swarm.mailbox,
    });
    return { output, outputText: JSON.stringify(output) };
  },
  userFacingName: () => TeammateIdleTool.name,
  isReadOnly: () => false,
  isConcurrencySafe: () => true,
  renderToolUseMessage(input) { return TeammateIdleTool.renderToolUseMessage(input); },
});

export function getSwarmRuntimeTools(): Tool[] {
  return [
    SwarmTeamCreateTool,
    SwarmTeamDeleteTool,
    SwarmListPeersTool,
    SwarmSendMessageTool,
    SwarmTeammateIdleTool,
  ];
}
