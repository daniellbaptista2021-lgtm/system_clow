/**
 * PluginOutputStyleLoader.ts — Load custom output styles from markdown files
 *
 * Based on Claude Code's outputStylePlugins.ts (~400 lines)
 *
 * Features:
 *   - Glob pattern expansion for style files
 *   - YAML frontmatter parsing (name, description, format, language)
 *   - Style content validation (non-empty, size limits)
 *   - Duplicate style name detection
 *   - Style categorization (chat, code, markdown, json, table)
 *   - Template variable support ({{model}}, {{date}}, etc.)
 *   - Style priority/ordering
 *   - Error recovery (skip malformed, continue loading)
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import type { PluginManifest, PluginValidationError } from '../types.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_STYLE_BODY_CHARS = 20_000;
const MAX_STYLE_NAME_LENGTH = 60;
const MAX_STYLES_PER_PLUGIN = 50;
const FRONTMATTER_DELIMITER = '---';

const VALID_FORMATS = new Set([
  'chat', 'code', 'markdown', 'json', 'table', 'xml',
  'plain', 'structured', 'minimal', 'verbose', 'custom',
]);

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ResolvedOutputStyle {
  /** Style name (derived from filename or frontmatter) */
  name: string;
  /** Human-readable description */
  description: string;
  /** Output format type */
  format: string;
  /** Style body (the actual formatting instructions) */
  body: string;
  /** File path for diagnostics */
  filePath: string;
  /** Plugin that provides this style */
  pluginName: string;
  /** Priority (higher = preferred when multiple match) */
  priority: number;
  /** Language override (e.g., 'pt-BR', 'en') */
  language?: string;
  /** Optional category for grouping */
  category?: string;
  /** Whether style is hidden from listing */
  hidden: boolean;
  /** Template variables found in body */
  templateVars: string[];
}

interface ParsedStyleFrontmatter {
  name?: string;
  description?: string;
  format?: string;
  language?: string;
  category?: string;
  priority?: number;
  hidden?: boolean;
}

interface StyleLoadError {
  filePath: string;
  error: string;
  recoverable: boolean;
}

// ════════════════════════════════════════════════════════════════════════════
// PluginOutputStyleLoader Class
// ════════════════════════════════════════════════════════════════════════════

export class PluginOutputStyleLoader {
  private loadErrors: StyleLoadError[] = [];

  /**
   * Load all output styles declared in manifest.
   * Returns style names (for registration tracking).
   */
  async loadAll(rootDir: string, manifest: PluginManifest): Promise<string[]> {
    if (!manifest.outputStyles || manifest.outputStyles.length === 0) return [];

    this.loadErrors = [];
    const styles = await this.resolveAll(rootDir, manifest);
    return styles.map(s => s.name);
  }

  /**
   * Resolve all output styles with full metadata.
   */
  async resolveAll(rootDir: string, manifest: PluginManifest): Promise<ResolvedOutputStyle[]> {
    if (!manifest.outputStyles || manifest.outputStyles.length === 0) return [];

    const allFiles = await this.expandAllGlobs(rootDir, manifest.outputStyles);

    if (allFiles.length === 0) {
      return [];
    }

    if (allFiles.length > MAX_STYLES_PER_PLUGIN) {
      this.loadErrors.push({
        filePath: rootDir,
        error: `Too many output styles: ${allFiles.length} (max ${MAX_STYLES_PER_PLUGIN})`,
        recoverable: true,
      });
    }

    const styles: ResolvedOutputStyle[] = [];
    const seenNames = new Set<string>();

    for (const filePath of allFiles.slice(0, MAX_STYLES_PER_PLUGIN)) {
      try {
        const style = await this.parseStyleFile(filePath, manifest.name);
        if (!style) continue;

        // Duplicate detection
        if (seenNames.has(style.name)) {
          this.loadErrors.push({
            filePath,
            error: `Duplicate output style name: "${style.name}"`,
            recoverable: true,
          });
          continue;
        }

        // Name validation
        if (!this.isValidStyleName(style.name)) {
          this.loadErrors.push({
            filePath,
            error: `Invalid style name: "${style.name}" (must be kebab-case, max ${MAX_STYLE_NAME_LENGTH} chars)`,
            recoverable: true,
          });
          continue;
        }

        seenNames.add(style.name);
        styles.push(style);
      } catch (err) {
        this.loadErrors.push({
          filePath,
          error: (err as Error).message,
          recoverable: true,
        });
      }
    }

    // Sort by priority (higher first)
    styles.sort((a, b) => b.priority - a.priority);
    return styles;
  }

  getLastErrors(): StyleLoadError[] {
    return [...this.loadErrors];
  }

  // ════════════════════════════════════════════════════════════════════
  // File Parsing
  // ════════════════════════════════════════════════════════════════════

