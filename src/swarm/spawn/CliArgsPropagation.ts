/**
 * CliArgsPropagation.ts — Build CLI arguments and env vars for spawned agents
 *
 * Ensures spawned teammate processes inherit the correct configuration
 * from the leader: permission mode, model, agent identity, team info,
 * and mailbox paths.
 */

import type { SpawnRequest } from '../types.js';

// ────────────────────────────────────────────────────────────────────────────
// CLI argument builder
// ────────────────────────────────────────────────────────────────────────────

/**
 * Build the CLI argument array for a spawned clow agent.
 *
 * Propagates:
 *   --permission-mode
 *   --model
 *   --agent-id
 *   --team-name
 */
export function buildArgs(
  member: { name: string; model?: string; planModeRequired?: boolean },
  teamName: string,
): string[] {
  const args: string[] = [];

  // Identity
  args.push('--agent-id', `${member.name}@${teamName}`);
  args.push('--team-name', teamName);

  // Permission mode
  if (member.planModeRequired) {
    args.push('--permission-mode', 'plan');
  }

  // Model override
  if (member.model) {
    args.push('--model', member.model);
  }

  return args;
}

// ────────────────────────────────────────────────────────────────────────────
// Environment variable builder
// ────────────────────────────────────────────────────────────────────────────

/**
 * Build environment variables for a spawned teammate process.
 *
 * Propagates:
 *   CLOW_TEAM          — team name
 *   CLOW_AGENT_ID      — full agent ID (name@team)
 *   CLOW_INBOX_DIR     — path to the agent's inbox directory
 *   CLOW_PANE_COLOR    — terminal pane colour
 */
export function buildEnvVars(
  request: SpawnRequest,
  options?: {
    inboxDir?: string;
    paneColor?: string;
  },
): Record<string, string> {
  const env: Record<string, string> = {
    CLOW_TEAM: request.teamName,
    CLOW_AGENT_ID: `${request.memberName}@${request.teamName}`,
  };

  if (options?.inboxDir) {
    env['CLOW_INBOX_DIR'] = options.inboxDir;
  }

  if (options?.paneColor) {
    env['CLOW_PANE_COLOR'] = options.paneColor;
  }

  return env;
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * Merge parent environment with overrides for the child process.
 */
export function mergeEnv(
  overrides: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) {
      env[k] = v;
    }
  }
  return { ...env, ...overrides };
}
