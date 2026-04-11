/**
 * BashTool — Shell Command Execution
 *
 * Based on Claude Code's BashTool.tsx (1,144 lines)
 * Handles: command validation, classification, execution via child_process,
 * CWD tracking, progress reporting, backgrounding
 */

import { z } from 'zod';
import { buildTool, type ToolResult, type ToolUseContext } from '../Tool.js';
import { execSync, spawn } from 'child_process';
import { getCwd, setCwd } from '../../bootstrap/state.js';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

// ─── Command Classification ─────────────────────────────────────────────────

const BASH_SEARCH_COMMANDS = new Set(['find', 'grep', 'rg', 'ag', 'fd', 'locate']);
const BASH_READ_COMMANDS = new Set(['cat', 'head', 'tail', 'jq', 'awk', 'less', 'more', 'wc', 'sort', 'uniq']);
const BASH_SILENT_COMMANDS = new Set(['mv', 'cp', 'rm', 'mkdir', 'rmdir', 'touch', 'chmod', 'chown']);
const BASH_SEMANTIC_NEUTRAL = new Set(['echo', 'printf', 'true', 'false', 'test']);

const READ_ONLY_COMMANDS = new Set([
  ...BASH_SEARCH_COMMANDS,
  ...BASH_READ_COMMANDS,
  'ls', 'dir', 'pwd', 'which', 'whereis', 'whoami', 'date', 'uptime',
  'df', 'du', 'free', 'env', 'printenv', 'uname', 'hostname',
  'git status', 'git log', 'git diff', 'git branch', 'git show',
  'node --version', 'npm --version', 'python --version',
  'type', 'file', 'stat', 'realpath', 'readlink',
]);

function getFirstCommand(command: string): string {
  // Strip leading env vars, sudo, time, etc.
  const stripped = command
    .replace(/^(\s*(sudo|time|nice|nohup|env)\s+)*/, '')
    .replace(/^[A-Z_]+=\S+\s+/, '')
    .trim();
  const first = stripped.split(/[\s|;&]/)[0] || '';
  return first.replace(/^['"]|['"]$/g, '');
}

function isReadOnlyCommand(command: string): boolean {
  const first = getFirstCommand(command);
  if (READ_ONLY_COMMANDS.has(first)) return true;
  if (READ_ONLY_COMMANDS.has(command.trim())) return true;
  // ls variants
  if (first === 'ls' || first === 'dir') return true;
  // git read-only
  if (command.trim().startsWith('git status') ||
      command.trim().startsWith('git log') ||
      command.trim().startsWith('git diff') ||
      command.trim().startsWith('git branch') ||
      command.trim().startsWith('git show') ||
      command.trim().startsWith('git remote -v')) return true;
  return false;
}

// ─── Input Schema ───────────────────────────────────────────────────────────

const BashInputSchema = z.object({
  command: z.string().describe('The bash command to execute'),
  timeout: z.number().optional().describe('Optional timeout in milliseconds (max 600000)'),
  description: z.string().optional().describe('Description of what the command does'),
});

type BashInput = z.infer<typeof BashInputSchema>;

// ─── Shell Execution ────────────────────────────────────────────────────────

async function runShellCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
  return new Promise((resolve) => {
    const isWindows = process.platform === 'win32';
    const shell = isWindows ? 'cmd.exe' : findShell();
    const shellArgs = isWindows ? ['/c', command] : ['-c', command];

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killed = false;

    const child = spawn(shell, shellArgs, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CLOW: '1' },
      windowsHide: true,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killed = true;
      try {
        child.kill('SIGKILL');
      } catch {}
    }, timeoutMs);

    if (signal) {
      signal.addEventListener('abort', () => {
        killed = true;
        try {
          child.kill('SIGKILL');
        } catch {}
      });
    }

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr: stderr || err.message,
        exitCode: 1,
        timedOut,
      });
    });

    child.on('exit', (code) => {
      clearTimeout(timer);

      // CWD tracking: detect if command changed directory
      if (!killed) {
        try {
          const pwdCmd = isWindows ? 'cd' : 'pwd -P';
          const newCwd = execSync(pwdCmd, {
            cwd,
            encoding: 'utf8',
            timeout: 2000,
          }).trim();
          if (newCwd && newCwd !== cwd) {
            setCwd(newCwd, cwd);
          }
        } catch {
          // Ignore CWD detection failures
        }
      }

      resolve({
        stdout,
        stderr,
        exitCode: code ?? (killed ? 137 : 1),
        timedOut,
      });
    });
  });
}

