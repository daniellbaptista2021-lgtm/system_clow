/**
 * TeamHelpers.ts — Utility functions for team operations
 *
 * Stateless helper functions that operate on TeamFile/TeamMember data
 * without needing the full TeamManager.
 */

import type {
  TeamFile,
  TeamMember,
} from '../types.js';

import {
  TEAM_LEAD_NAME,
  DEFAULT_MEMBER_COLORS,
} from '../constants.js';

import { formatAgentId } from './TeamManager.js';

// ════════════════════════════════════════════════════════════════════════════
// Leader Helpers
// ════════════════════════════════════════════════════════════════════════════

/**
 * Check if an agent ID is the leader of a team.
 */
export function isLeader(agentId: string, team: TeamFile): boolean {
  return agentId === team.leadAgentId;
}

/**
 * Get the leader's agent ID for a team.
 */
export function getLeaderAgentId(team: TeamFile): string {
  return team.leadAgentId;
}

// ════════════════════════════════════════════════════════════════════════════
// Member Queries
// ════════════════════════════════════════════════════════════════════════════

/**
 * Find a team member by their short name.
 * Returns null if not found.
 */
export function getMemberByName(
  team: TeamFile,
  name: string
): TeamMember | null {
  return team.members.find((m) => m.name === name) ?? null;
}

/**
 * Count active (isActive === true) members in a team.
 */
export function getActiveMemberCount(team: TeamFile): number {
  return team.members.filter((m) => m.isActive).length;
}

/**
 * Get all active members of a team.
 */
export function getActiveMembers(team: TeamFile): TeamMember[] {
  return team.members.filter((m) => m.isActive);
}

/**
 * Get all members (active or not) of a team.
 */
export function getAllMembers(team: TeamFile): TeamMember[] {
  return team.members;
}

// ════════════════════════════════════════════════════════════════════════════
// ID Generation
// ════════════════════════════════════════════════════════════════════════════

/**
 * Generate a member agent ID from team and member names.
 * Delegates to formatAgentId but provides a clearer name for this use case.
 */
export function generateMemberId(
  teamName: string,
  memberName: string
): string {
  return formatAgentId(memberName, teamName);
}

// ════════════════════════════════════════════════════════════════════════════
// Color Cycling
// ════════════════════════════════════════════════════════════════════════════

/**
 * Get the next available color for a new team member.
 * Cycles through DEFAULT_MEMBER_COLORS based on current member count.
 */
export function getNextColor(team: TeamFile): string {
  const usedColors = new Set(
    team.members.map((m) => m.color).filter(Boolean)
  );

  // Find the first unused color
  for (const color of DEFAULT_MEMBER_COLORS) {
    if (!usedColors.has(color)) {
      return color;
    }
  }

  // If all used, cycle based on member count
  const index = team.members.length % DEFAULT_MEMBER_COLORS.length;
  return DEFAULT_MEMBER_COLORS[index]!;
}

// ════════════════════════════════════════════════════════════════════════════
// Validation
// ════════════════════════════════════════════════════════════════════════════

/**
 * Validate a team name.
 * Must be kebab-case: lowercase letters, digits, hyphens. No leading/trailing hyphens.
 * Length: 1-64 characters.
 */
export function validateTeamName(
  name: string
): { valid: boolean; error?: string } {
  if (!name || name.length === 0) {
    return { valid: false, error: 'Team name cannot be empty' };
  }

  if (name.length > 64) {
    return { valid: false, error: 'Team name cannot exceed 64 characters' };
  }

  if (name.startsWith('-') || name.endsWith('-')) {
    return {
      valid: false,
      error: 'Team name cannot start or end with a hyphen',
    };
  }

  if (!/^[a-z0-9-]+$/.test(name)) {
    return {
      valid: false,
      error:
        'Team name must contain only lowercase letters, digits, and hyphens',
    };
  }

  if (/--/.test(name)) {
    return {
      valid: false,
      error: 'Team name cannot contain consecutive hyphens',
    };
  }

  return { valid: true };
}

/**
 * Validate a member name.
 * Must be kebab-case: lowercase letters, digits, hyphens. No leading/trailing hyphens.
 * Length: 1-32 characters.
 * Cannot be the reserved leader name.
 */
export function validateMemberName(
  name: string
): { valid: boolean; error?: string } {
  if (!name || name.length === 0) {
    return { valid: false, error: 'Member name cannot be empty' };
  }

  if (name.length > 32) {
    return { valid: false, error: 'Member name cannot exceed 32 characters' };
  }

  if (name === TEAM_LEAD_NAME) {
    return {
      valid: false,
      error: `"${TEAM_LEAD_NAME}" is reserved for the team leader`,
    };
  }

  if (name.startsWith('-') || name.endsWith('-')) {
    return {
      valid: false,
      error: 'Member name cannot start or end with a hyphen',
    };
  }

  if (!/^[a-z0-9-]+$/.test(name)) {
    return {
      valid: false,
      error:
        'Member name must contain only lowercase letters, digits, and hyphens',
    };
  }

  return { valid: true };
}

// ════════════════════════════════════════════════════════════════════════════
// Formatting
// ════════════════════════════════════════════════════════════════════════════

/**
 * Format a team summary as a human-readable string.
 */
export function formatTeamSummary(team: TeamFile): string {
  const lines: string[] = [];

  lines.push(`Team: ${team.name}`);
  if (team.description) {
    lines.push(`  Description: ${team.description}`);
  }
  lines.push(`  Leader: ${team.leadAgentId}`);
  lines.push(`  Created: ${new Date(team.createdAt).toISOString()}`);

  const activeCount = getActiveMemberCount(team);
  lines.push(
    `  Members: ${team.members.length} total, ${activeCount} active`
  );

  if (team.members.length > 0) {
    lines.push('  ─────────────────────────────');
    for (const member of team.members) {
      const status = member.isActive ? 'active' : 'inactive';
      const backend = member.backendType;
      lines.push(
        `  ${member.name} (${member.agentId}) [${status}] [${backend}]`
      );
      if (member.agentType) {
        lines.push(`    type: ${member.agentType}`);
      }
      if (member.cwd) {
        lines.push(`    cwd: ${member.cwd}`);
      }
    }
  }

  if (team.teamAllowedPaths && team.teamAllowedPaths.length > 0) {
    lines.push('  ─────────────────────────────');
    lines.push('  Allowed Paths:');
    for (const ap of team.teamAllowedPaths) {
      lines.push(`    ${ap.scope}: ${ap.path} (by ${ap.grantedBy})`);
    }
  }

  return lines.join('\n');
}
