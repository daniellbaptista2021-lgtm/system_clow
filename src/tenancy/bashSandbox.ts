/**
 * bashSandbox.ts — Bash command validation for multi-tenant safety
 *
 * Regular users get sandboxed Bash:
 *   - Commands restricted to whitelist
 *   - Dangerous patterns blocked
 *   - Execution locked to tenant workspace
 *
 * Admin users: unrestricted.
 */

// ════════════════════════════════════════════════════════════════════════════
// Configuration
// ════════════════════════════════════════════════════════════════════════════

/** Commands allowed for regular users */
const ALLOWED_COMMANDS = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'sort', 'uniq', 'tr', 'cut', 'paste',
  'grep', 'find', 'echo', 'printf', 'date', 'pwd', 'which', 'whoami',
  'node', 'npm', 'npx', 'python', 'python3', 'pip', 'pip3',
  'git', 'curl', 'wget',
  'mkdir', 'cp', 'mv', 'touch', 'rm', 'chmod',
  'tar', 'zip', 'unzip', 'gzip', 'gunzip',
  'jq', 'sed', 'awk', 'diff', 'tee', 'xargs',
  'tsc', 'tsx', 'bun', 'deno',
]);

/** Patterns that are ALWAYS blocked for regular users */
const BLOCKED_PATTERNS = [
  // System control
  /\bpm2\b/i,
  /\bsystemctl\b/i,
  /\bservice\b/i,
  /\bsudo\b/i,
  /\bsu\b\s/,
  /\bkill\b/,
  /\bkillall\b/i,
  /\bpkill\b/i,
  /\breboot\b/i,
  /\bshutdown\b/i,
  /\binit\b\s+\d/,

  // Environment / secrets
  /\bexport\b/,
  /\benv\b(?!\s)/,  // "env" standalone but not "environment"
  /\/etc\/(?!hostname)/,  // /etc/ except hostname
  /\.env\b/,
  /tenants\.json/i,
  /\.clow\//,
  /ANTHROPIC_API_KEY/i,
  /CLOW_ADMIN/i,
  /API_KEY/i,
  /SECRET/i,

  // Server code modification
  /src\/server\//,
  /src\/tenancy\//,
  /src\/hooks\//,
  /src\/api\//,
  /src\/utils\/context/,
  /dist\//,
  /package\.json/,
  /tsconfig/,
  /node_modules/,

  // Dangerous operations
  /rm\s+(-rf?|--recursive)\s+\//,  // rm -rf /
  />\s*\/dev\/sd/,                   // writing to devices
  /mkfs/i,
  /dd\s+if=/i,
  /chmod\s+777/,
  /chown/i,
  /chgrp/i,
  /\biptables\b/i,
  /\bufw\b/i,

  // Network abuse
  /nc\s+-l/i,     // netcat listener
  /nmap\b/i,
  /ssh\b/i,
  /scp\b/i,
  /rsync\b/i,

  // Process/system info leakage
  /\/proc\//,
  /\/sys\//,
  /\/root\//,
  /\/home\/(?!clow)/,
  /passwd/i,
  /shadow/i,
];

/** Paths that are always blocked */
const BLOCKED_PATHS = [
  '/etc/',
  '/root/',
  '/opt/system-clow/src/',
  '/opt/system-clow/dist/',
  '/opt/system-clow/.env',
  '/opt/system-clow/package.json',
];

// ════════════════════════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════════════════════════

export interface SandboxResult {
  allowed: boolean;
  reason?: string;
  sanitizedCommand?: string;
}

// ════════════════════════════════════════════════════════════════════════════
// Sandbox Validation
// ════════════════════════════════════════════════════════════════════════════

/**
 * Validate a Bash command for a regular (non-admin) user.
 * Returns { allowed: true } if safe, or { allowed: false, reason } if blocked.
 */
export function validateBashCommand(
  command: string,
  workspaceRoot: string,
  isAdmin: boolean = false,
): SandboxResult {
  // Admin: unrestricted
  if (isAdmin) return { allowed: true };

  const trimmed = command.trim();
  if (!trimmed) return { allowed: false, reason: 'Empty command' };

  // Check blocked patterns
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        allowed: false,
        reason: `Comando bloqueado por politica de seguranca: ${pattern.source.slice(0, 30)}`,
      };
    }
  }

  // Check blocked paths
  for (const blockedPath of BLOCKED_PATHS) {
    if (trimmed.includes(blockedPath)) {
      return {
        allowed: false,
        reason: `Acesso negado ao caminho: ${blockedPath}`,
      };
    }
  }

  // Extract first command (handle pipes, && , ||)
  const firstCmd = extractFirstCommand(trimmed);
  if (!firstCmd) return { allowed: false, reason: 'Comando nao reconhecido' };

  // Validate first command is in whitelist
  if (!ALLOWED_COMMANDS.has(firstCmd)) {
    return {
      allowed: false,
      reason: `Comando "${firstCmd}" nao esta na lista de comandos permitidos`,
    };
  }

  // Validate all piped/chained commands
  const allCmds = extractAllCommands(trimmed);
  for (const cmd of allCmds) {
    if (!ALLOWED_COMMANDS.has(cmd)) {
      return {
        allowed: false,
        reason: `Comando "${cmd}" nao esta na lista de comandos permitidos`,
      };
    }
  }

  return { allowed: true, sanitizedCommand: trimmed };
}

/**
 * Get the working directory for a tenant's Bash execution.
 * Always forces execution within the tenant's workspace.
 */
export function getTenantWorkspaceDir(tenantId: string): string {
  return `/opt/clow-workspaces/${sanitizeTenantId(tenantId)}`;
}

// ════════════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════════════

function extractFirstCommand(cmd: string): string | null {
  // Remove leading env vars (VAR=val command)
  const withoutEnv = cmd.replace(/^(\w+=\S+\s+)+/, '');
  // Get first word
  const match = withoutEnv.match(/^(\S+)/);
  if (!match) return null;
  // Remove path prefix (e.g., /usr/bin/ls → ls)
  return match[1].split('/').pop() || null;
}

function extractAllCommands(cmd: string): string[] {
  // Split by pipe, &&, ||, ;
  const parts = cmd.split(/\s*(?:\|{1,2}|&&|;)\s*/);
  const commands: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const first = extractFirstCommand(trimmed);
    if (first) commands.push(first);
  }
  return commands;
}

function sanitizeTenantId(tenantId: string): string {
  return tenantId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'default';
}
