/**
 * MemoryHookHandlers.ts — Hook handlers for persistent memory
 *
 * 3 handlers registered via HookEngine.registerFunctionHook():
 *   - SessionStart: create session record, inject past memory context
 *   - PostToolUse: record tool usage observation (fire-and-forget)
 *   - SessionEnd: generate session summary via LLM, store it
 */

import type { HookInput, HookOutput } from '../../hooks/types.js';
import { MemoryStore } from '../MemoryStore.js';
import { generateMemoryContext } from '../MemoryContextInjector.js';

// ════════════════════════════════════════════════════════════════════════════
// Store Cache (per tenant)
// ════════════════════════════════════════════════════════════════════════════

const storeCache = new Map<string, MemoryStore>();

function getStore(tenantId: string = 'default'): MemoryStore {
  if (!storeCache.has(tenantId)) {
    storeCache.set(tenantId, new MemoryStore(tenantId));
  }
  return storeCache.get(tenantId)!;
}

// ════════════════════════════════════════════════════════════════════════════
// SessionStart Handler
// ════════════════════════════════════════════════════════════════════════════

/**
 * On session start:
 * 1. Create a memory_sessions record
 * 2. Generate memory context from past sessions
 * 3. Return it as systemMessage for injection
 */
export async function handleSessionStart(input: HookInput): Promise<HookOutput | null> {
  try {
    const tenantId = input.tenant_id || 'default';
    const store = getStore(tenantId);

    // Record this session
    store.recordSession(input.session_id, input.cwd);

    // Generate memory context from past sessions
    const memoryContext = generateMemoryContext(tenantId);

    if (memoryContext) {
      return {
        continue: true,
        systemMessage: memoryContext,
      };
    }

    return null;
  } catch (err) {
    console.warn(`[Memory] SessionStart hook error: ${(err as Error).message}`);
    return null; // Never block the session
  }
}

// ════════════════════════════════════════════════════════════════════════════
// PostToolUse Handler
// ════════════════════════════════════════════════════════════════════════════

/**
 * After each tool use:
 * Record an observation with tool name, files, and a short title.
 * Fire-and-forget — returns null (no output needed).
 */
export async function handlePostToolUse(input: HookInput): Promise<HookOutput | null> {
  try {
    const tenantId = input.tenant_id || 'default';
    const store = getStore(tenantId);
    const toolName = input.tool_name || 'unknown';

    // Skip noisy/internal tools
    if (SKIP_TOOLS.has(toolName)) return null;

    // Extract files from tool input
    const files = extractFiles(input.tool_input);

    // Build title
    const title = buildTitle(toolName, input.tool_input);

    // Build narrative
    const narrative = buildNarrative(toolName, input.tool_input, input.tool_output);

    // Determine type
    const type = WRITE_TOOLS.has(toolName) ? 'file_change' : 'tool_use';

    store.recordObservation({
      sessionId: input.session_id,
      toolName,
      type,
      title,
      narrative,
      filesTouched: files.length > 0 ? files : undefined,
    });
  } catch (err) {
    console.warn(`[Memory] PostToolUse hook error: ${(err as Error).message}`);
  }

  return null;
}

// ════════════════════════════════════════════════════════════════════════════
// SessionEnd Handler
// ════════════════════════════════════════════════════════════════════════════

/**
 * On session end:
 * 1. Load all observations for this session
 * 2. Generate a structured summary (via LLM or fallback)
 * 3. Store the summary
 * 4. Mark session as completed
 */
export async function handleSessionEnd(input: HookInput): Promise<HookOutput | null> {
  try {
    const tenantId = input.tenant_id || 'default';
    const store = getStore(tenantId);

    const observations = store.getSessionObservations(input.session_id);
    if (observations.length === 0) {
      store.endSession(input.session_id, 'completed');
      return null;
    }

    // Try LLM summary, fallback to simple concatenation
    let summary: {
      request?: string;
      investigated?: string;
      learned?: string;
      completed?: string;
      nextSteps?: string;
    };

    try {
      summary = await generateLLMSummary(observations);
    } catch {
      summary = generateFallbackSummary(observations);
    }

    // Collect all files touched
    const allFiles = new Set<string>();
    for (const obs of observations) {
      if (obs.files_touched) {
        try {
          const files = JSON.parse(obs.files_touched) as string[];
          files.forEach(f => allFiles.add(f));
        } catch {}
      }
    }

    store.recordSummary({
      sessionId: input.session_id,
      ...summary,
      filesTouched: Array.from(allFiles),
    });

    store.endSession(input.session_id, 'completed');
  } catch (err) {
    console.warn(`[Memory] SessionEnd hook error: ${(err as Error).message}`);
  }

  return null;
}

