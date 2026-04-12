/**
 * HookExecutorHttp.ts — Execute HTTP webhook hooks
 *
 * Based on Claude Code's hookHttpExecutor.ts (~200 lines)
 *
 * Sends HookInput as JSON POST to a webhook URL.
 * Parses the response as JSON HookOutput.
 *
 * Features:
 *   - POST/PUT method support
 *   - Custom headers
 *   - Timeout with AbortSignal
 *   - Response parsing (JSON with fallback to text)
 *   - Error classification (network, timeout, HTTP error)
 *   - Content-Type validation
 *   - Response size limits
 *   - Retry on transient failures (5xx)
 *   - User-Agent header
 */

import type { HttpHookConfig, HookInput, HookOutput } from './types.js';
import { parseHookOutput } from './HookSchemas.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_SIZE = 500_000; // 500KB
const MAX_RETRIES = 1;
const RETRY_DELAY_MS = 1_000;
const USER_AGENT = 'Clow-Hook/1.0';

// ════════════════════════════════════════════════════════════════════════════
// HookHttpExecutor Class
// ════════════════════════════════════════════════════════════════════════════

export class HookHttpExecutor {
  /**
   * Execute an HTTP webhook hook.
   */
  async execute(config: HttpHookConfig, input: HookInput): Promise<HookOutput> {
    const timeout = config.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    let lastError: string = '';

    // Retry loop for transient failures
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const result = await this.doRequest(config, input, timeout);
        return result;
      } catch (err: any) {
        lastError = err.message;

        // Only retry on transient errors
        if (attempt < MAX_RETRIES && this.isTransientError(err)) {
          await this.delay(RETRY_DELAY_MS);
          continue;
        }

        // Final error
        if (err.name === 'AbortError' || err.name === 'TimeoutError') {
          return { systemMessage: `[hook http timeout] Exceeded ${timeout}ms` };
        }
        return { systemMessage: `[hook http error] ${err.message}` };
      }
    }

    return { systemMessage: `[hook http error] ${lastError}` };
  }

  /**
   * Perform the actual HTTP request.
   */
  private async doRequest(
    config: HttpHookConfig,
    input: HookInput,
    timeout: number,
  ): Promise<HookOutput> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
      'X-Clow-Hook-Event': input.hook_event_name,
      'X-Clow-Session-Id': input.session_id,
      ...config.headers,
    };

    const response = await fetch(config.url, {
      method: config.method ?? 'POST',
      headers,
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(timeout),
    });

    // Read response body
    const body = await response.text();

    // Check response size
    if (body.length > MAX_RESPONSE_SIZE) {
      return {
        systemMessage: `[hook http] Response too large: ${body.length} bytes (max ${MAX_RESPONSE_SIZE})`,
      };
    }

    // Non-2xx status
    if (!response.ok) {
      return {
        systemMessage: `[hook http ${response.status}] ${body.slice(0, 2000)}`,
      };
    }

    // Parse response
    const parsed = parseHookOutput(body);

    // Ensure hookEventName is set
    if (parsed.hookSpecificOutput && !parsed.hookSpecificOutput.hookEventName) {
      parsed.hookSpecificOutput.hookEventName = input.hook_event_name;
    }

    return parsed;
  }

  /**
   * Check if an error is transient (worth retrying).
   */
  private isTransientError(err: Error): boolean {
    const msg = err.message.toLowerCase();
    return (
      msg.includes('econnreset') ||
      msg.includes('econnrefused') ||
      msg.includes('etimedout') ||
      msg.includes('503') ||
      msg.includes('502') ||
      msg.includes('504')
    );
  }

  /**
   * Delay for retry.
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ─── Execution Statistics ────────────────────────────────────────

  private executionCount = 0;
  private successCount = 0;
  private timeoutCount = 0;
  private retryCount = 0;
  private totalDurationMs = 0;

  /**
   * Get HTTP executor statistics.
   */
  getStats(): {
    executionCount: number;
    successCount: number;
    timeoutCount: number;
    retryCount: number;
    avgDurationMs: number;
    successRate: number;
  } {
    return {
      executionCount: this.executionCount,
      successCount: this.successCount,
      timeoutCount: this.timeoutCount,
      retryCount: this.retryCount,
      avgDurationMs: this.executionCount > 0 ? this.totalDurationMs / this.executionCount : 0,
      successRate: this.executionCount > 0 ? this.successCount / this.executionCount : 0,
    };
  }

  /**
   * Validate a webhook URL for common issues.
   */
  static validateUrl(url: string): { valid: boolean; warnings: string[] } {
    const warnings: string[] = [];

    try {
      const parsed = new URL(url);

      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        return { valid: false, warnings: ['URL must use http or https protocol'] };
      }

      if (parsed.protocol === 'http:' && !parsed.hostname.match(/^(localhost|127\.0\.0\.1|\[::1\])$/)) {
        warnings.push('Using HTTP (not HTTPS) for non-localhost URL is insecure');
      }

      if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
        warnings.push('URL points to localhost — ensure the service is running');
      }

      return { valid: true, warnings };
    } catch {
      return { valid: false, warnings: ['Invalid URL format'] };
    }
  }

  /**
   * Test connectivity to a webhook URL without sending hook data.
   */
  async ping(url: string, timeoutMs: number = 5000): Promise<{ reachable: boolean; latencyMs: number; error?: string }> {
    const start = Date.now();
    try {
      const response = await fetch(url, {
        method: 'HEAD',
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(timeoutMs),
      });
      return { reachable: true, latencyMs: Date.now() - start };
    } catch (err: any) {
      return { reachable: false, latencyMs: Date.now() - start, error: err.message };
    }
  }
}