  /**
   * Parse a single output style markdown file.
   * Returns null if invalid.
   */
  private async parseStyleFile(filePath: string, pluginName: string): Promise<ResolvedOutputStyle | null> {
    const content = await fsp.readFile(filePath, 'utf-8');

    // Split frontmatter and body
    const { frontmatter, body } = this.splitFrontmatter(content);

    // Body is required
    const trimmedBody = body.trim();
    if (!trimmedBody) {
      this.loadErrors.push({ filePath, error: 'Empty style body', recoverable: true });
      return null;
    }

    // Check body size
    if (trimmedBody.length > MAX_STYLE_BODY_CHARS) {
      this.loadErrors.push({
        filePath,
        error: `Style body too large: ${trimmedBody.length} chars (max ${MAX_STYLE_BODY_CHARS})`,
        recoverable: true,
      });
      return null;
    }

    // Parse frontmatter (optional for styles)
    const parsed = frontmatter ? this.parseFrontmatter(frontmatter) : {};

    // Derive name from filename or frontmatter
    const fileName = path.basename(filePath, '.md');
    const styleName = parsed.name ?? fileName.toLowerCase().replace(/[^a-z0-9-]/g, '-');

    // Validate format
    const format = parsed.format ?? 'custom';
    if (!VALID_FORMATS.has(format)) {
      this.loadErrors.push({
        filePath,
        error: `Invalid format: "${format}". Valid: ${Array.from(VALID_FORMATS).join(', ')}`,
        recoverable: true,
      });
      // Continue with 'custom' as fallback
    }

    // Extract template variables
    const templateVars = this.extractTemplateVars(trimmedBody);

    return {
      name: styleName,
      description: parsed.description ?? `Output style "${styleName}" from plugin ${pluginName}`,
      format: VALID_FORMATS.has(format) ? format : 'custom',
      body: trimmedBody,
      filePath,
      pluginName,
      priority: typeof parsed.priority === 'number' ? parsed.priority : 0,
      language: parsed.language,
      category: parsed.category,
      hidden: parsed.hidden ?? false,
      templateVars,
    };
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
      if (trimmed === FRONTMATTER_DELIMITER) { openIdx = i; break; }
      return { frontmatter: null, body: content };
    }

    if (openIdx === -1) return { frontmatter: null, body: content };

    let closeIdx = -1;
    for (let i = openIdx + 1; i < lines.length; i++) {
      if (lines[i].trim() === FRONTMATTER_DELIMITER) { closeIdx = i; break; }
    }

    if (closeIdx === -1) return { frontmatter: null, body: content };

    return {
      frontmatter: lines.slice(openIdx + 1, closeIdx).join('\n'),
      body: lines.slice(closeIdx + 1).join('\n'),
    };
  }

  private parseFrontmatter(yaml: string): ParsedStyleFrontmatter {
    const result: Record<string, unknown> = {};
    for (const line of yaml.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const match = line.match(/^([a-z_]\w*):\s*(.*)$/i);
      if (match) {
        const [, key, rawValue] = match;
        result[key] = this.parseValue(rawValue.trim());
      }
    }
    return result as ParsedStyleFrontmatter;
  }

  private parseValue(value: string): unknown {
    if (value === 'true') return true;
    if (value === 'false') return false;
    if (value === 'null' || value === '~') return null;
    if (/^-?\d+$/.test(value)) return parseInt(value, 10);
    if (/^-?\d+\.\d+$/.test(value)) return parseFloat(value);
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      return value.slice(1, -1);
    }
    return value;
  }

  // ════════════════════════════════════════════════════════════════════
  // Template Variables
  // ════════════════════════════════════════════════════════════════════

  /**
   * Extract {{var}} template variables from style body.
   */
  private extractTemplateVars(body: string): string[] {
    const vars = new Set<string>();
    const regex = /\{\{([a-zA-Z_]\w*)\}\}/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(body)) !== null) {
      vars.add(match[1]);
    }
    return Array.from(vars);
  }

  /**
   * Expand template variables in a style body with actual values.
   */
  expandTemplateVars(body: string, values: Record<string, string>): string {
    return body.replace(/\{\{([a-zA-Z_]\w*)\}\}/g, (_match, varName) => {
      return values[varName] ?? `{{${varName}}}`;
    });
  }

  // ════════════════════════════════════════════════════════════════════
  // Glob Expansion
  // ════════════════════════════════════════════════════════════════════

  private async expandAllGlobs(rootDir: string, patterns: string[]): Promise<string[]> {
    const allFiles = new Set<string>();
    for (const pattern of patterns) {
      const expanded = await this.expandSingleGlob(rootDir, pattern);
      for (const file of expanded) allFiles.add(file);
    }
    return Array.from(allFiles).sort();
  }

  private async expandSingleGlob(rootDir: string, pattern: string): Promise<string[]> {
    const results: string[] = [];
    const isRecursive = pattern.includes('**');
    const patternDir = path.dirname(pattern);
    const patternFile = path.basename(pattern);

    const baseDir = isRecursive
      ? path.join(rootDir, patternDir.split('**')[0])
      : path.join(rootDir, patternDir);

    if (!fs.existsSync(baseDir)) return results;

    const fileRegex = this.globToRegex(patternFile);

    if (isRecursive) {
      await this.walkDirectory(baseDir, fileRegex, results);
    } else {
      try {
        for (const entry of await fsp.readdir(baseDir)) {
          if (fileRegex.test(entry)) {
            const fullPath = path.join(baseDir, entry);
            const stat = await fsp.stat(fullPath);
            if (stat.isFile()) results.push(fullPath);
          }
        }
      } catch { /* skip inaccessible dirs */ }
    }

    return results;
  }

  private async walkDirectory(dir: string, fileRegex: RegExp, results: string[]): Promise<void> {
    try {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await this.walkDirectory(fullPath, fileRegex, results);
        } else if (entry.isFile() && fileRegex.test(entry.name)) {
          results.push(fullPath);
        }
      }
    } catch { /* skip inaccessible dirs */ }
  }

  private globToRegex(glob: string): RegExp {
    const escaped = glob
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    return new RegExp(`^${escaped}$`, 'i');
  }

  // ════════════════════════════════════════════════════════════════════
  // Validation
  // ════════════════════════════════════════════════════════════════════

  private isValidStyleName(name: string): boolean {
    if (name.length === 0 || name.length > MAX_STYLE_NAME_LENGTH) return false;
    return /^[a-z][a-z0-9-]*$/.test(name);
  }
}
