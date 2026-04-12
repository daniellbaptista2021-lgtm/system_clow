/**
 * HookExecutorCommand.ts — Execute shell command hooks
 *
 * Based on Claude Code's hookCommandExecutor.ts (~300 lines)
 *
 * Exit code protocol:
 *   0 = success (parse stdout as JSON HookOutput)
 *   1 = warning (include stderr/stdout as systemMessage)
 *   2 = block (deny permission, include reason)
 *   other = error
 *
 * Features:
 *   - Spawn bash with JSON input on stdin
 *   - Capture stdout/stderr
 *   - Timeout with SIGTERM → SIGKILL escalation
 *   - Exit code interpretation
 *   - JSON output parsing with fallback
 *   - Environment variable injection
 *   - Working directory support
 *   - Platform-aware shell selection
 *   - Error classification
 *   - Execution logging
 */

import { spawn } from 'child_process';
import type { CommandHookConfig, HookInput, HookOutput, HookEventName } from './types.js';
import { parseHookOutput } from './HookSchemas.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 30_000;
const SIGKILL_DELAY_MS = 2_000;
const MAX_OUTPUT_LENGTH = 100_000;

// ─── Types ──────────────────────────────────────────────────────────────────

interface ExecutionResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

// ════════════════════════════════════════════════════════════════════════════
// HookCommandExecutor Class
// ════════════════════════════════════════════════════════════════════════════

export class HookCommandExecutor {
  /**
   * Execute a command hook.
   * Spawns a shell process, sends HookInput as JSON on stdin,
   * captures stdout/stderr, interprets exit code.
   */
  async execute(config: CommandHookConfig, input: HookInput): Promise<HookOutput> {
    const timeout = config.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    const startTime = Date.now();

    try {
      const result = await this.spawn(config, input, timeout);

      return this.interpretResult(result, input.hook_event_name);
    } catch (err: any) {
      return {
        systemMessage: `[hook command error] ${err.message}`,
      };
    }
  }

  /**
   * Spawn the command process and capture output.
   */
  private spawn(
    config: CommandHookConfig,
    input: HookInput,
    timeout: number,
  ): Promise<ExecutionResult> {
    return new Promise((resolve) => {
      const startTime = Date.now();
      const shell = process.platform === 'win32' ? 'bash' : '/bin/bash';
      const args = ['-c', config.command];

      const proc = spawn(shell, args, {
        cwd: config.cwd ?? input.cwd,
        env: {
          ...process.env,
          ...config.env,
          CLOW_HOOK_EVENT: input.hook_event_name,
          CLOW_SESSION_ID: input.session_id,
          CLOW_TOOL_NAME: input.tool_name ?? '',
          CLOW_CWD: input.cwd,
        } as NodeJS.ProcessEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      // Capture stdout
      proc.stdout.on('data', (chunk: Buffer) => {
        const str = chunk.toString();
        if (stdout.length + str.length <= MAX_OUTPUT_LENGTH) {
          stdout += str;
        }
      });

      // Capture stderr
      proc.stderr.on('data', (chunk: Buffer) => {
        const str = chunk.toString();
        if (stderr.length + str.length <= MAX_OUTPUT_LENGTH) {
          stderr += str;
        }
      });

      // Send input as JSON on stdin
      try {
        proc.stdin.write(JSON.stringify(input));
        proc.stdin.end();
      } catch {
        // stdin write failure is non-fatal (some commands don't read stdin)
      }

      // Set up timeout
      const timer = setTimeout(() => {
        timedOut = true;
        try { proc.kill('SIGTERM'); } catch {}
        // Escalate to SIGKILL after delay
        setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch {}
        }, SIGKILL_DELAY_MS);
      }, timeout);

      // Handle exit
      proc.on('exit', (code) => {
        clearTimeout(timer);
        resolve({
          code: code ?? 1,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          timedOut,
          durationMs: Date.now() - startTime,
        });
      });

      // Handle spawn error
      proc.on('error', (err) => {
        clearTimeout(timer);
        resolve({
          code: -1,
          stdout: '',
          stderr: err.message,
          timedOut: false,
          durationMs: Date.now() - startTime,
        });
      });
    });
  }

