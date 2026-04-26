/**
 * ListPeersTool.ts — List all teammates in the current team
 */

import type { TeamManager } from '../team/TeamManager.js';
import type { TeamMember } from '../types.js';

export interface ListPeersInput {
  teamName: string;
  activeOnly?: boolean;
}

export interface ListPeersOutput {
  teamName: string;
  leadAgentId: string;
  members: Array<{
    name: string;
    agentId: string;
    agentType?: string;
    isActive: boolean;
    backend: string;
    lastActivityAt?: number;
  }>;
  totalCount: number;
  activeCount: number;
}

export class ListPeersTool {
  static readonly name = 'ListPeers';
  static readonly description = 'List all teammates in the current team.';

  static async execute(
    input: ListPeersInput,
    context: { teamManager: TeamManager },
  ): Promise<ListPeersOutput> {
    const team = await context.teamManager.get(input.teamName);
    if (!team) throw new Error(`Team "${input.teamName}" not found`);

    let members = team.members;
    if (input.activeOnly) {
      members = members.filter(m => m.isActive);
    }

    return {
      teamName: team.name,
      leadAgentId: team.leadAgentId,
      members: members.map(m => ({
        name: m.name,
        agentId: m.agentId,
        agentType: m.agentType,
        isActive: m.isActive,
        backend: m.backendType,
        lastActivityAt: m.lastActivityAt,
      })),
      totalCount: team.members.length,
      activeCount: team.members.filter(m => m.isActive).length,
    };
  }

  static renderToolUseMessage(input: ListPeersInput): string {
    return `👥 Listing peers in team "${input.teamName}"`;
  }
}