function findShell(): string {
  // Only bash and zsh are supported (matching Claude Code's design)
  const shellEnv = process.env.CLAUDE_CODE_SHELL || process.env.SHELL;
  if (shellEnv) {
    const base = path.basename(shellEnv);
    if (base === 'bash' || base === 'zsh') return shellEnv;
  }
  // Probe
  for (const candidate of ['/bin/bash', '/usr/bin/bash', '/bin/zsh', '/usr/bin/zsh']) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  // Windows fallback
  if (process.platform === 'win32') {
    // Try git bash
    const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
    try {
      fs.accessSync(gitBash, fs.constants.X_OK);
      return gitBash;
    } catch {}
    return 'bash';
  }
  return '/bin/sh';
}

// ─── The Tool ───────────────────────────────────────────────────────────────

export const BashTool = buildTool<BashInput>({
  name: 'Bash',
  description: `Execute a bash command. The working directory persists between commands.
Use this for system commands, running tests, installing packages, git operations.
Avoid using this for file reading (use Read), editing (use Edit), searching (use Grep/Glob).
Commands timeout after 120 seconds by default.`,
  inputSchema: BashInputSchema,

  isReadOnly(input: BashInput): boolean {
    return isReadOnlyCommand(input.command);
  },

  isConcurrencySafe(input: BashInput): boolean {
    return isReadOnlyCommand(input.command);
  },

  async checkPermissions(input: BashInput) {
    // Read-only commands auto-allow
    if (isReadOnlyCommand(input.command)) {
      return { behavior: 'allow' as const, updatedInput: input };
    }
    return { behavior: 'ask' as const, message: `Run command: ${input.command}` };
  },

  async call(
    input: BashInput,
    context: ToolUseContext,
  ): Promise<ToolResult> {
    const command = input.command.trim();

    if (!command) {
      return {
        output: '',
        outputText: 'Error: empty command',
        isError: true,
      };
    }

    // Validate: block long sleep commands
    if (/sleep\s+(\d+)/.test(command)) {
      const seconds = parseInt(RegExp.$1, 10);
      if (seconds > 10) {
        return {
          output: '',
          outputText: `Error: sleep commands > 10s are blocked. Use timeout parameter instead.`,
          isError: true,
        };
      }
    }

    const cwd = context.cwd || getCwd();
    const timeoutMs = input.timeout || 120_000;

    const result = await runShellCommand(command, cwd, timeoutMs, context.abortSignal);

    // Format output
    let outputText = '';
    if (result.stdout) outputText += result.stdout;
    if (result.stderr) outputText += (outputText ? '\n' : '') + result.stderr;
    if (result.timedOut) outputText += '\n[Command timed out]';
    if (!outputText && result.exitCode === 0) {
      // Silent commands
      const first = getFirstCommand(command);
      outputText = BASH_SILENT_COMMANDS.has(first) ? 'Done' : '(No output)';
    }

    // Truncate very long output
    const MAX_OUTPUT = 50_000;
    if (outputText.length > MAX_OUTPUT) {
      const half = Math.floor(MAX_OUTPUT / 2);
      outputText = outputText.slice(0, half) +
        `\n\n... [${outputText.length - MAX_OUTPUT} characters truncated] ...\n\n` +
        outputText.slice(-half);
    }

    return {
      output: {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
      },
      outputText: result.exitCode !== 0
        ? `Exit code ${result.exitCode}\n${outputText}`
        : outputText,
      isError: result.exitCode !== 0,
    };
  },
});
