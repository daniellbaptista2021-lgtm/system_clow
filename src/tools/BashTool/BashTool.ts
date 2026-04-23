/**
 * BashTool.ts — Full implementation with persistent shell, background, classification, sandbox
 *
 * Integrates: PersistentShell, BackgroundProcessManager, CommandClassifier,
 * CommandValidator, OutputProcessor, SandboxRunner
 */

import { z } from 'zod';
import { spawn } from 'child_process';
import {
  buildTool, type ToolResult, type ToolUseContext,
  type ValidationResult, type RenderOptions,
} from '../Tool.js';
import { PersistentShell } from './persistentShell.js';
import { BackgroundProcessManager } from './backgroundProcessManager.js';
import { CommandClassifier } from './commandClassifier.js';
import { CommandValidator } from './commandValidator.js';
import { OutputProcessor } from './outputProcessor.js';
import { SandboxRunner } from './sandboxRunner.js';
import { DEFAULT_TIMEOUT_MS } from './constants.js';

// ─── Shared instances (per-session via registry) ────────────────────────────

const classifier = new CommandClassifier();
const shellRegistry = new Map<string, PersistentShell>();
const bgRegistry = new Map<string, BackgroundProcessManager>();

function getShell(sessionId: string, cwd: string): PersistentShell {
  let shell = shellRegistry.get(sessionId);
  if (!shell || !shell.isAlive()) {
    shell = new PersistentShell({ cwd });
    shellRegistry.set(sessionId, shell);
  }
  return shell;
}

function getBgManager(sessionId: string, cwd: string): BackgroundProcessManager {
  let mgr = bgRegistry.get(sessionId);
  if (!mgr) {
    mgr = new BackgroundProcessManager(cwd);
    bgRegistry.set(sessionId, mgr);
  }
  return mgr;
}

async function runOneShotCommand(
  command: string,
  opts: { cwd: string; timeoutMs: number },
): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
}> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn('/usr/bin/bash', ['-lc', command], {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({
        stdout,
        stderr: `${stderr}\n[timed out]`.trim(),
        exitCode: 124,
        durationMs: Date.now() - startedAt,
        timedOut: true,
      });
    }, opts.timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout: stdout.replace(/\n$/, ''),
        stderr: stderr.replace(/\n$/, ''),
        exitCode: code ?? 1,
        durationMs: Date.now() - startedAt,
        timedOut: false,
      });
    });
  });
}

// ─── Input Schema ───────────────────────────────────────────────────────────

const BashInputSchema = z.object({
  command: z.string().describe('The bash command to execute'),
  timeout: z.number().optional().describe('Timeout in milliseconds (max 1800000)'),
  description: z.string().optional().describe('Description of what the command does'),
  run_in_background: z.boolean().optional().describe('Run in background, return immediately'),
});

type BashInput = z.infer<typeof BashInputSchema>;

// ─── The Tool ───────────────────────────────────────────────────────────────

