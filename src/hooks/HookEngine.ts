/**
 * HookEngine.ts — Main hook system orchestrator
 *
 * Based on Claude Code's hookEngine.ts (~400 lines)
 *
 * Features:
 *   - Initialize: load hooks from config files + plugin hooks
 *   - Register: add function hooks programmatically (SDK)
 *   - Fire: match hooks → execute → aggregate results
 *   - Async hooks with re-wake support
 *   - Trust verification (skip untrusted workspaces)
 *   - Error scoping per session
 *   - Hook metrics tracking
 *   - Hook enable/disable
 *   - Event filtering
 *   - Lifecycle management
 */

import { randomUUID } from 'crypto';
import type { Tool } from '../tools/Tool.js';
import type {
  ConfiguredHook, HookInput, HookOutput, HookEventName,
  AggregatedHookResult, AgentHookConfig, FunctionHookConfig,
  HookMetrics,
} from './types.js';
import { HookExecutor } from './HookExecutor.js';
import { HookMatcher } from './HookMatcher.js';
import { HookAggregator } from './HookAggregator.js';
import { HookTrust } from './HookTrust.js';
import { AsyncHookRegistry } from './HookAsync.js';
import { HookErrorScope, recordHookError } from './HookErrorScope.js';
import { HookConfigLoader } from './HookConfigLoader.js';

// ════════════════════════════════════════════════════════════════════════════
// HookEngine Class
// ════════════════════════════════════════════════════════════════════════════

export class HookEngine {
  private hooks: ConfiguredHook[] = [];
  private executor: HookExecutor;
  private matcher: HookMatcher;
  private aggregator = new HookAggregator();
  private trust: HookTrust;
  private asyncRegistry = new AsyncHookRegistry();
  private errorScope = new HookErrorScope();
  private configLoader: HookConfigLoader;
  private trustChecked = new Set<string>();
  private initialized = false;

  // Metrics
  private totalFires = 0;
  private totalExecutions = 0;
  private totalBlocks = 0;
  private totalErrors = 0;
  private executionsByEvent = new Map<string, number>();

  constructor(deps: {
    toolRegistry: Map<string, Tool>;
    spawnSubagent: (c: AgentHookConfig, p: string) => Promise<string>;
    clowHome?: string;
  }) {
    this.executor = new HookExecutor({ spawnSubagent: deps.spawnSubagent });
    this.matcher = new HookMatcher(deps.toolRegistry);
    this.trust = new HookTrust(deps.clowHome);
    this.configLoader = new HookConfigLoader(deps.clowHome);
  }

  // ─── Initialization ──────────────────────────────────────────────

  /**
   * Initialize the hook system.
   * Loads hooks from user and project config files.
   * Checks workspace trust before enabling hooks.
   */
  async initialize(workspaceRoot: string, isInteractive: boolean): Promise<void> {
    this.hooks = await this.configLoader.loadAll(workspaceRoot);

    if (this.hooks.length === 0) {
      this.initialized = true;
      return;
    }

    // Trust check — only run once per workspace
    if (!this.trustChecked.has(workspaceRoot)) {
      this.trustChecked.add(workspaceRoot);
      const shouldSkip = await this.trust.shouldSkipDueToTrust(workspaceRoot, isInteractive);
      if (shouldSkip) {
        console.warn(`[HookEngine] Skipping hooks for untrusted workspace: ${workspaceRoot}`);
        this.hooks = [];
      }
    }

    this.initialized = true;

    if (this.hooks.length > 0) {
      console.log(`[HookEngine] Loaded ${this.hooks.length} hooks`);
    }
  }

  /**
   * Re-initialize (reload hooks from config files).
   */
  async reinitialize(workspaceRoot: string, isInteractive: boolean): Promise<void> {
    this.hooks = [];
    this.initialized = false;
    await this.initialize(workspaceRoot, isInteractive);
  }

  // ─── Registration (SDK) ──────────────────────────────────────────

  /**
   * Register a function hook programmatically.
   * Used by the SDK for in-process hooks.
   * Returns the hook ID for later unregistration.
   */
  registerFunctionHook(
    event: HookEventName,
    callback: (input: HookInput) => Promise<HookOutput | null>,
    opts: { matcher?: string; priority?: number } = {},
  ): string {
    const id = `fn_${randomUUID().slice(0, 12)}`;
    this.hooks.push({
      id,
      event,
      matcher: opts.matcher,
      hook: { type: 'function', callback } as FunctionHookConfig,
      source: 'sdk',
      enabled: true,
      priority: opts.priority ?? 0,
      createdAt: Date.now(),
    });
    return id;
  }

