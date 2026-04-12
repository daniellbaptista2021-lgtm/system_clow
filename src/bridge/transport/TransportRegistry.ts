/**
 * Transport Registry
 *
 * Central registry that maps {@link BridgeTransportVersion} strings to
 * factory functions capable of creating the corresponding {@link Transport}
 * implementation.  Provides a `detectVersion` helper that inspects a work
 * secret to infer which protocol version the server expects.
 */

import type {
  BridgeConfig,
  BridgeSession,
  BridgeTransportVersion,
  Transport,
  TransportFactory,
  WorkResponse,
} from '../types.js';
import { HybridTransport } from './HybridTransport.js';
import { SSETransport } from './SSETransport.js';

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class TransportRegistry {
  private readonly factories = new Map<BridgeTransportVersion, TransportFactory>();

  constructor() {
    // Register built-in transports.
    this.registerDefaults();
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Register (or override) a transport factory for a given version.
   */
  register(version: BridgeTransportVersion, factory: TransportFactory): void {
    this.factories.set(version, factory);
  }

  /**
   * Create a {@link Transport} for the requested version.
   *
   * @throws If no factory is registered for the version.
   */
  create(
    version: BridgeTransportVersion,
    config: BridgeConfig,
    session: BridgeSession,
    workResponse: WorkResponse,
  ): Transport {
    const factory = this.factories.get(version);
    if (!factory) {
      throw new Error(
        `No transport factory registered for version "${version}". ` +
          `Available: ${[...this.factories.keys()].join(', ')}`,
      );
    }
    return factory(config, session, workResponse);
  }

  /**
   * Inspect a work secret to determine the transport version the server
   * expects.
   *
   * Heuristic:
   *  - If the secret starts with `v2:` (or similar prefix) -> v2
   *  - If it is a plain opaque string -> v1
   *  - Otherwise fall back to the config default.
   */
  detectVersion(
    workSecret: string,
    fallback: BridgeTransportVersion = 'v1',
  ): BridgeTransportVersion {
    if (!workSecret) {
      return fallback;
    }

    // Convention: versioned secrets carry a "vN:" prefix.
    const prefixMatch = workSecret.match(/^(v\d+):/);
    if (prefixMatch) {
      const detected = prefixMatch[1] as BridgeTransportVersion;
      if (this.factories.has(detected)) {
        return detected;
      }
    }

    // If the secret is a JWT it likely indicates v2.
    const dotCount = workSecret.split('.').length;
    if (dotCount === 3) {
      return 'v2';
    }

    return fallback;
  }

  /**
   * Return an array of all registered version strings.
   */
  registeredVersions(): BridgeTransportVersion[] {
    return [...this.factories.keys()];
  }

  // -----------------------------------------------------------------------
  // Default registrations
  // -----------------------------------------------------------------------

  private registerDefaults(): void {
    // v1 — Hybrid (WebSocket reads + HTTP POST writes)
    this.register(
      'v1',
      (config, session, workResponse) =>
        new HybridTransport(config, session, workResponse),
    );

    // v2 — SSE reads + CCR POST writes
    this.register(
      'v2',
      (config, session, workResponse) =>
        new SSETransport(config, session, workResponse),
    );
  }
}

/**
 * Singleton registry instance used throughout the bridge.
 */
export const transportRegistry = new TransportRegistry();
