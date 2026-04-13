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

import { initAnthropic, type ClovMessage } from './api/anthropic.js';
import { QueryEngine } from './query/QueryEngine.js';
import { getTools } from './tools/tools.js';
import { MCPManager } from './mcp/MCPManager.js';
import { PluginSystem } from './plugins/PluginSystem.js';
import type { PluginCommand } from './plugins/types.js';
import { HookEngine } from './hooks/HookEngine.js';
import { HookEventDispatcher } from './hooks/HookEventDispatcher.js';
import { SkillEngine } from './skills/SkillEngine.js';
import { PluginMcpLoader } from './plugins/components/PluginMcpLoader.js';
import { buildPluginRuntimeTools } from './plugins/components/PluginRuntimeTools.js';
import { buildPluginRuntimeOutputStyles } from './plugins/components/PluginRuntimeOutputStyles.js';
import { AgentTool } from './tools/AgentTool/AgentTool.js';
import { CoordinatorMode } from './coordinator/CoordinatorMode.js';
import { BridgeSystem } from './bridge/BridgeSystem.js';
import { BridgeApiClient } from './bridge/api/bridgeApi.js';
import { SessionRunner } from './bridge/session/sessionRunner.js';
import { SwarmSystem } from './swarm/SwarmSystem.js';
import { DEFAULT_COORDINATOR_CONFIG } from './coordinator/types.js';
import { isCoordinatorModeEnabled, setCoordinatorMode } from './coordinator/modeDetection.js';
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

interface LoadedPluginCommand {
  plugin: string;
  command: PluginCommand;
}

function printBanner(): void {
  console.log('');
  console.log(chalk.bold.cyan('  ╔═══════════════════════════════════════╗'));
  console.log(chalk.bold.cyan('  ║') + chalk.bold.white('       System Clow v' + VERSION + '            ') + chalk.bold.cyan('║'));
  console.log(chalk.bold.cyan('  ║') + chalk.dim('  AI Coding Agent • Claude Sonnet 4.6 ') + chalk.bold.cyan('║'));
  console.log(chalk.bold.cyan('  ╚═══════════════════════════════════════╝'));
  console.log('');
}

// ─── Main ───────────────────────────────────────────────────────────────────

function extractPrintPrompt(argv: string[]): { argvForCommander: string[]; prompt?: string } {
  const rawArgs = argv.slice(2);
  if (rawArgs[0] === 'bridge') return { argvForCommander: argv };

  const printIndex = rawArgs.findIndex((arg) => arg === '--print' || arg === '-p');
  if (printIndex === -1) return { argvForCommander: argv };

  const trailingArgs = rawArgs.slice(printIndex + 1).filter((arg) => arg !== '--');
  if (trailingArgs.length === 0) return { argvForCommander: argv };

  return {
    argvForCommander: [...argv.slice(0, 2), ...rawArgs.slice(0, printIndex + 1)],
    prompt: trailingArgs.join(' '),
  };
}

let remoteControlBridge: BridgeSystem | null = null;

async function sendRemoteBridgeEvent(type: string, payload: unknown): Promise<void> {
  if (!remoteControlBridge) return;
  await remoteControlBridge.send({
    type,
    payload,
    uuid: randomUUID(),
    timestamp: Date.now(),
  });
}

