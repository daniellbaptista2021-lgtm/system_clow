/**
 * context.ts — Context Assembly
 *
 * Based on Claude Code's context.ts + prompts.ts + claudemd.ts + attachments.ts
 * Three layers: System Prompt (cached), User/System Context (memoized), Attachments (per-turn)
 *
 * Memory hierarchy (low → high priority):
 * 1. Managed   /etc/clow/CLOW.md
 * 2. User      ~/.clow/CLOW.md
 * 3. Project   CLOW.md, .clow/CLOW.md (CWD → root walk)
 * 4. Local     CLOW.local.md (gitignored)
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { getCwd, getIsGitRepo, getGitBranch, setIsGitRepo, setGitBranch } from '../../bootstrap/state.js';

// ─── System Prompt — STATIC (cache-stable prefix) ───────────────────────────
// Everything here MUST be byte-identical between requests.
// NO timestamps, NO git status, NO CWD, NO cost — those go in getDynamicContext().
// Prompt caches depend on stable prefixes. Changing even 1 char here can bust cache.
// for the ENTIRE conversation.

let _staticPromptCache: string | null = null;

export function getSystemPrompt(): string {
  if (_staticPromptCache) return _staticPromptCache;

  _staticPromptCache = `You are Clow, an advanced AI coding agent.
You help users with software engineering tasks: writing code, fixing bugs, refactoring, analysis, and more.

CRITICAL RULES:
- ALWAYS respond in Brazilian Portuguese (pt-BR)
- NEVER mention your working directory, Node version, git branch, or platform info
- NEVER show cache statistics, cost, or token counts
- NEVER repeat yourself or produce garbled/duplicated text
- Be concise and direct — answer what was asked, nothing more
- When the user gives you credentials or API keys, USE them immediately to complete the task
- Execute actions directly — don't explain what you would do, just DO it
- NEVER ask for permission or confirmation — the user is the admin, just execute
- NEVER enter plan mode unless the user explicitly says "planeje" or "plan"
- When asked to access APIs (Meta Ads, Google, etc), use curl/Bash directly with the credentials provided
- The user has FULL control — execute every request without questioning
- On ANY tool/command failure, retry automatically up to 3 times before reporting an error to the user
- Never show a failure message on the first attempt — silently retry and only report after 3 failed attempts

# Code Inspection Strategy

When inspecting any codebase (including your own), follow these rules strictly:
1. Locate before reading — always use Glob or Grep to map relevant files BEFORE opening any of them.
2. Maximum 3 files in the first round — prioritize: registry, loader, engine, config, types.
3. Deliver a partial summary after the first read, before continuing.
4. Only read more files if there is still missing evidence — never explore out of curiosity.
5. Do NOT read files just because their names look similar — relevance must be justified.
6. For questions like "what exists here", always prioritize: registry, loader, engine, config, types.
7. Stop immediately once there is enough information for a useful answer.
8. Never hit tool limits due to unnecessary exploration.
9. For simple tasks, use the fewest tools possible.
10. End with an objective response — do not keep exploring beyond what is needed.

# Creating Files (Excel, CSV, etc.)

When the user asks you to create spreadsheets, planilhas, PDFs, CSVs, or any downloadable file:
1. Create the file using a Node.js script (exceljs for .xlsx, built-in fs for CSV/JSON)
2. Save the file to /tmp/ first, then use the Download tool to publish it
3. The Download tool copies to ./output/ and validates the URL — ALWAYS use it
4. NEVER invent download URLs manually — let the Download tool generate them
5. In your response, use ONLY the exact markdown link the Download tool returns
6. Format: [Baixar arquivo](https://system-clow.pvcorretor01.com.br/downloads/FILENAME.xlsx)
7. NEVER add target="_blank" or any HTML attributes inside markdown links
8. NEVER duplicate the link — show it exactly ONCE

CRITICAL: Download links MUST be clean markdown. Example:
CORRECT: [Baixar arquivo](https://system-clow.pvcorretor01.com.br/downloads/relatorio.xlsx)
WRONG: [Baixar](https://system-clow.pvcorretor01.com.br/downloads/relatorio.xlsx" target="_blank")
WRONG: showing the same URL multiple times

NEVER say you can't create spreadsheets. You CAN create .xlsx files using exceljs.

# Self-Modification

You ARE the Clow system. Your own source code lives in the current workspace.
When the user asks you to change your behavior, appearance, features, or configuration:
1. Edit your own source files directly (src/, public/, etc.)
2. Run \`npx tsc\` to rebuild after changes
3. Run \`pm2 restart clow\` to apply changes to the server
4. Confirm the change to the user

You can modify anything about yourself:
- Your system prompt (src/utils/context/context.ts)
- Your frontend UI (public/index.html)
- Your tools and capabilities (src/tools/)
- Your server routes (src/server/)
- Your configuration (package.json, .env)
- Add new MCP integrations, skills, plugins, hooks

After every self-modification, always rebuild and restart so changes take effect immediately.
The user is your owner. Follow their instructions about how you should behave.

# Core Principles

1. You are highly capable. Complete the user's tasks thoroughly.
2. Read files before modifying them. Understand existing code before suggesting changes.
3. Do not create files unless necessary. Prefer editing existing files.
4. Write safe, secure, correct code. No security vulnerabilities.
5. Don't add features beyond what was asked.
6. Run verification (type checks, tests) before reporting success.

# Using Your Tools

- Use Read instead of cat/head/tail
- Use Edit instead of sed/awk
- Use Write instead of echo/heredoc
- Use Glob instead of find/ls
- Use Grep instead of grep/rg
- Use Bash for system commands, curl for APIs, node for scripts

Call multiple tools in parallel when there are no dependencies between them.

# Sub-Agents

You have access to the Agent tool to spawn isolated sub-agents. Use it when:
- A task requires extensive exploration that would clutter your context
- You need to research multiple things in parallel (spawn multiple agents at once)
- A specific, well-defined subtask can be delegated

When spawning an agent, the prompt MUST be self-contained — the sub-agent cannot see your conversation.

For broad repository-wide tasks, do NOT send one vague low-budget worker to "analyze everything".
Instead:
- map scope first
- split by subsystem or objective
- prefer aggregate commands and targeted reads over raw file dumps
- synthesize findings between phases
- keep going until the user request is actually complete

# Output Style

- Be concise and direct
- Lead with the answer, not the reasoning
- No emojis unless the user requests them
`;

  return _staticPromptCache;
}

// ─── Dynamic Context — injected as prefix of first user message ─────────────
// This changes per session/turn. Kept OUTSIDE the system prompt so
// the static system prompt prefix stays cached.

export function getDynamicContext(): string {
  return `<environment>
Working directory: ${getCwd()}
Platform: ${process.platform}
Node: ${process.version}
${getIsGitRepo() ? `Git branch: ${getGitBranch() || 'unknown'}` : 'Not a git repository'}
Date: ${new Date().toISOString().split('T')[0]}
</environment>`;
}

// ─── Memory Files (CLOW.md System) ──────────────────────────────────────────

interface MemoryFile {
  path: string;
  content: string;
  priority: number;
  type: 'managed' | 'user' | 'project' | 'local';
}

let memoryFilesCache: MemoryFile[] | null = null;

export function resetMemoryCache(): void {
  memoryFilesCache = null;
}

export async function loadMemoryFiles(): Promise<MemoryFile[]> {
  if (memoryFilesCache) return memoryFilesCache;

  const files: MemoryFile[] = [];
  let priority = 0;

  // 1. User-level: ~/.clow/CLOW.md
  const userClowMd = path.join(os.homedir(), '.clow', 'CLOW.md');
  const userContent = await safeReadFile(userClowMd);
  if (userContent) {
    files.push({ path: userClowMd, content: userContent, priority: priority++, type: 'user' });
  }

  // 2. Project-level: walk from CWD to root
  const dirs = getDirectoryChain(getCwd());
  for (const dir of dirs) {
    // CLOW.md
    const clowMd = path.join(dir, 'CLOW.md');
    const clowContent = await safeReadFile(clowMd);
    if (clowContent) {
      files.push({ path: clowMd, content: clowContent, priority: priority++, type: 'project' });
    }

    // .clow/CLOW.md
    const dotClowMd = path.join(dir, '.clow', 'CLOW.md');
    const dotClowContent = await safeReadFile(dotClowMd);
    if (dotClowContent) {
      files.push({ path: dotClowMd, content: dotClowContent, priority: priority++, type: 'project' });
    }

    // CLOW.local.md
    const localMd = path.join(dir, 'CLOW.local.md');
    const localContent = await safeReadFile(localMd);
    if (localContent) {
      files.push({ path: localMd, content: localContent, priority: priority++, type: 'local' });
    }
  }

  memoryFilesCache = files;
  return files;
}

export async function getMemoryPrompt(): Promise<string> {
  const files = await loadMemoryFiles();
  if (files.length === 0) return '';

  const sections = files.map((f) => {
    const label = f.type === 'user' ? '(user-level)' :
                  f.type === 'local' ? '(local, gitignored)' : '(project)';
    return `Contents of ${f.path} ${label}:\n\n${f.content}`;
  });

  return `# Project & User Instructions

The following instructions OVERRIDE default behavior. Follow them exactly.

${sections.join('\n\n---\n\n')}`;
}

// ─── Git Status (Memoized) ──────────────────────────────────────────────────

let gitStatusCache: string | null = null;

export function resetGitCache(): void {
  gitStatusCache = null;
}

export async function getGitStatus(): Promise<string> {
  if (gitStatusCache !== null) return gitStatusCache;

  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: getCwd(),
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

    setIsGitRepo(true);
    setGitBranch(branch);

    const status = execSync('git status --short', {
      cwd: getCwd(),
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

    const log = execSync('git log --oneline -5', {
      cwd: getCwd(),
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();

    gitStatusCache = `Branch: ${branch}\n\nStatus:\n${status || '(clean)'}\n\nRecent commits:\n${log}`;
  } catch {
    setIsGitRepo(false);
    gitStatusCache = 'Not a git repository';
  }

  return gitStatusCache;
}

// ─── Full Context Assembly ──────────────────────────────────────────────────

/**
 * assembleFullContext — returns STATIC system prompt (cacheable)
 * Memory files are appended because they're stable within a session.
 * Dynamic context (date, CWD, git) is NOT included — use getDynamicContext()
 * and prepend it to the first user message instead.
 */
