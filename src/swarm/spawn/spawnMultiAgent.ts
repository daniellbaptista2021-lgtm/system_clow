/**
 * spawnMultiAgent.ts — Unified spawn logic for teammate agents
 *
 * Responsible for:
 *   - Detecting the best backend
 *   - Creating a terminal pane / child process
 *   - Building the CLI command to launch a clow agent
 *   - Tracking the member in the team file
 *   - Progress reporting
 */

import * as crypto from 'crypto';
import type {
  SpawnRequest,
  SpawnResult,
  TeamMember,
  BackendType,
  CreatePaneOptions,
} from '../types.js';
import { SPAWN_TIMEOUT_MS, DEFAULT_MEMBER_COLORS } from '../constants.js';
import type { BackendRegistry } from '../backends/BackendRegistry.js';
import { buildArgs, buildEnvVars } from './CliArgsPropagation.js';
import { assignColors, formatPaneTitle } from './TeammateLayoutManager.js';

// ────────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────────

/**
 * Spawn a new teammate agent in a terminal pane or child process.
 *
 * @returns SpawnResult indicating success/failure plus the TeamMember record.
 */
export async function spawnTeammate(
  request: SpawnRequest,
  backendRegistry: BackendRegistry,
): Promise<SpawnResult> {
  const start = Date.now();

  try {
    // 1. Detect backend (or honour explicit preference)
    const backendType: BackendType = request.backendPreference
      ? request.backendPreference
      : await backendRegistry.detect();

    const backend = backendRegistry.get(backendType);

    // 2. Build agent ID
    const agentId = `${request.memberName}@${request.teamName}`;

    // 3. Build CLI command
    const cliArgs = buildCliwCommand(request);

    // 4. Assign a color
    const colorMap = assignColors([request.memberName]);
    const color = request.prompt
      ? colorMap.get(request.memberName)
      : DEFAULT_MEMBER_COLORS[0];

    // 5. Determine working directory
    const cwd = request.customCwd ?? process.cwd();

    // 6. Build env vars
    const env = buildEnvVars(request);

    // 7. Build pane options
    const paneTitle = formatPaneTitle(request.memberName, request.teamName);
    const paneOptions: CreatePaneOptions = {
      title: paneTitle,
      cwd,
      command: cliArgs,
      env,
      color,
      memberName: request.memberName,
    };

    // 8. Create the pane
    const handle = await backend.createPane(paneOptions);

    // 9. Build TeamMember record
    const member: TeamMember = {
      agentId,
      name: request.memberName,
      agentType: request.agentType,
      model: request.model,
      prompt: request.prompt,
      color,
      cwd,
      subscriptions: [],
      backendType,
      isActive: true,
      mode: undefined,
      pid: handle.pid,
      joinedAt: Date.now(),
      tmuxPaneId: backendType === 'tmux' ? handle.id : undefined,
      iTermTabId: backendType === 'iterm2' ? handle.id : undefined,
      planModeRequired: request.planModeRequired,
    };

    return {
      success: true,
      member,
      backend: backendType,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      success: false,
      backend: request.backendPreference ?? 'in-process',
      errorMessage: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
    };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// CLI Command Builder
// ────────────────────────────────────────────────────────────────────────────

/**
 * Build the full CLI command (as an argv array) to launch a clow agent
 * for the given spawn request.
 */
export function buildCliwCommand(request: SpawnRequest): string[] {
  const args: string[] = ['clow'];

  // Agent identity
  args.push('--agent-id', `${request.memberName}@${request.teamName}`);
  args.push('--team-name', request.teamName);

  // Model override
  if (request.model) {
    args.push('--model', request.model);
  }

  // Plan mode
  if (request.planModeRequired) {
    args.push('--permission-mode', 'plan');
  }

  // Initial prompt (passed via --prompt or as trailing argument)
  if (request.prompt) {
    args.push('--prompt', request.prompt);
  }

  return args;
}

// ────────────────────────────────────────────────────────────────────────────
// Progress tracking helper
// ────────────────────────────────────────────────────────────────────────────

export interface SpawnProgress {
  phase: string;
  detail?: string;
  elapsedMs: number;
}

export function reportProgress(
  phase: string,
  startTime: number,
  detail?: string,
): SpawnProgress {
  return {
    phase,
    detail,
    elapsedMs: Date.now() - startTime,
  };
}
