/**
 * HookConfigLoader.ts — Load hooks from configuration files
 *
 * Based on Claude Code's hookConfigLoader.ts (~300 lines)
 *
 * Loads hooks from two sources:
 *   1. User hooks: ~/.clow/hooks.json
 *   2. Project hooks: <workspace>/.clow/hooks.json
 *
 * Project hooks override user hooks on conflict (same event + matcher + type).
 *
 * Features:
 *   - JSON with comments (strip // and block comments before parse)
 *   - Zod schema validation
 *   - Source tracking (user vs project)
 *   - Deterministic hook IDs (hash of source + event + matcher + type)
 *   - Event name validation
 *   - Error recovery (skip invalid hooks, load rest)
 *   - Priority-based merge (project overrides user)
 *   - File change detection (for hot-reload)
 *   - Loading statistics
 *   - Config file watching for hot-reload
 *   - Config validation reporting
 *   - Config diff detection
 *   - Config merge strategies
 *   - Config templates for common patterns
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { HooksFileSchema } from './HookSchemas.js';
import { ALL_HOOK_EVENTS } from './types.js';
import type { ConfiguredHook, HookConfig, HookEventName } from './types.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const USER_HOOKS_FILE = 'hooks.json';
const PROJECT_HOOKS_FILE = 'hooks.json';
const MAX_HOOKS_FILE_SIZE = 500_000; // 500KB
const WATCH_DEBOUNCE_MS = 500;
const MAX_WATCH_ERRORS = 10;

// ─── Types ──────────────────────────────────────────────────────────────────

interface LoadResult {
  hooks: ConfiguredHook[];
  errors: string[];
  warnings: string[];
  sources: Array<{ path: string; hookCount: number }>;
}

/** Describes differences between two config loads */
interface ConfigDiff {
  added: ConfiguredHook[];
  removed: ConfiguredHook[];
  modified: Array<{ before: ConfiguredHook; after: ConfiguredHook }>;
  unchanged: ConfiguredHook[];
  hasChanges: boolean;
}

/** Validation report for a single config file */
interface ValidationReport {
  filePath: string;
  valid: boolean;
  errors: string[];
  warnings: string[];
  hookCount: number;
  eventCoverage: HookEventName[];
  duplicateMatchers: string[];
  fileSize: number;
  lastModified: number;
}

/** Strategy for merging hooks from multiple sources */
type MergeStrategy = 'project-wins' | 'user-wins' | 'priority-based' | 'append-all';

/** Config file watcher state */
interface WatcherState {
  watcher: fs.FSWatcher | null;
  filePath: string;
  lastEventAt: number;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  errorCount: number;
  active: boolean;
}

// ─── Config Templates ───────────────────────────────────────────────────────

/**
 * Common hook configuration templates.
 * These can be used as starting points for users setting up their hooks.
 */
export const CONFIG_TEMPLATES: Record<string, object> = {
  /** Basic logging template: logs all tool use events */
  'logging': {
    version: 1,
    description: 'Log all tool invocations to a file',
    hooks: {
      PostToolUse: [
        {
          hook: {
            type: 'command',
            command: 'echo "[$(date)] Tool: $CLOW_TOOL_NAME" >> ~/.clow/hook-log.txt',
            timeout_ms: 5000,
          },
          enabled: true,
          priority: 0,
        },
      ],
    },
  },

  /** Git safety template: prevent dangerous git operations */
  'git-safety': {
    version: 1,
    description: 'Block dangerous git operations (force push, reset --hard)',
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash(git push *--force*)',
          hook: {
            type: 'command',
            command: 'echo \'{"decision":"block","reason":"Force push blocked by safety hook"}\'',
            timeout_ms: 5000,
          },
          enabled: true,
          priority: 100,
        },
        {
          matcher: 'Bash(git reset --hard*)',
          hook: {
            type: 'command',
            command: 'echo \'{"decision":"block","reason":"Hard reset blocked by safety hook"}\'',
            timeout_ms: 5000,
          },
          enabled: true,
          priority: 100,
        },
      ],
    },
  },

  /** Notification template: webhook on session events */
  'notifications': {
    version: 1,
    description: 'Send webhook notifications on session lifecycle events',
    hooks: {
      SessionStart: [
        {
          hook: {
            type: 'http',
            url: 'https://hooks.example.com/session-start',
            method: 'POST',
            timeout_ms: 10000,
          },
          enabled: true,
          priority: 0,
        },
      ],
      SessionEnd: [
        {
          hook: {
            type: 'http',
            url: 'https://hooks.example.com/session-end',
            method: 'POST',
            timeout_ms: 10000,
          },
          enabled: true,
          priority: 0,
        },
      ],
    },
  },

  /** Permission guard template: ask before file writes outside project */
  'permission-guard': {
    version: 1,
    description: 'Require confirmation for file writes outside workspace',
    hooks: {
      PermissionRequest: [
        {
          matcher: 'Write(*)',
          hook: {
            type: 'command',
            command: 'echo \'{"decision":"ask","reason":"File write outside project directory"}\'',
            timeout_ms: 5000,
          },
          enabled: true,
          priority: 50,
        },
      ],
    },
  },

  /** Empty minimal template */
  'minimal': {
    version: 1,
    description: 'Minimal hooks configuration',
    hooks: {},
  },
};