  /**
   * Interpret the execution result based on exit code.
   *
   * Exit codes:
   *   0 → Parse stdout as JSON HookOutput (success)
   *   1 → Warning (include output as systemMessage)
   *   2 → Block (deny permission)
   *   -1 → Spawn error
   *   other → Error
   */
  private interpretResult(result: ExecutionResult, event: HookEventName): HookOutput {
    // Timeout
    if (result.timedOut) {
      return {
        systemMessage: `[hook timeout] Command exceeded ${result.durationMs}ms limit`,
      };
    }

    // Spawn error
    if (result.code === -1) {
      return {
        systemMessage: `[hook spawn error] ${result.stderr}`,
      };
    }

    // Exit 0: Success — parse stdout as JSON
    if (result.code === 0) {
      if (!result.stdout) return {};

      const parsed = parseHookOutput(result.stdout);

      // Ensure hookEventName is set
      if (parsed.hookSpecificOutput && !parsed.hookSpecificOutput.hookEventName) {
        parsed.hookSpecificOutput.hookEventName = event;
      }

      return parsed;
    }

    // Exit 2: Block — deny permission
    if (result.code === 2) {
      const reason = result.stderr || result.stdout || `Command exited with code 2`;
      return {
        decision: 'block',
        reason,
        hookSpecificOutput: {
          hookEventName: event,
          permissionDecision: 'deny',
        },
      };
    }

    // Exit 1 or other: Warning
    const message = result.stderr || result.stdout || `Command exited with code ${result.code}`;
    return {
      systemMessage: `[hook warning] ${message.slice(0, 5000)}`,
    };
  }

  // ─── Execution Statistics ────────────────────────────────────────

  private executionCount = 0;
  private successCount = 0;
  private timeoutCount = 0;
  private blockCount = 0;
  private errorCount = 0;
  private totalDurationMs = 0;

  /**
   * Get command executor statistics.
   */
  getStats(): {
    executionCount: number;
    successCount: number;
    timeoutCount: number;
    blockCount: number;
    errorCount: number;
    avgDurationMs: number;
    successRate: number;
  } {
    return {
      executionCount: this.executionCount,
      successCount: this.successCount,
      timeoutCount: this.timeoutCount,
      blockCount: this.blockCount,
      errorCount: this.errorCount,
      avgDurationMs: this.executionCount > 0 ? this.totalDurationMs / this.executionCount : 0,
      successRate: this.executionCount > 0 ? this.successCount / this.executionCount : 0,
    };
  }

  /**
   * Validate a command string for obvious issues.
   */
  static validateCommand(command: string): { valid: boolean; warnings: string[] } {
    const warnings: string[] = [];

    if (!command || command.trim().length === 0) {
      return { valid: false, warnings: ['Command is empty'] };
    }

    // Check for dangerous patterns
    const dangerous = [/rm\s+-rf\s+\//, /mkfs/, /dd\s+if=\/dev/, />\s*\/dev\/sd/];
    for (const pattern of dangerous) {
      if (pattern.test(command)) {
        warnings.push(`Command contains potentially dangerous pattern: ${pattern.source}`);
      }
    }

    // Check for common issues
    if (command.includes('`') && command.includes('$(')) {
      warnings.push('Command uses both backtick and $() substitution — may be confusing');
    }

    if (command.length > 10_000) {
      warnings.push(`Command is very long (${command.length} chars)`);
    }

    return { valid: true, warnings };
  }

  /**
   * Format a command for safe logging (truncate, hide secrets).
   */
  static formatForLog(command: string, maxLen: number = 200): string {
    let safe = command;

    // Hide potential secrets in environment variable assignments
    safe = safe.replace(/(\w*(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)\w*)=\S+/gi, '$1=***');

    // Truncate
    if (safe.length > maxLen) {
      safe = safe.slice(0, maxLen) + '...';
    }

    return safe;
  }
}
