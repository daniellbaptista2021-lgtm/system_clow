/**
 * Bridge API Client
 *
 * HTTP client that wraps every bridge-server endpoint with typed request /
 * response helpers, automatic retries on 5xx, rate-limit awareness, and
 * structured logging.
 */

import type {
  AckWorkRequest,
  BackoffConfig,
  BridgeConfig,
  CreateBridgeForSessionRequest,
  CreateBridgeForSessionResponse,
  CreateSessionEnvLessRequest,
  CreateSessionEnvLessResponse,
  HeartbeatRequest,
  HeartbeatResponse,
  HttpClient,
  HttpResponse,
  PollForWorkResponse,
  ReconnectSessionRequest,
  ReconnectSessionResponse,
  RegisterEnvironmentRequest,
  RegisterEnvironmentResponse,
  StopWorkRequest,
} from '../types.js';
import { BridgeApiError, DEFAULT_BACKOFF } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeBackoff(attempt: number, config: BackoffConfig): number {
  const base = config.initialDelayMs * Math.pow(config.multiplier, attempt);
  const clamped = Math.min(base, config.maxDelayMs);
  const jitter = 1 + (Math.random() * 2 - 1) * config.jitter;
  return Math.round(clamped * jitter);
}

/** Very small request logger – logs method + path + status. */
function logRequest(
  method: string,
  url: string,
  status: number,
  durationMs: number,
): void {
  const tag = status >= 400 ? '[WARN]' : '[INFO]';
  // Using console.error so it goes to stderr, keeping stdout clean.
  // eslint-disable-next-line no-console
  console.error(
    `${tag} BridgeApi ${method} ${url} → ${status} (${durationMs}ms)`,
  );
}

// ---------------------------------------------------------------------------
// Default HTTP client (uses global fetch)
// ---------------------------------------------------------------------------

const defaultHttpClient: HttpClient = {
  async request(url, options): Promise<HttpResponse> {
    const res = await fetch(url, {
      method: options.method,
      headers: options.headers,
      body: options.body,
      signal: options.signal,
    });

    const headersRecord: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headersRecord[k] = v;
    });

    return {
      status: res.status,
      headers: headersRecord,
      body: await res.text(),
    };
  },
};

// ---------------------------------------------------------------------------
// Rate-limit tracker
// ---------------------------------------------------------------------------

interface RateLimitState {
  retryAfterMs: number;
  blockedUntil: number;
}

// ---------------------------------------------------------------------------
// BridgeApiClient
// ---------------------------------------------------------------------------

