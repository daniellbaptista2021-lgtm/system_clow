/**
 * SwarmSystem.ts — Top-level orchestrator for Agent Swarms
 *
 * This is the main entry point for the multi-process agent swarm system.
 * It ties together all swarm components:
 *   - TeamManager: CRUD for team configurations
 *   - TeammateMailbox: file-based inter-agent messaging
 *   - BackendRegistry: terminal multiplexer detection and management
 *   - PermissionDelegation: worker→leader permission flow
 *   - Worker spawning and lifecycle management
 *
 * Unlike CoordinatorMode (in-process), SwarmSystem manages SEPARATE
 * processes that communicate via file-based mailboxes.
 */

import * as path from 'path';
import * as os from 'os';
import { TeamManager } from './team/TeamManager.js';
import { TeammateMailbox } from './mailbox/TeammateMailbox.js';
import { MailboxPoller } from './mailbox/MailboxPolling.js';
import { BackendRegistry } from './backends/BackendRegistry.js';
import { TmuxBackend } from './backends/TmuxBackend.js';
import { InProcessBackend } from './backends/InProcessBackend.js';
import { PermissionDelegation } from './permission/PermissionDelegation.js';
import { PlanApproval } from './permission/PlanApproval.js';
import { DelegationTracker } from './permission/DelegationTracker.js';
import type {
  TeamFile, TeamMember, BackendType, SpawnRequest, SpawnResult,
  MailboxMessage, MailboxMessageType, SwarmStats, PaneBackend,
} from './types.js';
import { TEAMS_DIR_NAME, MAILBOX_POLL_INTERVAL_MS } from './constants.js';

// ════════════════════════════════════════════════════════════════════════════
// SwarmSystem Class
// ════════════════════════════════════════════════════════════════════════════

export class SwarmSystem {
  readonly teamManager: TeamManager;
  readonly mailbox: TeammateMailbox;
  readonly backendRegistry: BackendRegistry;
  readonly permissionDelegation: PermissionDelegation;
  readonly planApproval: PlanApproval;

  private poller?: MailboxPoller;
  private initialized = false;
  private startedAt = 0;
  private detectedBackend: BackendType = 'in-process';

  // Stats
  private messagesSent = 0;
  private messagesReceived = 0;
  private permissionRequests = 0;

  constructor(private readonly clowHome: string = path.join(os.homedir(), '.clow')) {
    this.teamManager = new TeamManager(clowHome);
    this.mailbox = new TeammateMailbox({ clowHome });
    this.backendRegistry = new BackendRegistry();

    const tracker = new DelegationTracker();
    this.permissionDelegation = new PermissionDelegation(this.mailbox, tracker);
    this.planApproval = new PlanApproval(this.mailbox);
  }

  // ─── Initialization and Backend Management ───────────────────────

  /**
   * Initialize the swarm system.
   * Detects available backend, registers backends.
   */
  async initialize(): Promise<{ backend: BackendType }> {
    if (this.initialized) return { backend: this.detectedBackend };

    // Register backends
    await this.backendRegistry.register(new TmuxBackend());
    await this.backendRegistry.register(new InProcessBackend());

    // Detect best backend
    this.detectedBackend = await this.backendRegistry.detect();
    this.initialized = true;
    this.startedAt = Date.now();

    return { backend: this.detectedBackend };
  }

  // ─── Team Operations ─────────────────────────────────────────────

  /**
   * Create a new team.
   */
  async createTeam(params: {
    name?: string;
    description?: string;
    leadSessionId: string;
  }): Promise<TeamFile> {
    await this.ensureInitialized();
    return this.teamManager.create(params);
  }

  /**
   * Delete a team and clean up all resources.
   */
  async deleteTeam(teamName: string): Promise<boolean> {
    const team = await this.teamManager.get(teamName);
    if (!team) return false;

    // Kill all active member panes
    const backend = this.backendRegistry.get(this.detectedBackend);
    for (const member of team.members) {
      if (!member.isActive) continue;
      const paneId = member.tmuxPaneId ?? member.iTermTabId;
      if (paneId) {
        await backend.killPane(paneId).catch(() => {});
      }
    }

    await this.teamManager.delete(teamName);
    return true;
  }

