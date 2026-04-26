/** Discover skills from builtin, user, project, plugin directories. */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { SkillParser } from './SkillParser.js';
import { SKILL_FILE_NAME } from './types.js';
import type { ParsedSkill, SkillFrontmatter } from './types.js';
import { getBuiltinSkills } from './builtInSkills.js';

export class SkillDiscovery {
  constructor(private readonly parser: SkillParser, private readonly clowHome = path.join(os.homedir(), '.clow')) {}

  async discoverAll(workspaceRoot: string): Promise<ParsedSkill[]> {
    const [builtin, user, project] = await Promise.all([
      Promise.resolve(getBuiltinSkills()),
      this.scanDir(path.join(this.clowHome, 'skills'), 'user'),
      this.scanDir(path.join(workspaceRoot, '.clow', 'skills'), 'project'),
    ]);
    return this.merge([...builtin, ...user, ...project]);
  }

  async discoverFromPlugin(pluginDir: string): Promise<ParsedSkill[]> {
    return this.scanDir(path.join(pluginDir, 'skills'), 'plugin');
  }

  private async scanDir(dir: string, source: SkillFrontmatter['source']): Promise<ParsedSkill[]> {
    if (!fs.existsSync(dir)) return [];
    const skills: ParsedSkill[] = [];
    try {
      for (const ent of await fsp.readdir(dir, { withFileTypes: true })) {
        if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
        for (const name of [SKILL_FILE_NAME, 'skill.md', 'Skill.md']) {
          const fp = path.join(dir, ent.name, name);
          if (!fs.existsSync(fp)) continue;
          const p = await this.parser.parse(fp);
          if (p) { p.frontmatter.source = source; skills.push(p); }
          break;
        }
      }
    } catch {}
    return skills;
  }

  private merge(skills: ParsedSkill[]): ParsedSkill[] {
    const byName = new Map<string, ParsedSkill>();
    const order: Record<string, number> = { project: 4, user: 3, builtin: 2, plugin: 1 };
    for (const s of skills) {
      const existing = byName.get(s.frontmatter.name);
      if (!existing || (order[s.frontmatter.source ?? 'plugin'] > order[existing.frontmatter.source ?? 'plugin'])) {
        byName.set(s.frontmatter.name, s);
      }
    }
    return [...byName.values()];
  }

  // ─── Discovery Diagnostics ───────────────────────────────────────

  /**
   * Get discovery statistics.
   */
  async getDiscoveryStats(workspaceRoot: string): Promise<{
    builtinCount: number;
    userCount: number;
    projectCount: number;
    totalAfterMerge: number;
    duplicatesResolved: number;
    discoveryTimeMs: number;
  }> {
    const startTime = Date.now();

    const [builtin, user, project] = await Promise.all([
      Promise.resolve(getBuiltinSkills()),
      this.scanDir(path.join(this.clowHome, 'skills'), 'user'),
      this.scanDir(path.join(workspaceRoot, '.clow', 'skills'), 'project'),
    ]);

    const all = [...builtin, ...user, ...project];
    const merged = this.merge(all);

    return {
      builtinCount: builtin.length,
      userCount: user.length,
      projectCount: project.length,
      totalAfterMerge: merged.length,
      duplicatesResolved: all.length - merged.length,
      discoveryTimeMs: Date.now() - startTime,
    };
  }

  /**
   * Check if a specific skill directory is valid.
   */
  async validateSkillDir(dir: string): Promise<{
    valid: boolean;
    skillName?: string;
    error?: string;
  }> {
    for (const name of [SKILL_FILE_NAME, 'skill.md', 'Skill.md']) {
      const fp = path.join(dir, name);
      if (!fs.existsSync(fp)) continue;

      const parsed = await this.parser.parse(fp);
      if (parsed) {
        return { valid: true, skillName: parsed.frontmatter.name };
      }
      return { valid: false, error: 'Failed to parse SKILL.md' };
    }

    return { valid: false, error: 'No SKILL.md found in directory' };
  }

  /**
   * Get all skill directories (without loading/parsing).
   */
  async listSkillDirs(workspaceRoot: string): Promise<string[]> {
    const dirs: string[] = [];

    const checkDir = async (baseDir: string) => {
      if (!fs.existsSync(baseDir)) return;
      try {
        for (const ent of await fsp.readdir(baseDir, { withFileTypes: true })) {
          if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
          const subDir = path.join(baseDir, ent.name);
          for (const name of [SKILL_FILE_NAME, 'skill.md']) {
            if (fs.existsSync(path.join(subDir, name))) {
              dirs.push(subDir);
              break;
            }
          }
        }
      } catch { /* skip */ }
    };

    await checkDir(path.join(this.clowHome, 'skills'));
    await checkDir(path.join(workspaceRoot, '.clow', 'skills'));

    return dirs;
  }

  // ─── File Watcher for Hot-Reload ────────────────────────────────────

  private watchers: Map<string, fs.FSWatcher> = new Map();
  private watchCallbacks: Array<(event: string, filePath: string) => void> = [];