// ════════════════════════════════════════════════════════════════════════════
// LLM Summary Generation
// ════════════════════════════════════════════════════════════════════════════

async function generateLLMSummary(observations: import('../MemoryStore.js').Observation[]): Promise<{
  request?: string;
  investigated?: string;
  learned?: string;
  completed?: string;
  nextSteps?: string;
}> {
  // Dynamic import to avoid circular deps
  const anthropicModule = await import('../../api/anthropic.js');
  // getAnthropicClient() returns the already-initialized client
  const client = (anthropicModule as any).getAnthropicClient
    ? (anthropicModule as any).getAnthropicClient()
    : null;
  if (!client) throw new Error('Anthropic client not available');

  const obsList = observations
    .map(o => `- [${o.tool_name}] ${o.title}${o.narrative ? ': ' + o.narrative : ''}`)
    .join('\n');

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20250315',
    max_tokens: 500,
    messages: [{
      role: 'user',
      content: `Analise estas observações de uma sessão de trabalho e gere um resumo estruturado em JSON.
Responda APENAS com JSON válido, sem markdown.

Observações:
${obsList}

Formato:
{
  "request": "o que o usuário pediu (1 linha)",
  "investigated": "o que foi investigado/explorado (1-2 linhas)",
  "learned": "descobertas e aprendizados chave (1-2 linhas)",
  "completed": "o que foi realizado/concluído (1-2 linhas)",
  "nextSteps": "próximos passos sugeridos (1 linha, opcional)"
}`,
    }],
  });

  const text = response.content[0]?.type === 'text' ? response.content[0].text : '';

  // Extract JSON from response
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON found in LLM response');

  return JSON.parse(jsonMatch[0]);
}

function generateFallbackSummary(observations: import('../MemoryStore.js').Observation[]): {
  request?: string;
  investigated?: string;
  learned?: string;
  completed?: string;
} {
  const titles = observations.map(o => o.title).filter(Boolean);
  const tools = [...new Set(observations.map(o => o.tool_name).filter(Boolean))];

  return {
    request: 'Sessão de trabalho',
    investigated: `Usou ${tools.length} ferramentas: ${tools.join(', ')}`,
    completed: titles.slice(0, 5).join('; '),
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════════════

const SKIP_TOOLS = new Set(['TodoWrite', 'StatusLine', 'EnterPlanMode', 'ExitPlanMode']);
const WRITE_TOOLS = new Set(['Write', 'Edit', 'FileWrite', 'FileEdit']);

function extractFiles(toolInput: unknown): string[] {
  if (!toolInput || typeof toolInput !== 'object') return [];
  const input = toolInput as Record<string, unknown>;

  const files: string[] = [];
  if (typeof input.file_path === 'string') files.push(input.file_path);
  if (typeof input.path === 'string') files.push(input.path);
  if (typeof input.pattern === 'string') files.push(input.pattern);

  return files;
}

function buildTitle(toolName: string, toolInput: unknown): string {
  if (!toolInput || typeof toolInput !== 'object') return toolName;
  const input = toolInput as Record<string, unknown>;

  if (typeof input.file_path === 'string') {
    const file = input.file_path.split(/[/\\]/).pop() || input.file_path;
    return `${toolName}: ${file}`;
  }
  if (typeof input.command === 'string') {
    return `${toolName}: ${String(input.command).slice(0, 60)}`;
  }
  if (typeof input.pattern === 'string') {
    return `${toolName}: ${input.pattern}`;
  }
  if (typeof input.query === 'string') {
    return `${toolName}: ${String(input.query).slice(0, 50)}`;
  }

  return toolName;
}

function buildNarrative(toolName: string, toolInput: unknown, toolOutput: unknown): string {
  const parts: string[] = [];

  if (toolInput && typeof toolInput === 'object') {
    const input = toolInput as Record<string, unknown>;
    if (typeof input.file_path === 'string') parts.push(`arquivo: ${input.file_path}`);
    if (typeof input.command === 'string') parts.push(`comando: ${String(input.command).slice(0, 80)}`);
  }

  if (toolOutput && typeof toolOutput === 'string') {
    parts.push(`resultado: ${toolOutput.slice(0, 100)}`);
  }

  return parts.join(' | ').slice(0, 200);
}
