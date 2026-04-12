/**
 * TeamManager.ts — Team CRUD with file persistence
 *
 * Manages team lifecycle: creation, member management, persistence.
 * Each team is stored as config.json in ~/.clow/teams/<name>/.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

import type {
  TeamFile,
  TeamMember,
  TeamAllowedPath,
  BackendType,
} from '../types.js';

import {
  TEAMS_DIR_NAME,
  INBOXES_DIR_NAME,
  TEAM_LEAD_NAME,
  TEAM_NAME_WORDS,
  DEFAULT_MEMBER_COLORS,
  MAX_TEAM_MEMBERS,
  MAX_TEAMS,
} from '../constants.js';

// ════════════════════════════════════════════════════════════════════════════
// Paths
// ════════════════════════════════════════════════════════════════════════════

/**
 * Get the root directory for clow data: ~/.clow
 */
export function getClowHome(): string {
  return path.join(os.homedir(), '.clow');
}

/**
 * Get the teams root directory: ~/.clow/teams
 */
export function getTeamsRoot(): string {
  return path.join(getClowHome(), TEAMS_DIR_NAME);
}

/**
 * Get the directory for a specific team: ~/.clow/teams/<name>
 */
export function getTeamDir(teamName: string): string {
  return path.join(getTeamsRoot(), teamName);
}

/**
 * Get the config file path for a team: ~/.clow/teams/<name>/config.json
 */
export function getTeamConfigPath(teamName: string): string {
  return path.join(getTeamDir(teamName), 'config.json');
}

/**
 * Get the inboxes directory for a team: ~/.clow/teams/<name>/inboxes
 */
export function getInboxesDir(teamName: string): string {
  return path.join(getTeamDir(teamName), INBOXES_DIR_NAME);
}

/**
 * Get the inbox file for a specific agent: ~/.clow/teams/<name>/inboxes/<agentId>.json
 */
export function getInboxPath(teamName: string, agentId: string): string {
  // Sanitize agentId for use as filename (replace @ with _at_)
  const safeId = agentId.replace(/@/g, '_at_');
  return path.join(getInboxesDir(teamName), `${safeId}.json`);
}

// ════════════════════════════════════════════════════════════════════════════
// Agent ID Formatting
// ════════════════════════════════════════════════════════════════════════════

/**
 * Format an agent ID from member name and team name.
 * Example: formatAgentId("researcher", "my-project") => "researcher@my-project"
 */
export function formatAgentId(memberName: string, teamName: string): string {
  return `${memberName}@${teamName}`;
}

/**
 * Parse an agent ID into its component parts.
 * Example: parseAgentId("researcher@my-project") => { name: "researcher", teamName: "my-project" }
 */
