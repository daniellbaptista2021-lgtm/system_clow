/**
 * types.ts — Agent Swarms type vocabulary
 *
 * Defines all types for the multi-process agent swarm system.
 * Unlike Coordinator Mode (in-process), swarms use separate processes
 * with file-based mailbox communication and terminal multiplexing.
 *
 * Key concepts:
 *   - Team: a group of agents working together
 *   - Leader: the coordinator agent that dispatches work
 *   - Teammate: a worker agent in a separate process/pane
 *   - Mailbox: file-based message passing between agents
 *   - Backend: terminal multiplexer (tmux/iTerm2/in-process)
 */

import type { PermissionMode } from '../bootstrap/state.js';

// ════════════════════════════════════════════════════════════════════════════
// Team Configuration
// ════════════════════════════════════════════════════════════════════════════

export interface TeamFile {
  /** Team name (kebab-case) */
  name: string;
  /** Human-readable description */
  description?: string;
  /** When the team was created */
  createdAt: number;
  /** Agent ID of the team leader */
  leadAgentId: string;
  /** Session ID of the leader */
  leadSessionId?: string;
  /** Shared file paths all members can access */
  teamAllowedPaths?: TeamAllowedPath[];
  /** Team members (excluding leader) */
  members: TeamMember[];
}

export interface TeamMember {
  /** Unique agent ID: "name@teamName" */
  agentId: string;
  /** Short name (e.g., "researcher") */
  name: string;
  /** Agent type for tool filtering */
  agentType?: string;
  /** Model override */
  model?: string;
  /** Initial prompt/instructions */
  prompt?: string;
  /** Terminal color for this member's pane */
  color?: string;
  /** Whether this member needs plan approval from leader */
  planModeRequired?: boolean;
  /** tmux pane ID (e.g., "%42") */
  tmuxPaneId?: string;
  /** iTerm2 tab ID */
  iTermTabId?: string;
  /** Working directory */
  cwd: string;
  /** Git worktree path (if using worktrees) */
  worktreePath?: string;
  /** Events this member subscribes to */
  subscriptions: string[];
  /** Which backend is running this member */
  backendType: BackendType;
  /** Whether the member is currently active */
  isActive: boolean;
  /** Permission mode for this member */
  mode?: PermissionMode;
  /** Process ID */
  pid?: number;
  /** When the member joined */
  joinedAt: number;
  /** Last activity timestamp */
  lastActivityAt?: number;
}

export type BackendType = 'tmux' | 'iterm2' | 'in-process';

export interface TeamAllowedPath {
  /** Absolute file path */
  path: string;
  /** Read or write access */
  scope: 'read' | 'write';
  /** Who granted this access */
  grantedBy: string;
}

// ════════════════════════════════════════════════════════════════════════════
// Mailbox Messages
// ════════════════════════════════════════════════════════════════════════════

export interface MailboxMessage {
  /** Unique message ID */
  id: string;
  /** Sender agent ID */
  from: string;
  /** Recipient agent ID or '*' for broadcast */
  to: string;
  /** Message type (discriminated union key) */
  type: MailboxMessageType;
  /** Type-specific content */
  content: unknown;
  /** When the message was sent */
  timestamp: number;
  /** For request/response pairing */
  replyToId?: string;
  /** Auto-expire timestamp */
  expiresAt?: number;
}

export type MailboxMessageType =
  | 'direct_message'
  | 'broadcast'
  | 'idle_notification'
  | 'permission_request'
  | 'permission_response'
  | 'sandbox_permission_request'
  | 'plan_approval_request'
  | 'plan_approval_response'
  | 'shutdown_request'
  | 'shutdown_approved'
  | 'shutdown_rejected'
  | 'task_assignment'
  | 'task_result'
  | 'status_update';

// ─── Message Content Types ─────────────────────────────────────

export interface DirectMessageContent {
  text: string;
  metadata?: Record<string, unknown>;
}

export interface IdleNotificationContent {
  reason: 'done' | 'blocked' | 'failed' | 'waiting';
  summary?: string;
  cost?: number;
  turnCount?: number;
}

export interface PermissionRequestContent {
  toolName: string;
  toolInput: unknown;
  requestedAt: number;
}

export interface PermissionResponseContent {
  granted: boolean;
  reason?: string;
  updatedInput?: unknown;
}

export interface PlanApprovalRequestContent {
  plan: string;
  estimatedActions: number;
}

export interface PlanApprovalResponseContent {
  approved: boolean;
  feedback?: string;
}

export interface ShutdownRequestContent {
  reason: string;
  graceful: boolean;
  timeoutMs?: number;
}

export interface TaskAssignmentContent {
  taskId: string;
  description: string;
  prompt: string;
  priority?: number;
}

export interface TaskResultContent {
  taskId: string;
  success: boolean;
  result: string;
  costUsd?: number;
  tokensUsed?: number;
}

export interface StatusUpdateContent {
  phase: string;
  progress?: number;
  message?: string;
}

// ════════════════════════════════════════════════════════════════════════════
// Spawn
// ════════════════════════════════════════════════════════════════════════════

export interface SpawnRequest {
  teamName: string;
  memberName: string;
  agentType?: string;
  model?: string;
  prompt?: string;
  planModeRequired?: boolean;
  inheritWorktree?: boolean;
  customCwd?: string;
  backendPreference?: BackendType;
}

export interface SpawnResult {
  success: boolean;
  member?: TeamMember;
  backend: BackendType;
  errorMessage?: string;
  durationMs: number;
}

// ════════════════════════════════════════════════════════════════════════════
// Backend Interface
// ════════════════════════════════════════════════════════════════════════════

export interface PaneBackend {
  readonly type: BackendType;

  /** Check if this backend is available on the current system */
  isAvailable(): Promise<boolean>;

  /** Create a new pane/tab for a teammate */
  createPane(options: CreatePaneOptions): Promise<PaneHandle>;

  /** Send text input to a pane */
  sendToPane(paneId: string, input: string): Promise<void>;

  /** Set the title of a pane */
  setPaneTitle(paneId: string, title: string): Promise<void>;

  /** Kill/close a pane */
  killPane(paneId: string): Promise<boolean>;

  /** List all managed panes */
  listPanes(): Promise<PaneHandle[]>;

  /** Clean up all resources */
  cleanup(): Promise<void>;
}

export interface CreatePaneOptions {
  title: string;
  cwd: string;
  command: string[];
  env?: Record<string, string>;
  color?: string;
  memberName: string;
}

export interface PaneHandle {
  id: string;
  backend: BackendType;
  pid?: number;
  title: string;
  isAlive: boolean;
}

// ════════════════════════════════════════════════════════════════════════════
// Permission Delegation
// ════════════════════════════════════════════════════════════════════════════

export interface PendingDelegation {
  requestId: string;
  workerAgentId: string;
  toolName: string;
  requestedAt: number;
}

// ════════════════════════════════════════════════════════════════════════════
// Swarm Stats
// ════════════════════════════════════════════════════════════════════════════

export interface SwarmStats {
  activeTeams: number;
  totalMembers: number;
  activeMembers: number;
  messagesSent: number;
  messagesReceived: number;
  permissionRequests: number;
  backend: BackendType;
  uptime: number;
}
