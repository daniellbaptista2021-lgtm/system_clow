import type { PollConfig } from '../types.js';
import { DEFAULT_POLL_CONFIG } from '../types.js';

// ---------------------------------------------------------------------------
// PollConfigManager
// ---------------------------------------------------------------------------

export class PollConfigManager {
  private config: PollConfig;

  constructor(initial?: Partial<PollConfig>) {
    this.config = this.applyDefaults(initial);
  }

  /** Get the current poll configuration. */
  getConfig(): Readonly<PollConfig> {
    return { ...this.config };
  }

  /** Merge new values into the configuration. */
  update(partial: Partial<PollConfig>): void {
    this.config = { ...this.config, ...partial };
    this.validate();
  }

  /** Fetch configuration from a remote endpoint. */
  async refreshFromRemote(endpoint: string): Promise<void> {
    try {
      const response = await fetch(endpoint);
      if (!response.ok) {
        throw new Error('HTTP ' + response.status);
      }
      const data = (await response.json()) as Partial<PollConfig>;
      this.update(data);
    } catch (err) {
      console.error(
        '[PollConfigManager] Failed to refresh from remote:',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /** Apply defaults to a partial config. */
  applyDefaults(partial?: Partial<PollConfig>): PollConfig {
    return {
      intervalMs: partial?.intervalMs ?? DEFAULT_POLL_CONFIG.intervalMs,
      maxIntervalMs: partial?.maxIntervalMs ?? DEFAULT_POLL_CONFIG.maxIntervalMs,
      idleThreshold: partial?.idleThreshold ?? DEFAULT_POLL_CONFIG.idleThreshold,
      atCapacityMs: partial?.atCapacityMs ?? DEFAULT_POLL_CONFIG.atCapacityMs,
      notAtCapacityMs: partial?.notAtCapacityMs ?? DEFAULT_POLL_CONFIG.notAtCapacityMs,
      partialCapacityMs: partial?.partialCapacityMs ?? DEFAULT_POLL_CONFIG.partialCapacityMs,
    };
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private validate(): void {
    const d = DEFAULT_POLL_CONFIG;
    if (this.config.intervalMs <= 0) this.config.intervalMs = d.intervalMs;
    if (this.config.maxIntervalMs < this.config.intervalMs) {
      this.config.maxIntervalMs = this.config.intervalMs * 15;
    }
    if (this.config.idleThreshold <= 0) this.config.idleThreshold = d.idleThreshold;
    if (this.config.atCapacityMs <= 0) this.config.atCapacityMs = d.atCapacityMs;
    if (this.config.notAtCapacityMs <= 0) this.config.notAtCapacityMs = d.notAtCapacityMs;
    if (this.config.partialCapacityMs <= 0) this.config.partialCapacityMs = d.partialCapacityMs;
  }
}
