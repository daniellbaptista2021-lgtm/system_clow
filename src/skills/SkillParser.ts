/** Parse SKILL.md: split frontmatter + body, validate, find references. */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { validateFrontmatter } from './SkillFrontmatterSchema.js';
import { SKILL_FILE_NAME, MAX_SKILL_BODY_TOKENS } from './types.js';
import type { ParsedSkill, SkillReference } from './types.js';

export class SkillParser {
  async parse(filePath: string): Promise<ParsedSkill | null> {
    if (!fs.existsSync(filePath)) return null;
    return this.parseString(await fsp.readFile(filePath, 'utf-8'), filePath);
  }

  parseString(content: string, filePath: string): ParsedSkill | null {
    const { fm, body } = this.split(content);
    if (!fm) { console.warn(`[SkillParser] No frontmatter: ${filePath}`); return null; }

    const parsed = this.parseYaml(fm);
    if (!parsed) { console.warn(`[SkillParser] Bad YAML: ${filePath}`); return null; }

    const v = validateFrontmatter(parsed);
    if (!v.valid) { console.warn(`[SkillParser] Invalid: ${filePath} — ${v.errors.join(', ')}`); return null; }

    const dir = path.dirname(filePath);
    const tokens = Math.ceil(body.length / 4);
    if (tokens > MAX_SKILL_BODY_TOKENS) { console.warn(`[SkillParser] ${v.data.name} too large: ${tokens} tokens`); return null; }

    return {
      frontmatter: v.data, body: body.trim(), bodyTokens: tokens,
      filePath, directory: dir,
      references: (v.data.references ?? []).map(r => ({ name: r, path: path.join(dir, r), loaded: false })).filter(r => fs.existsSync(r.path)),
    };
  }

  private split(content: string): { fm: string | null; body: string } {
    const lines = content.split('\n');
    let start = -1;
    for (let i = 0; i < lines.length; i++) { if (lines[i].trim() === '') continue; if (lines[i].trim() === '---') { start = i; break; } return { fm: null, body: content }; }
    if (start === -1) return { fm: null, body: content };
    let end = -1;
    for (let i = start + 1; i < lines.length; i++) { if (lines[i].trim() === '---') { end = i; break; } }
    if (end === -1) return { fm: null, body: content };
    return { fm: lines.slice(start + 1, end).join('\n'), body: lines.slice(end + 1).join('\n') };
  }

  private parseYaml(yaml: string): Record<string, unknown> | null {
    try {
      // Minimal YAML: key: value, lists with -, nested 1 level
      const result: Record<string, unknown> = {};
      const lines = yaml.split('\n');
      let key: string | null = null;
      for (const line of lines) {
        if (!line.trim() || line.trim().startsWith('#')) continue;
        const top = line.match(/^([a-z_]\w*):\s*(.*)$/i);
        if (top) {
          key = top[1];
          const val = top[2].trim();
          if (val === '') continue;
          result[key] = this.val(val);
          continue;
        }
        const list = line.match(/^\s+-\s*(.*)$/);
        if (list && key) {
          if (!Array.isArray(result[key])) result[key] = [];
          const item = list[1].trim();
          // Check if list item is an object (has nested key:value)
          if (item.match(/^[a-z_]\w*:/i)) {
            // Parse as object
            const obj: Record<string, unknown> = {};
            const parts = item.split(/,\s*/);
            for (const p of parts) {
              const kv = p.match(/^([a-z_]\w*):\s*(.*)$/i);
              if (kv) obj[kv[1]] = this.val(kv[2]);
            }
            // Also check remaining indented lines for same object
            (result[key] as unknown[]).push(Object.keys(obj).length > 0 ? obj : this.val(item));
          } else {
            (result[key] as unknown[]).push(this.val(item));
          }
          continue;
        }
        const nested = line.match(/^\s+([a-z_]\w*):\s*(.*)$/i);
        if (nested && key) {
          // Could be nested object OR trigger list item property
          const lastArr = result[key];
          if (Array.isArray(lastArr) && lastArr.length > 0 && typeof lastArr[lastArr.length - 1] === 'object') {
            (lastArr[lastArr.length - 1] as Record<string, unknown>)[nested[1]] = this.val(nested[2]);
          } else if (typeof result[key] !== 'object' || Array.isArray(result[key])) {
            result[key] = {};
            (result[key] as Record<string, unknown>)[nested[1]] = this.val(nested[2]);
          } else {
            (result[key] as Record<string, unknown>)[nested[1]] = this.val(nested[2]);
          }
        }
      }
      return result;
    } catch { return null; }
  }