export function parseAgentId(agentId: string): { name: string; teamName: string } {
  const atIndex = agentId.indexOf('@');
  if (atIndex === -1) {
    throw new Error(`Invalid agent ID format (missing @): "${agentId}"`);
  }
  return {
    name: agentId.slice(0, atIndex),
    teamName: agentId.slice(atIndex + 1),
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Team Name Generation
// ════════════════════════════════════════════════════════════════════════════

/**
 * Generate a random team name using word list + hex suffix.
 * Example: "phoenix-a3f1"
 */
export function generateTeamName(): string {
  const word = TEAM_NAME_WORDS[Math.floor(Math.random() * TEAM_NAME_WORDS.length)]!;
  const hex = crypto.randomBytes(2).toString('hex');
  return `${word}-${hex}`;
}

// ════════════════════════════════════════════════════════════════════════════
// Create Params
// ════════════════════════════════════════════════════════════════════════════

export interface CreateTeamParams {
  /** Team name (kebab-case). Auto-generated if omitted. */
  name?: string;
  /** Human-readable description */
  description?: string;
  /** Leader session ID */
  leadSessionId?: string;
  /** Working directory for the leader */
  leaderCwd?: string;
}

// ════════════════════════════════════════════════════════════════════════════
// TeamManager
// ════════════════════════════════════════════════════════════════════════════

export interface TeamManagerOptions {
  clowHome: string;
}

export class TeamManager {
  private readonly clowHome: string;

  constructor(optionsOrClowHome?: TeamManagerOptions | string) {
    if (typeof optionsOrClowHome === 'string') {
      this.clowHome = optionsOrClowHome;
    } else if (optionsOrClowHome && typeof optionsOrClowHome === 'object') {
      this.clowHome = optionsOrClowHome.clowHome;
    } else {
      this.clowHome = getClowHome();
    }
  }

  // ─── Accessors ─────────────────────────────────────────────────────

  /** Root teams directory */
  get teamsRoot(): string {
    return path.join(this.clowHome, TEAMS_DIR_NAME);
  }

  /** Directory for a specific team */
  teamDir(teamName: string): string {
    return path.join(this.teamsRoot, teamName);
  }

  /** Config path for a specific team */
  configPath(teamName: string): string {
    return path.join(this.teamDir(teamName), 'config.json');
  }

  /** Inboxes directory for a specific team */
  inboxesDir(teamName: string): string {
    return path.join(this.teamDir(teamName), INBOXES_DIR_NAME);
  }

  // ─── Agent ID (convenience methods) ─────────────────────────────

  /**
   * Format an agent ID. Convenience method wrapping the standalone function.
   */
  formatAgentId(memberName: string, teamName: string): string {
    return formatAgentId(memberName, teamName);
  }

  /**
   * Parse an agent ID. Convenience method wrapping the standalone function.
   */
  parseAgentId(agentId: string): { name: string; teamName: string } {
    return parseAgentId(agentId);
  }

  // ─── Create ────────────────────────────────────────────────────────

  /**
   * Create a new team with directory structure and config.json.
   */
  async create(params: CreateTeamParams): Promise<TeamFile> {
    const name = params.name ?? generateTeamName();

    // Validate name
    if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(name) && !/^[a-z0-9]$/.test(name)) {
      throw new Error(
        `Invalid team name "${name}": must be kebab-case (lowercase letters, digits, hyphens; no leading/trailing hyphens)`
      );
    }

    // Check max teams
    const existing = await this.list();
    if (existing.length >= MAX_TEAMS) {
      throw new Error(`Maximum number of teams (${MAX_TEAMS}) reached`);
    }

    // Check for duplicate
    const teamDir = this.teamDir(name);
    if (fs.existsSync(teamDir)) {
      throw new Error(`Team "${name}" already exists`);
    }

    const leadAgentId = formatAgentId(TEAM_LEAD_NAME, name);

    const team: TeamFile = {
      name,
      description: params.description,
      createdAt: Date.now(),
      leadAgentId,
      leadSessionId: params.leadSessionId,
      teamAllowedPaths: [],
      members: [],
    };

    // Create directory structure
    fs.mkdirSync(teamDir, { recursive: true });
    fs.mkdirSync(this.inboxesDir(name), { recursive: true });

    // Write config
    await this.persistTeam(team);

    return team;
  }

  // ─── Read ──────────────────────────────────────────────────────────

  /**
   * Get a team by name. Returns null if not found.
   */
  async get(teamName: string): Promise<TeamFile | null> {
    const configFile = this.configPath(teamName);
    if (!fs.existsSync(configFile)) {
      return null;
    }
    try {
      const raw = fs.readFileSync(configFile, 'utf-8');
      return JSON.parse(raw) as TeamFile;
    } catch {
      return null;
    }
  }

  /**
   * List all team names.
   */
  async list(): Promise<string[]> {
    const root = this.teamsRoot;
    if (!fs.existsSync(root)) {
      return [];
    }
    const entries = fs.readdirSync(root, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((name) => fs.existsSync(this.configPath(name)));
  }

  // ─── Update ────────────────────────────────────────────────────────

  /**
   * Add a member to a team. Returns the updated team.
   */
  async addMember(
    teamName: string,
    member: TeamMember
  ): Promise<TeamFile> {
    const team = await this.get(teamName);
    if (!team) {
      throw new Error(`Team "${teamName}" not found`);
    }

    // Check max members
    if (team.members.length >= MAX_TEAM_MEMBERS) {
      throw new Error(
        `Team "${teamName}" already has maximum members (${MAX_TEAM_MEMBERS})`
      );
    }

    // Duplicate detection by agentId
    const duplicate = team.members.find((m) => m.agentId === member.agentId);
    if (duplicate) {
      throw new Error(
        `Member with agent ID "${member.agentId}" already exists in team "${teamName}"`
      );
    }

    // Duplicate detection by name
    const nameConflict = team.members.find((m) => m.name === member.name);
    if (nameConflict) {
      throw new Error(
        `Member with name "${member.name}" already exists in team "${teamName}"`
      );
    }

    team.members.push(member);
    await this.persistTeam(team);
    return team;
  }

  /**
   * Remove a member from a team by agent ID.
   */
  async removeMember(
    teamName: string,
    agentId: string
  ): Promise<TeamFile> {
    const team = await this.get(teamName);
    if (!team) {
      throw new Error(`Team "${teamName}" not found`);
    }

    const index = team.members.findIndex((m) => m.agentId === agentId);
    if (index === -1) {
      throw new Error(
        `Member "${agentId}" not found in team "${teamName}"`
      );
    }

    team.members.splice(index, 1);
    await this.persistTeam(team);
    return team;
  }

  /**
   * Update a member's status.
   *
   * Supports two calling conventions:
   *   updateMemberStatus(teamName, agentId, isActive)
   *   updateMemberStatus(teamName, agentId, { isActive, pid?, ... })
   */
  async updateMemberStatus(
    teamName: string,
    agentId: string,
    statusOrActive: boolean | Partial<Pick<TeamMember, 'isActive' | 'pid' | 'tmuxPaneId' | 'iTermTabId' | 'lastActivityAt'>>,
    extras?: Partial<Pick<TeamMember, 'pid' | 'tmuxPaneId' | 'iTermTabId' | 'lastActivityAt'>>
  ): Promise<TeamFile> {
    const team = await this.get(teamName);
    if (!team) {
      throw new Error(`Team "${teamName}" not found`);
    }

    // Find by agentId or by name
    const member = team.members.find(
      (m) => m.agentId === agentId || m.name === agentId
    );
    if (!member) {
      throw new Error(
        `Member "${agentId}" not found in team "${teamName}"`
      );
    }

    if (typeof statusOrActive === 'boolean') {
      member.isActive = statusOrActive;
      member.lastActivityAt = Date.now();
      if (extras) {
        if (extras.pid !== undefined) member.pid = extras.pid;
        if (extras.tmuxPaneId !== undefined) member.tmuxPaneId = extras.tmuxPaneId;
        if (extras.iTermTabId !== undefined) member.iTermTabId = extras.iTermTabId;
        if (extras.lastActivityAt !== undefined) member.lastActivityAt = extras.lastActivityAt;
      }
    } else {
      // Object form
      const update = statusOrActive;
      if (update.isActive !== undefined) member.isActive = update.isActive;
      if (update.pid !== undefined) member.pid = update.pid;
      if (update.tmuxPaneId !== undefined) member.tmuxPaneId = update.tmuxPaneId;
      if (update.iTermTabId !== undefined) member.iTermTabId = update.iTermTabId;
      member.lastActivityAt = update.lastActivityAt ?? Date.now();
    }

    await this.persistTeam(team);
    return team;
  }

  // ─── Delete ────────────────────────────────────────────────────────

  /**
   * Delete a team and all its data.
   * Returns true if the team was deleted, false if not found.
   */
  async delete(teamName: string): Promise<boolean> {
    const teamDir = this.teamDir(teamName);
    if (!fs.existsSync(teamDir)) {
      return false;
    }
    fs.rmSync(teamDir, { recursive: true, force: true });
    return true;
  }

  // ─── Persistence ───────────────────────────────────────────────────

  /**
   * Persist a team to disk with atomic write (write to tmp, then rename).
   */
  async persistTeam(team: TeamFile): Promise<void> {
    const configFile = this.configPath(team.name);
    const dir = path.dirname(configFile);

    // Ensure directory exists
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const tmpFile = `${configFile}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    const data = JSON.stringify(team, null, 2);

    try {
      fs.writeFileSync(tmpFile, data, 'utf-8');
      fs.renameSync(tmpFile, configFile);
    } catch (err) {
      // Clean up tmp file on failure
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        // Ignore cleanup errors
      }
      throw err;
    }
  }
}