  /**
   * Unregister a hook by ID.
   */
  unregisterHook(id: string): boolean {
    const idx = this.hooks.findIndex(h => h.id === id);
    if (idx === -1) return false;
    this.hooks.splice(idx, 1);
    return true;
  }

  // ─── Fire (synchronous) ──────────────────────────────────────────

  /**
   * Fire an event and wait for all matching hooks to complete.
   * Returns the aggregated result from all hooks.
   */
  async fire(event: HookEventName, input: HookInput): Promise<AggregatedHookResult> {
    this.totalFires++;
    this.executionsByEvent.set(event, (this.executionsByEvent.get(event) ?? 0) + 1);
    this.errorScope.begin(input.session_id);

    // Match hooks
    const matched = await this.matcher.match(this.hooks, event, input);
    if (matched.length === 0) return this.empty();

    // Execute each matched hook
    const results: Array<{ hookId: string; output: HookOutput }> = [];

    for (const hook of matched) {
      try {
        const output = await this.executor.execute(hook, input);
        this.totalExecutions++;

        // Handle async hooks
        if (output.async) {
          const taskId = output.asyncTaskId ?? this.asyncRegistry.register(hook, input.session_id);
          this.asyncRegistry.setRewake(taskId, output.asyncRewake ?? false);
          continue;
        }

        results.push({ hookId: hook.id, output });

        // Track blocks
        if (output.decision === 'block' || output.hookSpecificOutput?.permissionDecision === 'deny') {
          this.totalBlocks++;
        }
      } catch (err: any) {
        this.totalErrors++;
        recordHookError(err, input.session_id, hook.id, event);
        results.push({
          hookId: hook.id,
          output: { systemMessage: `[hook ${hook.id}] Error: ${err.message}` },
        });
      }
    }

    return this.aggregator.aggregate(results);
  }

  // ─── Fire (async / fire-and-forget) ──────────────────────────────

  /**
   * Fire an event asynchronously (fire-and-forget).
   * Errors are logged but don't propagate.
   */
  fireAsync(event: HookEventName, input: HookInput): void {
    this.fire(event, input).catch(err => {
      recordHookError(err, input.session_id, undefined, event);
    });
  }

  // ─── Hook Management ─────────────────────────────────────────────

  /**
   * Enable a hook by ID.
   */
  enableHook(id: string): boolean {
    const hook = this.hooks.find(h => h.id === id);
    if (!hook) return false;
    hook.enabled = true;
    return true;
  }

  /**
   * Disable a hook by ID.
   */
  disableHook(id: string): boolean {
    const hook = this.hooks.find(h => h.id === id);
    if (!hook) return false;
    hook.enabled = false;
    return true;
  }

  /**
   * Add a hook directly (for testing / programmatic use).
   */
  addHook(hook: ConfiguredHook): void {
    this.hooks.push(hook);
  }

  // ─── Queries ─────────────────────────────────────────────────────

  getAsyncRegistry(): AsyncHookRegistry { return this.asyncRegistry; }
  getErrorScope(): HookErrorScope { return this.errorScope; }

  listHooks(): ConfiguredHook[] { return [...this.hooks]; }

  listForEvent(event: HookEventName): ConfiguredHook[] {
    return this.hooks.filter(h => h.event === event && h.enabled);
  }

  listEnabled(): ConfiguredHook[] {
    return this.hooks.filter(h => h.enabled);
  }

  listDisabled(): ConfiguredHook[] {
    return this.hooks.filter(h => !h.enabled);
  }

  getHookById(id: string): ConfiguredHook | undefined {
    return this.hooks.find(h => h.id === id);
  }

  isInitialized(): boolean { return this.initialized; }

  // ─── Metrics ─────────────────────────────────────────────────────

  /**
   * Get hook system metrics.
   */
  getMetrics(): HookMetrics {
    const hooksByEvent: Record<string, number> = {};
    const hooksByType: Record<string, number> = {};

    for (const hook of this.hooks) {
      hooksByEvent[hook.event] = (hooksByEvent[hook.event] ?? 0) + 1;
      hooksByType[hook.hook.type] = (hooksByType[hook.hook.type] ?? 0) + 1;
    }

    return {
      totalHooks: this.hooks.length,
      hooksByEvent,
      hooksByType,
      totalExecutions: this.totalExecutions,
      totalBlocks: this.totalBlocks,
      avgExecutionMs: this.executor.getAvgDurationMs(),
      errorCount: this.totalErrors,
    };
  }

