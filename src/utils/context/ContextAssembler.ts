/**
 * ContextAssembler.ts — Orchestrates system prompt + dynamic context assembly.
 *
 * KEY: system prompt is STATIC (cacheable). Dynamic context goes as first user message.
 * This preserves prefix stability for prompt caching across repeated turns.
 */

import * as crypto from 'crypto';
import { MemoryFileWalker } from './memoryFileWalker.js';
import { UserContextBuilder } from './userContextBuilder.js';
import { DiscoveredSkillsTracker } from './discoveredSkillsTracker.js';
import { ContextCache } from './contextCache.js';
import type { SystemPromptParts, UserContextBlock, AssembledContext, ContextAssemblyOptions, MemoryFileResult } from './types.js';

export class ContextAssembler {
  private memoryWalker: MemoryFileWalker;
  private userCtxBuilder: UserContextBuilder;
  private skillsTracker: DiscoveredSkillsTracker;
  private cache: ContextCache;

  constructor() {
    this.memoryWalker = new MemoryFileWalker();
    this.userCtxBuilder = new UserContextBuilder();
    this.skillsTracker = new DiscoveredSkillsTracker();
    this.cache = new ContextCache();
  }

  async assemble(opts: ContextAssemblyOptions): Promise<AssembledContext> {
    // 1. Build system prompt (STATIC for cache)
    const parts = await this.buildParts(opts);
    const systemPrompt = this.layer(parts);

    // 2. Build dynamic context (goes as first user message)
    const userCtx = await this.userCtxBuilder.build({
      cwd: opts.cwd, workspaceRoot: opts.workspaceRoot,
      additionalWorkingDirectories: opts.additionalWorkingDirectories,
      tenantTier: opts.tenantTier, tenantId: opts.tenantId,
      permissionMode: opts.permissionMode, agentDepth: opts.agentDepth,
    });
    const dynamicContextMessage = this.formatDynamic(userCtx);

    // 3. Skills
    const discovered = Array.from(this.skillsTracker.toArray());

    // 4. Hash stable parts for cache validation
    const toolNames = opts.tools.map((t: any) => t.name).sort().join(',');
    const cacheableHash = crypto.createHash('sha256').update(`${systemPrompt}|${toolNames}`).digest('hex').slice(0, 16);

    return {
      systemPrompt,
      dynamicContextMessage,
      memoryMechanicsActive: !!parts.memoryMechanicsPrompt,
      discoveredSkills: discovered,
      cacheableHash,
      estimatedTokens: Math.ceil((systemPrompt.length + dynamicContextMessage.length) / 4),
    };
  }

  // ── Build prompt parts ──────────────────────────────────────────

  private async buildParts(opts: ContextAssemblyOptions): Promise<SystemPromptParts> {
    const defaultParts: string[] = [];

    // Layer 1: persona
    defaultParts.push(this.buildPersona(opts.mainLoopModel));

    // Layer 2: tool docs (sorted alphabetically for cache stability)
    defaultParts.push(this.buildToolDocs(opts.tools));

    // Layer 3: coordinator (if enabled)
    if (opts.isCoordinatorMode) defaultParts.push(this.buildCoordinator(opts));

    // Memory mechanics
    let memoryPrompt: string | undefined;
    const cacheKey = `${opts.cwd}|${opts.workspaceRoot}`;
    let memFiles = this.cache.getMemoryFiles(cacheKey);
    if (!memFiles) {
      memFiles = await this.memoryWalker.walk(opts.cwd, opts.workspaceRoot);
      this.cache.setMemoryFiles(cacheKey, memFiles);
    }
    if (memFiles.length > 0) memoryPrompt = this.buildMemoryPrompt(memFiles);

    return {
      defaultSystemPrompt: defaultParts,
      memoryMechanicsPrompt: memoryPrompt,
      appendSystemPrompt: opts.appendSystemPrompt,
      customSystemPrompt: opts.customSystemPrompt,
    };
  }

  // ── Layer: custom (or default) → memory → append ──────────────

  private layer(parts: SystemPromptParts): string {
    const layers: string[] = [];
    if (parts.customSystemPrompt) layers.push(parts.customSystemPrompt);
    else layers.push(...parts.defaultSystemPrompt);
    if (parts.memoryMechanicsPrompt) layers.push(parts.memoryMechanicsPrompt);
    if (parts.appendSystemPrompt) layers.push(parts.appendSystemPrompt);
    return layers.join('\n\n');
  }

  // ── Dynamic context as <environment> XML ──────────────────────