  /**
   * Start watching skill directories for changes.
   * When a SKILL.md file is added, modified, or deleted,
   * registered callbacks are invoked for hot-reload.
   *
   * @param workspaceRoot - Workspace root to watch skill directories in
   * @param onChange - Callback invoked when a skill file changes
   */
  startWatching(workspaceRoot: string, onChange: (event: string, filePath: string) => void): void {
    this.watchCallbacks.push(onChange);

    const dirsToWatch = [
      path.join(this.clowHome, 'skills'),
      path.join(workspaceRoot, '.clow', 'skills'),
    ];

    for (const dir of dirsToWatch) {
      if (!fs.existsSync(dir)) continue;
      if (this.watchers.has(dir)) continue;

      try {
        const watcher = fs.watch(dir, { recursive: true }, (eventType, filename) => {
          if (!filename) return;
          const filePath = path.join(dir, filename);

          // Only react to skill files
          const basename = path.basename(filename);
          if (basename !== SKILL_FILE_NAME && basename !== 'skill.md' && basename !== 'Skill.md') {
            return;
          }

          for (const cb of this.watchCallbacks) {
            try {
              cb(eventType, filePath);
            } catch (err) {
              console.warn(`[SkillDiscovery] Watch callback error: ${(err as Error).message}`);
            }
          }
        });

        this.watchers.set(dir, watcher);
      } catch (err) {
        console.warn(`[SkillDiscovery] Failed to watch ${dir}: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Stop all file watchers.
   */
  stopWatching(): void {
    for (const [dir, watcher] of this.watchers) {
      try {
        watcher.close();
      } catch { /* ignore */ }
    }
    this.watchers.clear();
    this.watchCallbacks = [];
  }

  /**
   * Check if watching is active.
   */
  isWatching(): boolean {
    return this.watchers.size > 0;
  }

  // ─── Discovery Performance Tracking ─────────────────────────────────

  private discoveryRuns: Array<{
    timestamp: number;
    durationMs: number;
    skillsFound: number;
    errors: number;
    source: string;
  }> = [];

  /**
   * Track a discovery run for performance monitoring.
   *
   * @param durationMs - How long the discovery took
   * @param skillsFound - Number of skills found
   * @param errors - Number of errors encountered
   * @param source - Which source was scanned
   */
  recordDiscoveryRun(durationMs: number, skillsFound: number, errors: number, source: string): void {
    this.discoveryRuns.push({
      timestamp: Date.now(),
      durationMs,
      skillsFound,
      errors,
      source,
    });

    // Keep only last 50 runs
    if (this.discoveryRuns.length > 50) {
      this.discoveryRuns = this.discoveryRuns.slice(-50);
    }
  }

  /**
   * Get discovery performance statistics.
   */
  getPerformanceStats(): {
    totalRuns: number;
    avgDurationMs: number;
    maxDurationMs: number;
    totalSkillsFound: number;
    totalErrors: number;
    lastRunAt: number | null;
  } {
    if (this.discoveryRuns.length === 0) {
      return { totalRuns: 0, avgDurationMs: 0, maxDurationMs: 0, totalSkillsFound: 0, totalErrors: 0, lastRunAt: null };
    }

    const totalDuration = this.discoveryRuns.reduce((sum, r) => sum + r.durationMs, 0);
    const maxDuration = Math.max(...this.discoveryRuns.map(r => r.durationMs));
    const totalSkills = this.discoveryRuns.reduce((sum, r) => sum + r.skillsFound, 0);
    const totalErrors = this.discoveryRuns.reduce((sum, r) => sum + r.errors, 0);

    return {
      totalRuns: this.discoveryRuns.length,
      avgDurationMs: Math.round(totalDuration / this.discoveryRuns.length),
      maxDurationMs: maxDuration,
      totalSkillsFound: totalSkills,
      totalErrors: totalErrors,
      lastRunAt: this.discoveryRuns[this.discoveryRuns.length - 1].timestamp,
    };
  }

  // ─── Skill Directory Creation Helper ────────────────────────────────

  /**
   * Create a new skill directory with a template SKILL.md file.
   * Creates both the directory and the initial skill file.
   *
   * @param baseDir - Base skills directory (e.g., ~/.clow/skills/)
   * @param skillName - Name for the new skill (used as directory name)
   * @param description - Skill description for the frontmatter
   * @param body - Initial body content for the skill
   * @returns Path to the created SKILL.md file, or null on failure
   */
  async createSkillDirectory(
    baseDir: string,
    skillName: string,
    description: string,
    body: string = '# Instructions\n\nDescribe what this skill does here.',
  ): Promise<string | null> {
    try {
      // Sanitize skill name for directory
      const dirName = skillName
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');

      if (!dirName) return null;

      const skillDir = path.join(baseDir, dirName);

      // Create directory
      if (!fs.existsSync(skillDir)) {
        await fsp.mkdir(skillDir, { recursive: true });
      }

      // Create SKILL.md using parser helper
      return await this.parser.createSkillFile(skillDir, skillName, description, body);
    } catch (err) {
      console.warn(`[SkillDiscovery] Failed to create skill directory: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * List available skill directory locations.
   */
  getSkillDirectoryPaths(workspaceRoot: string): {
    user: string;
    project: string;
    clowHome: string;
  } {
    return {
      user: path.join(this.clowHome, 'skills'),
      project: path.join(workspaceRoot, '.clow', 'skills'),
      clowHome: this.clowHome,
    };
  }
}
