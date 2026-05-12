/**
 * TeamCleanup.ts — Team resource cleanup utilities
 *
 * Handles cleanup of team resources: killing orphan panes,
 * clearing stale inboxes, and full team teardown.
 */

import * as fs from 'fs';
import * as path from 'path';

import type {
  TeamFile,
  PaneBackend,
} from '../types.js';

import { INBOXES_DIR_NAME } from '../constants.js';
import { TeamManager } from './TeamManager.js';

// ════════════════════════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════════════════════════

export interface CleanupResult {
  panesKilled: number;
  inboxesCleared: number;
}

export interface AllTeamsCleanupStats {
  teamsProcessed: number;
  totalPanesKilled: number;
  totalInboxesCleared: number;
  errors: Array<{ teamName: string; error: string }>;
}

// ════════════════════════════════════════════════════════════════════════════
// Single Team Cleanup
// ════════════════════════════════════════════════════════════════════════════

/**
 * Full cleanup for a single team: kill orphan panes + clear stale inboxes.
 */
export async function cleanupTeam(
  manager: TeamManager,
  teamName: string,
  backend: PaneBackend
): Promise<CleanupResult> {
  const team = await manager.get(teamName);
  if (!team) {
    throw new Error(`Team "${teamName}" not found`);
  }

  const panesKilled = await cleanupOrphanPanes(backend, team);
  // Use the team directory parent (teamsRoot parent) as clowHome
  const teamsRoot = manager.teamsRoot;
  const clowHome = path.dirname(teamsRoot);
  const inboxesCleared = await cleanupStaleInboxes(
    clowHome,
    teamName
  );

  // Mark all members as inactive
  for (const member of team.members) {
    if (member.isActive) {
      member.isActive = false;
      member.lastActivityAt = Date.now();
    }
  }
  await manager.persistTeam(team);

  return { panesKilled, inboxesCleared };
}

// ════════════════════════════════════════════════════════════════════════════
// Orphan Pane Cleanup
// ════════════════════════════════════════════════════════════════════════════

/**
 * Kill terminal panes whose associated member is no longer active.
 * Returns the number of panes killed.
 */
export async function cleanupOrphanPanes(
  backend: PaneBackend,
  team: TeamFile
): Promise<number> {
  let killed = 0;

  // Get all currently-alive panes from the backend
  const allPanes = await backend.listPanes();
  const alivePaneIds = new Set(
    allPanes.filter((p) => p.isAlive).map((p) => p.id)
  );

  for (const member of team.members) {
    // Determine the pane ID based on backend type
    const paneId = getPaneIdForMember(member);
    if (!paneId) continue;

    // If the member is inactive but their pane is still alive, kill it
    if (!member.isActive && alivePaneIds.has(paneId)) {
      try {
        const success = await backend.killPane(paneId);
        if (success) {
          killed++;
        }
      } catch {
        // Pane may already be gone; ignore errors
      }
    }

    // If the member is "active" but the pane is dead, mark inactive
    if (member.isActive && !alivePaneIds.has(paneId)) {
      member.isActive = false;
      member.lastActivityAt = Date.now();
    }
  }

  return killed;
}

/**
 * Extract the backend-specific pane ID from a member.
 */
function getPaneIdForMember(
  member: TeamFile['members'][number]
): string | null {
  switch (member.backendType) {
    case 'tmux':
      return member.tmuxPaneId ?? null;
    case 'iterm2':
      return member.iTermTabId ?? null;
    case 'in-process':
      // In-process members use PID as identifier
      return member.pid != null ? String(member.pid) : null;
    default:
      return null;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Stale Inbox Cleanup
// ════════════════════════════════════════════════════════════════════════════

/**
 * Clear inbox files that have no corresponding active member.
 * Also removes .lock files that are stale.
 * Returns number of inboxes cleared.
 */
export async function cleanupStaleInboxes(
  clowHome: string,
  teamName: string
): Promise<number> {
  const inboxDir = path.join(clowHome, 'teams', teamName, INBOXES_DIR_NAME);

  if (!fs.existsSync(inboxDir)) {
    return 0;
  }

  let cleared = 0;
  const entries = fs.readdirSync(inboxDir);

  for (const entry of entries) {
    const filePath = path.join(inboxDir, entry);

    // Remove .lock files (stale locks)
    if (entry.endsWith('.lock')) {
      try {
        // Check if lock is stale by checking the PID inside
        const lockContent = fs.readFileSync(filePath, 'utf-8').trim();
        const lockPid = parseInt(lockContent, 10);

        if (!isNaN(lockPid) && !isProcessAlive(lockPid)) {
          fs.unlinkSync(filePath);
          cleared++;
        }
      } catch {
        // If we can't read it, try to remove it
        try {
          fs.unlinkSync(filePath);
          cleared++;
        } catch {
          // Ignore
        }
      }
      continue;
    }

    // Remove empty inbox files
    if (entry.endsWith('.json')) {
      try {
        const content = fs.readFileSync(filePath, 'utf-8').trim();
        const messages = JSON.parse(content);
        if (Array.isArray(messages) && messages.length === 0) {
          fs.unlinkSync(filePath);
          cleared++;
        }
      } catch {
        // Corrupted file, remove it
        try {
          fs.unlinkSync(filePath);
          cleared++;
        } catch {
          // Ignore
        }
      }
    }
  }

  return cleared;
}

/**
 * Check if a process with the given PID is still alive.
 */
function isProcessAlive(pid: number): boolean {
  try {
    // Sending signal 0 checks if the process exists without actually signaling it
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// All Teams Cleanup
// ════════════════════════════════════════════════════════════════════════════

/**
 * Run cleanup across all teams.
 * Returns aggregate stats and per-team errors.
 */
export async function cleanupAllTeams(
  manager: TeamManager,
  backend: PaneBackend
): Promise<AllTeamsCleanupStats> {
  const stats: AllTeamsCleanupStats = {
    teamsProcessed: 0,
    totalPanesKilled: 0,
    totalInboxesCleared: 0,
    errors: [],
  };

  const teamNames = await manager.list();

  for (const teamName of teamNames) {
    try {
      const result = await cleanupTeam(manager, teamName, backend);
      stats.teamsProcessed++;
      stats.totalPanesKilled += result.panesKilled;
      stats.totalInboxesCleared += result.inboxesCleared;
    } catch (err) {
      stats.errors.push({
        teamName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return stats;
}
