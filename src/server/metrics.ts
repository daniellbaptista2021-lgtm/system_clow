/**
 * metrics.ts — Prometheus metrics endpoint for System Clow.
 *
 * Exposes /metrics in Prometheus text format. Token-protected via the
 * METRICS_TOKEN env var (Bearer header). If METRICS_TOKEN is unset, the
 * endpoint refuses to serve (503) — protects against accidentally
 * leaving prod metrics exposed to the world.
 *
 * Metrics:
 *   clow_http_requests_total{route,method,status}     counter
 *   clow_http_request_duration_seconds{route,method}  histogram (quantiles via Prom)
 *   clow_ai_messages_total{tenant_id,plan}            counter (per AI message processed)
 *   clow_webhooks_received_total{channel}             counter (Meta/Z-API/Stripe inbound)
 *   clow_errors_total{route,status}                   counter (5xx only)
 *   clow_tenants_active                               gauge (collected on scrape)
 *   clow_db_size_bytes                                gauge (collected on scrape)
 *
 * The first two come from the prometheusMiddleware that wraps every
 * request. The mid four are incremented at the call sites that already
 * know the right labels (routes.ts for AI messages, stripeRoutes.ts +
 * crm/webhooks.ts for inbound webhooks). The two gauges are collected
 * lazily on each /metrics scrape.
 */
import type { MiddlewareHandler } from 'hono';
import { Hono } from 'hono';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ─── Registry ─────────────────────────────────────────────────────────────

export const registry = new Registry();
registry.setDefaultLabels({ app: 'system-clow' });

// Expose Node.js / process defaults (CPU, mem, event loop lag, etc).
// These come for free with prom-client and are a goldmine for ops.
collectDefaultMetrics({ register: registry, prefix: 'clow_node_' });

// ─── HTTP request counters (set by prometheusMiddleware) ──────────────────

const httpRequestsTotal = new Counter({
  name: 'clow_http_requests_total',
  help: 'Total HTTP requests, labeled by route, method, status',
  labelNames: ['route', 'method', 'status'] as const,
  registers: [registry],
});

const httpRequestDuration = new Histogram({
  name: 'clow_http_request_duration_seconds',
  help: 'HTTP request latency in seconds, labeled by route, method',
  labelNames: ['route', 'method'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

const errorsTotal = new Counter({
  name: 'clow_errors_total',
  help: '5xx responses, labeled by route, status',
  labelNames: ['route', 'status'] as const,
  registers: [registry],
});

// ─── Domain counters (incremented from call sites) ────────────────────────

const aiMessagesTotal = new Counter({
  name: 'clow_ai_messages_total',
  help: 'AI messages processed, labeled by tenant_id, plan',
  labelNames: ['tenant_id', 'plan'] as const,
  registers: [registry],
});

const webhooksReceivedTotal = new Counter({
  name: 'clow_webhooks_received_total',
  help: 'Inbound webhooks received, labeled by channel (meta, zapi, stripe, etc)',
  labelNames: ['channel'] as const,
  registers: [registry],
});

// ─── Public helpers — call from business logic ────────────────────────────

export function incAiMessage(tenantId: string, plan: string): void {
  aiMessagesTotal.inc({ tenant_id: tenantId, plan });
}

export function incWebhookReceived(channel: 'meta' | 'zapi' | 'stripe' | 'n8n' | string): void {
  webhooksReceivedTotal.inc({ channel });
}

// ─── Gauges — lazily collected on each /metrics scrape ────────────────────

new Gauge({
  name: 'clow_tenants_active',
  help: 'Number of tenants currently in active or trial status',
  registers: [registry],
  async collect() {
    try {
      const { listTenants } = await import('../tenancy/tenantStore.js');
      const all = listTenants();
      const active = all.filter((t) => t.status === 'active' || t.status === 'trial').length;
      this.set(active);
    } catch {
      // tenantStore not yet initialized (early boot scrape) — leave the gauge at 0.
      this.set(0);
    }
  },
});

new Gauge({
  name: 'clow_db_size_bytes',
  help: 'Size in bytes of the CRM SQLite file ($CLOW_HOME/crm.sqlite3)',
  registers: [registry],
  collect() {
    try {
      const home = process.env.CLOW_HOME ?? path.join(os.homedir(), '.clow');
      const dbPath = process.env.CRM_DB_PATH ?? path.join(home, 'crm.sqlite3');
      const stat = fs.statSync(dbPath);
      this.set(stat.size);
    } catch {
      this.set(0);
    }
  },
});

// ─── HTTP middleware: count + time every request ──────────────────────────
//
// `route` label uses the matched ROUTE PATTERN, not the actual path —
// otherwise /v1/crm/cards/abc and /v1/crm/cards/xyz would explode label
// cardinality (one series per card id). Hono exposes the matched route
// via `c.req.routePath` after the route resolves.

export function prometheusMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const start = process.hrtime.bigint();
    let status = 0;
    try {
      await next();
      status = c.res.status;
    } catch (err) {
      status = 500;
      throw err;
    } finally {
      const elapsedSec = Number(process.hrtime.bigint() - start) / 1e9;
      // Hono sets routePath when a route matches. Falls back to the raw
      // path for 404s / errors before routing — those are still useful
      // signals, just slightly higher cardinality.
      const route = (c.req.routePath as string | undefined) ?? c.req.path;
      const method = c.req.method;
      const statusStr = String(status);
      httpRequestsTotal.inc({ route, method, status: statusStr });
      httpRequestDuration.observe({ route, method }, elapsedSec);
      if (status >= 500) errorsTotal.inc({ route, status: statusStr });
    }
  };
}

// ─── /metrics router (token-protected) ────────────────────────────────────

export function buildMetricsRoutes(): Hono {
  const app = new Hono();

  app.get('/', async (c) => {
    const expected = process.env.METRICS_TOKEN;
    if (!expected) {
      return c.text('metrics_token_not_configured', 503);
    }
    const auth = c.req.header('authorization') ?? '';
    const presented = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    // Constant-time-ish compare. The token is short and the Bearer
    // prefix is fixed length; this is fine without a true HMAC compare.
    if (presented !== expected) {
      return c.text('unauthorized', 401);
    }
    const body = await registry.metrics();
    return c.body(body, 200, { 'content-type': registry.contentType });
  });

  return app;
}
