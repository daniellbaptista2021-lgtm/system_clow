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
import * as fs from 'fs';
import { randomUUID } from 'crypto';

import { initDeepSeek } from './api/deepseek.js';
import { QueryEngine } from './query/QueryEngine.js';
import { getTools } from './tools/tools.js';
import { MCPManager } from './mcp/MCPManager.js';
import { assembleFullContext, getGitStatus, getDynamicContext } from './utils/context/context.js';
import { createCanUseTool, type LegacyPermissionContext } from './utils/permissions/permissions.js';
import {
  initSessionStorage, recordTranscript, flushSession,
  listSessions, loadTranscriptFile, saveSessionMetadata,
  getSessionFilePath, acquireSessionLock, releaseSessionLock,
} from './utils/session/sessionStorage.js';
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
  setPermissionMode,
  getPermissionMode,
  getPrePlanPermissionMode,
  setPrePlanPermissionMode,
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
    .option('--plan-mode', 'Start in plan mode (read-only until plan approved)')
    .option('--resume <id>', 'Resume a previous session by ID (supports partial match)')
    .option('--continue', 'Resume the last session for the current directory')
    .option('--list-sessions', 'List recent sessions for the current directory')
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

  const selectedModel = opts.model || process.env.CLOW_MODEL || process.env.DEEPSEEK_MODEL || 'deepseek-chat';
  const isOpenAI = selectedModel.startsWith('gpt-');

  initDeepSeek({
    apiKey: isOpenAI ? (process.env.OPENAI_API_KEY || apiKey) : apiKey,
    baseURL: isOpenAI ? 'https://api.openai.com/v1' : (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com'),
    model: selectedModel,
    maxOutputTokens: 8192,
  });

  await initSessionStorage();
  await getGitStatus(); // Populate git cache

  // Phase 2b: MCP servers
  const mcpManager = new MCPManager();
  const mcpConfigPath = path.join(os.homedir(), '.clow', 'mcp.json');
  if (fs.existsSync(mcpConfigPath)) {
    try {
      await mcpManager.loadFromConfig(mcpConfigPath);
      await mcpManager.connectAll();
      if (mcpManager.serverCount > 0) {
        const mcpToolCount = mcpManager.getAllTools().length;
        console.log(chalk.green(`  ✓ MCP: ${mcpManager.serverCount} server(s), ${mcpToolCount} tool(s)`));
      }
    } catch (err: any) {
      console.error(chalk.yellow(`  ⚠ MCP init error: ${err.message}`));
    }
  }

  // Cleanup MCP on exit
  const cleanupMCP = async () => { await mcpManager.disconnectAll(); };
  process.on('exit', () => { void cleanupMCP(); });
  process.on('SIGTERM', async () => { await cleanupMCP(); process.exit(0); });

  const tools = getTools(undefined, mcpManager);
  const systemPrompt = await assembleFullContext();

  // Auto-allow MCP tools that are read-only-ish (by name convention)
  const mcpToolNames = mcpManager.getAllTools().map(t => `mcp__${t.serverName}__${t.tool.name}`);

  const permContext: LegacyPermissionContext = {
    denyRules: [],
    allowRules: ['Read', 'Glob', 'Grep', 'TodoWrite', 'WebFetch', 'WebSearch', 'Agent', 'EnterPlanMode', 'ExitPlanMode', ...mcpToolNames],
    askRules: [],
  };

  const canUseTool = createCanUseTool(permContext);
  const maxTurns = parseInt(opts.maxTurns) || 50;

  // ── Plan mode flag ────────────────────────────────────────────────
  if (opts.planMode) {
    setPermissionMode('plan');
    console.log(chalk.yellow('  ✓ Plan mode active — read-only until plan approved'));
  }

  // ── --list-sessions ───────────────────────────────────────────────
  if (opts.listSessions) {
    const sessions = await listSessions(20);
    if (sessions.length === 0) {
      console.log(chalk.dim('  No sessions found for this directory.'));
    } else {
      console.log(chalk.bold('\n  Recent sessions:\n'));
      for (let i = 0; i < sessions.length; i++) {
        const s = sessions[i];
        const ago = formatTimeAgo(s.mtime);
        console.log(`  ${i + 1}. [${ago}] ${s.sessionId.slice(0, 8)} ${chalk.dim(`(${s.cwd})`)}`);
      }
      console.log('');
    }
    await mcpManager.disconnectAll();
    process.exit(0);
  }

  // ── --resume / --continue ─────────────────────────────────────────
  let resumedMessages: Array<{ role: string; content: string }> | null = null;
  let resumeSessionId: string | null = null;

  if (opts.continue || opts.resume) {
    const sessions = await listSessions(50);

    if (opts.continue) {
      // Find last session for current CWD
      if (sessions.length === 0) {
        console.error(chalk.red('  No previous session found in this directory.'));
        await mcpManager.disconnectAll();
        process.exit(1);
      }
      resumeSessionId = sessions[0].sessionId;
    } else if (opts.resume) {
      // Match by prefix
      const match = sessions.find(s => s.sessionId.startsWith(opts.resume));
      if (!match) {
        console.error(chalk.red(`  Session not found: ${opts.resume}`));
        await mcpManager.disconnectAll();
        process.exit(1);
      }
      resumeSessionId = match.sessionId;

      // CWD check
      if (match.cwd !== getCwd()) {
        console.log(chalk.yellow(`  ⚠ Session was started in a different directory`));
        console.log(chalk.dim(`    Session CWD: ${match.cwd}`));
        console.log(chalk.dim(`    Current CWD: ${getCwd()}`));
      }
    }

    if (resumeSessionId) {
      // Acquire lock
      const lockOk = await acquireSessionLock(resumeSessionId);
      if (!lockOk) {
        console.error(chalk.red(`  Session ${resumeSessionId.slice(0, 8)} is already open in another terminal.`));
        await mcpManager.disconnectAll();
        process.exit(1);
      }

      // Load transcript
      const entries = await loadTranscriptFile(resumeSessionId);
      resumedMessages = entries
        .filter(e => e.role === 'user' || e.role === 'assistant' || e.role === 'tool')
        .map(e => ({ role: e.role as string, content: String(e.content || '') }));

      // Restore session ID
      setSessionId(resumeSessionId);

      // Restore accumulated cost
      const costEntries = entries.filter(e => e.type === 'cost');
      let resumedCost = 0;
      for (const c of costEntries) {
        resumedCost += (c as any).value?.costUsd || 0;
      }

      console.log(chalk.green(`  ✓ Resumed session ${resumeSessionId.slice(0, 8)} (${resumedMessages.length} messages${resumedCost > 0 ? `, $${resumedCost.toFixed(4)} prior cost` : ''})`));
    }
  }

  // Phase 3: Execute
  if (opts.print && args[0]) {
    await runSinglePrompt(args[0], tools, systemPrompt, canUseTool, maxTurns);
  } else if (args[0]) {
    printBanner();
    await runREPL(tools, systemPrompt, canUseTool, maxTurns, args[0], resumedMessages);
  } else {
    printBanner();
    console.log(chalk.dim(`  Session: ${getSessionId().slice(0, 8)}`));
    console.log(chalk.dim(`  CWD: ${getCwd()}`));
    console.log(chalk.dim(`  Tools: ${tools.map((t) => t.name).join(', ')}`));
    if (getPermissionMode() === 'plan') {
      console.log(chalk.yellow(`  Mode: PLAN (read-only)`));
    }
    console.log(chalk.dim(`  Type /help for commands, /exit to quit\n`));
    await runREPL(tools, systemPrompt, canUseTool, maxTurns, undefined, resumedMessages);
  }
}

