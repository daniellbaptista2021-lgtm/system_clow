#!/usr/bin/env node

/**
 * cli.ts — System Clow Entry Point
 *
 * Based on Claude Code's cli.tsx (303 lines) + main.tsx (4,500+ lines)
 *
 * Startup sequence:
 * Phase 0: Fast-path cascade (--version, --help)
 * Phase 1: Load config and env
 * Phase 2: Initialize API client
 * Phase 3: Start REPL loop
 */

import { config as loadEnv } from 'dotenv';
import { Command } from 'commander';
import chalk from 'chalk';
import * as readline from 'readline';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';

import { initDeepSeek } from './api/deepseek.js';
import { QueryEngine } from './query/QueryEngine.js';
import { getTools } from './tools/tools.js';
import { assembleFullContext, getGitStatus } from './utils/context/context.js';
import { createCanUseTool, type PermissionContext } from './utils/permissions/permissions.js';
import { initSessionStorage, recordTranscript, flushSession } from './utils/session/sessionStorage.js';
import {
  setSessionId,
  setCwd,
  setOriginalCwd,
  setProjectRoot,
  getTotalCostUSD,
  getTotalInputTokens,
  getTotalOutputTokens,
  getSessionId,
  getCwd,
} from './bootstrap/state.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const VERSION = '1.0.0';
const PRODUCT_NAME = 'System Clow';

// ─── Banner ─────────────────────────────────────────────────────────────────

function printBanner(): void {
  console.log('');
  console.log(chalk.bold.cyan('  ╔═══════════════════════════════════════╗'));
  console.log(chalk.bold.cyan('  ║') + chalk.bold.white('       System Clow v' + VERSION + '            ') + chalk.bold.cyan('║'));
  console.log(chalk.bold.cyan('  ║') + chalk.dim('    AI Coding Agent • DeepSeek V3.2   ') + chalk.bold.cyan('║'));
  console.log(chalk.bold.cyan('  ╚═══════════════════════════════════════╝'));
  console.log('');
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Phase 0: Fast paths
  const program = new Command();
  program
    .name('clow')
    .description('System Clow — AI-powered coding agent')
    .version(VERSION, '-v, --version')
    .option('-p, --print', 'Non-interactive: process single prompt and exit')
    .option('--cwd <dir>', 'Set working directory')
    .option('--model <model>', 'Override DeepSeek model')
    .option('--max-turns <n>', 'Maximum conversation turns', '50')
    .argument('[prompt]', 'Initial prompt (non-interactive mode)');

  program.parse(process.argv);
  const opts = program.opts();
  const args = program.args;

  // Phase 1: Load environment
  // Try multiple .env locations
  loadEnv({ path: path.resolve(process.cwd(), '.env') });
  loadEnv({ path: path.resolve(os.homedir(), '.clow', '.env') });

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    console.error(chalk.red('Error: DEEPSEEK_API_KEY not found.'));
    console.error(chalk.dim('Set it in .env file or as environment variable.'));
    process.exit(1);
  }

  // Phase 2: Initialize
  const cwd = opts.cwd ? path.resolve(opts.cwd) : process.cwd();
  setCwd(cwd);
  setOriginalCwd(cwd);
  setProjectRoot(cwd);
  setSessionId(randomUUID());

  initDeepSeek({
    apiKey,
    baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    model: opts.model || process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    maxOutputTokens: 8192,
  });

  await initSessionStorage();
  await getGitStatus(); // Populate git cache

  const tools = getTools();
  const systemPrompt = await assembleFullContext();

  const permContext: PermissionContext = {
    denyRules: [],
    allowRules: ['Read', 'Glob', 'Grep', 'TodoWrite'], // Read-only tools auto-allowed
    askRules: [],
  };

  const canUseTool = createCanUseTool(permContext);
  const maxTurns = parseInt(opts.maxTurns) || 50;

  // Phase 3: Execute
  if (opts.print && args[0]) {
    // Non-interactive mode
    await runSinglePrompt(args[0], tools, systemPrompt, canUseTool, maxTurns);
  } else if (args[0]) {
    // Interactive mode with initial prompt
    printBanner();
    await runREPL(tools, systemPrompt, canUseTool, maxTurns, args[0]);
  } else {
    // Interactive REPL
    printBanner();
    console.log(chalk.dim(`  Session: ${getSessionId().slice(0, 8)}`));
    console.log(chalk.dim(`  CWD: ${getCwd()}`));
    console.log(chalk.dim(`  Tools: ${tools.map((t) => t.name).join(', ')}`));
    console.log(chalk.dim(`  Type /help for commands, /exit to quit\n`));
    await runREPL(tools, systemPrompt, canUseTool, maxTurns);
  }
}

// ─── Single Prompt (--print mode) ───────────────────────────────────────────