  private formatDynamic(ctx: UserContextBlock): string {
    const lines = ['<environment>'];
    lines.push(`Working directory: ${ctx.cwd}`);
    lines.push(`Platform: ${ctx.platform}`);
    lines.push(`Node: ${ctx.nodeVersion}`);
    lines.push(`Date: ${ctx.date}`);
    lines.push(`Permission mode: ${ctx.permissionMode}`);
    if (ctx.tenantTier) lines.push(`Tier: ${ctx.tenantTier}`);
    if (ctx.agentDepth > 0) lines.push(`Agent depth: ${ctx.agentDepth}`);
    if (ctx.isGitRepo) {
      lines.push(`Git branch: ${ctx.gitBranch}`);
      if (ctx.gitStatus) lines.push(`Git status: ${ctx.gitStatus}`);
    }
    if (ctx.recentlyModifiedFiles?.length) lines.push(`Recent files: ${ctx.recentlyModifiedFiles.join(', ')}`);
    if (ctx.additionalWorkingDirectories?.length) lines.push(`Additional dirs: ${ctx.additionalWorkingDirectories.join(', ')}`);
    lines.push('</environment>');
    return lines.join('\n');
  }

  // ── Persona ───────────────────────────────────────────────────

  private buildPersona(model: string): string {
    return `You are System Clow, an autonomous coding agent powered by ${model}.

## REGRAS DE CONCLUSAO DE TAREFA (OBRIGATORIO)

1. NUNCA marque uma tarefa como concluida ate que o output solicitado pelo usuario tenha sido EFETIVAMENTE ENTREGUE na conversa (arquivo enviado, codigo colado, planilha gerada, link fornecido, etc).

2. "Entendi o que voce quer" NAO e conclusao. "Vou fazer" NAO e conclusao. Conclusao e SOMENTE quando o artefato final esta visivel para o usuario.

3. Se o usuario pedir um arquivo (planilha, documento, codigo, etc), voce DEVE:
   a) Executar a tarefa completa
   b) Gerar/modificar o arquivo
   c) Enviar o arquivo ou seu conteudo na resposta
   d) SO ENTAO marcar como concluido

4. Se o contexto da conversa ficar longo demais, faca um resumo interno do estado atual da tarefa ANTES de continuar, mas NUNCA descarte o objetivo original do usuario.

5. Se voce perceber que vai perder contexto, diga ao usuario: "Estou com contexto longo, vou resumir o que temos ate aqui e continuar." — e continue ate entregar.

6. PROIBIDO usar "concluido" ou equivalente sem ter entregue o que foi pedido.

# Core Principles
1. Be precise — do exactly what's asked, not more, not less.
2. Think before acting — use EnterPlanMode for complex tasks.
3. Verify your work — run tests, type checks after changes.
4. Communicate clearly — surface blockers, don't hide errors.
5. Respect the workspace — no destructive ops without confirmation.

# Tool Usage
- Use Read instead of cat/head/tail
- Use Edit instead of sed/awk
- Use Write instead of echo/heredoc
- Use Glob instead of find/ls
- Use Grep instead of grep/rg
- Use Bash only for commands that need shell execution
- Use WebSearch for current info beyond training cutoff
- Use WebFetch for specific URLs
- Use Agent for tasks that would clutter your context
- Use EnterPlanMode for tasks affecting 3+ files

Call tools in parallel when independent. Never retry blindly on failure.

# Style
- Concise by default. Long explanations only when warranted.
- No unnecessary preamble. No excessive apologies.
- Code blocks for code, bold for emphasis.

# Tier Note
Some tools may not be available depending on account tier. If a tool returns tier_restricted, try an alternative approach.`;
  }

  // ── Tool documentation (alphabetical for cache stability) ─────

  private buildToolDocs(tools: any[]): string {
    const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
    const lines = ['## Available Tools', ''];
    for (const t of sorted) {
      const desc = typeof t.description === 'string' ? t.description.split('\n')[0] : '(see schema)';
      lines.push(`- **${t.name}**: ${desc}`);
    }
    return lines.join('\n');
  }

  // ── Coordinator mode ──────────────────────────────────────────

  private buildCoordinator(opts: ContextAssemblyOptions): string {
    return `## Coordinator Mode
You spawn worker sub-agents. Workers can't see your conversation — prompts must be self-contained.
${opts.scratchpadDir ? `Scratchpad: ${opts.scratchpadDir}` : ''}
Workflow: Research → Synthesis → Implementation → Verification.`;
  }

  // ── Memory files ──────────────────────────────────────────────

  private buildMemoryPrompt(files: MemoryFileResult[]): string {
    const lines = ['## Project Memory', '', 'Follow these instructions:'];
    for (const f of files) {
      lines.push(`\n### ${f.path} (${f.source})\n`);
      lines.push(f.content);
    }
    return lines.join('\n');
  }

  // ── Public accessors ──────────────────────────────────────────

  getSkillsTracker(): DiscoveredSkillsTracker { return this.skillsTracker; }
  invalidateCache(): void { this.cache.clearAll(); this.userCtxBuilder.invalidateCache(); }
}
