/**
 * logger.ts — Structured logging with metrics and tracing
 *
 * Provides JSON-structured logs with:
 *   - Severity levels (debug, info, warn, error, fatal)
 *   - Component tagging ([Memory], [Query], [Hook], etc.)
 *   - Session/tenant context
 *   - Duration tracking
 *   - Request tracing
 *   - Latency metrics collection
 *
 * Usage:
 *   const log = createLogger('Memory');
 *   log.info('Session started', { sessionId, tenantId });
 *   log.error('Failed to save', { error: err.message });
 *
 *   const timer = log.startTimer('query');
 *   // ... do work ...
 *   timer.end({ rows: 42 });  // logs duration automatically
 */

// ════════════════════════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════════════════════════

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface LogEntry {
  ts: string;
  level: LogLevel;
  component: string;
  msg: string;
  data?: Record<string, unknown>;
  sessionId?: string;
  tenantId?: string;
  durationMs?: number;
  traceId?: string;
}

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
  errorCount: number;
  byComponent: Record<string, { count: number; avgMs: number; errors: number }>;
  byTenant: Record<string, { requests: number; totalMs: number }>;
}

// ════════════════════════════════════════════════════════════════════════════
// Metrics Collector (Singleton)
// ════════════════════════════════════════════════════════════════════════════

class MetricsCollector {
  private latencies: LatencyMetric[] = [];
  private errors: Array<{ component: string; timestamp: number; msg: string }> = [];
  private tenantRequests: Map<string, { count: number; totalMs: number }> = new Map();
  private maxEntries = 10_000;

  record(metric: LatencyMetric): void {
    this.latencies.push(metric);
    if (this.latencies.length > this.maxEntries) {
      this.latencies = this.latencies.slice(-this.maxEntries / 2);
    }
  }

  recordError(component: string, msg: string): void {
    this.errors.push({ component, timestamp: Date.now(), msg });
    if (this.errors.length > 1000) {
      this.errors = this.errors.slice(-500);
    }
  }

  recordTenantRequest(tenantId: string, durationMs: number): void {
    const existing = this.tenantRequests.get(tenantId) || { count: 0, totalMs: 0 };
    existing.count++;
    existing.totalMs += durationMs;
    this.tenantRequests.set(tenantId, existing);
  }

  getSummary(windowMs: number = 3600_000): MetricsSummary {
    const cutoff = Date.now() - windowMs;
    const recent = this.latencies.filter(m => m.timestamp > cutoff);
    const recentErrors = this.errors.filter(e => e.timestamp > cutoff);

    const durations = recent.map(m => m.durationMs).sort((a, b) => a - b);
    const avg = durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
    const p95 = durations.length > 0 ? durations[Math.floor(durations.length * 0.95)] : 0;
    const p99 = durations.length > 0 ? durations[Math.floor(durations.length * 0.99)] : 0;

    // By component
    const byComponent: Record<string, { count: number; avgMs: number; errors: number }> = {};
    for (const m of recent) {
      if (!byComponent[m.component]) byComponent[m.component] = { count: 0, avgMs: 0, errors: 0 };
      byComponent[m.component].count++;
      byComponent[m.component].avgMs += m.durationMs;
    }
    for (const [comp, data] of Object.entries(byComponent)) {
      data.avgMs = data.count > 0 ? Math.round(data.avgMs / data.count) : 0;
      data.errors = recentErrors.filter(e => e.component === comp).length;
    }

    // By tenant
    const byTenant: Record<string, { requests: number; totalMs: number }> = {};
    for (const [tid, data] of this.tenantRequests) {
      byTenant[tid] = { requests: data.count, totalMs: data.totalMs };
    }

    return {
      totalRequests: recent.length,
      avgLatencyMs: Math.round(avg),
      p95LatencyMs: p95,
      p99LatencyMs: p99,
      errorCount: recentErrors.length,
      byComponent,
      byTenant,
    };
  }

  reset(): void {
    this.latencies = [];
    this.errors = [];
    this.tenantRequests.clear();
  }
}

export const metrics = new MetricsCollector();

// ════════════════════════════════════════════════════════════════════════════
// Logger
// ════════════════════════════════════════════════════════════════════════════

const LOG_LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3, fatal: 4 };
const MIN_LEVEL: LogLevel = (process.env.CLOW_LOG_LEVEL as LogLevel) || 'info';

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  fatal(msg: string, data?: Record<string, unknown>): void;
  startTimer(operation: string): { end: (data?: Record<string, unknown>) => number };
  child(extra: Record<string, unknown>): Logger;
}

export function createLogger(component: string, context?: Record<string, unknown>): Logger {
  const ctx = context || {};

  function emit(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
    if (LOG_LEVELS[level] < LOG_LEVELS[MIN_LEVEL]) return;

    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      component,
      msg,
      ...(data || ctx ? { data: { ...ctx, ...data } } : {}),
    };

    const line = JSON.stringify(entry);

    if (level === 'error' || level === 'fatal') {
      process.stderr.write(line + '\n');
      metrics.recordError(component, msg);
    } else {
      process.stdout.write(line + '\n');
    }
  }

  const logger: Logger = {
    debug: (msg, data) => emit('debug', msg, data),
    info: (msg, data) => emit('info', msg, data),
    warn: (msg, data) => emit('warn', msg, data),
    error: (msg, data) => emit('error', msg, data),
    fatal: (msg, data) => emit('fatal', msg, data),

    startTimer(operation: string) {
      const start = Date.now();
      return {
        end(data?: Record<string, unknown>): number {
          const durationMs = Date.now() - start;
          emit('info', `${operation} completed`, { ...data, durationMs });
          metrics.record({ component, operation, durationMs, timestamp: Date.now() });
          return durationMs;
        },
      };
    },

    child(extra: Record<string, unknown>): Logger {
      return createLogger(component, { ...ctx, ...extra });
    },
  };

  return logger;
}

// ════════════════════════════════════════════════════════════════════════════
// Metrics API Route Helper
// ════════════════════════════════════════════════════════════════════════════

/**
 * Get metrics summary for API endpoint.
 * Usage: app.get('/v1/metrics', (c) => c.json(getMetricsSummary()))
 */
export function getMetricsSummary(windowMs?: number): MetricsSummary {
  return metrics.getSummary(windowMs);
}
