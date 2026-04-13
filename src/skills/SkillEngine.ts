/**
 * SkillEngine.ts — Main orchestrator for the skills system
 *
 * Based on Claude Code's skillEngine.ts (~300 lines)
 *
 * Features:
 *   - Discover skills from all sources (builtin, user, project, plugin)
 *   - Match skills against context (message, tool use, file operations)
 *   - Inject matched skills into system message
 *   - Track which skills have been invoked
 *   - Load skill references on demand
 *   - Hot-reload skills
 *   - Statistics tracking
 */

import * as path from 'path';
import * as os from 'os';
import { SkillParser } from './SkillParser.js';
import { SkillDiscovery } from './SkillDiscovery.js';
import { SkillMatcher } from './SkillMatcher.js';
import { SkillInjector } from './SkillInjector.js';
import { SkillRegistry } from './SkillRegistry.js';
import { SkillContextProvider } from './SkillContextProvider.js';
import { SkillReferenceLoader } from './SkillReferenceLoader.js';
import type { ParsedSkill, SkillInjectionResult, SkillReference, SkillContext, SkillMatchResult } from './types.js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface SkillEngineStats {
  initialized: boolean;
  totalSkills: number;
  totalMatches: number;
  totalInjections: number;
  totalTokensInjected: number;
  matchTimeMs: number;
  discoveryTimeMs: number;
}

// ════════════════════════════════════════════════════════════════════════════
// SkillEngine Class
// ════════════════════════════════════════════════════════════════════════════

export class SkillEngine {
  private discovery: SkillDiscovery;
  private parser = new SkillParser();
  private matcher = new SkillMatcher();
  private injector = new SkillInjector();
  private registry = new SkillRegistry();
  private ctxProvider = new SkillContextProvider();
  private refLoader = new SkillReferenceLoader();

  private stats: SkillEngineStats = {
    initialized: false,
    totalSkills: 0,
    totalMatches: 0,
    totalInjections: 0,
    totalTokensInjected: 0,
    matchTimeMs: 0,
    discoveryTimeMs: 0,
  };

  constructor(deps: { clowHome?: string } = {}) {
    this.discovery = new SkillDiscovery(this.parser, deps.clowHome);
  }

  // ─── Initialization ──────────────────────────────────────────────

  /**
   * Initialize: discover all skills from all sources.
   */
  async initialize(workspaceRoot: string): Promise<void> {
    const startTime = Date.now();
    const skills = await this.discovery.discoverAll(workspaceRoot);
    await this.registry.loadAll(skills);
    this.stats.initialized = true;
    this.stats.totalSkills = skills.length;
    this.stats.discoveryTimeMs = Date.now() - startTime;

    if (skills.length > 0 && process.env.CLOW_QUIET_BOOTSTRAP !== '1') {
      console.log(`[SkillEngine] Discovered ${skills.length} skills in ${this.stats.discoveryTimeMs}ms`);
    }
  }

  /**
   * Add skills from a plugin directory.
   */
  async addPluginSkills(pluginDir: string): Promise<number> {
    const skills = await this.discovery.discoverFromPlugin(pluginDir);
    const all = [...this.registry.list(), ...skills];
    await this.registry.loadAll(all);
    this.stats.totalSkills = all.length;
    return skills.length;
  }

  // ─── Matching ────────────────────────────────────────────────────

  /**
   * Match skills for a user message.
   * Returns injection result with formatted system message addition.
   */
  async matchForMessage(params: {
    message: string;
    sessionId: string;
    cwd: string;
    workspaceRoot: string;
    isFirstMessage: boolean;
    tier?: string;
  }): Promise<SkillInjectionResult> {
    const startTime = Date.now();
    const ctx = this.ctxProvider.buildFromMessage(params);
    const matches = await this.matcher.matchAll(this.registry.listActive(), ctx);
    const result = this.injector.inject(matches);

    // Track invoked skills
    for (const skill of result.injectedSkills) {
      this.registry.markInvoked(skill.frontmatter.name);
    }

    this.stats.totalMatches += matches.length;
    this.stats.totalInjections += result.injectedSkills.length;
    this.stats.totalTokensInjected += result.estimatedTokens;
    this.stats.matchTimeMs += Date.now() - startTime;

    return result;
  }

  /**
   * Match skills for a tool use event.
   */
  async matchForToolUse(params: {
    toolName: string;
    toolInput: unknown;
    sessionId: string;
    cwd: string;
    workspaceRoot: string;
    tier?: string;
  }): Promise<SkillInjectionResult> {
    const ctx = this.ctxProvider.buildFromToolUse(params);
    const matches = await this.matcher.matchAll(this.registry.listActive(), ctx);
    return this.injector.inject(matches);
  }

  /**
   * Get raw match results without injection (for debugging).
   */
  async getMatches(ctx: SkillContext): Promise<SkillMatchResult[]> {
    return this.matcher.matchAll(this.registry.listActive(), ctx);
  }

  // ─── References ──────────────────────────────────────────────────

  /**
   * Load reference files for a skill.
   */
  async loadReferences(skillName: string): Promise<SkillReference[]> {
    const skill = this.registry.getByName(skillName);
    return skill ? this.refLoader.loadMany(skill.references) : [];
  }

  // ─── Queries ─────────────────────────────────────────────────────

  getInvokedSkillNames(): string[] { return this.registry.getInvoked(); }

  async loadSkillForRestoration(name: string): Promise<{ path: string; content: string } | null> {
    const skill = this.registry.getByName(name);
    return skill ? { path: skill.filePath, content: skill.body } : null;
  }

  list(): ParsedSkill[] { return this.registry.list(); }
  getByName(name: string): ParsedSkill | null { return this.registry.getByName(name); }
  getParser(): SkillParser { return this.parser; }
  getRegistry(): SkillRegistry { return this.registry; }
  getStats(): SkillEngineStats { return { ...this.stats }; }

  // ─── Hot Reload ──────────────────────────────────────────────────

  /**
   * Hot-reload all skills (re-discover from all sources).
   */
  async hotReload(workspaceRoot: string): Promise<{ added: number; removed: number }> {
    const before = new Set(this.registry.list().map(s => s.frontmatter.name));
    await this.initialize(workspaceRoot);
    const after = new Set(this.registry.list().map(s => s.frontmatter.name));

    let added = 0, removed = 0;
    for (const name of after) if (!before.has(name)) added++;
    for (const name of before) if (!after.has(name)) removed++;

    return { added, removed };
  }

  /**
   * Reload a single skill by name (if file changed).
   */
  async reloadSkill(name: string): Promise<boolean> {
    const skill = this.registry.getByName(name);
    if (!skill) return false;

    const reloaded = await this.parser.parse(skill.filePath);
    if (!reloaded) return false;

    // Replace in registry
    const all = this.registry.list().map(s =>
      s.frontmatter.name === name ? reloaded : s,
    );
    await this.registry.loadAll(all);
    return true;
  }
}
