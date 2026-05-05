/**
 * logger.ts — pino-backed structured JSON logging for System Clow.
 *
 * Output shape (one line of JSON per event, regardless of dev/prod):
 *   {
 *     "ts": "2026-04-26T17:42:33.041Z",
 *     "level": "info" | "warn" | "error" | "debug" | "fatal",
 *     "env": "production" | "development" | "test",
 *     "component": "QueryEngine" | undefined,
 *     "request_id": "uuid…" | undefined,
 *     "tenant_id": "uuid…" | undefined,
 *     "user_id": "uuid…" | undefined,
 *     "msg": "...",
 *     "<extra fields>": ...
 *   }
 *
 * - In development (NODE_ENV !== 'production'), output flows through
 *   pino-pretty for human-readable color output. In production it's
 *   raw JSON to stdout (PM2 captures).
 * - request_id / tenant_id / user_id come from a module-scoped
 *   AsyncLocalStorage; the Hono middleware (`requestContextMiddleware`)
 *   establishes a fresh context per HTTP request so logs emitted deep
 *   in the call stack carry the right ids without manual passing.
 *
 * Public surface (kept stable from the previous custom logger):
 *   logger                        — global default logger
 *   createLogger(component, ctx?) — component-scoped logger
 *   metrics                       — latency collector
 *   getMetricsSummary(windowMs?)  — for the /v1/metrics endpoint
 *   requestContextMiddleware()    — Hono middleware (sets request_id)
 *   withRequestContext(ctx, fn)   — manual scope helper for non-Hono code
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import pino from 'pino';

// ─── Request-scoped context (request_id, tenant_id, user_id) ──────────────

interface RequestContext {
  request_id?: string;
  tenant_id?: string;
  user_id?: string;
}

const requestContext = new AsyncLocalStorage<RequestContext>();

export function getRequestContext(): RequestContext {
  return requestContext.getStore() ?? {};
}

/**
 * Run `fn` inside an AsyncLocalStorage scope so any logs emitted by it
 * (including async descendants) carry the supplied request_id /
 * tenant_id / user_id. Used both by the Hono middleware and by
 * background workers that want their logs grouped by some external
 * correlation id.
 */
export function withRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return requestContext.run({ ...getRequestContext(), ...ctx }, fn);
}

/** Hono middleware: assign a per-request request_id, propagate via header,
 *  and run the rest of the handler chain in an AsyncLocalStorage scope. */
export function requestContextMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const incoming = c.req.header('x-request-id');
    const requestId = incoming && incoming.length <= 64 ? incoming : randomUUID();
    c.header('x-request-id', requestId);
    // tenantId / userId are set by tenantAuth later in the chain; we
    // give them a place to live now.
    const tenantId = (c.get('tenantId') as string | undefined) ?? undefined;
    const userId = (c.get('userId') as string | undefined) ?? undefined;
    return requestContext.run(
      { request_id: requestId, tenant_id: tenantId, user_id: userId },
      () => next(),
    );
  };
}

// ─── Pino instance ────────────────────────────────────────────────────────

const isProd = process.env.NODE_ENV === 'production';
const isTest = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';

const baseLogger = pino({
  level: process.env.CLOW_LOG_LEVEL ?? (isProd ? 'info' : 'debug'),
  // pino includes "level" + "time" by default. We override "time" to ISO
  // (matches the previous custom logger and is friendlier to humans /
  // log aggregators) and add ENV at the base level so every line tags it.
  base: { env: process.env.NODE_ENV ?? 'development' },
  timestamp: () => `,"ts":"${new Date().toISOString()}"`,
  formatters: {
    // pino's default level formatter emits the numeric level (30 = info,
    // etc). We re-cast to the textual name so consumers don't have to
    // map back, and merge in the request-scoped context so it appears
    // on every line without per-call boilerplate.
    level: (label) => ({ level: label }),
    log: (obj) => ({ ...getRequestContext(), ...obj }),
  },
  // pino-pretty in dev so the human looking at terminal gets colors.
  // In prod (and tests) we keep raw JSON for log aggregation.
  ...((!isProd && !isTest)
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss.l',
            ignore: 'pid,hostname,env',
            singleLine: false,
          },
        },
      }
    : {}),
});

// ─── Public Logger interface (compatible with previous logger) ───────────

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface LogEntry {
  ts: string;
  level: LogLevel;
  component?: string;
  msg: string;
  request_id?: string;
  tenant_id?: string;
  user_id?: string;
  env?: string;
  data?: Record<string, unknown>;
  durationMs?: number;
}

export interface Logger {
  // Variadic to keep compatibility with console.log-style calls that
  // were mass-rewritten by scripts/replace-console.cjs:
  //   console.log("foo:", err)        → logger.info("foo:", err)
  //   console.error("x", a, b)        → logger.error("x", a, b)
  // The first arg is the message; everything after is folded into the
  // log record (single object → as-is; multiple → as `extra: [...]`).
  debug(msg: string, ...rest: unknown[]): void;
  info(msg: string, ...rest: unknown[]): void;
  warn(msg: string, ...rest: unknown[]): void;
  error(msg: string, ...rest: unknown[]): void;
  fatal(msg: string, ...rest: unknown[]): void;
  startTimer(operation: string): { end: (data?: Record<string, unknown>) => number };
  child(extra: Record<string, unknown>): Logger;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Error);
}

