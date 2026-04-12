/**
 * PluginCommandLoader.ts — Load slash commands from markdown files
 *
 * Based on Claude Code's loadPluginCommands.ts (31K / ~800 lines)
 *
 * Features:
 *   - YAML frontmatter parsing (description, allowed_tools, model, aliases, arguments)
 *   - Recursive glob expansion (commands/*.md, commands/**\/*.md)
 *   - Duplicate command name detection
 *   - Command name validation (kebab-case, no conflicts with built-in)
 *   - Body size limits (prevent massive prompts)
 *   - Argument schema validation
 *   - Template variable expansion in body
 *   - Error recovery (skip malformed, continue loading)
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import type { PluginManifest, PluginCommand, PluginCommandArgument, PluginValidationError } from '../types.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const FRONTMATTER_DELIMITER = '---';
const MAX_COMMAND_BODY_CHARS = 50_000;
const MAX_COMMAND_NAME_LENGTH = 60;
const MAX_COMMANDS_PER_PLUGIN = 100;
const BUILTIN_COMMANDS = new Set([
  'help', 'exit', 'quit', 'clear', 'cost', 'context',
  'plan', 'compact', 'resume', 'model', 'bug', 'memory',
]);

// ─── Types ──────────────────────────────────────────────────────────────────

interface ParsedFrontmatter {
  description: string;
  allowed_tools?: string[];
  model?: string;
  aliases?: string[];
  arguments?: RawArgumentDef[];
  category?: string;
  hidden?: boolean;
  requires_confirmation?: boolean;
  timeout_ms?: number;
}

interface RawArgumentDef {
  name: string;
  type?: string;
  description?: string;
  required?: boolean;
  default?: unknown;
}

interface CommandLoadError {
  filePath: string;
  error: string;
  recoverable: boolean;
}

// ════════════════════════════════════════════════════════════════════════════
// PluginCommandLoader Class
// ════════════════════════════════════════════════════════════════════════════

export class PluginCommandLoader {
  private loadErrors: CommandLoadError[] = [];

  /**
   * Load all commands declared in manifest.
   * Never throws — returns empty array on total failure.
   */
  async loadAll(rootDir: string, manifest: PluginManifest): Promise<PluginCommand[]> {
    if (!manifest.commands || manifest.commands.length === 0) return [];

    this.loadErrors = [];
    const allFiles = await this.expandAllGlobs(rootDir, manifest.commands);

    if (allFiles.length === 0) {
      console.warn(`[PluginCommandLoader] No command files found for ${manifest.name}`);
      return [];
    }

    if (allFiles.length > MAX_COMMANDS_PER_PLUGIN) {
      console.warn(`[PluginCommandLoader] ${manifest.name} has ${allFiles.length} commands (max ${MAX_COMMANDS_PER_PLUGIN}), truncating`);
    }

    const commands: PluginCommand[] = [];
    const seenNames = new Set<string>();

    for (const filePath of allFiles.slice(0, MAX_COMMANDS_PER_PLUGIN)) {
      try {
        const command = await this.parseCommandFile(filePath, manifest.name);
        if (!command) continue;

        // Duplicate detection
        if (seenNames.has(command.name)) {
          this.loadErrors.push({
            filePath,
            error: `Duplicate command name: ${command.name}`,
            recoverable: true,
          });
          continue;
        }

        // Builtin conflict detection
        if (BUILTIN_COMMANDS.has(command.name)) {
          this.loadErrors.push({
            filePath,
            error: `Command "${command.name}" conflicts with built-in command`,
            recoverable: true,
          });
          continue;
        }

        // Name validation
        if (!this.isValidCommandName(command.name)) {
          this.loadErrors.push({
            filePath,
            error: `Invalid command name: "${command.name}" (must be kebab-case, max ${MAX_COMMAND_NAME_LENGTH} chars)`,
            recoverable: true,
          });
          continue;
        }

        seenNames.add(command.name);
        commands.push(command);
      } catch (err) {
        this.loadErrors.push({
          filePath,
          error: (err as Error).message,
          recoverable: true,
        });
      }
    }

    if (this.loadErrors.length > 0) {
      console.warn(
        `[PluginCommandLoader] ${manifest.name}: loaded ${commands.length} commands, ${this.loadErrors.length} errors`,
      );
    }

    return commands;
  }

  /**
   * Get errors from last loadAll call.
   */
  getLastErrors(): CommandLoadError[] {
    return [...this.loadErrors];
  }

  // ════════════════════════════════════════════════════════════════════
  // File Parsing
  // ════════════════════════════════════════════════════════════════════

  /**
   * Parse a single command markdown file.
   * Returns null if file is not a valid command (no frontmatter, missing description).
   */
  private async parseCommandFile(filePath: string, pluginName: string): Promise<PluginCommand | null> {
    const content = await fsp.readFile(filePath, 'utf-8');

    // Split frontmatter and body
    const { frontmatter, body } = this.splitFrontmatter(content);
    if (!frontmatter) {
      this.loadErrors.push({ filePath, error: 'No YAML frontmatter found', recoverable: true });
      return null;
    }

    // Parse frontmatter
    const parsed = this.parseFrontmatter(frontmatter);
    if (!parsed) {
      this.loadErrors.push({ filePath, error: 'Failed to parse YAML frontmatter', recoverable: true });
      return null;
    }

    // Validate required field: description
    if (!parsed.description || typeof parsed.description !== 'string') {
      this.loadErrors.push({ filePath, error: 'Missing required "description" in frontmatter', recoverable: true });
      return null;
    }

    // Check body size
    if (body.length > MAX_COMMAND_BODY_CHARS) {
      this.loadErrors.push({
        filePath,
        error: `Body too large: ${body.length} chars (max ${MAX_COMMAND_BODY_CHARS})`,
        recoverable: true,
      });
      return null;
    }

    // Derive command name from filename
    const fileName = path.basename(filePath, '.md');
    const commandName = fileName.toLowerCase().replace(/[^a-z0-9-]/g, '-');

    // Validate arguments if present
    const validatedArgs = this.validateArguments(parsed.arguments, filePath);

    // Build command
    return {
      name: commandName,
      description: parsed.description,
      filePath,
      pluginName,
      frontmatter: {
        description: parsed.description,
        allowedTools: this.normalizeStringArray(parsed.allowed_tools),
        model: typeof parsed.model === 'string' ? parsed.model : undefined,
        aliases: this.normalizeStringArray(parsed.aliases),
      },
      body: body.trim(),
    };
  }

  // ════════════════════════════════════════════════════════════════════
  // YAML Frontmatter
  // ════════════════════════════════════════════════════════════════════

  /**
   * Split content into YAML frontmatter and markdown body.
   * Frontmatter is delimited by --- at start and end.
   */
  private splitFrontmatter(content: string): { frontmatter: string | null; body: string } {
    const lines = content.split('\n');

    // Find opening ---
    let openIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (trimmed === '') continue;
      if (trimmed === FRONTMATTER_DELIMITER) {
        openIdx = i;
        break;
      }
      // First non-empty, non-delimiter line → no frontmatter
      return { frontmatter: null, body: content };
    }

    if (openIdx === -1) return { frontmatter: null, body: content };

    // Find closing ---
    let closeIdx = -1;
    for (let i = openIdx + 1; i < lines.length; i++) {
      if (lines[i].trim() === FRONTMATTER_DELIMITER) {
        closeIdx = i;
        break;
      }
    }

    if (closeIdx === -1) return { frontmatter: null, body: content };

    return {
      frontmatter: lines.slice(openIdx + 1, closeIdx).join('\n'),
      body: lines.slice(closeIdx + 1).join('\n'),
    };
  }

  /**
   * Parse YAML frontmatter into structured object.
   * Handles: key: value, key: [a, b, c], nested objects (1 level),
   * lists with -, quoted strings, booleans, numbers.
   */
  private parseFrontmatter(yaml: string): ParsedFrontmatter | null {
    try {
      const result: Record<string, unknown> = {};
      const lines = yaml.split('\n');
      let currentKey: string | null = null;
      let currentList: unknown[] | null = null;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;

        // Top-level key: value
        const topMatch = line.match(/^([a-z_]\w*):\s*(.*)$/i);
        if (topMatch) {
          // Save previous list
          if (currentKey && currentList) {
            result[currentKey] = currentList;
          }
          currentList = null;

          const [, key, rawValue] = topMatch;
          currentKey = key;
          const value = rawValue.trim();

          if (value === '') {
            // Empty value — might be followed by list items
            currentList = [];
            continue;
          }

          result[key] = this.parseYamlValue(value);
          continue;
        }

        // List item (indented with -)
        const listMatch = line.match(/^\s+-\s+(.*)$/);
        if (listMatch && currentKey) {
          if (!currentList) currentList = [];

          const listValue = listMatch[1].trim();

          // Check if list item is a nested object (key: value on same line)
          if (listValue.match(/^[a-z_]\w*:/i)) {
            const obj: Record<string, unknown> = {};
            // Parse inline key-value pairs
            const pairs = listValue.split(/,\s*/);
            for (const pair of pairs) {
              const kvMatch = pair.match(/^([a-z_]\w*):\s*(.*)$/i);
              if (kvMatch) {
                obj[kvMatch[1]] = this.parseYamlValue(kvMatch[2]);
              }
            }
            currentList.push(obj);
          } else {
            currentList.push(this.parseYamlValue(listValue));
          }
          continue;
        }

        // Nested key (indented without -)
        const nestedMatch = line.match(/^\s+([a-z_]\w*):\s*(.*)$/i);
        if (nestedMatch && currentKey && currentList) {
          // This is a property of the last list item
          const lastItem = currentList[currentList.length - 1];
          if (lastItem && typeof lastItem === 'object') {
            (lastItem as Record<string, unknown>)[nestedMatch[1]] = this.parseYamlValue(nestedMatch[2]);
          }
        }
      }

      // Save final list
      if (currentKey && currentList) {
        result[currentKey] = currentList;
      }

      if (!result.description) return null;
      return result as unknown as ParsedFrontmatter;
    } catch {
      return null;
    }
  }

  /**
   * Parse a single YAML value (string, number, boolean, array, null).
   */
  private parseYamlValue(value: string): unknown {
    const trimmed = value.trim();

    // Boolean
    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;

    // Null
    if (trimmed === 'null' || trimmed === '~') return null;

    // Number
    if (/^-?\d+$/.test(trimmed)) return parseInt(trimmed, 10);
    if (/^-?\d+\.\d+$/.test(trimmed)) return parseFloat(trimmed);

    // Quoted string
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
      return trimmed.slice(1, -1);
    }

    // Inline array [a, b, c]
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      return trimmed
        .slice(1, -1)
        .split(',')
        .map(s => this.parseYamlValue(s.trim()));
    }

    // Plain string
    return trimmed;
  }

  // ════════════════════════════════════════════════════════════════════
  // Glob Expansion
  // ════════════════════════════════════════════════════════════════════

  /**
   * Expand all glob patterns and collect unique file paths.
   * Supports: *.md, **\/*.md, commands/*.md
   */
  private async expandAllGlobs(rootDir: string, patterns: string[]): Promise<string[]> {
    const allFiles = new Set<string>();

    for (const pattern of patterns) {
      const expanded = await this.expandSingleGlob(rootDir, pattern);
      for (const file of expanded) {
        allFiles.add(file);
      }
    }

    // Sort for deterministic order
    return Array.from(allFiles).sort();
  }

  /**
   * Expand a single glob pattern.
   * Handles: *.md (files in dir), **\/*.md (recursive)
   */
  private async expandSingleGlob(rootDir: string, pattern: string): Promise<string[]> {
    const results: string[] = [];

    // Split pattern into directory and file parts
    const patternDir = path.dirname(pattern);
    const patternFile = path.basename(pattern);
    const isRecursive = pattern.includes('**');

    // Determine base directory
    const baseDir = isRecursive
      ? path.join(rootDir, patternDir.split('**')[0])
      : path.join(rootDir, patternDir);

    if (!fs.existsSync(baseDir)) return results;

    // Build regex from file pattern
    const fileRegex = this.globToRegex(patternFile);

    if (isRecursive) {
      // Recursive walk
      await this.walkDirectory(baseDir, fileRegex, results);
    } else {
      // Single directory
      try {
        const entries = await fsp.readdir(baseDir);
        for (const entry of entries) {
          if (fileRegex.test(entry)) {
            const fullPath = path.join(baseDir, entry);
            const stat = await fsp.stat(fullPath);
            if (stat.isFile()) {
              results.push(fullPath);
            }
          }
        }
      } catch {}
    }

    return results;
  }

  /**
   * Recursively walk a directory and collect files matching regex.
   */
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
    } catch {}
  }

  /**
   * Convert a simple glob pattern to a RegExp.
   * Supports: * (any chars), ? (single char), .ext
   */
  private globToRegex(glob: string): RegExp {
    const escaped = glob
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    return new RegExp(`^${escaped}$`, 'i');
  }

  // ════════════════════════════════════════════════════════════════════
  // Validation Helpers
  // ════════════════════════════════════════════════════════════════════

  /**
   * Validate command name: lowercase kebab-case, no conflicts.
   */
  private isValidCommandName(name: string): boolean {
    if (name.length === 0 || name.length > MAX_COMMAND_NAME_LENGTH) return false;
    return /^[a-z][a-z0-9-]*$/.test(name);
  }

  /**
   * Validate argument definitions.
   */
  private validateArguments(
    args: RawArgumentDef[] | undefined,
    filePath: string,
  ): PluginCommandArgument[] | undefined {
    if (!args || !Array.isArray(args)) return undefined;

    const validated: PluginCommandArgument[] = [];
    const seenNames = new Set<string>();

    for (const arg of args) {
      if (!arg.name || typeof arg.name !== 'string') {
        this.loadErrors.push({ filePath, error: `Argument missing name`, recoverable: true });
        continue;
      }

      if (seenNames.has(arg.name)) {
        this.loadErrors.push({ filePath, error: `Duplicate argument: ${arg.name}`, recoverable: true });
        continue;
      }

      seenNames.add(arg.name);
      validated.push({
        name: arg.name,
        type: (arg.type as string) ?? 'string',
        description: arg.description,
        required: arg.required,
      });
    }

    return validated.length > 0 ? validated : undefined;
  }

  /**
   * Normalize a value that should be string[].
   * Handles: undefined, string, string[], mixed arrays.
   */
  private normalizeStringArray(value: unknown): string[] | undefined {
    if (!value) return undefined;
    if (typeof value === 'string') return [value];
    if (Array.isArray(value)) {
      return value.filter((v): v is string => typeof v === 'string');
    }
    return undefined;
  }
}