// ════════════════════════════════════════════════════════════════════════════
// HookConfigLoader Class
// ════════════════════════════════════════════════════════════════════════════

export class HookConfigLoader {
  private lastLoadResult: LoadResult | null = null;
  private fileMtimes = new Map<string, number>();
  private watchers = new Map<string, WatcherState>();
  private mergeStrategy: MergeStrategy = 'project-wins';
  private onReloadCallbacks = new Set<(hooks: ConfiguredHook[]) => void>();
  private previousHookSnapshot = new Map<string, ConfiguredHook>();

  constructor(private readonly clowHome: string = path.join(os.homedir(), '.clow')) {}

  /**
   * Load all hooks from user and project config files.
   * Project hooks override user hooks on conflict.
   */
  async loadAll(workspaceRoot: string): Promise<ConfiguredHook[]> {
    const errors: string[] = [];
    const warnings: string[] = [];
    const sources: LoadResult['sources'] = [];

    // Load from user config
    const userPath = path.join(this.clowHome, USER_HOOKS_FILE);
    const userHooks = await this.loadFile(userPath, 'user', errors, warnings);
    if (userHooks.length > 0) sources.push({ path: userPath, hookCount: userHooks.length });

    // Load from project config
    const projectPath = path.join(workspaceRoot, '.clow', PROJECT_HOOKS_FILE);
    const projectHooks = await this.loadFile(projectPath, 'project', errors, warnings);
    if (projectHooks.length > 0) sources.push({ path: projectPath, hookCount: projectHooks.length });

    // Merge using configured strategy
    const merged = this.mergeHooksWithStrategy(userHooks, projectHooks);

    // Store snapshot for diff detection
    this.previousHookSnapshot.clear();
    for (const hook of merged) {
      this.previousHookSnapshot.set(hook.id, hook);
    }

    this.lastLoadResult = { hooks: merged, errors, warnings, sources };

    if (errors.length > 0) {
      console.warn(`[HookConfigLoader] ${errors.length} errors loading hooks`);
    }

    return merged;
  }

  /**
   * Check if any hook config file has changed since last load.
   */
  async hasChanged(workspaceRoot: string): Promise<boolean> {
    const paths = [
      path.join(this.clowHome, USER_HOOKS_FILE),
      path.join(workspaceRoot, '.clow', PROJECT_HOOKS_FILE),
    ];

    for (const fp of paths) {
      try {
        if (fs.existsSync(fp)) {
          const stat = await fsp.stat(fp);
          const lastMtime = this.fileMtimes.get(fp);
          if (lastMtime && stat.mtimeMs !== lastMtime) return true;
        }
      } catch { /* skip */ }
    }

    return false;
  }

  /**
   * Get result from last load.
   */
  getLastResult(): LoadResult | null {
    return this.lastLoadResult;
  }

  // ─── Config File Watching ───────────────────────────────────────