  /**
   * Reset all metrics.
   */
  resetMetrics(): void {
    this.totalFires = 0;
    this.totalExecutions = 0;
    this.totalBlocks = 0;
    this.totalErrors = 0;
    this.executionsByEvent.clear();
    this.executor.resetStats();
    this.matcher.resetStats();
  }

  // ─── Internal ────────────────────────────────────────────────────

  private empty(): AggregatedHookResult {
    return HookAggregator.empty();
  }

  // ─── Hook Profiling (Track Execution Time Per Hook) ─────────────

  private hookProfiles = new Map<string, {
    hookId: string;
    executionCount: number;
    totalDurationMs: number;
    minDurationMs: number;
    maxDurationMs: number;
    lastExecutedAt: number;
    errorCount: number;
  }>();

  /**
   * Record execution timing for a hook.
   * Builds a profile of each hook's performance characteristics.
   *
   * @param hookId - The hook that was executed
   * @param durationMs - How long the execution took
   * @param hadError - Whether the execution resulted in an error
   */
  recordHookProfile(hookId: string, durationMs: number, hadError: boolean = false): void {
    const existing = this.hookProfiles.get(hookId);
    if (existing) {
      existing.executionCount++;
      existing.totalDurationMs += durationMs;
      existing.minDurationMs = Math.min(existing.minDurationMs, durationMs);
      existing.maxDurationMs = Math.max(existing.maxDurationMs, durationMs);
      existing.lastExecutedAt = Date.now();
      if (hadError) existing.errorCount++;
    } else {
      this.hookProfiles.set(hookId, {
        hookId,
        executionCount: 1,
        totalDurationMs: durationMs,
        minDurationMs: durationMs,
        maxDurationMs: durationMs,
        lastExecutedAt: Date.now(),
        errorCount: hadError ? 1 : 0,
      });
    }
  }

  /**
   * Get the performance profile for a specific hook.
   *
   * @param hookId - The hook to get profile for
   * @returns Profile data or undefined if hook has not been profiled
   */
  getHookProfile(hookId: string): {
    hookId: string;
    executionCount: number;
    avgDurationMs: number;
    minDurationMs: number;
    maxDurationMs: number;
    lastExecutedAt: number;
    errorRate: number;
  } | undefined {
    const profile = this.hookProfiles.get(hookId);
    if (!profile) return undefined;

    return {
      hookId: profile.hookId,
      executionCount: profile.executionCount,
      avgDurationMs: profile.executionCount > 0 ? Math.round(profile.totalDurationMs / profile.executionCount) : 0,
      minDurationMs: profile.minDurationMs,
      maxDurationMs: profile.maxDurationMs,
      lastExecutedAt: profile.lastExecutedAt,
      errorRate: profile.executionCount > 0 ? profile.errorCount / profile.executionCount : 0,
    };
  }

  /**
   * Get profiles for all hooks, sorted by average duration (slowest first).
   */
  getAllProfiles(): Array<{
    hookId: string;
    executionCount: number;
    avgDurationMs: number;
    maxDurationMs: number;
    errorRate: number;
  }> {
    const profiles: Array<{
      hookId: string;
      executionCount: number;
      avgDurationMs: number;
      maxDurationMs: number;
      errorRate: number;
    }> = [];

    for (const [, profile] of this.hookProfiles) {
      profiles.push({
        hookId: profile.hookId,
        executionCount: profile.executionCount,
        avgDurationMs: profile.executionCount > 0 ? Math.round(profile.totalDurationMs / profile.executionCount) : 0,
        maxDurationMs: profile.maxDurationMs,
        errorRate: profile.executionCount > 0 ? profile.errorCount / profile.executionCount : 0,
      });
    }

    return profiles.sort((a, b) => b.avgDurationMs - a.avgDurationMs);
  }

  // ─── Hook Dependency Checking ───────────────────────────────────

