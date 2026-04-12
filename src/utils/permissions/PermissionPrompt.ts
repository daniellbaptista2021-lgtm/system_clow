/**
 * PermissionPrompt.ts — Interactive CLI permission prompt
 * Shows 4+ options: allow once, allow always (session), deny, deny always
 * Plus pattern-based options from tool's preparePermissionMatcher.
 */

import * as readline from 'readline';
import * as pathLib from 'path';
import { randomUUID } from 'crypto';
import type { Tool } from '../../tools/Tool.js';
import type { PermissionRule, PermissionPromptOption, PromptResult, PermissionDecision } from './types.js';
import type { PermissionContext } from './PermissionContext.js';

export class PermissionPrompt {

  async ask(params: {
    tool: Tool;
    input: unknown;
    context: PermissionContext;
    message?: string;
  }): Promise<PromptResult> {
    // Non-interactive mode: auto-deny
    if (!params.context.isInteractive) {
      return { decision: 'deny', remember: false };
    }

    const options = this.buildOptions(params.tool, params.input);
    const display = this.render(params.tool, params.input, params.message);

    process.stderr.write(display);
    const optionLines = options.map((o) => `  [${o.key}] ${o.label}`).join('\n');
    process.stderr.write(optionLines + '\n  > ');

    const choice = await this.readLine();
    return this.interpretChoice(choice, options, params);
  }

  private buildOptions(tool: Tool, input: unknown): PermissionPromptOption[] {
    const options: PermissionPromptOption[] = [
      { key: 'a', label: 'Allow once', decision: 'allow' },
      { key: 'A', label: 'Allow always (this session)', decision: 'allow', persistAs: 'session' },
      { key: 'd', label: 'Deny', decision: 'deny' },
      { key: 'D', label: 'Deny always (this session)', decision: 'deny', persistAs: 'session' },
    ];

    // Pattern-based options
    const pattern = this.suggestPattern(tool, input);
    if (pattern) {
      options.push(
        { key: 'w', label: `Allow "${pattern}" always (workspace)`, decision: 'allow', persistAs: 'workspace', pattern },
      );
    }

    return options;
  }

  private suggestPattern(tool: Tool, input: unknown): string | null {
    if (tool.name === 'Bash') {
      const cmd = (input as any)?.command as string;
      if (!cmd) return null;
      const first = cmd.trim().split(/\s+/)[0];
      return first ? `${first} *` : null;
    }
    if (tool.name === 'FileWrite' || tool.name === 'FileEdit' || tool.name === 'Write' || tool.name === 'Edit') {
      const fp = (input as any)?.file_path as string;
      if (!fp) return null;
      const ext = pathLib.extname(fp);
      return ext ? `*${ext}` : null;
    }
    return null;
  }

  private render(tool: Tool, input: unknown, message?: string): string {
    const toolMsg = tool.renderToolUseMessage(input, { verbose: true, width: 60, isInteractive: true });
    return `\n  ╭─ Permission Required ────────────────────╮\n` +
           `  │ ${tool.userFacingName(input).padEnd(42)}│\n` +
           `  │ ${(message || toolMsg).slice(0, 42).padEnd(42)}│\n` +
           `  ╰───────────────────────────────────────────╯\n`;
  }

  private async readLine(): Promise<string> {
    return new Promise((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: false });
      rl.on('line', (line) => { rl.close(); resolve(line.trim()); });
      setTimeout(() => { rl.close(); resolve('d'); }, 5 * 60_000); // 5 min timeout → deny
    });
  }

  private interpretChoice(
    choice: string,
    options: PermissionPromptOption[],
    params: { tool: Tool; input: unknown; context: PermissionContext },
  ): PromptResult {
    const option = options.find((o) => o.key === choice);

    if (!option) {
      // Default: deny
      return { decision: 'deny', remember: false };
    }

    let persistRule: PermissionRule | undefined;
    if (option.persistAs) {
      persistRule = {
        id: randomUUID(),
        toolName: params.tool.name,
        pattern: option.pattern,
        decision: option.decision,
        scope: option.persistAs,
        source: 'user',
        createdAt: Date.now(),
        reason: 'User chose via interactive prompt',
      };
    }

    return {
      decision: option.decision,
      persistRule,
      remember: Boolean(option.persistAs),
    };
  }
}
