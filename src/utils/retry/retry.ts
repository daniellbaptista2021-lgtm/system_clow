/**
 * retry.ts — Error Recovery with Exponential Backoff
 *
 * Based on Claude Code's error recovery patterns (doc 01, 06, 13)
 *
 * Three components:
 *   classifyError(error)  — routes error to correct recovery path
 *   calculateBackoff()    — exponential with 0-30% jitter
 *   withRetry(fn, opts)   — wraps any async fn with retry logic
 *
 * Error classification for DeepSeek API:
 *   429                        → rate_limit  (60s wait, retry 3x)
 *   500, 502, 503, 504         → retryable   (exp backoff, retry 3x)
 *   ECONNRESET, ETIMEDOUT, etc → retryable   (exp backoff, retry 3x)
 *   400 + context_length msg   → context_overflow (trigger reactive compact, no retry)
 *   401, 403                   → fatal        (no retry, auth error)
 *   400 other                  → fatal        (schema/payload invalid)
 */

// ─── Constants ──────────────────────────────────────────────────────────────

export const MAX_RETRIES = 3;
export const BASE_BACKOFF_MS = 1_000;       // 1s
export const MAX_BACKOFF_MS = 30_000;       // 30s
export const RATE_LIMIT_BACKOFF_MS = 60_000; // 1min on 429

// ─── Error Types ────────────────────────────────────────────────────────────

export type ErrorType = 'retryable' | 'fatal' | 'context_overflow' | 'rate_limit';

// ─── classifyError ──────────────────────────────────────────────────────────

export function classifyError(error: unknown): ErrorType {
  if (!error || typeof error !== 'object') return 'fatal';

  const err = error as Record<string, any>;

  // Extract status code — OpenAI SDK puts it in error.status
  const status: number | undefined =
    err.status ?? err.statusCode ?? err.response?.status;

  // Extract message — DeepSeek puts context_length_exceeded inside JSON body
  const message: string =
    err.message ?? err.error?.message ?? String(err);

  // ── Rate limit (429) ──────────────────────────────────────────────────
  if (status === 429 || /rate.?limit|too many requests/i.test(message)) {
    return 'rate_limit';
  }

  // ── Context overflow (400 + specific message) ─────────────────────────
  // DeepSeek V3.2 returns this inside the error JSON, not as a header
  if (isContextOverflow(err)) {
    return 'context_overflow';
  }

  // ── Auth errors (401, 403) — fatal, no retry ─────────────────────────
  if (status === 401 || status === 403) {
    return 'fatal';
  }

  // ── Other 400 — schema/payload error, fatal ──────────────────────────
  if (status === 400) {
    return 'fatal';
  }

  // ── Server errors (500, 502, 503, 504) — retryable ───────────────────
  if (status !== undefined && status >= 500 && status < 600) {
    return 'retryable';
  }

  // ── Network errors — retryable ────────────────────────────────────────
  const code: string | undefined = err.code ?? err.cause?.code;
  const NETWORK_CODES = new Set([
    'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED',
    'ECONNABORTED', 'EPIPE', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_SOCKET', 'FETCH_ERROR',
  ]);
  if (code && NETWORK_CODES.has(code)) {
    return 'retryable';
  }

  // Network-ish messages without a code
  if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|socket hang up|network|fetch failed/i.test(message)) {
    return 'retryable';
  }

  // ── Abort — never retry user-initiated cancellation ───────────────────
  if (err.name === 'AbortError' || /abort/i.test(message)) {
    return 'fatal';
  }

  // ── Default — assume fatal (fail-closed) ─────────────────────────────
  return 'fatal';
}

// ─── isContextOverflow ──────────────────────────────────────────────────────
// Generous regex because DeepSeek's exact message varies between API versions

export function isContextOverflow(error: any): boolean {
  const msg: string =
    error?.message ?? error?.error?.message ?? '';
  return /context.{0,5}length|maximum context|too long|token.{0,5}limit/i.test(msg);
}

// ─── calculateBackoff ───────────────────────────────────────────────────────
// Exponential with 0-30% jitter — essential so all Clow instances don't
// slam DeepSeek at the same millisecond after a shared outage.

export function calculateBackoff(attempt: number, baseMs: number): number {
  const exp = Math.min(baseMs * Math.pow(2, attempt), MAX_BACKOFF_MS);
  const jitter = Math.random() * 0.3 * exp; // 0-30% jitter
  return Math.floor(exp + jitter);
}

// ─── sleep ──────────────────────────────────────────────────────────────────

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('Retry sleep aborted'));
      }, { once: true });
    }
  });
}

// ─── withRetry ──────────────────────────────────────────────────────────────

export interface RetryOptions {
  /** Max retry attempts (default: MAX_RETRIES = 3) */
  maxRetries?: number;
  /** Base backoff in ms (default: BASE_BACKOFF_MS = 1000) */
  baseBackoffMs?: number;
  /** Abort signal to cancel retries */
  signal?: AbortSignal;
  /** Called before each retry with attempt info */
  onRetry?: (attempt: number, maxRetries: number, backoffMs: number, errorType: ErrorType, error: Error) => void;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? MAX_RETRIES;
  const baseBackoffMs = options.baseBackoffMs ?? BASE_BACKOFF_MS;

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;
      const errorType = classifyError(error);

      // ── Fatal or context_overflow: never retry ────────────────────────
      // context_overflow is handled at QueryEngine level (reactive compact)
      if (errorType === 'fatal' || errorType === 'context_overflow') {
        throw error;
      }

      // ── Last attempt exhausted: throw ─────────────────────────────────
      if (attempt >= maxRetries) {
        throw error;
      }

      // ── Calculate wait time ───────────────────────────────────────────
      let backoffMs: number;
      if (errorType === 'rate_limit') {
        // Fixed 60s for rate limits + small jitter
        backoffMs = RATE_LIMIT_BACKOFF_MS + Math.floor(Math.random() * 5_000);
      } else {
        // Exponential backoff for retryable errors
        backoffMs = calculateBackoff(attempt, baseBackoffMs);
      }

      // ── Log ───────────────────────────────────────────────────────────
      const msg = error?.message || String(error);
      console.error(
        `[retry] attempt ${attempt + 1}/${maxRetries} after ${backoffMs}ms — ${errorType}: ${msg}`,
      );

      options.onRetry?.(attempt + 1, maxRetries, backoffMs, errorType, error);

      // ── Wait ──────────────────────────────────────────────────────────
      await sleep(backoffMs, options.signal);
    }
  }

  // Should never reach here, but TypeScript wants it
  throw lastError ?? new Error('withRetry exhausted');
}