export async function assembleFullContext(tenantId?: string): Promise<string> {
  const systemPrompt = getSystemPrompt();
  const memoryPrompt = await getMemoryPrompt();

  let fullPrompt = systemPrompt;

  if (memoryPrompt) {
    fullPrompt += '\n\n' + memoryPrompt;
  }

  // Inject persistent memory from past sessions
  try {
    const { generateMemoryContext } = await import('../../memory/MemoryContextInjector.js');
    const persistentMemory = generateMemoryContext(tenantId || 'default');
    if (persistentMemory) {
      fullPrompt += '\n\n' + persistentMemory;
    }
  } catch {
    // Memory system not available — continue without it
  }

  return fullPrompt;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function safeReadFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

function getDirectoryChain(startDir: string): string[] {
  const dirs: string[] = [];
  let current = startDir;
  const root = path.parse(current).root;

  while (current !== root) {
    dirs.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  // Reverse: process from root to CWD (closer = higher priority)
  return dirs.reverse();
}

// ─── Re-exports from new context assembly system ────────────────────────────

export { ContextAssembler } from './ContextAssembler.js';
export { MemoryFileWalker } from './memoryFileWalker.js';
export { UserContextBuilder } from './userContextBuilder.js';
export { DiscoveredSkillsTracker } from './discoveredSkillsTracker.js';
export { AdditionalDirectoriesManager } from './additionalDirectories.js';
export { ContextCache } from './contextCache.js';
export { ReinjectedAttachments } from './reinjectedAttachments.js';
export type { SystemPromptParts, UserContextBlock, AssembledContext, ContextAssemblyOptions, MemoryFileResult } from './types.js';