export const BashTool = buildTool<BashInput>({
  name: 'Bash',
  aliases: ['BashTool', 'Shell'],
  searchHint: 'shell command terminal execute run',
  description: `Execute a bash command in a persistent shell session.
The shell maintains state between calls (cwd, environment variables, aliases).
For long-running processes, use run_in_background: true.
Commands timeout after 120 seconds by default.`,
  inputSchema: BashInputSchema,

  // ── Identity ──────────────────────────────────────────────────────────
  userFacingName(input?: BashInput): string {
    if (!input) return 'Bash';
    const first = input.command.trim().split(/\s+/)[0];
    return first ? `Bash(${first})` : 'Bash';
  },

  // ── Input-dependent behavioral flags ──────────────────────────────────
  isReadOnly(input: BashInput): boolean {
    return classifier.isReadOnly(input.command);
  },

  isConcurrencySafe(input: BashInput): boolean {
    return classifier.isReadOnly(input.command);
  },

  isDestructive(input: BashInput): boolean {
    return classifier.isDestructive(input.command);
  },

  interruptBehavior() { return 'cancel' as const; },

  // ── Validation (before permission) ────────────────────────────────────
  async validateInput(input: BashInput, _ctx: ToolUseContext): Promise<ValidationResult> {
    const v = CommandValidator.validate(input.command);
    if (!v.valid) return { valid: false, message: v.reason, errorCode: v.code };

    const isMultiTenantContext = Boolean(_ctx.tenantId && _ctx.tenantId !== 'default' && _ctx.workspaceRoot);
    if (isMultiTenantContext) {
      // TENANT: bloqueia tudo (usuario comum nunca roda bash no servidor)
      return {
        valid: false,
        message: 'Essas operacoes sao exclusivas do administrador do sistema. Posso te ajudar com outras tarefas — criar sites, apps, planilhas, debug de codigo, consultas, relatorios.',
        errorCode: 'BASH_NOT_ALLOWED_FOR_USER',
      };
    }

    // ADMIN: requer senha destravada na sessao (NUNCA persiste entre sessoes)
    try {
      const { isSessionUnlocked } = await import('../../auth/adminUnlock.js');
      if (!isSessionUnlocked(_ctx.sessionId)) {
        return {
          valid: false,
          message: 'Pra rodar comandos no servidor preciso da senha admin. Me envie na proxima mensagem (sem nada alem dela). A senha nao fica salva — cada conversa nova exige verificacao novamente.',
          errorCode: 'ADMIN_PASSWORD_REQUIRED',
        };
      }
    } catch (err: any) {
      // Se o modulo falhou por qualquer motivo, fail-closed
      return {
        valid: false,
        message: 'Erro ao verificar destravamento admin: ' + (err?.message || 'desconhecido'),
        errorCode: 'ADMIN_UNLOCK_CHECK_FAILED',
      };
    }

    return { valid: true };
  },

  // ── Permission matching ───────────────────────────────────────────────
  async preparePermissionMatcher(input: BashInput) {
    const command = input.command.trim();
    const firstWord = command.split(/\s+/)[0];
    return (pattern: string): boolean => {
      if (pattern === '*') return true;
      if (pattern.endsWith(' *')) {
        const prefix = pattern.slice(0, -2);
        return command === prefix || command.startsWith(prefix + ' ');
      }
      if (pattern.includes(' ') && !pattern.endsWith('*')) {
        return command === pattern || command.startsWith(pattern + ' ');
      }
      return command === pattern || firstWord === pattern;
    };
  },

  toAutoClassifierInput(input: BashInput): string { return input.command; },

  // ── Permissions ───────────────────────────────────────────────────────
  async checkPermissions(input: BashInput) {
    if (classifier.isReadOnly(input.command)) {
      return { behavior: 'allow' as const, updatedInput: input };
    }
    return { behavior: 'ask' as const, message: `Run: ${input.command}` };
  },

  // ── Rendering ─────────────────────────────────────────────────────────
  renderToolUseMessage(input: BashInput, options: RenderOptions): string {
    const cmd = options.verbose
      ? input.command
      : (input.command.length > 80 ? input.command.slice(0, 77) + '...' : input.command);
    const prefix = input.run_in_background ? '⚡bg' : 'bash>';
    return `${prefix} ${cmd}`;
  },

  renderToolUseRejectedMessage(input: BashInput, reason: string, _opts: RenderOptions): string {
    return `🚫 bash> ${input.command.slice(0, 60)}\n   ${reason}`;
  },

  // ── Execution ─────────────────────────────────────────────────────────
  async call(input: BashInput, context: ToolUseContext): Promise<ToolResult> {
    const command = input.command.trim();
    if (!command) return { output: '', outputText: 'Error: empty command', isError: true };

    const cwd = context.cwd;
    const workspaceRoot = context.workspaceRoot || context.cwd;
    const sessionId = context.sessionId || 'default';
    const timeoutMs = input.timeout || DEFAULT_TIMEOUT_MS;
    const isMultiTenantContext = Boolean(context.tenantId && context.workspaceRoot);
    const sandboxBackend = isMultiTenantContext ? SandboxRunner.detect() : 'none';
    const commandToRun = isMultiTenantContext
      ? SandboxRunner.wrap(command, sandboxBackend, {
        workspaceRoot,
        allowNetwork: false,
        timeoutMs,
      })
      : command;

    // ── Background mode ─────────────────────────────────────────────
    if (input.run_in_background) {
      const mgr = getBgManager(sessionId, cwd);
      const bg = mgr.start(commandToRun, { cwd });
      return {
        output: { background: true, id: bg.id, pid: bg.pid },
        outputText: `Background process started: ${bg.id} (pid ${bg.pid})\nUse Bash to check: cat ${bg.stdoutFile}`,
      };
    }

    // ── Foreground via persistent shell ──────────────────────────────
    if (isMultiTenantContext) {
      try {
        const result = await runOneShotCommand(commandToRun, { cwd, timeoutMs });
        const processed = OutputProcessor.process(
          result.stdout + (result.stderr ? '\n' + result.stderr : ''),
        );

        let outputText = processed.output;
        if (result.timedOut) outputText += '\n[Command timed out]';
        if (!outputText.trim() && result.exitCode === 0) outputText = '(No output)';
        if (processed.truncated) {
          outputText += `\n[Output truncated. Original: ${processed.originalLength} chars]`;
        }

        return {
          output: {
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            durationMs: result.durationMs,
          },
          outputText: result.exitCode !== 0
            ? `Exit code ${result.exitCode}\n${outputText}`
            : outputText,
          isError: result.exitCode !== 0,
          metadata: { durationMs: result.durationMs },
        };
      } catch (err: any) {
        return { output: null, outputText: `Shell error: ${err.message}`, isError: true };
      }
    }

    const shell = getShell(sessionId, cwd);
    if (!shell.isAlive()) {
      try {
        await shell.start();
      } catch (err: any) {
        return { output: null, outputText: `Shell start failed: ${err.message}`, isError: true };
      }
    }

    try {
      const result = await shell.exec(commandToRun, { timeoutMs });
      const processed = OutputProcessor.process(
        result.stdout + (result.stderr ? '\n' + result.stderr : ''),
      );

      let outputText = processed.output;
      if (result.timedOut) outputText += '\n[Command timed out]';
      if (!outputText.trim() && result.exitCode === 0) outputText = '(No output)';
      if (processed.truncated) {
        outputText += `\n[Output truncated. Original: ${processed.originalLength} chars]`;
      }

      return {
        output: {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          durationMs: result.durationMs,
        },
        outputText: result.exitCode !== 0
          ? `Exit code ${result.exitCode}\n${outputText}`
          : outputText,
        isError: result.exitCode !== 0,
        metadata: { durationMs: result.durationMs },
      };
    } catch (err: any) {
      return { output: null, outputText: `Shell error: ${err.message}`, isError: true };
    }
  },
});

// ─── Session Cleanup ────────────────────────────────────────────────────────

export function cleanupBashSession(sessionId: string): void {
  const shell = shellRegistry.get(sessionId);
  if (shell) { shell.stop().catch(() => {}); shellRegistry.delete(sessionId); }
  bgRegistry.delete(sessionId);
}

// ─── Re-exports for tests ───────────────────────────────────────────────────

export { CommandClassifier } from './commandClassifier.js';
export { CommandValidator } from './commandValidator.js';
export { OutputProcessor } from './outputProcessor.js';
export { PersistentShell } from './persistentShell.js';
export { BackgroundProcessManager } from './backgroundProcessManager.js';
export { SandboxRunner } from './sandboxRunner.js';
