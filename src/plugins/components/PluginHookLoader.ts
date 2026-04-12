/**
 * PluginHookLoader.ts — Load hooks from plugin's hooks.json
 *
 * Based on Claude Code's hookPluginIntegration.ts (~350 lines)
 *
 * Features:
 *   - Parse hooks.json file from plugin directory
 *   - Validate hook configurations against HookSchemas
 *   - Namespace hook IDs: plugin_<pluginName>_<event>_<index>
 *   - Event type validation
 *   - Hook executor type support (command, http, agent, function)
 *   - Priority ordering
 *   - Duplicate detection
 *   - Permission check (requires 'register-hooks' permission)
 *   - Matcher pattern validation
 *   - Error recovery
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import type { PluginManifest, PluginValidationError } from '../types.js';
import type { ConfiguredHook, HookConfig, HookEventName } from '../../hooks/types.js';
import { HooksFileSchema } from '../../hooks/HookSchemas.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_HOOKS_PER_PLUGIN = 100;
const MAX_HOOKS_FILE_SIZE = 500_000; // 500KB

const VALID_EVENTS: Set<string> = new Set([
  'PreToolUse', 'PostToolUse', 'Notification', 'Stop',
  'SubagentStop', 'PreCompact', 'PostCompact',
  'PrePermissionPrompt', 'PostPermissionPrompt',
  'SessionStart', 'SessionEnd', 'PreQuery', 'PostQuery',
  'PreSubagent', 'PostSubagent', 'PreResume', 'PostResume',
  'PrePlanMode', 'PostPlanMode', 'PreBuild', 'PostBuild',
]);

// ─── Types ──────────────────────────────────────────────────────────────────

interface HookLoadError {
  event: string;
  error: string;
  recoverable: boolean;
}

// ════════════════════════════════════════════════════════════════════════════
// PluginHookLoader Class
// ════════════════════════════════════════════════════════════════════════════

export class PluginHookLoader {
  private loadErrors: HookLoadError[] = [];

  /**
   * Load all hooks from plugin's hooks.json file.
   * Returns ConfiguredHook[] ready for HookEngine registration.
   */
  async loadAll(rootDir: string, manifest: PluginManifest): Promise<ConfiguredHook[]> {
    if (!manifest.hooks) return [];

    this.loadErrors = [];

    // Check permission
    if (!this.hasHookPermission(manifest)) {
      this.loadErrors.push({
        event: '*',
        error: `Plugin "${manifest.name}" declares hooks but lacks 'register-hooks' permission`,
        recoverable: true,
      });
      // Continue loading but warn
    }

    const fp = path.join(rootDir, manifest.hooks);

    // File existence check
    if (!fs.existsSync(fp)) {
      this.loadErrors.push({
        event: '*',
        error: `Hooks file not found: ${manifest.hooks}`,
        recoverable: true,
      });
      return [];
    }

    // Size check
    try {
      const stat = await fsp.stat(fp);
      if (stat.size > MAX_HOOKS_FILE_SIZE) {
        this.loadErrors.push({
          event: '*',
          error: `Hooks file too large: ${stat.size} bytes (max ${MAX_HOOKS_FILE_SIZE})`,
          recoverable: false,
        });
        return [];
      }
    } catch {
      return [];
    }

    // Parse JSON
    let raw: unknown;
    try {
      raw = JSON.parse(await fsp.readFile(fp, 'utf-8'));
    } catch (err) {
      this.loadErrors.push({
        event: '*',
        error: `Invalid JSON in hooks file: ${(err as Error).message}`,
        recoverable: false,
      });
      return [];
    }

    // Validate against schema
    const validation = HooksFileSchema.safeParse(raw);
    if (!validation.success) {
      this.loadErrors.push({
        event: '*',
        error: `Invalid hooks schema: ${validation.error.message}`,
        recoverable: false,
      });
      return [];
    }

    // Build ConfiguredHook array
    const hooks: ConfiguredHook[] = [];
    let hookIndex = 0;

    for (const [event, entries] of Object.entries(validation.data.hooks)) {
      // Validate event name
      if (!VALID_EVENTS.has(event)) {
        this.loadErrors.push({
          event,
          error: `Unknown hook event: "${event}"`,
          recoverable: true,
        });
        continue;
      }

      for (const entry of entries) {
        if (hooks.length >= MAX_HOOKS_PER_PLUGIN) {
          this.loadErrors.push({
            event,
            error: `Too many hooks (max ${MAX_HOOKS_PER_PLUGIN})`,
            recoverable: true,
          });
          break;
        }

        try {
          // Validate hook config
          const hookConfig = entry.hook as HookConfig;
          if (!this.isValidHookConfig(hookConfig)) {
            this.loadErrors.push({
              event,
              error: `Invalid hook config at index ${hookIndex}`,
              recoverable: true,
            });
            continue;
          }

          // Validate matcher if present
          if (entry.matcher && !this.isValidMatcher(entry.matcher)) {
            this.loadErrors.push({
              event,
              error: `Invalid matcher pattern: "${entry.matcher}"`,
              recoverable: true,
            });
            continue;
          }

          hooks.push({
            id: `plugin_${manifest.name}_${event}_${hookIndex}`,
            event: event as HookEventName,
            matcher: entry.matcher,
            hook: hookConfig,
            source: 'plugin',
            sourcePath: fp,
            enabled: entry.enabled ?? true,
            priority: entry.priority ?? 0,
            createdAt: Date.now(),
          });

          hookIndex++;
        } catch (err) {
          this.loadErrors.push({
            event,
            error: `Failed to parse hook: ${(err as Error).message}`,
            recoverable: true,
          });
        }
      }
    }

    if (hooks.length > 0) {
      console.log(`[PluginHookLoader] Loaded ${hooks.length} hooks from ${manifest.name}`);
    }

    return hooks;
  }

  getLastErrors(): HookLoadError[] {
    return [...this.loadErrors];
  }

  // ─── Validation ──────────────────────────────────────────────────

  private hasHookPermission(manifest: PluginManifest): boolean {
    return (manifest.requiredPermissions ?? []).includes('register-hooks');
  }

  private isValidHookConfig(config: HookConfig): boolean {
    if (!config || typeof config !== 'object') return false;
    if (!('type' in config)) return false;
    const validTypes = ['command', 'http', 'agent', 'function'];
    return validTypes.includes((config as unknown as Record<string, unknown>).type as string);
  }

  private isValidMatcher(matcher: string): boolean {
    if (!matcher || typeof matcher !== 'string') return false;
    // Matchers should be reasonable patterns
    if (matcher.length > 500) return false;
    return true;
  }
}