  private val(v: string): unknown {
    const t = v.trim();
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (t === 'null' || t === '~') return null;
    if (/^-?\d+$/.test(t)) return parseInt(t, 10);
    if (/^-?\d+\.\d+$/.test(t)) return parseFloat(t);
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
    if (t.startsWith('[') && t.endsWith(']')) return t.slice(1, -1).split(',').map(s => this.val(s.trim()));
    return t;
  }

  // ─── Batch Parsing ───────────────────────────────────────────────

  /**
   * Parse multiple skill files at once.
   * Returns all successfully parsed skills (skips failures).
   */
  async parseMany(filePaths: string[]): Promise<ParsedSkill[]> {
    const results: ParsedSkill[] = [];
    for (const fp of filePaths) {
      try {
        const skill = await this.parse(fp);
        if (skill) results.push(skill);
      } catch {
        console.warn(`[SkillParser] Failed to parse: ${fp}`);
      }
    }
    return results;
  }

  /**
   * Parse a skill from raw YAML frontmatter and body strings.
   * Used for testing and programmatic skill creation.
   */
  parseFromParts(frontmatterYaml: string, body: string, filePath: string = '<inline>'): ParsedSkill | null {
    const parsed = this.parseYaml(frontmatterYaml);
    if (!parsed) return null;

    const v = validateFrontmatter(parsed);
    if (!v.valid) return null;

    const dir = path.dirname(filePath);
    const tokens = Math.ceil(body.length / 4);
    if (tokens > MAX_SKILL_BODY_TOKENS) return null;

    return {
      frontmatter: v.data,
      body: body.trim(),
      bodyTokens: tokens,
      filePath,
      directory: dir,
      references: (v.data.references ?? []).map(r => ({
        name: r, path: path.join(dir, r), loaded: false,
      })).filter(r => fs.existsSync(r.path)),
    };
  }

  // ─── Validation Only ─────────────────────────────────────────────

  /**
   * Validate a skill file without fully parsing it.
   * Returns validation result with errors.
   */
  async validate(filePath: string): Promise<{
    valid: boolean;
    skillName?: string;
    errors: string[];
    bodyTokens?: number;
  }> {
    if (!fs.existsSync(filePath)) {
      return { valid: false, errors: ['File not found'] };
    }

    try {
      const content = await fsp.readFile(filePath, 'utf-8');
      const { fm, body } = this.split(content);

      if (!fm) return { valid: false, errors: ['No YAML frontmatter found'] };

      const parsed = this.parseYaml(fm);
      if (!parsed) return { valid: false, errors: ['Failed to parse YAML'] };

      const v = validateFrontmatter(parsed);
      if (!v.valid) return { valid: false, errors: v.errors };

      const tokens = Math.ceil(body.length / 4);
      if (tokens > MAX_SKILL_BODY_TOKENS) {
        return { valid: false, skillName: v.data.name, errors: [`Body too large: ${tokens} tokens (max ${MAX_SKILL_BODY_TOKENS})`] };
      }

      return { valid: true, skillName: v.data.name, errors: [], bodyTokens: tokens };
    } catch (err) {
      return { valid: false, errors: [(err as Error).message] };
    }
  }