function normalizePayload(rest: unknown[]): Record<string, unknown> {
  if (rest.length === 0) return {};
  if (rest.length === 1) {
    const only = rest[0];
    if (isPlainObject(only)) return only;
    if (only instanceof Error) return { err: { message: only.message, stack: only.stack } };
    return { extra: only };
  }
  return { extra: rest };
}

function buildLogger(p: pino.Logger, component?: string): Logger {
  const log = (level: LogLevel) => (msg: string, ...rest: unknown[]) => {
    if (level === 'error' || level === 'fatal') metrics.recordError(component ?? 'global', msg);
    p[level](normalizePayload(rest), msg);
  };

  return {
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
    fatal: log('fatal'),
    startTimer(operation: string) {
      const start = Date.now();
      return {
        end(data?: Record<string, unknown>): number {
          const durationMs = Date.now() - start;
          p.info({ ...data, durationMs, operation }, `${operation} completed`);
          metrics.record({ component: component ?? 'global', operation, durationMs, timestamp: Date.now() });
          return durationMs;
        },
      };
    },
    child(extra: Record<string, unknown>): Logger {
      return buildLogger(p.child(extra), component);
    },
  };
}

/** Default logger — no component tag. Imported as `logger` from
 *  call sites that don't care about scoping. */
export const logger: Logger = buildLogger(baseLogger);

/** Component-scoped logger. The component name appears in every line
 *  emitted by the returned logger. */
export function createLogger(component: string, context?: Record<string, unknown>): Logger {
  const child = baseLogger.child({ component, ...(context ?? {}) });
  return buildLogger(child, component);
}

// ─── Latency / error metrics (preserved API surface) ──────────────────────

export interface LatencyMetric {
  component: string;
  operation: string;
  durationMs: number;
  timestamp: number;
}

export interface MetricsSummary {
  totalRequests: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  /** alias for totalErrors — kept for the admin dashboard call site */
  errorCount: number;
  totalErrors: number;
  errorsPerComponent: Record<string, number>;
  byComponent: Record<string, { count: number; avgMs: number; p95Ms: number }>;
}

class MetricsCollector {
  private latencies: LatencyMetric[] = [];
  private errors = new Map<string, number>();
  private maxSize = 10_000;

  record(metric: LatencyMetric): void {
    this.latencies.push(metric);
    if (this.latencies.length > this.maxSize) this.latencies.shift();
  }

  recordError(component: string, _msg: string): void {
    this.errors.set(component, (this.errors.get(component) ?? 0) + 1);
  }

  getSummary(windowMs?: number): MetricsSummary {
    const now = Date.now();
    const window = windowMs ? this.latencies.filter((m) => now - m.timestamp <= windowMs) : this.latencies;
    const sorted = [...window].sort((a, b) => a.durationMs - b.durationMs);
    const sum = window.reduce((s, m) => s + m.durationMs, 0);
    const avg = window.length ? sum / window.length : 0;
    const p95Idx = Math.max(0, Math.floor(sorted.length * 0.95) - 1);
    const p95 = sorted[p95Idx]?.durationMs ?? 0;
    const p99Idx = Math.max(0, Math.floor(sorted.length * 0.99) - 1);
    const p99 = sorted[p99Idx]?.durationMs ?? 0;

    const byComponent: Record<string, { count: number; avgMs: number; p95Ms: number }> = {};
    const grouped = new Map<string, LatencyMetric[]>();
    for (const m of window) {
      let arr = grouped.get(m.component);
      if (!arr) { arr = []; grouped.set(m.component, arr); }
      arr.push(m);
    }
    for (const [comp, arr] of grouped) {
      const ss = [...arr].sort((a, b) => a.durationMs - b.durationMs);
      const total = arr.reduce((s, m) => s + m.durationMs, 0);
      byComponent[comp] = {
        count: arr.length,
        avgMs: arr.length ? total / arr.length : 0,
        p95Ms: ss[Math.max(0, Math.floor(ss.length * 0.95) - 1)]?.durationMs ?? 0,
      };
    }

    const totalErrors = [...this.errors.values()].reduce((s, n) => s + n, 0);
    return {
      totalRequests: window.length,
      avgLatencyMs: avg,
      p95LatencyMs: p95,
      p99LatencyMs: p99,
      totalErrors,
      errorCount: totalErrors,
      errorsPerComponent: Object.fromEntries(this.errors),
      byComponent,
    };
  }

  reset(): void { this.latencies = []; this.errors.clear(); }
}

export const metrics = new MetricsCollector();

export function getMetricsSummary(windowMs?: number): MetricsSummary {
  return metrics.getSummary(windowMs);
}
