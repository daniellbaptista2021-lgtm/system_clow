/**
 * teamAllowedPaths.ts — Path access control for team members
 *
 * Manages which file paths team members are allowed to read/write.
 * Paths can be scoped to individual members or the entire team.
 */

import * as path from 'path';

import type {
  TeamFile,
  TeamAllowedPath,
} from '../types.js';

// ════════════════════════════════════════════════════════════════════════════
// Path Checking
// ════════════════════════════════════════════════════════════════════════════

/**
 * Check if a path is allowed for a given team and scope.
 *
 * A path is considered allowed if any allowed path in the team
 * is a prefix of the requested path (i.e., the requested path is
 * inside an allowed directory) and the scope is compatible.
 *
 * 'write' scope implies 'read' access.
 *
 * @param requestedPath - The absolute path to check
 * @param team - The team configuration
 * @param scope - The access scope required ('read' or 'write')
 * @returns true if the path is allowed
 */
export function isPathAllowed(
  requestedPath: string,
  team: TeamFile,
  scope: 'read' | 'write'
): boolean {
  if (!team.teamAllowedPaths || team.teamAllowedPaths.length === 0) {
    return false;
  }

  const normalizedRequest = path.resolve(requestedPath);

  for (const allowed of team.teamAllowedPaths) {
    const normalizedAllowed = path.resolve(allowed.path);

    // Check if requested path is under the allowed path
    const isUnder =
      normalizedRequest === normalizedAllowed ||
      normalizedRequest.startsWith(normalizedAllowed + path.sep);

    if (!isUnder) continue;

    // Check scope compatibility
    // 'write' scope grants both read and write
    if (scope === 'read') {
      return true; // Any scope (read or write) allows reading
    }
    if (scope === 'write' && allowed.scope === 'write') {
      return true;
    }
  }

  return false;
}

// ════════════════════════════════════════════════════════════════════════════
// Path Management
// ════════════════════════════════════════════════════════════════════════════

/**
 * Add an allowed path to a team's configuration.
 * Mutates the team object in place. Caller must persist.
 *
 * @param team - The team to modify
 * @param pathToAllow - The absolute path to allow
 * @param scope - 'read' or 'write'
 * @param grantedBy - Agent ID of who granted the access
 */
export function addAllowedPath(
  team: TeamFile,
  pathToAllow: string,
  scope: 'read' | 'write',
  grantedBy: string
): void {
  if (!team.teamAllowedPaths) {
    team.teamAllowedPaths = [];
  }

  const normalized = path.resolve(pathToAllow);

  // Check for duplicate (same path and scope)
  const existing = team.teamAllowedPaths.find(
    (ap) => path.resolve(ap.path) === normalized && ap.scope === scope
  );
  if (existing) {
    return; // Already allowed
  }

  team.teamAllowedPaths.push({
    path: normalized,
    scope,
    grantedBy,
  });
}

/**
 * Remove an allowed path from a team's configuration.
 * Removes all entries matching the path regardless of scope.
 * Mutates the team object in place. Caller must persist.
 *
 * @param team - The team to modify
 * @param pathToRemove - The absolute path to remove
 */
export function removeAllowedPath(
  team: TeamFile,
  pathToRemove: string
): void {
  if (!team.teamAllowedPaths) return;

  const normalized = path.resolve(pathToRemove);
  team.teamAllowedPaths = team.teamAllowedPaths.filter(
    (ap) => path.resolve(ap.path) !== normalized
  );
}

// ════════════════════════════════════════════════════════════════════════════
// Member-Specific Queries
// ════════════════════════════════════════════════════════════════════════════

/**
 * Get all allowed paths for a specific member.
 * Currently returns the team-wide allowed paths since path access
 * is team-scoped. The memberAgentId parameter is for future
 * per-member path filtering.
 *
 * @param team - The team configuration
 * @param _memberAgentId - Agent ID (reserved for future per-member filtering)
 * @returns Array of allowed paths
 */
export function getPathsForMember(
  team: TeamFile,
  _memberAgentId: string
): TeamAllowedPath[] {
  return team.teamAllowedPaths ?? [];
}