export class BridgeApiClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly http: HttpClient;
  private readonly backoff: BackoffConfig;
  private readonly maxRetries: number;
  private rateLimit: RateLimitState | null = null;

  constructor(config: BridgeConfig, httpClient?: HttpClient) {
    // Strip trailing slash for consistent URL building.
    this.baseUrl = config.endpointUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.http = httpClient ?? defaultHttpClient;
    this.backoff = { ...DEFAULT_BACKOFF, ...config.backoff };
    this.maxRetries = 3;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /** Register a new environment with the bridge server. */
  async registerEnvironment(
    req: RegisterEnvironmentRequest,
  ): Promise<RegisterEnvironmentResponse> {
    return this.request<RegisterEnvironmentResponse>(
      'POST',
      '/environments',
      req,
    );
  }

  /** Long-poll (or short-poll) the server for available work. */
  async pollForWork(environmentId: string): Promise<PollForWorkResponse> {
    return this.request<PollForWorkResponse>(
      'GET',
      `/environments/${encodeURIComponent(environmentId)}/work`,
    );
  }

  /** Send a heartbeat for the given environment. */
  async heartbeat(req: HeartbeatRequest): Promise<HeartbeatResponse> {
    return this.request<HeartbeatResponse>(
      'POST',
      `/environments/${encodeURIComponent(req.environmentId)}/heartbeat`,
      req,
    );
  }

  /** Acknowledge that a work item has been picked up. */
  async ackWork(environmentId: string, req: AckWorkRequest): Promise<void> {
    await this.request<Record<string, never>>(
      'POST',
      `/environments/${encodeURIComponent(environmentId)}/work/ack`,
      req,
    );
  }

  /** Report that work has been stopped / completed. */
  async stopWork(environmentId: string, req: StopWorkRequest): Promise<void> {
    await this.request<Record<string, never>>(
      'POST',
      `/environments/${encodeURIComponent(environmentId)}/work/stop`,
      req,
    );
  }

  /** De-register an environment, releasing all resources. */
  async deregisterEnvironment(environmentId: string): Promise<void> {
    await this.request<Record<string, never>>(
      'DELETE',
      `/environments/${encodeURIComponent(environmentId)}`,
    );
  }

  /** Create a session without a pre-registered environment (env-less mode). */
  async createSessionEnvLess(
    req: CreateSessionEnvLessRequest,
  ): Promise<CreateSessionEnvLessResponse> {
    return this.request<CreateSessionEnvLessResponse>(
      'POST',
      '/sessions/env-less',
      req,
    );
  }

  /** Bind an existing session to an environment via a bridge transport. */
  async createBridgeForSession(
    req: CreateBridgeForSessionRequest,
  ): Promise<CreateBridgeForSessionResponse> {
    return this.request<CreateBridgeForSessionResponse>(
      'POST',
      '/sessions/bridge',
      req,
    );
  }

  /** Reconnect to a session that was previously active. */
  async reconnectSession(
    req: ReconnectSessionRequest,
  ): Promise<ReconnectSessionResponse> {
    return this.request<ReconnectSessionResponse>(
      'POST',
      '/sessions/reconnect',
      req,
    );
  }

  // -----------------------------------------------------------------------
  // Private transport
  // -----------------------------------------------------------------------

  /**
   * Core HTTP request method with:
   *  - Auth header injection
   *  - Rate-limit awareness (429 / Retry-After)
   *  - Automatic retry on 5xx
   *  - Request logging
   *  - JSON parsing with error handling
   */
  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    // Respect active rate-limit
    if (this.rateLimit) {
      const waitMs = this.rateLimit.blockedUntil - Date.now();
      if (waitMs > 0) {
        await sleep(waitMs);
      }
      this.rateLimit = null;
    }

    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };

    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const serializedBody = body !== undefined ? JSON.stringify(body) : undefined;

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        const delayMs = computeBackoff(attempt - 1, this.backoff);
        await sleep(delayMs);
      }

      const start = Date.now();
      let response: HttpResponse;

      try {
        response = await this.http.request(url, {
          method,
          headers,
          body: serializedBody,
        });
      } catch (err) {
        lastError =
          err instanceof Error ? err : new Error(String(err));
        // Network-level errors are retried.
        continue;
      }

      const durationMs = Date.now() - start;
      logRequest(method, url, response.status, durationMs);

      // --- Rate-limit handling (429) ---
      if (response.status === 429) {
        const retryAfter = response.headers['retry-after'];
        const retryMs = retryAfter
          ? parseRetryAfter(retryAfter)
          : computeBackoff(attempt, this.backoff);

        this.rateLimit = {
          retryAfterMs: retryMs,
          blockedUntil: Date.now() + retryMs,
        };

        lastError = new BridgeApiError(
          `Rate limited on ${method} ${path}`,
          429,
          response.body,
        );
        await sleep(retryMs);
        continue;
      }

      // --- Retry on 5xx ---
      if (response.status >= 500) {
        lastError = new BridgeApiError(
          `Server error on ${method} ${path}: ${response.status}`,
          response.status,
          response.body,
        );
        continue;
      }

      // --- Client errors are not retried ---
      if (response.status >= 400) {
        throw new BridgeApiError(
          `Client error on ${method} ${path}: ${response.status}`,
          response.status,
          response.body,
        );
      }

      // --- Success ---
      return this.parseJson<T>(response.body, method, path);
    }

    // Exhausted retries.
    throw (
      lastError ??
      new BridgeApiError(`Request to ${method} ${path} failed`, 0)
    );
  }

  /** Safely parse JSON from a response body. */
  private parseJson<T>(raw: string, method: string, path: string): T {
    if (!raw || raw.trim().length === 0) {
      return {} as T;
    }
    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new BridgeApiError(
        `Invalid JSON in response from ${method} ${path}`,
        0,
        raw,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/** Parse the Retry-After header (seconds or HTTP-date) into milliseconds. */
function parseRetryAfter(value: string): number {
  const seconds = Number(value);
  if (!Number.isNaN(seconds)) {
    return seconds * 1_000;
  }
  // Attempt to parse as HTTP-date.
  const date = new Date(value).getTime();
  if (!Number.isNaN(date)) {
    return Math.max(0, date - Date.now());
  }
  // Fallback: 1 second.
  return 1_000;
}