  /**
   * List all teams.
   */
  async listTeams(): Promise<string[]> {
    return this.teamManager.list();
  }

  /**
   * Get team details.
   */
  async getTeam(name: string): Promise<TeamFile | null> {
    return this.teamManager.get(name);
  }

  // ─── Member Spawning ─────────────────────────────────────────────

  /**
   * Spawn a new team member.
   */
  async spawnMember(request: SpawnRequest): Promise<SpawnResult> {
    await this.ensureInitialized();
    const startTime = Date.now();

    const team = await this.teamManager.get(request.teamName);
    if (!team) {
      return { success: false, backend: this.detectedBackend, errorMessage: 'Team not found', durationMs: 0 };
    }

    const backendType = request.backendPreference ?? this.detectedBackend;
    const backend = this.backendRegistry.get(backendType);
    const agentId = `${request.memberName}@${request.teamName}`;

    try {
      // Build command for the new member process
      const command = this.buildMemberCommand(request, agentId);

      // Create pane
      const pane = await backend.createPane({
        title: `${request.memberName}@${request.teamName}`,
        cwd: request.customCwd ?? process.cwd(),
        command,
        env: {
          CLOW_TEAM: request.teamName,
          CLOW_AGENT_ID: agentId,
          CLOW_INBOX_DIR: path.join(this.clowHome, TEAMS_DIR_NAME, request.teamName, 'inboxes'),
          CLOW_QUIET_BOOTSTRAP: '1',
          ...(request.prompt ? { CLOW_INITIAL_PROMPT: request.prompt } : {}),
        },
        memberName: request.memberName,
      });

      // Create member record
      const member: TeamMember = {
        agentId,
        name: request.memberName,
        agentType: request.agentType,
        model: request.model,
        prompt: request.prompt,
        planModeRequired: request.planModeRequired,
        tmuxPaneId: backendType === 'tmux' ? pane.id : undefined,
        iTermTabId: backendType === 'iterm2' ? pane.id : undefined,
        cwd: request.customCwd ?? process.cwd(),
        subscriptions: [],
        backendType,
        isActive: true,
        pid: pane.pid,
        joinedAt: Date.now(),
      };

      // Register member in team
      await this.teamManager.addMember(request.teamName, member);

      return {
        success: true,
        member,
        backend: backendType,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        backend: backendType,
        errorMessage: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Kill a specific team member.
   */
  async killMember(teamName: string, memberName: string): Promise<boolean> {
    const team = await this.teamManager.get(teamName);
    if (!team) return false;

    const member = team.members.find(m => m.name === memberName);
    if (!member) return false;

    const backend = this.backendRegistry.get(member.backendType);
    const paneId = member.tmuxPaneId ?? member.iTermTabId;

    if (paneId) {
      await backend.killPane(paneId).catch(() => {});
    }

    await this.teamManager.updateMemberStatus(teamName, memberName, false);
    return true;
  }

  // ─── Messaging ───────────────────────────────────────────────────

  /**
   * Send a message from one agent to another.
   */
  async sendMessage(from: string, to: string, type: MailboxMessageType, content: unknown): Promise<string> {
    this.messagesSent++;
    return this.mailbox.send({ from, to, type, content } as any);
  }

  /**
   * Start polling inbox for the given agent.
   */
  startInboxPolling(agentId: string, handlers: Record<string, (msg: MailboxMessage) => void>): void {
    if (this.poller) this.poller.stop();

    this.poller = new MailboxPoller({ mailbox: this.mailbox, agentId, intervalMs: MAILBOX_POLL_INTERVAL_MS });

    for (const [type, handler] of Object.entries(handlers)) {
      this.poller.on(type as MailboxMessageType, async (msg) => {
        this.messagesReceived++;
        handler(msg);
      });
    }

    this.poller.start();
  }

  /**
   * Stop inbox polling.
   */
  stopInboxPolling(): void {
    if (this.poller) {
      this.poller.stop();
      this.poller = undefined;
    }
  }

  // ─── Permission Delegation ───────────────────────────────────────

  /**
   * Worker requests permission from leader.
   */
  async requestPermission(workerAgentId: string, leaderAgentId: string, toolName: string, toolInput: unknown) {
    this.permissionRequests++;
    return this.permissionDelegation.requestFromLeader({
      workerAgentId, leaderAgentId, toolName, toolInput,
    });
  }

  /**
   * Leader responds to permission request.
   */
  async respondToPermission(leaderAgentId: string, workerAgentId: string, requestId: string, granted: boolean, reason?: string) {
    return this.permissionDelegation.respondToWorker({
      leaderAgentId, workerAgentId, requestId, granted, reason,
    });
  }

  // ─── Stats ───────────────────────────────────────────────────────

  /**
   * Get swarm system statistics.
   */
  async getStats(): Promise<SwarmStats> {
    const teams = await this.teamManager.list();
    let totalMembers = 0;
    let activeMembers = 0;

    for (const teamName of teams) {
      const team = await this.teamManager.get(teamName);
      if (team) {
        totalMembers += team.members.length;
        activeMembers += team.members.filter(m => m.isActive).length;
      }
    }

    return {
      activeTeams: teams.length,
      totalMembers,
      activeMembers,
      messagesSent: this.messagesSent,
      messagesReceived: this.messagesReceived,
      permissionRequests: this.permissionRequests,
      backend: this.detectedBackend,
      uptime: this.startedAt > 0 ? Date.now() - this.startedAt : 0,
    };
  }

  // ─── Cleanup ─────────────────────────────────────────────────────

  /**
   * Clean up all swarm resources.
   */
  async cleanup(): Promise<void> {
    this.stopInboxPolling();

    // Kill all active members in all teams
    const teams = await this.teamManager.list();
    for (const teamName of teams) {
      const team = await this.teamManager.get(teamName);
      if (!team) continue;

      for (const member of team.members) {
        if (!member.isActive) continue;
        const backend = this.backendRegistry.get(member.backendType);
        const paneId = member.tmuxPaneId ?? member.iTermTabId;
        if (paneId) await backend.killPane(paneId).catch(() => {});
      }
    }

    await this.backendRegistry.cleanupAll();
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  getDetectedBackend(): BackendType {
    return this.detectedBackend;
  }

  // ─── Internal ────────────────────────────────────────────────────

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) await this.initialize();
  }

  private buildMemberCommand(request: SpawnRequest, agentId: string): string[] {
    const args = ['node', 'dist/cli.js'];

    if (request.model) {
      args.push('--model', request.model);
    }

    // Pass swarm context via env (already set in createPane env)
    return args;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Re-exports
// ════════════════════════════════════════════════════════════════════════════

export { TeamManager } from './team/TeamManager.js';
export { TeammateMailbox } from './mailbox/TeammateMailbox.js';
export { MailboxPoller } from './mailbox/MailboxPolling.js';
export { BackendRegistry } from './backends/BackendRegistry.js';
export { TmuxBackend } from './backends/TmuxBackend.js';
export { InProcessBackend } from './backends/InProcessBackend.js';
export { PermissionDelegation } from './permission/PermissionDelegation.js';
export { PlanApproval } from './permission/PlanApproval.js';
export { DelegationTracker } from './permission/DelegationTracker.js';
export { TeamCreateTool } from './tools/TeamCreateTool.js';
export { TeamDeleteTool } from './tools/TeamDeleteTool.js';
export { SendMessageTool } from './tools/SendMessageTool.js';
export { ListPeersTool } from './tools/ListPeersTool.js';
export { TeammateIdleTool } from './tools/TeammateIdleTool.js';
export type {
  TeamFile, TeamMember, BackendType, MailboxMessage, MailboxMessageType,
  SpawnRequest, SpawnResult, PaneBackend, CreatePaneOptions, PaneHandle,
  SwarmStats,
} from './types.js';