  /**
   * Start watching config files for changes and auto-reload.
   * Calls registered reload callbacks when hooks change.
   */
  startWatching(workspaceRoot: string): void {
    const paths = [
      path.join(this.clowHome, USER_HOOKS_FILE),
      path.join(workspaceRoot, '.clow', PROJECT_HOOKS_FILE),
    ];

    for (const filePath of paths) {
      if (this.watchers.has(filePath)) continue;

      const state: WatcherState = {
        watcher: null,
        filePath,
        lastEventAt: 0,
        debounceTimer: null,
        errorCount: 0,
        active: false,
      };

      // Only watch if the directory exists
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        this.watchers.set(filePath, state);
        continue;
      }

      try {
        state.watcher = fs.watch(dir, (eventType, filename) => {
          if (filename !== path.basename(filePath)) return;
          this.handleWatchEvent(state, workspaceRoot);
        });

        state.watcher.on('error', () => {
          state.errorCount++;
          if (state.errorCount >= MAX_WATCH_ERRORS) {
            this.stopWatchingFile(filePath);
          }
        });

        state.active = true;
      } catch {
        // Directory might not be watchable
      }

      this.watchers.set(filePath, state);
    }
  }

  /**
   * Stop all config file watchers.
   */
  stopWatching(): void {
    for (const [filePath] of this.watchers) {
      this.stopWatchingFile(filePath);
    }
    this.watchers.clear();
  }

  /**
   * Register a callback for when hooks are reloaded via file watching.
   */
  onReload(callback: (hooks: ConfiguredHook[]) => void): () => void {
    this.onReloadCallbacks.add(callback);
    return () => { this.onReloadCallbacks.delete(callback); };
  }

  private handleWatchEvent(state: WatcherState, workspaceRoot: string): void {
    const now = Date.now();

    // Debounce rapid file events
    if (now - state.lastEventAt < WATCH_DEBOUNCE_MS) {
      if (state.debounceTimer) clearTimeout(state.debounceTimer);
    }

    state.lastEventAt = now;
    state.debounceTimer = setTimeout(async () => {
      try {
        const hooks = await this.loadAll(workspaceRoot);
        for (const cb of this.onReloadCallbacks) {
          try { cb(hooks); } catch { /* ignore callback errors */ }
        }
      } catch {
        state.errorCount++;
      }
    }, WATCH_DEBOUNCE_MS);
  }

  private stopWatchingFile(filePath: string): void {
    const state = this.watchers.get(filePath);
    if (!state) return;

    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    if (state.watcher) {
      try { state.watcher.close(); } catch { /* ignore */ }
    }
    state.active = false;
  }

  // ─── Config Validation Reporting ────────────────────────────────

  /**
   * Generate a detailed validation report for a config file.
   */
  async validateFile(filePath: string): Promise<ValidationReport> {
    const report: ValidationReport = {
      filePath,
      valid: false,
      errors: [],
      warnings: [],
      hookCount: 0,
      eventCoverage: [],
      duplicateMatchers: [],
      fileSize: 0,
      lastModified: 0,
    };

    if (!fs.existsSync(filePath)) {
      report.errors.push('File does not exist');
      return report;
    }

    try {
      const stat = await fsp.stat(filePath);
      report.fileSize = stat.size;
      report.lastModified = stat.mtimeMs;

      if (stat.size > MAX_HOOKS_FILE_SIZE) {
        report.errors.push(`File too large: ${stat.size} bytes (max ${MAX_HOOKS_FILE_SIZE})`);
        return report;
      }

      const raw = await fsp.readFile(filePath, 'utf-8');
      const stripped = this.stripComments(raw);

      let parsed: unknown;
      try {
        parsed = JSON.parse(stripped);
      } catch (err) {
        report.errors.push(`Invalid JSON: ${(err as Error).message}`);
        return report;
      }

      const validation = HooksFileSchema.safeParse(parsed);
      if (!validation.success) {
        report.errors.push(`Schema validation failed: ${validation.error.message}`);
        return report;
      }

      // Analyze hook entries
      const matcherSeen = new Map<string, number>();
      const eventsUsed = new Set<HookEventName>();

      for (const [event, entries] of Object.entries(validation.data.hooks)) {
        if (!ALL_HOOK_EVENTS.includes(event as HookEventName)) {
          report.warnings.push(`Unknown event: "${event}"`);
          continue;
        }

        eventsUsed.add(event as HookEventName);

        for (const entry of entries) {
          report.hookCount++;

          // Check for duplicate matchers
          const matcherKey = `${event}:${entry.matcher ?? '*'}:${entry.hook.type}`;
          const count = (matcherSeen.get(matcherKey) ?? 0) + 1;
          matcherSeen.set(matcherKey, count);
          if (count > 1) {
            report.duplicateMatchers.push(matcherKey);
          }

          // Validate type-specific fields
          if (entry.hook.type === 'command' && !entry.hook.command) {
            report.warnings.push(`Hook in "${event}" has type "command" but no command field`);
          }
          if (entry.hook.type === 'http' && !entry.hook.url) {
            report.warnings.push(`Hook in "${event}" has type "http" but no url field`);
          }
          if (entry.hook.type === 'agent' && !entry.hook.agent) {
            report.warnings.push(`Hook in "${event}" has type "agent" but no agent field`);
          }
        }
      }

      report.eventCoverage = [...eventsUsed];
      report.valid = report.errors.length === 0;
    } catch (err) {
      report.errors.push(`Read error: ${(err as Error).message}`);
    }

    return report;
  }

  /**
   * Validate all config files and return combined report.
   */
  async validateAll(workspaceRoot: string): Promise<ValidationReport[]> {
    const paths = [
      path.join(this.clowHome, USER_HOOKS_FILE),
      path.join(workspaceRoot, '.clow', PROJECT_HOOKS_FILE),
    ];

    const reports: ValidationReport[] = [];
    for (const fp of paths) {
      reports.push(await this.validateFile(fp));
    }
    return reports;
  }

  // ─── Config Diff Detection ──────────────────────────────────────

  /**
   * Detect differences between the current hooks and a new load.
   * Useful for reporting what changed during a hot-reload.
   */
  diffWith(newHooks: ConfiguredHook[]): ConfigDiff {
    const newById = new Map<string, ConfiguredHook>();
    for (const hook of newHooks) {
      newById.set(hook.id, hook);
    }

    const added: ConfiguredHook[] = [];
    const removed: ConfiguredHook[] = [];
    const modified: Array<{ before: ConfiguredHook; after: ConfiguredHook }> = [];
    const unchanged: ConfiguredHook[] = [];

    // Find removed and modified
    for (const [id, oldHook] of this.previousHookSnapshot) {
      const newHook = newById.get(id);
      if (!newHook) {
        removed.push(oldHook);
      } else if (this.hookContentHash(oldHook) !== this.hookContentHash(newHook)) {
        modified.push({ before: oldHook, after: newHook });
      } else {
        unchanged.push(oldHook);
      }
    }

    // Find added
    for (const [id, newHook] of newById) {
      if (!this.previousHookSnapshot.has(id)) {
        added.push(newHook);
      }
    }

    return {
      added,
      removed,
      modified,
      unchanged,
      hasChanges: added.length > 0 || removed.length > 0 || modified.length > 0,
    };
  }

  private hookContentHash(hook: ConfiguredHook): string {
    const content = JSON.stringify({
      event: hook.event,
      matcher: hook.matcher,
      hook: hook.hook,
      enabled: hook.enabled,
      priority: hook.priority,
    });
    return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
  }

  // ─── Merge Strategies ───────────────────────────────────────────

  /**
   * Set the merge strategy used when combining user and project hooks.
   */
  setMergeStrategy(strategy: MergeStrategy): void {
    this.mergeStrategy = strategy;
  }

  /**
   * Get the current merge strategy.
   */
  getMergeStrategy(): MergeStrategy {
    return this.mergeStrategy;
  }

  private mergeHooksWithStrategy(userHooks: ConfiguredHook[], projectHooks: ConfiguredHook[]): ConfiguredHook[] {
    switch (this.mergeStrategy) {
      case 'project-wins':
        return this.mergeHooks(userHooks, projectHooks);

      case 'user-wins':
        return this.mergeHooksUserWins(userHooks, projectHooks);

      case 'priority-based':
        return this.mergeHooksByPriority(userHooks, projectHooks);

      case 'append-all':
        return [...userHooks, ...projectHooks];

      default:
        return this.mergeHooks(userHooks, projectHooks);
    }
  }

  /**
   * User-wins merge: user hooks override project hooks on conflict.
   */
  private mergeHooksUserWins(userHooks: ConfiguredHook[], projectHooks: ConfiguredHook[]): ConfiguredHook[] {
    const merged = [...userHooks];

    for (const projectHook of projectHooks) {
      const conflict = userHooks.some(uh =>
        uh.event === projectHook.event &&
        uh.matcher === projectHook.matcher &&
        uh.hook.type === projectHook.hook.type,
      );

      if (!conflict) {
        merged.push(projectHook);
      }
    }

    return merged;
  }

  /**
   * Priority-based merge: higher priority wins on conflict regardless of source.
   */
  private mergeHooksByPriority(userHooks: ConfiguredHook[], projectHooks: ConfiguredHook[]): ConfiguredHook[] {
    const all = [...userHooks, ...projectHooks];
    const byKey = new Map<string, ConfiguredHook>();

    for (const hook of all) {
      const key = `${hook.event}|${hook.matcher ?? ''}|${hook.hook.type}`;
      const existing = byKey.get(key);

      if (!existing || hook.priority > existing.priority) {
        byKey.set(key, hook);
      }
    }

    return [...byKey.values()];
  }

  // ─── Config Templates ───────────────────────────────────────────

  /**
   * Get a config template by name.
   */
  static getTemplate(name: string): object | null {
    return CONFIG_TEMPLATES[name] ?? null;
  }

  /**
   * List available template names.
   */
  static listTemplates(): string[] {
    return Object.keys(CONFIG_TEMPLATES);
  }

  /**
   * Write a template to a config file.
   * Will not overwrite an existing file unless force is true.
   */
  async writeTemplate(name: string, filePath: string, force = false): Promise<boolean> {
    const template = CONFIG_TEMPLATES[name];
    if (!template) return false;

    if (!force && fs.existsSync(filePath)) return false;

    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, JSON.stringify(template, null, 2));
    return true;
  }

  /**
   * Initialize user hooks config from a template.
   */
  async initUserConfig(templateName: string = 'minimal'): Promise<boolean> {
    const filePath = path.join(this.clowHome, USER_HOOKS_FILE);
    return this.writeTemplate(templateName, filePath);
  }

  /**
   * Initialize project hooks config from a template.
   */
  async initProjectConfig(workspaceRoot: string, templateName: string = 'minimal'): Promise<boolean> {
    const filePath = path.join(workspaceRoot, '.clow', PROJECT_HOOKS_FILE);
    return this.writeTemplate(templateName, filePath);
  }

  // ─── File Loading ────────────────────────────────────────────────

  private async loadFile(
    filePath: string,
    source: 'user' | 'project',
    errors: string[],
    warnings: string[],
  ): Promise<ConfiguredHook[]> {
    if (!fs.existsSync(filePath)) return [];

    try {
      // Size check
      const stat = await fsp.stat(filePath);
      if (stat.size > MAX_HOOKS_FILE_SIZE) {
        errors.push(`${filePath}: File too large (${stat.size} bytes, max ${MAX_HOOKS_FILE_SIZE})`);
        return [];
      }

      // Track mtime for change detection
      this.fileMtimes.set(filePath, stat.mtimeMs);

      // Read and strip comments
      const raw = await fsp.readFile(filePath, 'utf-8');
      const stripped = this.stripComments(raw);

      // Parse JSON
      let parsed: unknown;
      try {
        parsed = JSON.parse(stripped);
      } catch (err) {
        errors.push(`${filePath}: Invalid JSON: ${(err as Error).message}`);
        return [];
      }

      // Validate schema
      const validation = HooksFileSchema.safeParse(parsed);
      if (!validation.success) {
        errors.push(`${filePath}: Schema validation failed: ${validation.error.message}`);
        return [];
      }

      // Build ConfiguredHook array
      const hooks: ConfiguredHook[] = [];

      for (const [event, entries] of Object.entries(validation.data.hooks)) {
        // Validate event name
        if (!ALL_HOOK_EVENTS.includes(event as HookEventName)) {
          warnings.push(`${filePath}: Unknown event "${event}" (skipped)`);
          continue;
        }

        for (const entry of entries) {
          const hookId = this.computeHookId(source, event, entry.matcher, entry.hook.type);

          hooks.push({
            id: hookId,
            event: event as HookEventName,
            matcher: entry.matcher,
            hook: entry.hook as HookConfig,
            source,
            sourcePath: filePath,
            enabled: entry.enabled ?? true,
            priority: entry.priority ?? 0,
            createdAt: Date.now(),
          });
        }
      }

      return hooks;
    } catch (err: any) {
      errors.push(`${filePath}: ${err.message}`);
      return [];
    }
  }

  // ─── Merge ───────────────────────────────────────────────────────

  /**
   * Merge user and project hooks.
   * Project hooks override user hooks with same event + matcher + type.
   */
  private mergeHooks(userHooks: ConfiguredHook[], projectHooks: ConfiguredHook[]): ConfiguredHook[] {
    const merged = [...projectHooks];

    for (const userHook of userHooks) {
      const conflict = projectHooks.some(ph =>
        ph.event === userHook.event &&
        ph.matcher === userHook.matcher &&
        ph.hook.type === userHook.hook.type,
      );

      if (!conflict) {
        merged.push(userHook);
      }
    }

    return merged;
  }

  // ─── Utilities ───────────────────────────────────────────────────

  /**
   * Strip JS-style comments from JSON string.
   * Supports // line comments and block comments.
   */
  private stripComments(json: string): string {
    return json
      .replace(/\/\*[\s\S]*?\*\//g, '')   // Block comments
      .replace(/\/\/.*$/gm, '');           // Line comments
  }

  /**
   * Compute a deterministic hook ID.
   */
  private computeHookId(source: string, event: string, matcher: string | undefined, type: string): string {
    const input = `${source}|${event}|${matcher ?? ''}|${type}`;
    return crypto.createHash('sha256').update(input).digest('hex').slice(0, 12);
  }
}
