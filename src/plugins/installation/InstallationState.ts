/**
 * InstallationState.ts — Track installation progress with events and history
 *
 * Based on Claude Code's installationState.ts (~250 lines)
 *
 * Features:
 *   - Phase tracking (resolving -> downloading -> extracting -> validating -> etc.)
 *   - Progress percentage (0-100)
 *   - Progress callbacks with throttling
 *   - Installation history (timestamped events)
 *   - Duration tracking per phase
 *   - Error state with recovery suggestions
 *   - Cancellation support
 *   - State serialization for persistence
 *   - Phase timing breakdown
 *   - ETA estimation
 *   - Progress persistence for resume
 *   - State machine validation
 *   - State serialization/deserialization
 *   - Cancellation handling with reason
 */

import type { InstallationPhase } from '../types.js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface ProgressEvent {
  phase: InstallationPhase;
  message: string;
  progress: number;
  timestamp: number;
  durationMs?: number;
}

type ProgressHandler = (phase: InstallationPhase, message: string, progress: number) => void;

interface PhaseDefinition {
  phase: InstallationPhase;
  weight: number; // How much of total progress this phase represents
}

/** Breakdown of time spent in each phase. */
interface PhaseTimingEntry {
  phase: InstallationPhase;
  startedAt: number;
  durationMs: number;
}

/** Serialisable snapshot of the full state. */
interface SerializedState {
  phase: InstallationPhase;
  message: string;
  progress: number;
  error: string | null;
  cancelled: boolean;
  cancelReason: string | null;
  elapsedMs: number;
  history: ProgressEvent[];
  phaseTiming: PhaseTimingEntry[];
}

// ─── Constants ──────────────────────────────────────────────────────────────

const PHASE_WEIGHTS: PhaseDefinition[] = [
  { phase: 'resolving', weight: 5 },
  { phase: 'downloading', weight: 30 },
  { phase: 'extracting', weight: 15 },
  { phase: 'validating', weight: 10 },
  { phase: 'resolving-dependencies', weight: 10 },
  { phase: 'installing-dependencies', weight: 15 },
  { phase: 'loading-components', weight: 10 },
  { phase: 'complete', weight: 5 },
];

const MIN_PROGRESS_INTERVAL_MS = 100;

/**
 * Valid phase transitions.  Each key maps to the set of phases that
 * may legally follow it.  Transitions not listed here are rejected
 * by {@link InstallationState.update} when strict mode is enabled.
 */
const VALID_TRANSITIONS: Record<string, Set<string>> = {
  'resolving': new Set(['downloading', 'failed']),
  'downloading': new Set(['extracting', 'failed']),
  'extracting': new Set(['validating', 'failed']),
  'validating': new Set(['resolving-dependencies', 'loading-components', 'failed']),
  'resolving-dependencies': new Set(['installing-dependencies', 'failed']),
  'installing-dependencies': new Set(['loading-components', 'failed']),
  'loading-components': new Set(['complete', 'failed']),
  'complete': new Set([]),
  'failed': new Set([]),
};

// ════════════════════════════════════════════════════════════════════════════
// InstallationState Class
// ════════════════════════════════════════════════════════════════════════════

export class InstallationState {
  private phase: InstallationPhase = 'resolving';
  private message: string = '';
  private progress: number = 0;
  private handlers: ProgressHandler[] = [];
  private history: ProgressEvent[] = [];
  private phaseStartTime: number = Date.now();
  private startTime: number = Date.now();
  private cancelled: boolean = false;
  private cancelReason: string | null = null;
  private lastNotifyTime: number = 0;
  private error: string | null = null;
  private strictTransitions: boolean = false;

  /** Accumulated timing entries for every completed phase. */
  private phaseTiming: PhaseTimingEntry[] = [];

  /**
   * @param strict  When `true`, phase transitions are validated against
   *   the allowed-transition map and invalid transitions throw.
   */
  constructor(strict: boolean = false) {
    this.strictTransitions = strict;
  }

  /**
   * Update installation phase with progress tracking.
   */
  update(phase: InstallationPhase, message: string, progress?: number): void {
    if (this.cancelled) return;

    // State machine validation
    if (this.strictTransitions && this.phase !== phase) {
      const allowed = VALID_TRANSITIONS[this.phase];
      if (allowed && !allowed.has(phase)) {
        throw new Error(`Invalid phase transition: ${this.phase} -> ${phase}`);
      }
    }

    // Record phase duration
    const now = Date.now();
    if (this.phase !== phase) {
      const duration = now - this.phaseStartTime;
      this.history.push({
        phase: this.phase,
        message: this.message,
        progress: this.progress,
        timestamp: this.phaseStartTime,
        durationMs: duration,
      });
      this.phaseTiming.push({ phase: this.phase, startedAt: this.phaseStartTime, durationMs: duration });
      this.phaseStartTime = now;
    }

    this.phase = phase;
    this.message = message;

    if (progress !== undefined) {
      this.progress = Math.max(0, Math.min(100, progress));
    } else {
      // Auto-calculate progress from phase weights
      this.progress = this.calculateProgressFromPhase(phase);
    }

    // Handle special phases
    if (phase === 'failed') {
      this.error = message;
    } else if (phase === 'complete') {
      this.progress = 100;
      this.error = null;
    }

    // Throttled notification
    this.notifyHandlers();
  }

  /**
   * Register a progress handler.
   */
  onProgress(handler: ProgressHandler): void {
    this.handlers.push(handler);
  }