async function main(): Promise<void> {
  // Phase 0: Fast paths
  const program = new Command();
  program
    .name('clow')
    .description('System Clow — AI-powered coding agent')
    .version(VERSION, '-v, --version')
    .option('-p, --print', 'Non-interactive: process single prompt and exit')
    .option('--cwd <dir>', 'Set working directory')
    .option('--model <model>', 'Override Claude model')
    .option('--max-turns <n>', 'Maximum conversation turns', '50')
    .option('--plan-mode', 'Start in plan mode (read-only until plan approved)')
    .option('--resume <id>', 'Resume a previous session by ID (supports partial match)')
    .option('--continue', 'Resume the last session for the current directory')
    .option('--list-sessions', 'List recent sessions for the current directory')
    .option('--coordinator', 'Enable coordinator mode (orchestration-first)')
    .option('--agent-id <id>', 'Internal: swarm agent id')
    .option('--team-name <name>', 'Internal: swarm team name')
    .option('--permission-mode <mode>', 'Internal: permission mode override')
    .option('--prompt <text>', 'Internal: initial prompt override')
    .argument('[prompt]', 'Initial prompt (non-interactive mode)')
    .action(() => {});

  program
    .command('bridge')
    .description('Run bridge standalone mode against a bridge-enabled server')
    .requiredOption('--endpoint <url>', 'Bridge endpoint URL')
    .requiredOption('--api-key <key>', 'Bridge API key (tenant/admin/global)')
    .option('--capacity <n>', 'Max concurrent bridge sessions', '1')
    .option('--transport <version>', 'Bridge transport version', 'v2')
    .option('--spawn-mode <mode>', 'Bridge spawn mode', 'single-session')
    .option('--workdir <dir>', 'Workdir root for bridge-spawned sessions')
    .option('--test-seconds <n>', 'Exit automatically after N seconds (useful for validation)');

  const printPrompt = extractPrintPrompt(process.argv);
  program.parse(printPrompt.argvForCommander);
  const opts = program.opts();
  const args = program.args;
  const resolvedPrompt = opts.prompt || process.env.CLOW_INITIAL_PROMPT || printPrompt.prompt || args[0];
  const bridgeCommand = program.commands.find((cmd) => cmd.name() === 'bridge');
  const bridgeOpts = bridgeCommand?.opts();

  if (process.argv[2] === 'bridge' && bridgeOpts) {
    await runBridgeCommand(bridgeOpts as { endpoint: string; apiKey: string; capacity?: string; transport?: string; spawnMode?: string; workdir?: string; testSeconds?: string; });
    return;
  }

  if (opts.permissionMode && ['default','acceptEdits','bypassPermissions','dontAsk','auto','plan'].includes(opts.permissionMode)) {
    setPermissionMode(opts.permissionMode as any);
  }

  if (opts.coordinator) {
    setCoordinatorMode(true);
  }
  const coordinatorEnabled = opts.coordinator || isCoordinatorModeEnabled();

  // Phase 1: Load environment
  // Try multiple .env locations
  loadEnv({ path: path.resolve(process.cwd(), '.env') });
  loadEnv({ path: path.resolve(os.homedir(), '.clow', '.env') });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error(chalk.red('Error: API key not found.'));
    console.error(chalk.dim('Set ANTHROPIC_API_KEY in .env'));
    process.exit(1);
  }

  // Phase 2: Initialize
  const cwd = opts.cwd ? path.resolve(opts.cwd) : process.cwd();
  setCwd(cwd);
  setOriginalCwd(cwd);
  setProjectRoot(cwd);
  setSessionId(randomUUID());

  const selectedModel = opts.model
    || process.env.CLOW_MODEL
    || 'claude-sonnet-4-6';

  initAnthropic({
    apiKey,
    model: selectedModel,
    maxOutputTokens: 8192,
  });

  await initSessionStorage();
  await getGitStatus(); // Populate git cache

  const pluginSystem = new PluginSystem();
  let pluginCommands: LoadedPluginCommand[] = [];
  try {
    await pluginSystem.initialize(cwd);
    pluginCommands = pluginSystem.getCommands();
    const pluginStats = pluginSystem.getStats();
    if (pluginStats.pluginCount > 0) {
      console.log(chalk.green(`  ? Plugins: ${pluginStats.pluginCount} plugin(s), ${pluginStats.commandCount} command(s)`));
    }
  } catch (err: any) {
    console.error(chalk.yellow(`  ? Plugin init error: ${err.message}`));
  }

  // Phase 2b: MCP servers
  const mcpManager = new MCPManager();
  const mcpConfigPath = path.join(os.homedir(), '.clow', 'mcp.json');
  try {
    if (fs.existsSync(mcpConfigPath)) {
      await mcpManager.loadFromConfig(mcpConfigPath);
    }
    const pluginMcpLoader = new PluginMcpLoader();
    const pluginMcpConfigs: Record<string, { command: string; args?: string[]; env?: Record<string, string> }> = {};
    for (const plugin of pluginSystem.registry.listEnabled()) {
      Object.assign(pluginMcpConfigs, pluginMcpLoader.getServerConfigs(plugin.manifest, plugin.rootDir));
    }
    mcpManager.registerServers(pluginMcpConfigs);
    await mcpManager.connectAll();
    if (mcpManager.serverCount > 0) {
      const mcpToolCount = mcpManager.getAllTools().length;
      console.log(chalk.green(`  ? MCP: ${mcpManager.serverCount} server(s), ${mcpToolCount} tool(s)`));
    }
  } catch (err: any) {
    console.error(chalk.yellow(`  ? MCP init error: ${err.message}`));
  }

  // Cleanup MCP on exit
  const cleanupMCP = async () => { await mcpManager.disconnectAll(); };
  process.on('exit', () => { void cleanupMCP(); });
  process.on('SIGTERM', async () => { await cleanupMCP(); process.exit(0); });

  const pluginRuntimeTools = await buildPluginRuntimeTools(pluginSystem);
  const pluginOutputStyles = await buildPluginRuntimeOutputStyles(pluginSystem);
  const fullTools = [...getTools(undefined, mcpManager), ...pluginRuntimeTools];
  let tools = fullTools;
  let coordinatorMode: CoordinatorMode | undefined;
  if (coordinatorEnabled) {
    const coordinatorExecutor = {
      execute: async (params: {
        description: string;
        prompt: string;
        subagent_type: string;
        budgetUsd: number;
        maxTurns: number;
        allowedTools: string[];
      }) => {
        const result = await AgentTool.call({
          description: params.description,
          prompt: params.prompt,
          subagent_type: params.subagent_type as any,
          budgetUsd: params.budgetUsd,
          maxTurns: params.maxTurns,
          allowedTools: params.allowedTools,
        }, {
          cwd: getCwd(),
          sessionId: getSessionId(),
          workspaceRoot: cwd,
          permissionMode: getPermissionMode(),
          options: { tools: fullTools },
          depth: 0,
        }, async () => ({ behavior: 'allow' as const }), `coordinator:${params.description}`);

        const output = (result.output || {}) as any;
        return {
          success: !result.isError,
          result: typeof output.result === 'string' ? output.result : result.outputText,
          tokensUsed: Number(output.tokens_used || 0),
          costUsd: Number(output.cost_usd || 0),
          toolUseCount: 0,
        };
      },
    };

    coordinatorMode = new CoordinatorMode({
      ...DEFAULT_COORDINATOR_CONFIG,
      enabled: true,
      scratchpadDir: path.join(cwd, '.clow', 'scratchpad'),
    }, coordinatorExecutor);
    await coordinatorMode.initialize();
    tools = coordinatorMode.filterCoordinatorTools(fullTools) as typeof fullTools;
  }
  const toolRegistry = new Map(tools.map((tool) => [tool.name, tool]));
  const hookEngine = new HookEngine({
    toolRegistry,
    spawnSubagent: async () => 'ok',
  });
  await hookEngine.initialize(cwd, !opts.print);
  for (const pluginHook of pluginSystem.getHooks()) {
    hookEngine.addHook(pluginHook);
  }
  const hookDispatcher = new HookEventDispatcher(hookEngine, {
    sessionId: getSessionId(),
    transcriptPath: getSessionFilePath(getSessionId()),
    cwd: getCwd(),
    workspaceRoot: cwd,
    agentDepth: 0,
  });

  const skillEngine = new SkillEngine();
  await skillEngine.initialize(cwd);
  for (const plugin of pluginSystem.registry.listEnabled()) {
    await skillEngine.addPluginSkills(plugin.rootDir);
  }

  const baseSystemPrompt = coordinatorMode
    ? coordinatorMode.buildSystemPrompt({
        workspaceRoot: cwd,
        mcpServerNames: mcpManager.getServerNames(),
      })
    : await assembleFullContext();

  const systemPrompt = pluginOutputStyles.systemPromptAddition
    ? `${baseSystemPrompt}\n\n${pluginOutputStyles.systemPromptAddition}`
    : baseSystemPrompt;

  // Auto-allow MCP tools that are read-only-ish (by name convention)
  const mcpToolNames = mcpManager.getAllTools().map(t => `mcp__${t.serverName}__${t.tool.name}`);

  // In --print mode, auto-approve ALL tools (non-interactive)
  const allToolNames = tools.map(t => t.name);
  const permContext: LegacyPermissionContext = {
    denyRules: [],
    allowRules: opts.print
      ? allToolNames  // Auto-approve everything in non-interactive mode
      : ['Read', 'Glob', 'Grep', 'TodoWrite', 'WebFetch', 'WebSearch', 'Agent', 'EnterPlanMode', 'ExitPlanMode', ...mcpToolNames],
    askRules: [],
  };

  const canUseTool = createCanUseTool(permContext, true, () => ({
    sessionId: getSessionId(),
    cwd: getCwd(),
    permissionMode: getPermissionMode(),
  }));
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
      const match = sessions.find(s => s.cwd === getCwd());
      if (!match) {
        console.error(chalk.red('  No previous session found in this directory.'));
        await mcpManager.disconnectAll();
        process.exit(1);
      }
      resumeSessionId = match.sessionId;
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

  if (!resumeSessionId && !fs.existsSync(getSessionFilePath())) {
    await saveSessionMetadata('session_start', {
      cwd: getCwd(),
      mode: coordinatorEnabled ? 'coordinator' : (opts.print ? 'print' : 'cli'),
      createdAt: Date.now(),
    });
  }

  const swarmAgentId = opts.agentId || process.env.CLOW_AGENT_ID;
  let swarmRuntime: SwarmSystem | undefined;
  if (swarmAgentId) {
    swarmRuntime = await startSwarmInboxPolling(swarmAgentId);
  }

  // Phase 3: Execute
  if (opts.print && resolvedPrompt) {
    await runSinglePrompt(resolvedPrompt, tools, systemPrompt, canUseTool, maxTurns, hookDispatcher, skillEngine);
  } else if (resolvedPrompt) {
    printBanner();
    await runREPL(tools, systemPrompt, canUseTool, maxTurns, pluginCommands, hookDispatcher, skillEngine, resolvedPrompt, resumedMessages);
  } else {
    printBanner();
    console.log(chalk.dim(`  Session: ${getSessionId().slice(0, 8)}`));
    console.log(chalk.dim(`  CWD: ${getCwd()}`));
    console.log(chalk.dim(`  Tools: ${tools.map((t) => t.name).join(', ')}`));
    if (coordinatorEnabled) {
      console.log(chalk.cyan(`  Mode: COORDINATOR`));
    }
    if (getPermissionMode() === 'plan') {
      console.log(chalk.yellow(`  Mode: PLAN (read-only)`));
    }
    console.log(chalk.dim(`  Type /help for commands, /exit to quit\n`));
    await runREPL(tools, systemPrompt, canUseTool, maxTurns, pluginCommands, hookDispatcher, skillEngine, undefined, resumedMessages);
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

async function runBridgeCommand(opts: {
  endpoint: string;
  apiKey: string;
  capacity?: string;
  transport?: string;
  spawnMode?: string;
  workdir?: string;
  testSeconds?: string;
}): Promise<void> {
  loadEnv({ path: path.resolve(process.cwd(), '.env') });
  loadEnv({ path: path.resolve(os.homedir(), '.clow', '.env') });

  const bridge = new BridgeSystem({
    endpointUrl: opts.endpoint,
    apiKey: opts.apiKey,
    mode: 'standalone',
    transportVersion: (opts.transport as any) || 'v2',
    capacity: parseInt(opts.capacity || '1', 10) || 1,
    spawnMode: (opts.spawnMode as any) || 'single-session',
    worktree: opts.workdir ? { baseDir: path.resolve(opts.workdir) } : undefined,
  });

  const apiClient = new BridgeApiClient({
    endpointUrl: opts.endpoint,
    apiKey: opts.apiKey,
    mode: 'standalone',
    transportVersion: (opts.transport as any) || 'v2',
    capacity: parseInt(opts.capacity || '1', 10) || 1,
    spawnMode: (opts.spawnMode as any) || 'single-session',
  });

  const apiAdapter = {
    registerEnvironment: async (params: { capacity: number; reuseEnvironmentId?: string }) => {
      return apiClient.registerEnvironment({
        capacity: params.capacity,
        metadata: params.reuseEnvironmentId ? { reuseEnvironmentId: params.reuseEnvironmentId } : undefined,
      });
    },
    pollForWork: async (envId: string, _secret: string) => {
      const response = await apiClient.pollForWork(envId);
      return response.work;
    },
    heartbeat: async (envId: string, _secret: string, payload: { activeSessionCount: number; capacity: number; status: string }) => {
      await apiClient.heartbeat({
        environmentId: envId,
        activeSessions: payload.activeSessionCount > 0 ? [`active:${payload.activeSessionCount}`] : [],
      });
    },
    ackWork: async (envId: string, _secret: string, payload: { workId: string; sessionId: string }) => {
      await apiClient.ackWork(envId, payload);
    },
    stopWork: async (envId: string, _secret: string, payload: { workId: string; sessionId: string; reason: string }) => {
      await apiClient.stopWork(envId, payload);
    },
    deregisterEnvironment: async (envId: string, _secret: string) => {
      await apiClient.deregisterEnvironment(envId);
    },
  };

  const sessionRunner = new SessionRunner(
    process.execPath,
    (opts.spawnMode as any) || 'single-session',
    opts.workdir ? { baseDir: path.resolve(opts.workdir) } : undefined,
    { extraArgs: [path.resolve(process.argv[1])] },
  );

  const autoExitSeconds = parseInt(opts.testSeconds || process.env.CLOW_BRIDGE_TEST_SECONDS || '0', 10) || 0;
  if (autoExitSeconds > 0) {
    setTimeout(() => {
      void bridge.stop();
      process.exit(0);
    }, autoExitSeconds * 1000);
  }

  console.log(chalk.cyan(`Starting bridge against ${opts.endpoint}`));
  await bridge.start({ api: apiAdapter, sessionRunner });
}


async function startSwarmInboxPolling(agentId: string): Promise<SwarmSystem> {
  const swarm = new SwarmSystem();
  await swarm.initialize();
  swarm.startInboxPolling(agentId, {
    direct_message: (msg) => {
      const payload = typeof msg.content === 'object' && msg.content !== null ? msg.content as Record<string, unknown> : {};
      const text = typeof payload.text === 'string' ? payload.text : JSON.stringify(msg.content);
      process.stdout.write(`
[swarm:${msg.from}] ${text}
`);
    },
    broadcast: (msg) => {
      const payload = typeof msg.content === 'object' && msg.content !== null ? msg.content as Record<string, unknown> : {};
      const text = typeof payload.text === 'string' ? payload.text : JSON.stringify(msg.content);
      process.stdout.write(`
[swarm:broadcast:${msg.from}] ${text}
`);
    },
    task_assignment: (msg) => {
      process.stdout.write(`
[swarm:task] ${JSON.stringify(msg.content)}
`);
    },
    shutdown_request: (msg) => {
      process.stdout.write(`
[swarm:shutdown] ${JSON.stringify(msg.content)}
`);
    },
  });
  return swarm;
}

async function runSinglePrompt(
  prompt: string,
  tools: any[],
  systemPrompt: string,
  canUseTool: any,
  maxTurns: number,
  hookDispatcher: HookEventDispatcher,
  skillEngine: SkillEngine,
): Promise<void> {
  const engine = new QueryEngine({
    tools,
    systemPrompt,
    canUseTool,
    maxTurns,
    getExecutionContext: () => ({
      cwd: getCwd(),
      sessionId: getSessionId(),
      permissionMode: getPermissionMode(),
    }),
    dynamicContext: getDynamicContext(),
    onText: (text) => process.stdout.write(text),
    hookDispatcher,
    skillEngine,
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
  pluginCommands: LoadedPluginCommand[],
  hookDispatcher: HookEventDispatcher,
  skillEngine: SkillEngine,
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

  if (resumedMessages?.length) {
    const historyMessages: ClovMessage[] = resumedMessages
      .filter((msg) => msg.role === 'user' || msg.role === 'assistant')
      .map((msg): ClovMessage => (
        msg.role === 'assistant'
          ? { role: 'assistant', content: msg.content }
          : { role: 'user', content: msg.content }
      ));

    if (historyMessages.length > 0) {
      engine.hydrateFromApiMessages(historyMessages);
    }
  }

  let isProcessingInput = false;
  let suppressCloseHandler = false;

  const createRepl = (): readline.Interface => {
    const repl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: chalk.cyan('\n? '),
    });

    repl.on('line', async (line) => {
      const input = line.trim();

      if (!input) {
        repl.prompt();
        return;
      }

      await runWithExclusiveInput(async () => {
        if (input.startsWith('/')) {
          const handled = await handleSlashCommand(input, engine, pluginCommands);
          if (handled === 'exit') {
            if (remoteControlBridge) {
              await remoteControlBridge.stop();
              remoteControlBridge = null;
            }
            await engine.gracefulShutdown('cli_exit');
            await flushSession();
            process.exit(0);
          }
          return;
        }

        await processInput(engine, input);
      });
    });

    repl.on('close', async () => {
      if (suppressCloseHandler) {
        return;
      }
      if (remoteControlBridge) {
        await remoteControlBridge.stop();
        remoteControlBridge = null;
      }
      await engine.gracefulShutdown('cli_close');
      await flushSession();
      console.log(chalk.dim('\nGoodbye!'));
      process.exit(0);
    });

    return repl;
  };

  let rl = createRepl();

  const runWithExclusiveInput = async (task: () => Promise<void>): Promise<void> => {
    if (isProcessingInput) {
      return;
    }

    isProcessingInput = true;
    suppressCloseHandler = true;
    rl.removeAllListeners('line');
    rl.close();
    suppressCloseHandler = false;

    try {
      await task();
    } finally {
      rl = createRepl();
      isProcessingInput = false;
      rl.prompt();
    }
  };

  if (initialPrompt) {
    await runWithExclusiveInput(async () => {
      await processInput(engine, initialPrompt);
    });
  } else {
    rl.prompt();
  }

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
  let assistantRecorded = false;

  try {
    for await (const msg of engine.submitMessage(input)) {
      switch (msg.type) {
        case 'result':
          if (msg.subtype && msg.subtype.startsWith('error')) {
            console.log(chalk.red(`\n  ${msg.content}`));
          }
          if (!assistantRecorded && msg.content) {
            await recordTranscript('assistant', msg.content);
            assistantRecorded = true;
          }
          if (msg.content) {
            await sendRemoteBridgeEvent('assistant_result', { subtype: msg.subtype, content: msg.content });
          }
          break;

        case 'assistant':
          if (msg.content) {
            await recordTranscript('assistant', msg.content);
            assistantRecorded = true;
            await sendRemoteBridgeEvent('assistant_message', { content: msg.content });
          }
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

async function handleSlashCommand(input: string, engine: QueryEngine, pluginCommands: LoadedPluginCommand[]): Promise<string | void> {
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
      console.log('  /remote-control start|stop|status');
      if (pluginCommands.length > 0) {
        console.log('');
        console.log(chalk.bold('  Plugin Commands:'));
        for (const entry of pluginCommands) {
          console.log(`  /${entry.command.name.padEnd(12)} ${entry.command.description} ${chalk.dim(`[${entry.plugin}]`)}`);
        }
      }
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

    case 'remote-control':
    case 'remote': {
      const subcmd = (args[0] || 'status').toLowerCase();

      if (subcmd === 'start') {
        if (remoteControlBridge) {
          console.log(chalk.yellow('  Remote control already active.'));
          break;
        }

        const endpoint = process.env.CLOW_BRIDGE_ENDPOINT || process.env.CLOW_ENDPOINT || 'http://127.0.0.1:3001';
        const apiKey = process.env.CLOW_ADMIN_KEY || process.env.CLOW_API_KEY;
        if (!apiKey) {
          console.log(chalk.red('  CLOW_ADMIN_KEY or CLOW_API_KEY is required.'));
          break;
        }

        const bridge = new BridgeSystem({
          mode: 'repl',
          endpointUrl: endpoint,
          apiKey,
          transportVersion: 'v2',
        });

        await bridge.start({
          sessionId: getSessionId(),
          onInboundMessage: (msg) => {
            const payload = typeof msg.payload === 'object' && msg.payload !== null ? msg.payload as Record<string, unknown> : {};
            if (msg.type === 'remote_prompt') {
              const remoteText = typeof payload.text === 'string' ? payload.text : '';
              if (remoteText) {
                process.stdout.write(`\n[remote] ${remoteText}\n`);
                void processInput(engine, remoteText);
              }
            }
          },
        });

        remoteControlBridge = bridge;
        console.log(chalk.green('  ? Remote control activated.'));
        console.log(bridge.getDetailedStatus());
        break;
      }

      if (subcmd === 'stop') {
        if (!remoteControlBridge) {
          console.log(chalk.yellow('  Remote control is not active.'));
          break;
        }

        await remoteControlBridge.stop();
        remoteControlBridge = null;
        console.log(chalk.green('  ? Remote control stopped.'));
        break;
      }

      if (!remoteControlBridge) {
        console.log(chalk.dim('  Remote control is inactive. Use /remote-control start'));
      } else {
        console.log(remoteControlBridge.getDetailedStatus());
      }
      break;
    }

    default: {
      const pluginCommand = findPluginCommand(cmd.toLowerCase(), pluginCommands);
      if (pluginCommand) {
        console.log(chalk.dim(`  ? plugin /${cmd} ${chalk.dim(`[${pluginCommand.plugin}]`)}`));
        await processInput(engine, buildPluginCommandPrompt(pluginCommand.command, args));
        return;
      }

      console.log(chalk.yellow(`  Unknown command: /${cmd}. Type /help for available commands.`));
    }
  }
}

function findPluginCommand(name: string, pluginCommands: LoadedPluginCommand[]): LoadedPluginCommand | undefined {
  return pluginCommands.find((entry) => (
    entry.command.name === name || entry.command.frontmatter.aliases?.includes(name)
  ));
}

function buildPluginCommandPrompt(command: PluginCommand, args: string[]): string {
  const parts = [command.body.trim()];
  const rawArgs = args.join(' ').trim();

  if (rawArgs) {
    parts.push(`User arguments:
${rawArgs}`);
  }

  if (command.frontmatter.allowedTools?.length) {
    parts.push(`Preferred tools for this command: ${command.frontmatter.allowedTools.join(', ')}`);
  }

  return parts.filter(Boolean).join('\n\n');
}

// ─── Entry Point ────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error(chalk.red(`Fatal error: ${err.message}`));
  process.exit(1);
});
