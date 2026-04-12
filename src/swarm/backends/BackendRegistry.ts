/**
 * BackendRegistry.ts — Detects and manages terminal backends
 *
 * Responsible for:
 *   - Registering available PaneBackend implementations
 *   - Auto-detecting the best backend for the current environment
 *   - Providing access to backends by type
 *   - Cleaning up all backends on shutdown
 */

import type { PaneBackend, BackendType } from '../types.js';

// ────────────────────────────────────────────────────────────────────────────
// Registry
// ────────────────────────────────────────────────────────────────────────────

export class BackendRegistry {
  private readonly backends = new Map<BackendType, PaneBackend>();
  private detectedType: BackendType | null = null;

  // ── Registration ──────────────────────────────────────────────────────

  /**
   * Register a backend implementation. Overwrites any previous backend of
   * the same type.
   */
  register(backend: PaneBackend): void {
    this.backends.set(backend.type, backend);
  }

  /**
   * Return all registered backend types.
   */
  registeredTypes(): BackendType[] {
    return Array.from(this.backends.keys());
  }

  // ── Detection ─────────────────────────────────────────────────────────

  /**
   * Detect the best available backend for the current environment.
   *
   * Priority order:
   *   1. Already inside a tmux session (TMUX env var set)
   *   2. Running inside iTerm2 (TERM_PROGRAM === 'iTerm.app')
   *   3. tmux binary is available on PATH
   *   4. Fallback to in-process
   */
  async detect(): Promise<BackendType> {
    // Fast path: return cached result
    if (this.detectedType != null) {
      return this.detectedType;
    }

    // 1. Inside a tmux session already?
    if (process.env['TMUX']) {
      const tmux = this.backends.get('tmux');
      if (tmux && (await tmux.isAvailable())) {
        this.detectedType = 'tmux';
        return this.detectedType;
      }
    }

    // 2. Inside iTerm2?
    if (process.env['TERM_PROGRAM'] === 'iTerm.app') {
      const iterm = this.backends.get('iterm2');
      if (iterm && (await iterm.isAvailable())) {
        this.detectedType = 'iterm2';
        return this.detectedType;
      }
    }

    // 3. tmux available on the system?
    const tmux = this.backends.get('tmux');
    if (tmux && (await tmux.isAvailable())) {
      this.detectedType = 'tmux';
      return this.detectedType;
    }

    // 4. Fallback to in-process
    this.detectedType = 'in-process';
    return this.detectedType;
  }

  /**
   * Force-set the detected backend type (useful for tests / overrides).
   */
  setDetectedType(type: BackendType): void {
    this.detectedType = type;
  }

  // ── Access ────────────────────────────────────────────────────────────

  /**
   * Get a backend by type. Throws if the type has not been registered.
   */
  get(type: BackendType): PaneBackend {
    const backend = this.backends.get(type);
    if (!backend) {
      throw new Error(
        `Backend "${type}" is not registered. ` +
          `Available: ${this.registeredTypes().join(', ') || 'none'}`,
      );
    }
    return backend;
  }

  /**
   * Get the detected (or explicitly set) backend. Calls detect() if no
   * type has been resolved yet.
   */
  async getDetected(): Promise<PaneBackend> {
    const type = await this.detect();
    return this.get(type);
  }

  /**
   * Check whether a backend of the given type is registered.
   */
  has(type: BackendType): boolean {
    return this.backends.has(type);
  }

  // ── Convenience predicates ────────────────────────────────────────────

  /**
   * Returns true when the in-process backend is the detected (or only)
   * option -- meaning we have no real terminal multiplexer.
   */
  isInProcessFallback(): boolean {
    return this.detectedType === 'in-process';
  }

  // ── Cleanup ───────────────────────────────────────────────────────────

  /**
   * Cleanup all registered backends. Errors are collected and re-thrown as
   * a single AggregateError after every backend has had a chance to clean up.
   */
  async cleanupAll(): Promise<void> {
    const errors: Error[] = [];

    for (const [type, backend] of this.backends) {
      try {
        await backend.cleanup();
      } catch (err) {
        errors.push(
          new Error(`Cleanup failed for backend "${type}": ${err}`, {
            cause: err,
          }),
        );
      }
    }

    this.backends.clear();
    this.detectedType = null;

    if (errors.length > 0) {
      throw new AggregateError(errors, 'One or more backends failed to clean up');
    }
  }

  /**
   * Cleanup a single backend by type. No-op if the type is not registered.
   */
  async cleanupOne(type: BackendType): Promise<void> {
    const backend = this.backends.get(type);
    if (backend) {
      await backend.cleanup();
      this.backends.delete(type);
    }
  }

  // ── Debugging ─────────────────────────────────────────────────────────

  /**
   * Return a summary of registry state for logging / debugging.
   */
  debugSummary(): string {
    const lines: string[] = [
      `BackendRegistry (detected: ${this.detectedType ?? 'none'})`,
    ];
    for (const [type] of this.backends) {
      lines.push(`  - ${type}`);
    }
    return lines.join('\n');
  }
}

/**
 * Create a pre-wired registry with the standard set of backends.
 * Import each backend and register it before returning.
 */
export function createDefaultRegistry(
  backends: PaneBackend[],
): BackendRegistry {
  const registry = new BackendRegistry();
  for (const b of backends) {
    registry.register(b);
  }
  return registry;
}
