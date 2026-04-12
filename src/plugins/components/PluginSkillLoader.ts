/**
 * PluginSkillLoader.ts — Load skills from plugin directories
 *
 * Based on Claude Code's skillPluginLoader.ts (~300 lines)
 *
 * Features:
 *   - Glob pattern expansion for skill directories
 *   - SKILL.md detection (case-insensitive)
 *   - Skill frontmatter validation (name, triggers, references)
 *   - Skill body size limits
 *   - Duplicate skill name detection
 *   - Skill registration tracking
 *   - Reference file validation
 *   - Error recovery
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import type { PluginManifest } from '../types.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_SKILLS_PER_PLUGIN = 50;
const MAX_SKILL_BODY_CHARS = 100_000;
const MAX_SKILL_NAME_LENGTH = 60;
const SKILL_FILE_NAMES = ['SKILL.md', 'skill.md', 'Skill.md'];

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ResolvedPluginSkill {
  /** Skill name (derived from directory name or frontmatter) */
  name: string;
  /** Human-readable description */
  description: string;
  /** Absolute path to SKILL.md file */
  filePath: string;
  /** Absolute path to skill directory */
  dirPath: string;
  /** Plugin providing this skill */
  pluginName: string;
  /** Skill body content */
  body: string;
  /** Trigger types found in frontmatter */
  triggerTypes: string[];
  /** Reference files found in skill directory */
  referenceFiles: string[];
  /** Whether skill is auto-injectable or explicit only */
  autoInject: boolean;
}

interface SkillLoadError {
  filePath: string;
  error: string;
  recoverable: boolean;
}

// ════════════════════════════════════════════════════════════════════════════
// PluginSkillLoader Class
// ════════════════════════════════════════════════════════════════════════════

export class PluginSkillLoader {
  private loadErrors: SkillLoadError[] = [];

  /**
   * Load all skills declared in manifest.
   * Returns skill names for registration tracking.
   */
  async loadAll(rootDir: string, manifest: PluginManifest): Promise<string[]> {
    if (!manifest.skills || manifest.skills.length === 0) return [];

    this.loadErrors = [];
    const skills = await this.resolveAll(rootDir, manifest);
    return skills.map(s => s.name);
  }

  /**
   * Resolve all skills with full metadata.
   */
  async resolveAll(rootDir: string, manifest: PluginManifest): Promise<ResolvedPluginSkill[]> {
    if (!manifest.skills || manifest.skills.length === 0) return [];

    const skillDirs = await this.findAllSkillDirs(rootDir, manifest.skills);

    if (skillDirs.length === 0) return [];

    if (skillDirs.length > MAX_SKILLS_PER_PLUGIN) {
      this.loadErrors.push({
        filePath: rootDir,
        error: `Too many skills: ${skillDirs.length} (max ${MAX_SKILLS_PER_PLUGIN})`,
        recoverable: true,
      });
    }

    const skills: ResolvedPluginSkill[] = [];
    const seenNames = new Set<string>();

    for (const { dirPath, skillFilePath } of skillDirs.slice(0, MAX_SKILLS_PER_PLUGIN)) {
      try {
        const skill = await this.parseSkillDir(dirPath, skillFilePath, manifest.name);
        if (!skill) continue;

        if (seenNames.has(skill.name)) {
          this.loadErrors.push({
            filePath: skillFilePath,
            error: `Duplicate skill name: "${skill.name}"`,
            recoverable: true,
          });
          continue;
        }

        if (!this.isValidSkillName(skill.name)) {
          this.loadErrors.push({
            filePath: skillFilePath,
            error: `Invalid skill name: "${skill.name}"`,
            recoverable: true,
          });
          continue;
        }

        seenNames.add(skill.name);
        skills.push(skill);
      } catch (err) {
        this.loadErrors.push({
          filePath: skillFilePath,
          error: (err as Error).message,
          recoverable: true,
        });
      }
    }

    return skills;
  }

  getLastErrors(): SkillLoadError[] {
    return [...this.loadErrors];
  }

  // ════════════════════════════════════════════════════════════════════
  // Skill Directory Discovery
  // ════════════════════════════════════════════════════════════════════

  /**
   * Find all skill directories matching glob patterns.
   * Each skill directory must contain a SKILL.md file.
   */
  private async findAllSkillDirs(
    rootDir: string,
    patterns: string[],
  ): Promise<Array<{ dirPath: string; skillFilePath: string }>> {
    const results: Array<{ dirPath: string; skillFilePath: string }> = [];
    const seen = new Set<string>();

    for (const pattern of patterns) {
      const found = await this.findSkillDirsForPattern(rootDir, pattern);
      for (const item of found) {
        if (!seen.has(item.dirPath)) {
          seen.add(item.dirPath);
          results.push(item);
        }
      }
    }

    return results;
  }

  /**
   * Find skill directories for a single pattern.
   * Pattern like "skills/asterisk/SKILL.md" — expand the wildcard.
   */
  private async findSkillDirsForPattern(
    rootDir: string,
    pattern: string,
  ): Promise<Array<{ dirPath: string; skillFilePath: string }>> {
    const results: Array<{ dirPath: string; skillFilePath: string }> = [];

    // Parse pattern to find base directory
    const parts = pattern.split('/');
    const wildcardIdx = parts.findIndex(p => p.includes('*'));

    if (wildcardIdx === -1) {
      // No wildcard — treat as direct path
      const fullPath = path.join(rootDir, pattern);
      if (fs.existsSync(fullPath)) {
        const dirPath = path.dirname(fullPath);
        results.push({ dirPath, skillFilePath: fullPath });
      }
      return results;
    }

    // Get base directory (before the wildcard)
    const baseDir = path.join(rootDir, ...parts.slice(0, wildcardIdx));
    if (!fs.existsSync(baseDir)) return results;

    // Read subdirectories
    try {
      const entries = await fsp.readdir(baseDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

        const subDir = path.join(baseDir, entry.name);

        // Check for SKILL.md in this directory
        const skillFile = this.findSkillFile(subDir);
        if (skillFile) {
          results.push({ dirPath: subDir, skillFilePath: skillFile });
        }
      }
    } catch { /* skip */ }

    return results;
  }