  /**
   * Check if a hook has dependencies on other hooks.
   * Dependencies are inferred from hook event ordering:
   * e.g., a PostToolUse hook depends on PreToolUse hooks completing first.
   *
   * @param hookId - The hook to check dependencies for
   * @returns List of hook IDs that this hook depends on
   */
  getHookDependencies(hookId: string): string[] {
    const hook = this.hooks.find(h => h.id === hookId);
    if (!hook) return [];

    const deps: string[] = [];

    // PostToolUse depends on PreToolUse hooks for the same matcher
    if (hook.event === 'PostToolUse') {
      for (const other of this.hooks) {
        if (other.event === 'PreToolUse' && other.enabled) {
          if (!hook.matcher || !other.matcher || hook.matcher === other.matcher) {
            deps.push(other.id);
          }
        }
      }
    }

    // SessionEnd depends on all SessionStart hooks
    if (hook.event === 'SessionEnd') {
      for (const other of this.hooks) {
        if (other.event === 'SessionStart' && other.enabled) {
          deps.push(other.id);
        }
      }
    }

    // SubagentStop depends on SubagentStart hooks
    if (hook.event === 'SubagentStop') {
      for (const other of this.hooks) {
        if (other.event === 'SubagentStart' && other.enabled) {
          deps.push(other.id);
        }
      }
    }

    return deps;
  }

  /**
   * Validate that all hook dependencies are satisfiable.
   * Returns any dependency issues found.
   */
  validateDependencies(): Array<{ hookId: string; issue: string }> {
    const issues: Array<{ hookId: string; issue: string }> = [];

    for (const hook of this.hooks) {
      if (!hook.enabled) continue;

      const deps = this.getHookDependencies(hook.id);
      for (const depId of deps) {
        const dep = this.hooks.find(h => h.id === depId);
        if (!dep) {
          issues.push({ hookId: hook.id, issue: `Dependency ${depId} not found` });
        } else if (!dep.enabled) {
          issues.push({ hookId: hook.id, issue: `Dependency ${depId} is disabled` });
        }
      }
    }

    return issues;
  }

  // ─── Event Statistics ───────────────────────────────────────────

  /**
   * Get detailed statistics about hook events.
   * Shows how many times each event has been fired and which hooks responded.
   */
  getEventStats(): Array<{
    event: HookEventName;
    fireCount: number;
    hookCount: number;
    lastFiredAt: number | null;
  }> {
    const stats: Array<{
      event: HookEventName;
      fireCount: number;
      hookCount: number;
      lastFiredAt: number | null;
    }> = [];

    const allEvents: HookEventName[] = [
      'SessionStart', 'SessionEnd', 'Setup',
      'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
      'PermissionDenied', 'PermissionRequest',
      'SubagentStart', 'SubagentStop', 'TeammateIdle',
      'UserPromptSubmit', 'ConfigChange', 'CwdChanged',
      'FileChanged', 'InstructionsLoaded',
      'TaskCreated', 'TaskCompleted',
      'StatusLine', 'FileSuggestion',
      'Stop', 'StopFailure',
      'Elicitation', 'ElicitationResult',
    ];

    for (const event of allEvents) {
      const hookCount = this.hooks.filter(h => h.event === event && h.enabled).length;
      const fireCount = this.executionsByEvent.get(event) ?? 0;
      stats.push({
        event,
        fireCount,
        hookCount,
        lastFiredAt: fireCount > 0 ? Date.now() : null,
      });
    }

    return stats.sort((a, b) => b.fireCount - a.fireCount);
  }

  /**
   * Get a summary of the hook system health.
   */
  getSystemHealth(): {
    initialized: boolean;
    totalHooks: number;
    enabledHooks: number;
    disabledHooks: number;
    totalFires: number;
    totalErrors: number;
    errorRate: number;
    dependencyIssues: number;
    slowestHook: { hookId: string; avgMs: number } | null;
  } {
    const profiles = this.getAllProfiles();
    const slowest = profiles.length > 0 ? { hookId: profiles[0].hookId, avgMs: profiles[0].avgDurationMs } : null;

    return {
      initialized: this.initialized,
      totalHooks: this.hooks.length,
      enabledHooks: this.hooks.filter(h => h.enabled).length,
      disabledHooks: this.hooks.filter(h => !h.enabled).length,
      totalFires: this.totalFires,
      totalErrors: this.totalErrors,
      errorRate: this.totalExecutions > 0 ? this.totalErrors / this.totalExecutions : 0,
      dependencyIssues: this.validateDependencies().length,
      slowestHook: slowest,
    };
  }
}
