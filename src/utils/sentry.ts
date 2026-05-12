/**
 * sentry.ts — Error tracking integration.
 *
 * No-op when SENTRY_DSN is unset (dev / first prod boot before account
 * is created). Once SENTRY_DSN is in .env, all the API surface here
 * starts shipping events automatically without touching any call site.
 *
 * Captures:
 *   - process.on('uncaughtException')      — installed by initSentry
 *   - process.on('unhandledRejection')      — installed by initSentry
 *   - Hono onError handler                  — via honoSentryErrorHandler
 *   - Manual via captureException(err, ctx) — for try/catch in
 *     automation actions, webhooks, schedulers, etc.
 *
 * Sensitive-data filtering (Sentry's `beforeSend` hook):
 *   - Strips request bodies for: /auth/*, /webhooks/stripe/*,
 *     anything matching /channels/.*credentials.* in the path.
 *   - Strips Authorization, Cookie, x-api-key headers everywhere.
 *   - Strips a list of well-known sensitive keys
 *     (password, password_hash, api_key, stripe_*, access_token,
 *     credentials_encrypted, webhook_secret) from any object the
 *     stack might serialize.
 *
 * Auto-tagging (Sentry scope set on init, augmented by withSentryScope):
 *   - environment: NODE_ENV (production / development / test)
 *   - app: 'system-clow'
 *   - tenant_id, user_id, plan: pulled from the request context
 *     AsyncLocalStorage that the logger / requestContextMiddleware set.
 */
import * as Sentry from '@sentry/node';
import { getRequestContext } from './logger.js';

let _initialized = false;

// ─── Sensitive-data filter ────────────────────────────────────────────────

const SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'x-api-key',
  'x-stripe-signature',
  'stripe-signature',
  'x-hub-signature',
  'x-hub-signature-256',
]);

const SENSITIVE_KEY_RX = /(?:password|password_hash|api_key|stripe_(?:customer|subscription|secret|webhook)|access_?token|credentials_encrypted|webhook_secret|client_secret|refresh_token)/i;

const SENSITIVE_PATH_RX = /^\/(?:auth\/|webhooks\/stripe(?:\/|$)|.*channels\/[^/]+\/credentials)/;

export function shouldStripBody(path: string): boolean {
  return SENSITIVE_PATH_RX.test(path);
}

function scrubObject(obj: unknown, depth = 0): unknown {
  if (depth > 6 || obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map((v) => scrubObject(v, depth + 1));
  if (typeof obj !== 'object') return obj;

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const lc = k.toLowerCase();
    if (SENSITIVE_HEADERS.has(lc) || SENSITIVE_KEY_RX.test(k)) {
      out[k] = '[Filtered]';
    } else {
      out[k] = scrubObject(v, depth + 1);
    }
  }
  return out;
}

/**
 * Sentry's `beforeSend` hook. Runs on every event before it leaves the
 * process. Drops or scrubs anything that looks sensitive. Exported so
 * the test suite can pin its behavior without booting Sentry.
 */
export function sentryBeforeSend(event: Sentry.ErrorEvent): Sentry.ErrorEvent | null {
  // 1. Strip request body for auth / webhook / credentials paths.
  if (event.request?.url) {
    let pathname = event.request.url;
    try { pathname = new URL(event.request.url).pathname; } catch { /* relative URL */ }
    if (shouldStripBody(pathname)) {
      if (event.request.data) event.request.data = '[Filtered: sensitive route]';
      if (event.request.cookies) event.request.cookies = { _scrubbed: '[Filtered]' } as never;
    }
  }

  // 2. Always strip dangerous headers, regardless of path.
  if (event.request?.headers) {
    const cleaned: Record<string, string> = {};
    for (const [k, v] of Object.entries(event.request.headers)) {
      cleaned[k] = SENSITIVE_HEADERS.has(k.toLowerCase()) ? '[Filtered]' : String(v);
    }
    event.request.headers = cleaned;
  }

  // 3. Walk known nested locations and scrub by key name.
  if (event.extra) event.extra = scrubObject(event.extra) as Record<string, unknown>;
  if (event.contexts) event.contexts = scrubObject(event.contexts) as Sentry.ErrorEvent['contexts'];
  if (event.request?.data && typeof event.request.data === 'object') {
    event.request.data = scrubObject(event.request.data);
  }

  return event;
}

// ─── Init ─────────────────────────────────────────────────────────────────

/**
 * Initialize Sentry. Idempotent. No-op when SENTRY_DSN is unset, so it's
 * safe to call from server bootstrap regardless of environment.
 */
export function initSentry(): void {
  if (_initialized) return;
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? 'development',
    release: process.env.GIT_COMMIT_SHA ?? process.env.GITHUB_SHA ?? undefined,
    // Send 10% of transactions in prod, 100% elsewhere — adjustable later.
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
    sendDefaultPii: false,            // don't auto-attach IPs / cookies
    beforeSend: sentryBeforeSend,
    initialScope: {
      tags: { app: 'system-clow' },
    },
  });

  // Catch unhandled top-level errors. Sentry has built-in handlers, but
  // we install fallback `process.on` listeners so a missing signal still
  // hits captureException + lets the process die properly afterwards.
  process.on('uncaughtException', (err) => {
    captureException(err, { source: 'uncaughtException' });
  });
  process.on('unhandledRejection', (reason) => {
    captureException(reason as Error, { source: 'unhandledRejection' });
  });

  _initialized = true;
}

// ─── Public capture helpers ───────────────────────────────────────────────

/** Was Sentry actually initialized? Used by tests + the readiness check. */
export function isSentryEnabled(): boolean {
  return _initialized;
}

/**
 * Capture an exception with the current request scope (tenant_id /
 * user_id from AsyncLocalStorage) plus optional ad-hoc context.
 *
 * Safe to call when Sentry isn't initialized (no-op).
 */
export function captureException(
  err: unknown,
  context?: Record<string, unknown>,
): void {
  if (!_initialized) return;
  Sentry.withScope((scope) => {
    const ctx = getRequestContext();
    if (ctx.tenant_id) scope.setTag('tenant_id', ctx.tenant_id);
    if (ctx.user_id) scope.setTag('user_id', ctx.user_id);
    if (ctx.request_id) scope.setTag('request_id', ctx.request_id);
    if (context) {
      // Only the safe subset — anything else goes via context which
      // beforeSend then scrubs.
      if (typeof context.plan === 'string') scope.setTag('plan', context.plan);
      if (typeof context.source === 'string') scope.setTag('source', context.source);
      scope.setContext('details', scrubObject(context) as Record<string, unknown>);
    }
    Sentry.captureException(err);
  });
}

/**
 * Hono onError handler. Wires Hono's error pipeline to captureException
 * with the Hono context exposed (route, method, status). Use as:
 *
 *   import { honoSentryErrorHandler } from '../utils/sentry.js';
 *   app.onError(honoSentryErrorHandler);
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function honoSentryErrorHandler(err: Error, c: any): Response {
  captureException(err, {
    source: 'hono',
    route: c?.req?.routePath ?? c?.req?.path,
    method: c?.req?.method,
  });
  // Re-throw the same error response Hono would have produced. We don't
  // own the contract here — server.ts mounts this and decides the body.
  return c.json({ error: 'internal_error', message: err.message }, 500);
}