async function runSinglePrompt(
  prompt: string,
  tools: any[],
  systemPrompt: string,
  canUseTool: any,
  maxTurns: number,
): Promise<void> {
  const engine = new QueryEngine({
    tools,
    systemPrompt,
    canUseTool,
    maxTurns,
    onText: (text) => process.stdout.write(text),
  });

  for await (const msg of engine.submitMessage(prompt)) {
    if (msg.type === 'result') {
      if (msg.subtype === 'error_during_execution') {
        console.error(chalk.red(`\nError: ${msg.content}`));
        process.exit(1);
      }
      break;
    }
  }

  await flushSession();
  console.log('');
}

// ─── Interactive REPL ───────────────────────────────────────────────────────

async function runREPL(
  tools: any[],
  systemPrompt: string,
  canUseTool: any,
  maxTurns: number,
  initialPrompt?: string,
): Promise<void> {
  const engine = new QueryEngine({
    tools,
    systemPrompt,
    canUseTool,
    maxTurns,
    onText: (text) => process.stdout.write(text),
    onToolUse: (name, input) => {
      console.log(chalk.dim(`\n  ▸ ${name}`));
    },
    onToolResult: (name, result) => {
      if (result.isError) {
        console.log(chalk.red(`  ✗ ${name}: error`));
      }
    },
    onTurnComplete: (turn) => {
      // Show cost after each turn
      const cost = getTotalCostUSD();
      if (cost > 0) {
        process.stderr.write(chalk.dim(`  [$${cost.toFixed(4)} | ${getTotalInputTokens()}in/${getTotalOutputTokens()}out]\n`));
      }
    },
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.cyan('\n❯ '),
  });

  // Handle initial prompt
  if (initialPrompt) {
    await processInput(engine, initialPrompt);
  }

  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();

    if (!input) {
      rl.prompt();
      return;
    }

    // Slash commands
    if (input.startsWith('/')) {
      const handled = await handleSlashCommand(input, engine);
      if (handled === 'exit') {
        await flushSession();
        rl.close();
        process.exit(0);
      }
      rl.prompt();
      return;
    }

    await processInput(engine, input);
    rl.prompt();
  });

  rl.on('close', async () => {
    await flushSession();
    console.log(chalk.dim('\nGoodbye!'));
    process.exit(0);
  });

  // Handle Ctrl+C gracefully
  process.on('SIGINT', async () => {
    engine.abort();
    console.log(chalk.yellow('\n  Interrupted'));
    rl.prompt();
  });
}

async function processInput(engine: QueryEngine, input: string): Promise<void> {
  console.log('');
  await recordTranscript('user', input);

  try {
    for await (const msg of engine.submitMessage(input)) {
      switch (msg.type) {
        case 'result':
          if (msg.subtype && msg.subtype.startsWith('error')) {
            console.log(chalk.red(`\n  ${msg.content}`));
          }
          await recordTranscript('assistant', msg.content || '');
          break;

        case 'assistant':
          // Text already streamed via onText
          break;
      }
    }
  } catch (error: any) {
    console.error(chalk.red(`\nError: ${error.message}`));
  }

  console.log('');
}

// ─── Slash Commands ─────────────────────────────────────────────────────────

async function handleSlashCommand(input: string, engine: QueryEngine): Promise<string | void> {
  const [cmd, ...args] = input.slice(1).split(/\s+/);

  switch (cmd.toLowerCase()) {
    case 'exit':
    case 'quit':
    case 'q':
      return 'exit';

    case 'help':
      console.log(chalk.bold('\n  System Clow Commands:\n'));
      console.log('  /help        Show this help');
      console.log('  /exit        Exit System Clow');
      console.log('  /clear       Clear conversation history');
      console.log('  /cost        Show session cost');
      console.log('  /compact     Compact conversation (free context)');
      console.log('  /context     Show context info');
      console.log('');
      break;

    case 'clear':
      console.log(chalk.dim('  Conversation cleared'));
      break;

    case 'cost':
      console.log(chalk.bold('\n  Session Cost:'));
      console.log(`  Total: $${getTotalCostUSD().toFixed(4)}`);
      console.log(`  Input tokens: ${getTotalInputTokens()}`);
      console.log(`  Output tokens: ${getTotalOutputTokens()}`);
      console.log(`  Messages: ${engine.getMessageCount()}`);
      console.log('');
      break;

    case 'context':
      console.log(chalk.bold('\n  Context Info:'));
      console.log(`  Session: ${getSessionId().slice(0, 8)}`);
      console.log(`  CWD: ${getCwd()}`);
      console.log(`  Messages: ${engine.getMessageCount()}`);
      console.log('');
      break;

    default:
      console.log(chalk.yellow(`  Unknown command: /${cmd}. Type /help for available commands.`));
  }
}

// ─── Entry Point ────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error(chalk.red(`Fatal error: ${err.message}`));
  process.exit(1);
});