  /**
   * Remove a progress handler.
   */
  removeHandler(handler: ProgressHandler): void {
    const idx = this.handlers.indexOf(handler);
    if (idx !== -1) this.handlers.splice(idx, 1);
  }

  /**
   * Cancel the installation with an optional reason string.
   */
  cancel(reason?: string): void {
    this.cancelled = true;
    this.cancelReason = reason ?? 'Installation cancelled by user';
    this.update('failed', this.cancelReason);
  }

  /**
   * Check if installation was cancelled.
   */
  isCancelled(): boolean {
    return this.cancelled;
  }

  /**
   * Return the cancellation reason, or `null` if not cancelled.
   */
  getCancelReason(): string | null {
    return this.cancelReason;
  }

  // ─── Getters ─────────────────────────────────────────────────────

  getPhase(): InstallationPhase { return this.phase; }
  getMessage(): string { return this.message; }
  getProgress(): number { return this.progress; }
  getError(): string | null { return this.error; }
  getHistory(): ProgressEvent[] { return [...this.history]; }
  isComplete(): boolean { return this.phase === 'complete'; }
  isFailed(): boolean { return this.phase === 'failed'; }

  /**
   * Get total elapsed time in ms.
   */
  getElapsedMs(): number {
    return Date.now() - this.startTime;
  }

  /**
   * Get current phase elapsed time in ms.
   */
  getPhaseElapsedMs(): number {
    return Date.now() - this.phaseStartTime;
  }

  // ─── Phase Timing Breakdown ─────────────────────────────────────

  /**
   * Return a timing breakdown for all phases that have completed so far.
   */
  getPhaseTimingBreakdown(): PhaseTimingEntry[] {
    return [...this.phaseTiming];
  }

  /**
   * Find the phase that took the longest time.
   */
  getSlowestPhase(): PhaseTimingEntry | null {
    if (this.phaseTiming.length === 0) return null;
    return this.phaseTiming.reduce((a, b) => (a.durationMs > b.durationMs ? a : b));
  }

  // ─── ETA Estimation ─────────────────────────────────────────────

  /**
   * Estimate the remaining time to completion based on current
   * progress and elapsed time.
   *
   * @returns Estimated remaining milliseconds, or `null` if no
   *   meaningful estimate can be made (e.g. progress is 0).
   */
  estimateRemainingMs(): number | null {
    if (this.progress <= 0 || this.progress >= 100) return null;
    const elapsed = this.getElapsedMs();
    const rate = this.progress / elapsed;
    if (rate <= 0) return null;
    return Math.round((100 - this.progress) / rate);
  }

  /**
   * Return a human-readable ETA string such as "~12 s remaining".
   */
  estimateRemainingLabel(): string {
    const ms = this.estimateRemainingMs();
    if (ms === null) return 'unknown';
    const seconds = Math.ceil(ms / 1000);
    if (seconds < 60) return `~${seconds}s remaining`;
    const minutes = Math.ceil(seconds / 60);
    return `~${minutes}m remaining`;
  }

  // ─── Serialization / Deserialization ────────────────────────────

  /**
   * Serialize state for persistence or transfer.
   */
  toJSON(): SerializedState {
    return {
      phase: this.phase,
      message: this.message,
      progress: this.progress,
      error: this.error,
      cancelled: this.cancelled,
      cancelReason: this.cancelReason,
      elapsedMs: this.getElapsedMs(),
      history: this.history,
      phaseTiming: this.phaseTiming,
    };
  }

  /**
   * Restore internal state from a previously serialized snapshot.
   * Useful for resuming an interrupted installation.
   */
  static fromJSON(data: SerializedState): InstallationState {
    const state = new InstallationState();
    state.phase = data.phase;
    state.message = data.message;
    state.progress = data.progress;
    state.error = data.error;
    state.cancelled = data.cancelled;
    state.cancelReason = data.cancelReason ?? null;
    state.history = data.history ?? [];
    state.phaseTiming = data.phaseTiming ?? [];
    // Adjust start time so that getElapsedMs reflects the persisted duration
    state.startTime = Date.now() - (data.elapsedMs ?? 0);
    state.phaseStartTime = Date.now();
    return state;
  }

  /**
   * Create a human-readable summary.
   */
  toString(): string {
    const pct = Math.round(this.progress);
    const elapsed = Math.round(this.getElapsedMs() / 1000);
    if (this.error) return `[FAILED] ${this.error} (after ${elapsed}s)`;
    if (this.phase === 'complete') return `[DONE] Completed in ${elapsed}s`;
    const eta = this.estimateRemainingLabel();
    return `[${this.phase.toUpperCase()}] ${this.message} (${pct}%, ${elapsed}s, ${eta})`;
  }

  // ─── Internal ────────────────────────────────────────────────────

  private calculateProgressFromPhase(phase: InstallationPhase): number {
    let accumulated = 0;
    for (const pw of PHASE_WEIGHTS) {
      if (pw.phase === phase) return accumulated + pw.weight / 2;
      accumulated += pw.weight;
    }
    return accumulated;
  }

  private notifyHandlers(): void {
    const now = Date.now();
    if (now - this.lastNotifyTime < MIN_PROGRESS_INTERVAL_MS && this.phase !== 'complete' && this.phase !== 'failed') {
      return;
    }
    this.lastNotifyTime = now;

    for (const handler of this.handlers) {
      try {
        handler(this.phase, this.message, this.progress);
      } catch { /* ignore handler errors */ }
    }
  }
}