function formatTimeAgo(date: Date): string {
  const ms = Date.now() - date.getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
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
    dynamicContext: getDynamicContext(),
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
  resumedMessages?: Array<{ role: string; content: string }> | null,
): Promise<void> {
  const engine = new QueryEngine({
    tools,
    systemPrompt,
    canUseTool,
    maxTurns,
    dynamicContext: getDynamicContext(),
    onText: (text) => process.stdout.write(text),
    onToolUse: (name, input) => {
      console.log(chalk.dim(`\n  ▸ ${name}`));
    },
    onToolResult: (name, result: any) => {
      if (result?.isError) {
        console.log(chalk.red(`  ✗ ${name}: error`));
      }
    },
    onTurnComplete: (_turn) => {
      // Cost info hidden — product mode
    },
    onCompact: (originalTokens, newTokens) => {
      console.log(chalk.yellow(`\n  ⟳ Compacted: ${originalTokens} → ${newTokens} tokens`));
    },
    onContextWarning: (percentLeft) => {
      console.log(chalk.yellow(`\n  ⚠ Context ${percentLeft.toFixed(0)}% remaining`));
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

        case 'system':
          if (msg.subtype === 'compacting') {
            console.log(chalk.yellow(`\n  ⟳ ${msg.content}`));
          } else if (msg.subtype === 'compact_complete') {
            console.log(chalk.green(`  ✓ ${msg.content}`));
          } else if (msg.subtype === 'compact_failed') {
            console.log(chalk.red(`  ✗ ${msg.content}`));
          }
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
      console.log('  /plan        Toggle plan mode (read-only)');
      console.log('  /compact     Compact conversation (free context)');
      console.log('  /context     Show context info');
      console.log('');
      break;

    case 'plan': {
      const current = getPermissionMode();
      if (current === 'plan') {
        setPermissionMode(getPrePlanPermissionMode() || 'default');
        setPrePlanPermissionMode(undefined);
        console.log(chalk.green('  ✓ Plan mode deactivated. Normal operations resumed.'));
      } else {
        setPrePlanPermissionMode(current);
        setPermissionMode('plan');
        console.log(chalk.yellow('  ✓ Plan mode activated. Read-only until /plan again or ExitPlanMode.'));
      }
      break;
    }

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