  /**
   * Extract just the name from a skill file (fast, no full parse).
   */
  async extractName(filePath: string): Promise<string | null> {
    if (!fs.existsSync(filePath)) return null;

    try {
      const content = await fsp.readFile(filePath, 'utf-8');
      const { fm } = this.split(content);
      if (!fm) return null;

      // Quick regex for name field
      const match = fm.match(/^name:\s*(.+)$/m);
      if (!match) return null;
      const name = match[1].trim().replace(/^['"]|['"]$/g, '');
      return name || null;
    } catch {
      return null;
    }
  }

  /**
   * Estimate tokens for a file without full parsing.
   */
  async estimateTokens(filePath: string): Promise<number> {
    if (!fs.existsSync(filePath)) return 0;
    try {
      const stat = await fsp.stat(filePath);
      return Math.ceil(stat.size / 4);
    } catch {
      return 0;
    }
  }

  // ─── Parser Statistics ───────────────────────────────────────────

  private parseCount = 0;
  private parseErrors = 0;
  private totalParseTimeMs = 0;

  /**
   * Get parser statistics.
   */
  getStats(): { parseCount: number; parseErrors: number; avgParseTimeMs: number } {
    return {
      parseCount: this.parseCount,
      parseErrors: this.parseErrors,
      avgParseTimeMs: this.parseCount > 0 ? this.totalParseTimeMs / this.parseCount : 0,
    };
  }

  // ─── YAML Multiline String Support (| and >) ───────────────────────

  /**
   * Parse YAML multiline strings using literal block scalar (|) and
   * folded block scalar (>) syntax.
   *
   * Literal block (|): preserves newlines exactly as written
   * Folded block (>): folds newlines into spaces (paragraph style)
   *
   * @param yaml - Raw YAML string potentially containing multiline blocks
   * @returns Parsed YAML with multiline strings resolved
   */
  parseYamlWithMultiline(yaml: string): Record<string, unknown> | null {
    try {
      const result: Record<string, unknown> = {};
      const lines = yaml.split('\n');
      let i = 0;

      while (i < lines.length) {
        const line = lines[i];

        // Skip empty lines and comments
        if (!line.trim() || line.trim().startsWith('#')) {
          i++;
          continue;
        }

        // Match top-level key
        const topMatch = line.match(/^([a-z_]\w*):\s*(.*)$/i);
        if (topMatch) {
          const key = topMatch[1];
          const valueStr = topMatch[2].trim();

          // Check for literal block scalar (|)
          if (valueStr === '|' || valueStr === '|+' || valueStr === '|-') {
            const blockLines: string[] = [];
            const chopMode = valueStr === '|-' ? 'strip' : valueStr === '|+' ? 'keep' : 'clip';
            i++;

            // Detect indent of first content line
            let blockIndent = -1;
            while (i < lines.length) {
              const bLine = lines[i];
              if (blockIndent === -1) {
                const indentMatch = bLine.match(/^(\s+)/);
                if (!indentMatch) break;
                blockIndent = indentMatch[1].length;
              }
              if (bLine.trim() === '' || bLine.match(new RegExp(`^\\s{${blockIndent}}`))) {
                blockLines.push(bLine.slice(blockIndent));
                i++;
              } else {
                break;
              }
            }

            let blockText = blockLines.join('\n');
            if (chopMode === 'strip') blockText = blockText.replace(/\n+$/, '');
            else if (chopMode === 'clip') blockText = blockText.replace(/\n+$/, '\n');
            result[key] = blockText;
            continue;
          }

          // Check for folded block scalar (>)
          if (valueStr === '>' || valueStr === '>+' || valueStr === '>-') {
            const blockLines: string[] = [];
            const chopMode = valueStr === '>-' ? 'strip' : valueStr === '>+' ? 'keep' : 'clip';
            i++;

            let blockIndent = -1;
            while (i < lines.length) {
              const bLine = lines[i];
              if (blockIndent === -1) {
                const indentMatch = bLine.match(/^(\s+)/);
                if (!indentMatch) break;
                blockIndent = indentMatch[1].length;
              }
              if (bLine.trim() === '' || bLine.match(new RegExp(`^\\s{${blockIndent}}`))) {
                blockLines.push(bLine.slice(blockIndent));
                i++;
              } else {
                break;
              }
            }

            // Folded: replace single newlines with spaces, keep double newlines
            let blockText = blockLines.join('\n');
            blockText = blockText.replace(/([^\n])\n([^\n])/g, '$1 $2');
            if (chopMode === 'strip') blockText = blockText.replace(/\n+$/, '');
            else if (chopMode === 'clip') blockText = blockText.replace(/\n+$/, '\n');
            result[key] = blockText;
            continue;
          }

          // Regular value
          if (valueStr !== '') {
            result[key] = this.val(valueStr);
          }
          i++;
          continue;
        }

        i++;
      }

      return Object.keys(result).length > 0 ? result : null;
    } catch {
      return null;
    }
  }

  // ─── Frontmatter Template Generation ────────────────────────────────

  /**
   * Generate a YAML frontmatter template for a new skill.
   * Creates a valid frontmatter block with all required fields
   * and commonly used optional fields pre-filled.
   *
   * @param name - Skill name (required)
   * @param description - Skill description (required)
   * @param options - Optional fields to include
   * @returns Complete frontmatter YAML string (without --- delimiters)
   */
  generateFrontmatterTemplate(
    name: string,
    description: string,
    options: {
      command?: string;
      triggers?: Array<{ type: string; patterns?: string[] }>;
      minTier?: string;
      alwaysActive?: boolean;
      references?: string[];
      source?: string;
    } = {},
  ): string {
    const lines: string[] = [];

    lines.push(`name: ${name}`);
    lines.push(`description: ${description}`);

    if (options.command) {
      lines.push(`command: ${options.command}`);
    }

    if (options.alwaysActive) {
      lines.push(`always_active: true`);
    }

    if (options.minTier) {
      lines.push(`min_tier: ${options.minTier}`);
    }

    if (options.source) {
      lines.push(`source: ${options.source}`);
    }

    if (options.triggers && options.triggers.length > 0) {
      lines.push(`triggers:`);
      for (const trigger of options.triggers) {
        lines.push(`  - type: ${trigger.type}`);
        if (trigger.patterns && trigger.patterns.length > 0) {
          lines.push(`    patterns:`);
          for (const pattern of trigger.patterns) {
            lines.push(`      - ${pattern}`);
          }
        }
      }
    }

    if (options.references && options.references.length > 0) {
      lines.push(`references:`);
      for (const ref of options.references) {
        lines.push(`  - ${ref}`);
      }
    }

    return lines.join('\n');
  }

  // ─── Skill File Creation Helper ─────────────────────────────────────

  /**
   * Create a complete skill file content from components.
   * Combines frontmatter and body into a valid SKILL.md file.
   *
   * @param frontmatterYaml - YAML frontmatter content (without --- delimiters)
   * @param body - Markdown body content (skill instructions)
   * @returns Complete SKILL.md file content
   */
  buildSkillFileContent(frontmatterYaml: string, body: string): string {
    const parts: string[] = [];
    parts.push('---');
    parts.push(frontmatterYaml.trim());
    parts.push('---');
    parts.push('');
    parts.push(body.trim());
    parts.push('');
    return parts.join('\n');
  }

  /**
   * Create a new skill file on disk with the given parameters.
   * Creates the directory if it doesn't exist.
   *
   * @param dir - Directory to create the skill in
   * @param name - Skill name
   * @param description - Skill description
   * @param body - Markdown body content
   * @param options - Additional frontmatter options
   * @returns Path to the created file, or null on failure
   */
  async createSkillFile(
    dir: string,
    name: string,
    description: string,
    body: string,
    options: {
      command?: string;
      triggers?: Array<{ type: string; patterns?: string[] }>;
    } = {},
  ): Promise<string | null> {
    try {
      // Ensure directory exists
      if (!fs.existsSync(dir)) {
        await fsp.mkdir(dir, { recursive: true });
      }

      const frontmatter = this.generateFrontmatterTemplate(name, description, options);
      const content = this.buildSkillFileContent(frontmatter, body);
      const filePath = path.join(dir, SKILL_FILE_NAME);

      await fsp.writeFile(filePath, content, 'utf-8');
      return filePath;
    } catch (err) {
      console.warn(`[SkillParser] Failed to create skill file: ${(err as Error).message}`);
      return null;
    }
  }
}
