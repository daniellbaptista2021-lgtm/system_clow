/**
 * MarketplaceClient.ts — HTTP client for Clow marketplace API
 *
 * Based on Claude Code's marketplace HTTP client patterns
 *
 * Features:
 *   - Catalog fetch (full catalog JSON from GCS)
 *   - Plugin manifest fetch (per-plugin metadata)
 *   - Plugin download (zip binary with progress tracking)
 *   - Blocklist fetch (remotely disabled plugins)
 *   - Flagged plugins fetch
 *   - Install count reporting
 *   - Request retry with exponential backoff
 *   - Rate limiting (1 req/sec default)
 *   - Timeout configuration per endpoint
 *   - Custom headers (auth, user-agent, etc)
 *   - Response caching headers support (ETag, If-None-Match)
 *   - Error classification (network, auth, not-found, server)
 *   - Request logging for debugging
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import type {
  MarketplaceCatalog,
  MarketplaceCatalogEntry,
  PluginManifest,
  PluginAuthor,
} from '../types.js';
import {
  OFFICIAL_MARKETPLACE_URL,
  OFFICIAL_MARKETPLACE_ID,
  CATALOG_PATH,
  BLOCKLIST_PATH,
} from './OfficialMarketplace.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const BLOCKLIST_TIMEOUT_MS = 10_000;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 15_000;
const RATE_LIMIT_MIN_INTERVAL_MS = 1_000;
const MAX_RESPONSE_SIZE_BYTES = 50 * 1024 * 1024; // 50MB max for downloads
const MAX_CATALOG_SIZE_BYTES = 10 * 1024 * 1024;  // 10MB max for catalog JSON
const USER_AGENT = 'Clow-Marketplace/1.0';

// ─── Types ──────────────────────────────────────────────────────────────────

export type MarketplaceErrorType =
  | 'network'          // ECONNRESET, timeout, DNS
  | 'auth'             // 401, 403
  | 'not_found'        // 404
  | 'rate_limited'     // 429
  | 'server_error'     // 500-599
  | 'invalid_response' // non-JSON, corrupt
  | 'too_large'        // response exceeds size limit
  | 'unknown';

export class MarketplaceError extends Error {
  constructor(
    message: string,
    public readonly type: MarketplaceErrorType,
    public readonly status?: number,
    public readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = 'MarketplaceError';
  }
}

export interface DownloadProgress {
  bytesDownloaded: number;
  totalBytes: number | null;
  percent: number;  // 0-100, -1 if total unknown
}

export type DownloadProgressCallback = (progress: DownloadProgress) => void;

export interface RequestOptions {
  timeoutMs?: number;
  headers?: Record<string, string>;
  etag?: string;  // for conditional requests
  maxSizeBytes?: number;
  retries?: number;
}

interface RequestLog {
  url: string;
  method: string;
  status?: number;
  durationMs: number;
  error?: string;
  cached: boolean;
  retryCount: number;
}

// ════════════════════════════════════════════════════════════════════════════
// MarketplaceClient Class
// ════════════════════════════════════════════════════════════════════════════

export class MarketplaceClient {
  private readonly baseUrl: string;
  private readonly defaultHeaders: Record<string, string>;
  private lastRequestTime: number = 0;
  private requestLog: RequestLog[] = [];
  private etagCache: Map<string, string> = new Map();

  constructor(
    baseUrl: string = OFFICIAL_MARKETPLACE_URL,
    options: {
      authToken?: string;
      customHeaders?: Record<string, string>;
    } = {},
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.defaultHeaders = {
      'User-Agent': USER_AGENT,
      'Accept': 'application/json',
      ...options.customHeaders,
    };
    if (options.authToken) {
      this.defaultHeaders['Authorization'] = `Bearer ${options.authToken}`;
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // Catalog Operations
  // ════════════════════════════════════════════════════════════════════

  /**
   * Fetch the full marketplace catalog.
   * Returns cached version if ETag matches (304 Not Modified).
   */
  async fetchCatalog(options: RequestOptions = {}): Promise<MarketplaceCatalog> {
    const url = `${this.baseUrl}${CATALOG_PATH}`;
    const etag = this.etagCache.get(url);

    const response = await this.request(url, {
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      headers: etag ? { 'If-None-Match': etag } : undefined,
      maxSizeBytes: MAX_CATALOG_SIZE_BYTES,
      retries: options.retries ?? MAX_RETRIES,
    });

    // Store ETag for future conditional requests
    const newEtag = response.headers.get('etag');
    if (newEtag) {
      this.etagCache.set(url, newEtag);
    }

    const data = await this.parseJSON<MarketplaceCatalog>(response, url);

    // Validate basic structure
    if (!data.plugins || !Array.isArray(data.plugins)) {
      throw new MarketplaceError(
        'Invalid catalog: missing plugins array',
        'invalid_response',
      );
    }

    // Enrich with metadata
    return {
      ...data,
      marketplaceId: data.marketplaceId ?? OFFICIAL_MARKETPLACE_ID,
      lastFetchedAt: Date.now(),
    };
  }

  /**
   * Fetch manifest for a specific plugin version.
   */
  async fetchManifest(
    pluginId: string,
    version: string,
    options: RequestOptions = {},
  ): Promise<PluginManifest> {
    const url = `${this.baseUrl}/plugins/${encodeURIComponent(pluginId)}/${encodeURIComponent(version)}/manifest.json`;

    const response = await this.request(url, {
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      retries: options.retries ?? MAX_RETRIES,
    });

    return this.parseJSON<PluginManifest>(response, url);
  }

  /**
   * Fetch details for a specific plugin (latest version).
   */
  async fetchPluginDetails(pluginId: string): Promise<MarketplaceCatalogEntry | null> {
    try {
      const catalog = await this.fetchCatalog();
      const entries = catalog.plugins
        .filter(p => p.pluginId === pluginId || p.name === pluginId)
        .sort((a, b) => b.updatedAt - a.updatedAt);
      return entries[0] ?? null;
    } catch {
      return null;
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // Download Operations
  // ════════════════════════════════════════════════════════════════════

  /**
   * Download a plugin zip to a file path.
   * Supports progress callback for UI reporting.
   * Validates Content-Length against size limit.
   */
  async download(
    downloadUrl: string,
    destPath: string,
    options: {
      onProgress?: DownloadProgressCallback;
      maxSizeBytes?: number;
      timeoutMs?: number;
    } = {},
  ): Promise<{ bytesWritten: number; durationMs: number }> {
    const startTime = Date.now();
    const maxSize = options.maxSizeBytes ?? MAX_RESPONSE_SIZE_BYTES;

    await this.rateLimitWait();

    const response = await this.requestRaw(downloadUrl, {
      timeoutMs: options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS,
    });

    // Check Content-Length
    const contentLength = response.headers.get('content-length');
    const totalBytes = contentLength ? parseInt(contentLength, 10) : null;

    if (totalBytes && totalBytes > maxSize) {
      throw new MarketplaceError(
        `Download too large: ${totalBytes} bytes (max ${maxSize})`,
        'too_large',
      );
    }

    // Stream to file
    const dir = path.dirname(destPath);
    await fsp.mkdir(dir, { recursive: true });

    const reader = response.body?.getReader();
    if (!reader) {
      throw new MarketplaceError('Response has no body', 'invalid_response');
    }

    const chunks: Buffer[] = [];
    let bytesDownloaded = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = Buffer.from(value);
        chunks.push(chunk);
        bytesDownloaded += chunk.length;

        // Size check during streaming
        if (bytesDownloaded > maxSize) {
          reader.cancel();
          throw new MarketplaceError(
            `Download exceeded size limit: ${bytesDownloaded} > ${maxSize}`,
            'too_large',
          );
        }

        // Progress callback
        if (options.onProgress) {
          options.onProgress({
            bytesDownloaded,
            totalBytes,
            percent: totalBytes ? Math.floor((bytesDownloaded / totalBytes) * 100) : -1,
          });
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Write to disk
    const fullBuffer = Buffer.concat(chunks);
    await fsp.writeFile(destPath, fullBuffer);

    return {
      bytesWritten: bytesDownloaded,
      durationMs: Date.now() - startTime,
    };
  }

  // ════════════════════════════════════════════════════════════════════
  // Security Operations
  // ════════════════════════════════════════════════════════════════════

  /**
   * Fetch the remote blocklist of disabled plugins.
   * Never throws — returns empty array on failure.
   */
  async fetchBlocklist(): Promise<string[]> {
    try {
      const url = `${this.baseUrl}${BLOCKLIST_PATH}`;
      const response = await this.request(url, {
        timeoutMs: BLOCKLIST_TIMEOUT_MS,
        retries: 1,  // Only 1 retry for blocklist
      });

      const data = await this.parseJSON<{ blocked: string[]; updatedAt?: number }>(response, url);
      return data.blocked ?? [];
    } catch {
      // Blocklist fetch failure is non-critical
      return [];
    }
  }

  /**
   * Fetch list of flagged plugins (under review).
   */
  async fetchFlagged(): Promise<string[]> {
    try {
      const url = `${this.baseUrl}/flagged.json`;
      const response = await this.request(url, {
        timeoutMs: BLOCKLIST_TIMEOUT_MS,
        retries: 1,
      });

      const data = await this.parseJSON<{ flagged: string[] }>(response, url);
      return data.flagged ?? [];
    } catch {
      return [];
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // Telemetry Operations
  // ════════════════════════════════════════════════════════════════════

  /**
   * Report plugin install to marketplace (anonymous telemetry).
   * Fire-and-forget — never blocks or throws.
   */
  reportInstall(pluginId: string, version: string): void {
    const url = `${this.baseUrl}/telemetry/install`;
    // Fire and forget
    fetch(url, {
      method: 'POST',
      headers: {
        ...this.defaultHeaders,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        pluginId,
        version,
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
        timestamp: Date.now(),
      }),
      signal: AbortSignal.timeout(5_000),
    }).catch(() => {}); // Silently ignore failures
  }

  // ════════════════════════════════════════════════════════════════════
  // Core HTTP Layer
  // ════════════════════════════════════════════════════════════════════

  /**
   * Make an HTTP request with retry, rate limiting, and error classification.
   */
  private async request(
    url: string,
    options: RequestOptions = {},
  ): Promise<Response> {
    const maxRetries = options.retries ?? MAX_RETRIES;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const startTime = Date.now();
      const logEntry: Partial<RequestLog> = {
        url,
        method: 'GET',
        retryCount: attempt,
        cached: false,
      };

      try {
        await this.rateLimitWait();

        const response = await fetch(url, {
          method: 'GET',
          headers: {
            ...this.defaultHeaders,
            ...options.headers,
            ...(options.etag ? { 'If-None-Match': options.etag } : {}),
          },
          signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        });

        logEntry.status = response.status;
        logEntry.durationMs = Date.now() - startTime;

        // 304 Not Modified
        if (response.status === 304) {
          logEntry.cached = true;
          this.logRequest(logEntry as RequestLog);
          return response;
        }

        // Success
        if (response.ok) {
          this.logRequest(logEntry as RequestLog);
          return response;
        }

        // Classify error
        const error = this.classifyResponseError(response);

        if (error.retryable && attempt < maxRetries) {
          logEntry.error = error.message;
          this.logRequest(logEntry as RequestLog);
          await this.retryDelay(attempt);
          continue;
        }

        throw error;

      } catch (err) {
        lastError = err instanceof MarketplaceError ? err : this.classifyNetworkError(err as Error);
        logEntry.error = lastError.message;
        logEntry.durationMs = Date.now() - startTime;
        this.logRequest(logEntry as RequestLog);

        if ((lastError as MarketplaceError).retryable && attempt < maxRetries) {
          await this.retryDelay(attempt);
          continue;
        }

        throw lastError;
      }
    }

    throw lastError ?? new MarketplaceError('Request failed', 'unknown');
  }

  /**
   * Raw request without JSON parsing (for binary downloads).
   */
  private async requestRaw(url: string, options: RequestOptions = {}): Promise<Response> {
    await this.rateLimitWait();

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        ...this.defaultHeaders,
        'Accept': '*/*',
        ...options.headers,
      },
      signal: AbortSignal.timeout(options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw this.classifyResponseError(response);
    }

    return response;
  }

  // ════════════════════════════════════════════════════════════════════
  // Response Parsing
  // ════════════════════════════════════════════════════════════════════

  /**
   * Parse JSON response with size limit and error handling.
   */
  private async parseJSON<T>(response: Response, url: string): Promise<T> {
    let text: string;

    try {
      text = await response.text();
    } catch (err) {
      throw new MarketplaceError(
        `Failed to read response body from ${url}: ${(err as Error).message}`,
        'invalid_response',
      );
    }

    if (text.length === 0) {
      throw new MarketplaceError(
        `Empty response from ${url}`,
        'invalid_response',
      );
    }

    try {
      return JSON.parse(text) as T;
    } catch (err) {
      throw new MarketplaceError(
        `Invalid JSON from ${url}: ${(err as Error).message}`,
        'invalid_response',
      );
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // Error Classification
  // ════════════════════════════════════════════════════════════════════

  /**
   * Classify HTTP response errors.
   */
  private classifyResponseError(response: Response): MarketplaceError {
    const status = response.status;

    if (status === 401 || status === 403) {
      return new MarketplaceError(
        `Authentication failed: ${status} ${response.statusText}`,
        'auth',
        status,
        false,
      );
    }

    if (status === 404) {
      return new MarketplaceError(
        `Not found: ${response.url}`,
        'not_found',
        status,
        false,
      );
    }

    if (status === 429) {
      return new MarketplaceError(
        'Rate limited by marketplace',
        'rate_limited',
        status,
        true,  // retryable after delay
      );
    }

    if (status >= 500) {
      return new MarketplaceError(
        `Server error: ${status} ${response.statusText}`,
        'server_error',
        status,
        true,  // retryable
      );
    }

    return new MarketplaceError(
      `HTTP ${status}: ${response.statusText}`,
      'unknown',
      status,
      false,
    );
  }

  /**
   * Classify network-level errors (timeouts, DNS, connection reset).
   */
  private classifyNetworkError(err: Error): MarketplaceError {
    const msg = err.message.toLowerCase();

    if (err.name === 'AbortError' || msg.includes('timeout') || msg.includes('abort')) {
      return new MarketplaceError(
        `Request timed out: ${err.message}`,
        'network',
        undefined,
        true,  // retryable
      );
    }

    if (msg.includes('econnreset') || msg.includes('econnrefused') ||
        msg.includes('etimedout') || msg.includes('enotfound') ||
        msg.includes('fetch failed') || msg.includes('network')) {
      return new MarketplaceError(
        `Network error: ${err.message}`,
        'network',
        undefined,
        true,  // retryable
      );
    }

    return new MarketplaceError(
      err.message,
      'unknown',
      undefined,
      false,
    );
  }

  // ════════════════════════════════════════════════════════════════════
  // Rate Limiting & Retry
  // ════════════════════════════════════════════════════════════════════

  /**
   * Wait if necessary to respect rate limit.
   */
  private async rateLimitWait(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;

    if (elapsed < RATE_LIMIT_MIN_INTERVAL_MS) {
      await new Promise(r => setTimeout(r, RATE_LIMIT_MIN_INTERVAL_MS - elapsed));
    }

    this.lastRequestTime = Date.now();
  }

  /**
   * Exponential backoff delay between retries.
   */
  private async retryDelay(attempt: number): Promise<void> {
    const delay = Math.min(
      RETRY_BASE_DELAY_MS * Math.pow(2, attempt),
      MAX_RETRY_DELAY_MS,
    );
    // Add jitter (0-30%)
    const jitter = Math.random() * 0.3 * delay;
    await new Promise(r => setTimeout(r, delay + jitter));
  }

  // ════════════════════════════════════════════════════════════════════
  // Request Logging
  // ════════════════════════════════════════════════════════════════════

  /**
   * Log request for debugging (keeps last 100).
   */
  private logRequest(entry: RequestLog): void {
    this.requestLog.push(entry);
    if (this.requestLog.length > 100) {
      this.requestLog = this.requestLog.slice(-50);
    }
  }

  /**
   * Get recent request logs (for debugging).
   */
  getRequestLog(): readonly RequestLog[] {
    return this.requestLog;
  }

  /**
   * Clear request log.
   */
  clearRequestLog(): void {
    this.requestLog = [];
  }

  // ════════════════════════════════════════════════════════════════════
  // Configuration
  // ════════════════════════════════════════════════════════════════════

  /**
   * Get the base URL this client is configured for.
   */
  getBaseUrl(): string {
    return this.baseUrl;
  }

  /**
   * Test connectivity to the marketplace.
   * Returns latency in ms, or throws on failure.
   */
  async ping(): Promise<number> {
    const start = Date.now();
    await this.request(`${this.baseUrl}/health`, {
      timeoutMs: 5_000,
      retries: 0,
    });
    return Date.now() - start;
  }

  // ════════════════════════════════════════════════════════════════════
  // Extended API Methods
  // ════════════════════════════════════════════════════════════════════

  /**
   * Fetch the README for a specific plugin version.
   */
  async fetchReadme(pluginId: string, version: string): Promise<string | null> {
    const url = `${this.baseUrl}/plugins/${encodeURIComponent(pluginId)}/${encodeURIComponent(version)}/README.md`;
    try {
      return await this.request(url, { timeoutMs: 10_000, retries: 1 }) as unknown as string;
    } catch {
      return null;
    }
  }

  /**
   * Fetch the changelog for a specific plugin version.
   */
  async fetchChangelog(pluginId: string, version: string): Promise<string | null> {
    const url = `${this.baseUrl}/plugins/${encodeURIComponent(pluginId)}/${encodeURIComponent(version)}/CHANGELOG.md`;
    try {
      return await this.request(url, { timeoutMs: 10_000, retries: 1 }) as unknown as string;
    } catch {
      return null;
    }
  }

  /**
   * Report a telemetry event (install/uninstall/update).
   * Fire-and-forget: never blocks or throws.
   */
  async reportTelemetry(eventType: 'install' | 'uninstall' | 'update', data: {
    pluginId: string;
    version: string;
    source?: string;
  }): Promise<void> {
    const paths: Record<string, string> = {
      install: '/telemetry/install',
      uninstall: '/telemetry/uninstall',
      update: '/telemetry/update',
    };

    try {
      await fetch(`${this.baseUrl}${paths[eventType]}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'Clow-MarketplaceClient/1.0' },
        body: JSON.stringify({ ...data, timestamp: Date.now() }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      // Telemetry is best-effort — never fail
    }
  }

  /**
   * Fetch all available versions for a plugin.
   */
  async fetchVersions(pluginId: string): Promise<string[]> {
    try {
      const catalog = await this.fetchCatalog();
      const entry = catalog.plugins.find(p => p.pluginId === pluginId || p.name === pluginId);
      if (!entry) return [];
      // Catalog only has latest version; for full version list we'd need a versions endpoint
      return [entry.version];
    } catch {
      return [];
    }
  }

  /**
   * Check if the marketplace is reachable and healthy.
   */
  async healthCheck(): Promise<{
    healthy: boolean;
    latencyMs: number;
    error?: string;
  }> {
    try {
      const latency = await this.ping();
      return { healthy: true, latencyMs: latency };
    } catch (err) {
      return { healthy: false, latencyMs: -1, error: (err as Error).message };
    }
  }

  /**
   * Get client statistics.
   */
  getStats(): {
    totalRequests: number;
    successCount: number;
    errorCount: number;
    avgLatencyMs: number;
    lastRequestAt: number;
  } {
    const successCount = this.requestLog.filter(r => (r.status ?? 0) < 400).length;
    const errorCount = this.requestLog.filter(r => (r.status ?? 0) >= 400 || r.error).length;
    const totalLatency = this.requestLog.reduce((sum, r) => sum + r.durationMs, 0);

    return {
      totalRequests: this.requestLog.length,
      successCount,
      errorCount,
      avgLatencyMs: this.requestLog.length > 0 ? totalLatency / this.requestLog.length : 0,
      lastRequestAt: Date.now(),
    };
  }
}
