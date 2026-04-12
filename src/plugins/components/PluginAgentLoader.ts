/**
 * PluginAgentLoader.ts — Load agent definitions from plugin markdown files
 *
 * Based on Claude Code's loadPluginAgents.ts (400 lines)
 *
 * Agent files are markdown with optional YAML frontmatter:
 *   ---
 *   description: Code reviewer agent
 *   allowed_tools: [Read, Grep, Glob]
 *   model: deepseek-chat
 *   category: development
 *   ---
 *   You are a code reviewer. Analyze code for...
 *
 * The body becomes the agent's system prompt.
 * Agents are available as subagent_type in the Agent tool.
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import type { PluginManifest, PluginAgentDef, PluginValidationError } from '../types.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_AGENTS_PER_PLUGIN = 20;
const MAX_PROMPT_SIZE = 50_000;
const FRONTMATTER_DELIMITER = '---';

// ════════════════════════════════════════════════════════════════════════════
// PluginAgentLoader Class
// ════════════════════════════════════════════════════════════════════════════

export class PluginAgentLoader {
  private errors: PluginValidationError[] = [];

  /**
   * Load all agents declared in manifest.
   */
  async loadAll(rootDir: string, manifest: PluginManifest): Promise<PluginAgentDef[]> {
    if (!manifest.agents || manifest.agents.length === 0) return [];

    this.errors = [];
    const agents: PluginAgentDef[] = [];
    const seenNames = new Set<string>();

    for (const pattern of manifest.agents) {
      const dir = path.join(rootDir, path.dirname(pattern).replace(/\*/g, ''));
      if (!fs.existsSync(dir)) continue;

      try {
        const entries = await fsp.readdir(dir);

        for (const entry of entries) {
          if (!entry.endsWith('.md')) continue;
          if (agents.length >= MAX_AGENTS_PER_PLUGIN) break;

          const filePath = path.join(dir, entry);

          try {
            const content = await fsp.readFile(filePath, 'utf-8');
            const agent = this.parseAgentFile(content, filePath, manifest.name);

            if (!agent) continue;

            // Duplicate check
            if (seenNames.has(agent.name)) {
              this.errors.push({
                code: 'DUPLICATE_AGENT',
                message: `Duplicate agent name: ${agent.name}`,
                severity: 'warning',
                filePath,
                recoverable: true,
              });
              continue;
            }

            // Size check
            if (agent.systemPrompt.length > MAX_PROMPT_SIZE) {
              this.errors.push({
                code: 'AGENT_PROMPT_TOO_LARGE',
                message: `Agent "${agent.name}" prompt is ${agent.systemPrompt.length} chars (max ${MAX_PROMPT_SIZE})`,
                severity: 'warning',
                filePath,
                recoverable: true,
              });
              continue;
            }

            seenNames.add(agent.name);
            agents.push(agent);
          } catch (err) {
            this.errors.push({
              code: 'AGENT_LOAD_FAILED',
              message: `Failed to load ${filePath}: ${(err as Error).message}`,
              severity: 'warning',
              filePath,
              recoverable: true,
            });
          }
        }
      } catch {}
    }

    return agents;
  }

  getLastErrors(): PluginValidationError[] {
    return [...this.errors];
  }

  // ─── Parse Agent File ─────────────────────────────────────────────

  private parseAgentFile(content: string, filePath: string, pluginName: string): PluginAgentDef | null {
    const name = path.basename(filePath, '.md').toLowerCase().replace(/[^a-z0-9-]/g, '-');

    // Try to extract frontmatter
    const { frontmatter, body } = this.splitFrontmatter(content);

    let description = `Agent from plugin ${pluginName}`;
    let allowedTools: string[] | undefined;
    let model: string | undefined;
    let category: string | undefined;

    if (frontmatter) {
      const parsed = this.parseFrontmatter(frontmatter);
      if (parsed) {
        if (typeof parsed.description === 'string') description = parsed.description;
        if (Array.isArray(parsed.allowed_tools)) allowedTools = parsed.allowed_tools;
        if (typeof parsed.model === 'string') model = parsed.model;
        if (typeof parsed.category === 'string') category = parsed.category;
      }
    }

    const systemPrompt = body.trim();
    if (!systemPrompt) {
      this.errors.push({
        code: 'AGENT_EMPTY_PROMPT',
        message: `Agent "${name}" has empty system prompt`,
        severity: 'warning',
        filePath,
        recoverable: true,
      });
      return null;
    }

    return {
      name,
      description,
      filePath,
      pluginName,
      systemPrompt,
      allowedTools,
      model,
      category,
    };
  }

  private splitFrontmatter(content: string): { frontmatter: string | null; body: string } {
    const lines = content.split('\n');
    let openIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      if (lines[i].trim() === FRONTMATTER_DELIMITER) { openIdx = i; break; }
      return { frontmatter: null, body: content };
    }
    if (openIdx === -1) return { frontmatter: null, body: content };
    let closeIdx = -1;
    for (let i = openIdx + 1; i < lines.length; i++) {
      if (lines[i].trim() === FRONTMATTER_DELIMITER) { closeIdx = i; break; }
    }
    if (closeIdx === -1) return { frontmatter: null, body: content };
    return { frontmatter: lines.slice(openIdx + 1, closeIdx).join('\n'), body: lines.slice(closeIdx + 1).join('\n') };
  }

  private parseFrontmatter(yaml: string): Record<string, unknown> | null {
    try {
      const result: Record<string, unknown> = {};
      let currentKey: string | null = null;
      let currentList: unknown[] | null = null;

      for (const line of yaml.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;

        // Top-level key: value
        const topMatch = line.match(/^([a-z_]\w*):\s*(.*)$/i);
        if (topMatch) {
          // Save previous list
          if (currentKey && currentList) result[currentKey] = currentList;
          currentList = null;

          const [, key, rawValue] = topMatch;
          currentKey = key;
          const value = rawValue.trim();

          if (value === '') { currentList = []; continue; }

          // Inline array: [a, b, c]
          if (value.startsWith('[') && value.endsWith(']')) {
            result[key] = value.slice(1, -1).split(',').map(s => this.parseValue(s.trim()));
            continue;
          }

          result[key] = this.parseValue(value);
          continue;
        }

        // List item
        const listMatch = line.match(/^\s+-\s+(.*)$/);
        if (listMatch && currentKey) {
          if (!currentList) currentList = [];
          currentList.push(this.parseValue(listMatch[1].trim()));
          continue;
        }
      }

      if (currentKey && currentList) result[currentKey] = currentList;
      return result;
    } catch { return null; }
  }

  private parseValue(v: string): unknown {
    const t = v.trim();
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (t === 'null' || t === '~') return null;
    if (/^-?\d+$/.test(t)) return parseInt(t, 10);
    if (/^-?\d+\.\d+$/.test(t)) return parseFloat(t);
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
    return t;
  }

  // ─── Validation Helpers ──────────────────────────────────────────

  /**
   * Validate agent name (kebab-case, max 60 chars).
   */
  private isValidAgentName(name: string): boolean {
    if (name.length === 0 || name.length > 60) return false;
    return /^[a-z][a-z0-9-]*$/.test(name);
  }

  /**
   * Get a summary of loaded agents for diagnostics.
   */
  summarize(): string {
    const errs = this.errors.length;
    return errs > 0 ? `${errs} errors during agent loading` : 'All agents loaded successfully';
  }
}