  /**
   * Find SKILL.md file in a directory (case-insensitive).
   */
  private findSkillFile(dirPath: string): string | null {
    for (const fileName of SKILL_FILE_NAMES) {
      const fp = path.join(dirPath, fileName);
      if (fs.existsSync(fp)) return fp;
    }
    return null;
  }

  // ════════════════════════════════════════════════════════════════════
  // Skill Parsing
  // ════════════════════════════════════════════════════════════════════

  /**
   * Parse a skill directory.
   */
  private async parseSkillDir(
    dirPath: string,
    skillFilePath: string,
    pluginName: string,
  ): Promise<ResolvedPluginSkill | null> {
    const content = await fsp.readFile(skillFilePath, 'utf-8');

    // Check size
    if (content.length > MAX_SKILL_BODY_CHARS) {
      this.loadErrors.push({
        filePath: skillFilePath,
        error: `Skill body too large: ${content.length} chars (max ${MAX_SKILL_BODY_CHARS})`,
        recoverable: true,
      });
      return null;
    }

    // Parse frontmatter
    const { frontmatter, body } = this.splitFrontmatter(content);
    const parsed = frontmatter ? this.parseFrontmatter(frontmatter) : {};

    // Derive name from directory or frontmatter
    const dirName = path.basename(dirPath);
    const name = (parsed.name as string) ?? dirName.toLowerCase().replace(/[^a-z0-9-]/g, '-');

    // Find reference files in the directory
    const referenceFiles = await this.findReferenceFiles(dirPath, skillFilePath);

    // Extract trigger types from frontmatter
    const triggerTypes = this.extractTriggerTypes(parsed);

    return {
      name,
      description: (parsed.description as string) ?? `Skill "${name}" from plugin ${pluginName}`,
      filePath: skillFilePath,
      dirPath,
      pluginName,
      body: body.trim(),
      triggerTypes,
      referenceFiles,
      autoInject: (parsed.auto_inject as boolean) ?? true,
    };
  }

  /**
   * Find reference files in skill directory (non-SKILL.md files).
   */
  private async findReferenceFiles(dirPath: string, skillFilePath: string): Promise<string[]> {
    const refs: string[] = [];
    try {
      const entries = await fsp.readdir(dirPath);
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry);
        if (fullPath === skillFilePath) continue;

        const stat = await fsp.stat(fullPath);
        if (stat.isFile()) refs.push(fullPath);
      }
    } catch { /* skip */ }
    return refs;
  }

  /**
   * Extract trigger types from parsed frontmatter.
   */
  private extractTriggerTypes(parsed: Record<string, unknown>): string[] {
    const types: string[] = [];
    const triggers = parsed.triggers;

    if (Array.isArray(triggers)) {
      for (const t of triggers) {
        if (typeof t === 'string') types.push(t);
        else if (t && typeof t === 'object' && 'type' in t) {
          types.push(String((t as Record<string, unknown>).type));
        }
      }
    }

    return types;
  }

  // ════════════════════════════════════════════════════════════════════
  // YAML Frontmatter
  // ════════════════════════════════════════════════════════════════════

  private splitFrontmatter(content: string): { frontmatter: string | null; body: string } {
    const lines = content.split('\n');
    let openIdx = -1;

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (trimmed === '') continue;
      if (trimmed === '---') { openIdx = i; break; }
      return { frontmatter: null, body: content };
    }

    if (openIdx === -1) return { frontmatter: null, body: content };

    let closeIdx = -1;
    for (let i = openIdx + 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') { closeIdx = i; break; }
    }

    if (closeIdx === -1) return { frontmatter: null, body: content };

    return {
      frontmatter: lines.slice(openIdx + 1, closeIdx).join('\n'),
      body: lines.slice(closeIdx + 1).join('\n'),
    };
  }

  private parseFrontmatter(yaml: string): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    let currentKey: string | null = null;
    let currentList: unknown[] | null = null;

    for (const line of yaml.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const topMatch = line.match(/^([a-z_]\w*):\s*(.*)$/i);
      if (topMatch) {
        if (currentKey && currentList) result[currentKey] = currentList;
        currentList = null;

        const [, key, rawValue] = topMatch;
        currentKey = key;
        const value = rawValue.trim();

        if (value === '') { currentList = []; continue; }
        result[key] = this.parseValue(value);
        continue;
      }

      const listMatch = line.match(/^\s+-\s+(.*)$/);
      if (listMatch && currentKey) {
        if (!currentList) currentList = [];
        currentList.push(this.parseValue(listMatch[1].trim()));
      }
    }

    if (currentKey && currentList) result[currentKey] = currentList;
    return result;
  }

  private parseValue(value: string): unknown {
    if (value === 'true') return true;
    if (value === 'false') return false;
    if (value === 'null' || value === '~') return null;
    if (/^-?\d+$/.test(value)) return parseInt(value, 10);
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      return value.slice(1, -1);
    }
    return value;
  }

  // ════════════════════════════════════════════════════════════════════
  // Validation
  // ════════════════════════════════════════════════════════════════════

  private isValidSkillName(name: string): boolean {
    if (name.length === 0 || name.length > MAX_SKILL_NAME_LENGTH) return false;
    return /^[a-z][a-z0-9-]*$/.test(name);
  }
}
