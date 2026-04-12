/**
 * TeamDeleteTool.ts — Delete a team and clean up all resources
 */

import type { TeamManager } from '../team/TeamManager.js';
import type { PaneBackend } from '../types.js';

export interface TeamDeleteInput {
  teamName: string;
  force?: boolean;
}

export interface TeamDeleteOutput {
  deleted: boolean;
  teamName: string;
  membersKilled: number;
  inboxesCleared: number;
  error?: string;
}

export class TeamDeleteTool {
  static readonly name = 'TeamDelete';
  static readonly description = 'Delete a team and clean up all its resources.';

  static async execute(
    input: TeamDeleteInput,
    context: {
      teamManager: TeamManager;
      backend: PaneBackend;
    },
  ): Promise<TeamDeleteOutput> {
    const team = await context.teamManager.get(input.teamName);
    if (!team) {
      return { deleted: false, teamName: input.teamName, membersKilled: 0, inboxesCleared: 0, error: 'Team not found' };
    }

    // Kill all member panes
    let membersKilled = 0;
    for (const member of team.members) {
      if (!member.isActive) continue;
      const paneId = member.tmuxPaneId ?? member.iTermTabId;
      if (paneId) {
        const killed = await context.backend.killPane(paneId);
        if (killed) membersKilled++;
      }
    }

    // Delete team directory (includes inboxes)
    await context.teamManager.delete(input.teamName);

    return {
      deleted: true,
      teamName: input.teamName,
      membersKilled,
      inboxesCleared: team.members.length,
    };
  }

  static renderToolUseMessage(input: TeamDeleteInput): string {
    return `🗑️ Deleting team "${input.teamName}"`;
  }
}
