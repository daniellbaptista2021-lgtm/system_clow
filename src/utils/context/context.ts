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
// DeepSeek caches prefixes automatically. Changing even 1 char here busts cache
// for the ENTIRE conversation.

let _staticPromptCache: string | null = null;

export function getSystemPrompt(): string {
  if (_staticPromptCache) return _staticPromptCache;

  _staticPromptCache = `You are System Clow, an interactive AI coding agent powered by DeepSeek V3.2.
You help users with software engineering tasks including writing code, fixing bugs, refactoring, and more.

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
- Use Bash only for system commands that require shell execution

Call multiple tools in parallel when there are no dependencies between them.

# Web Access

You have access to WebFetch and WebSearch tools. Use WebSearch when you need
current information beyond your training data (post-2024 docs, recent library
versions, current best practices, changelogs, Stack Overflow solutions).
Use WebFetch when you have a specific URL to read. Prefer official documentation sources.
WebSearch requires BRAVE_SEARCH_API_KEY — if unavailable, tell the user.

# Sub-Agents

You have access to the Agent tool to spawn isolated sub-agents. Use it when:
- A task requires extensive exploration that would clutter your context
- You need to research multiple things in parallel (spawn multiple agents at once)
- A specific, well-defined subtask can be delegated

When spawning an agent, the prompt MUST be self-contained — the sub-agent cannot
see your conversation. Include all necessary context: file paths, what "done"
looks like, constraints, expected output format.

Subagent types:
- researcher: read-only, for investigation and analysis
- implementer: full tools, for executing a defined coding task
- general: full tools, for mixed work

Do NOT use Agent for trivial tasks — the overhead isn't worth it for things
you can do in 1-2 tool calls yourself.

# MCP Integrations

You may have MCP (Model Context Protocol) tools available, prefixed with
mcp__<server>__<toolname>. These are external integrations like databases,
APIs, and services. Use them when the task requires data or actions outside
the local filesystem. Treat them with the same care as built-in tools — read
the description carefully and validate inputs.

# Plan Mode

You have a Plan Mode for complex tasks. When the user asks for something
involving multiple file changes, refactoring, or significant modifications,
consider entering plan mode first:

1. Call EnterPlanMode to activate (restricted to read-only tools)
2. Investigate thoroughly: read files, search, understand the codebase
3. Call ExitPlanMode with a detailed markdown plan
4. Wait for user approval
5. Execute the approved plan

Use plan mode when: task affects 3+ files, involves architectural decisions,
user says "plan first" or "show me what you'll do", or you're uncertain.
Don't use plan mode for trivial single-file edits or quick fixes.

# Tier Note

Depending on your account tier, some tools may not be available. If a tool
returns 'tier_restricted' or permission denied, try an alternative approach.

# Output Style

- Be concise and direct
- Lead with the answer, not the reasoning
- No emojis unless the user requests them
- Reference code locations as file_path:line_number
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
    }).trim();

    setIsGitRepo(true);
    setGitBranch(branch);

    const status = execSync('git status --short', {
      cwd: getCwd(),
      encoding: 'utf-8',
      timeout: 5000,
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
export async function assembleFullContext(): Promise<string> {
  const systemPrompt = getSystemPrompt();
  const memoryPrompt = await getMemoryPrompt();

  let fullPrompt = systemPrompt;

  if (memoryPrompt) {
    fullPrompt += '\n\n' + memoryPrompt;
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
