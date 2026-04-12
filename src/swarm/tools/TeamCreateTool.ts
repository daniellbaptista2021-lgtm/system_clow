/**
 * TeamCreateTool.ts — Create a new multi-agent team
 *
 * Creates a team with N members, each running in their own pane/process.
 * The current agent becomes the team leader.
 */

import type { TeamFile, SpawnResult, TeamMember, BackendType } from '../types.js';
import type { TeamManager } from '../team/TeamManager.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TeamCreateInput {
  name?: string;
  description?: string;
  members: Array<{
    name: string;
    agentType?: string;
    prompt: string;
    planModeRequired?: boolean;
    model?: string;
  }>;
}

export interface TeamCreateOutput {
  teamName: string;
  leadAgentId: string;
  members: SpawnResult[];
  totalMembers: number;
  successfulSpawns: number;
  failedSpawns: number;
  backend: BackendType;
}

// ════════════════════════════════════════════════════════════════════════════
// TeamCreateTool Implementation
// ════════════════════════════════════════════════════════════════════════════

export class TeamCreateTool {
  static readonly name = 'TeamCreate';
  static readonly description = 'Create a new multi-agent team with isolated workspaces.';

  /**
   * Execute team creation.
   */
  static async execute(
    input: TeamCreateInput,
    context: {
      sessionId: string;
      cwd: string;
      teamManager: TeamManager;
      spawnMember: (teamName: string, memberSpec: TeamCreateInput['members'][0]) => Promise<SpawnResult>;
    },
  ): Promise<TeamCreateOutput> {
    // Validate member count
    if (input.members.length < 1) throw new Error('Team must have at least 1 member');
    if (input.members.length > 10) throw new Error('Team can have at most 10 members');

    // Validate unique names
    const names = new Set(input.members.map(m => m.name));
    if (names.size !== input.members.length) {
      throw new Error('Member names must be unique');
    }

    // Create team
    const team = await context.teamManager.create({
      name: input.name,
      description: input.description,
      leadSessionId: context.sessionId,
    });

    // Spawn members
    const results: SpawnResult[] = [];
    let successCount = 0;
    let failCount = 0;

    for (const memberSpec of input.members) {
      try {
        const result = await context.spawnMember(team.name, memberSpec);
        results.push(result);
        if (result.success) successCount++;
        else failCount++;
      } catch (err) {
        results.push({
          success: false,
          backend: 'in-process',
          errorMessage: (err as Error).message,
          durationMs: 0,
        });
        failCount++;
      }
    }

    return {
      teamName: team.name,
      leadAgentId: team.leadAgentId,
      members: results,
      totalMembers: input.members.length,
      successfulSpawns: successCount,
      failedSpawns: failCount,
      backend: results[0]?.backend ?? 'in-process',
    };
  }

  static renderToolUseMessage(input: TeamCreateInput): string {
    return `🏗️ Creating team${input.name ? ` "${input.name}"` : ''} with ${input.members.length} members`;
  }
}
