/**
 * /metrics endpoint integration tests.
 *
 * Verifies:
 *   - 503 when METRICS_TOKEN is unset (don't accidentally leak metrics)
 *   - 401 when token doesn't match
 *   - 200 + Prometheus text format when token matches
 *   - prometheusMiddleware bumps clow_http_requests_total
 *   - clow_http_request_duration_seconds histogram is emitted
 *   - clow_ai_messages_total / clow_webhooks_received_total counters work
 *   - 5xx responses bump clow_errors_total
 *   - clow_tenants_active gauge is collected lazily on scrape
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildMetricsRoutes,
  prometheusMiddleware,
  registry,
  incAiMessage,
  incWebhookReceived,
} from '../../src/server/metrics.js';

let tmpHome: string;

beforeEach(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), 'clow-metrics-'));
  process.env.CLOW_HOME = tmpHome;
  process.env.CRM_DB_PATH = join(tmpHome, 'crm.sqlite3');
  // Reset all metric values between tests so counters don't leak across.
  registry.resetMetrics();
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.CLOW_HOME;
  delete process.env.CRM_DB_PATH;
  delete process.env.METRICS_TOKEN;
});

function buildApp(): Hono {
  const app = new Hono();
  app.use('*', prometheusMiddleware());
  app.route('/metrics', buildMetricsRoutes());
  app.get('/ok', (c) => c.json({ ok: true }));
  app.get('/explode', () => {
    throw new Error('boom');
  });
  return app;
}

describe('/metrics endpoint — auth', () => {
  it('503 when METRICS_TOKEN is unset', async () => {
    const r = await buildApp().fetch(new Request('http://localhost/metrics'));
    expect(r.status).toBe(503);
    expect(await r.text()).toMatch(/metrics_token_not_configured/);
  });

  it('401 when token is wrong', async () => {
    process.env.METRICS_TOKEN = 'correct';
    const r = await buildApp().fetch(
      new Request('http://localhost/metrics', { headers: { authorization: 'Bearer wrong' } }),
    );
    expect(r.status).toBe(401);
  });

  it('401 when no Authorization header', async () => {
    process.env.METRICS_TOKEN = 'correct';
    const r = await buildApp().fetch(new Request('http://localhost/metrics'));
    expect(r.status).toBe(401);
  });

  it('200 + Prometheus text format when token matches', async () => {
    process.env.METRICS_TOKEN = 'correct';
    const r = await buildApp().fetch(
      new Request('http://localhost/metrics', { headers: { authorization: 'Bearer correct' } }),
    );
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/text\/plain/);
    const body = await r.text();
    // Prometheus text format starts with HELP/TYPE comments per metric.
    expect(body).toMatch(/^# HELP clow_/m);
    expect(body).toMatch(/^# TYPE clow_/m);
  });
});

describe('prometheusMiddleware — HTTP counters + latency', () => {
  it('bumps clow_http_requests_total + emits histogram on each request', async () => {
    process.env.METRICS_TOKEN = 'tok';
    const app = buildApp();

    await app.fetch(new Request('http://localhost/ok'));
    await app.fetch(new Request('http://localhost/ok'));
    await app.fetch(new Request('http://localhost/ok'));

    const body = await (await app.fetch(
      new Request('http://localhost/metrics', { headers: { authorization: 'Bearer tok' } }),
    )).text();

    // Counter: 3 requests to /ok with 200
    expect(body).toMatch(/clow_http_requests_total\{[^}]*route="\/ok"[^}]*method="GET"[^}]*status="200"[^}]*\} 3/);
    // Histogram: there should be a count + sum line for /ok
    expect(body).toMatch(/clow_http_request_duration_seconds_count\{[^}]*route="\/ok"/);
    expect(body).toMatch(/clow_http_request_duration_seconds_sum\{[^}]*route="\/ok"/);
  });

  it('bumps clow_errors_total on 5xx', async () => {
    process.env.METRICS_TOKEN = 'tok';
    const app = buildApp();

    // /explode throws — Hono returns 500
    try { await app.fetch(new Request('http://localhost/explode')); } catch {}

    const body = await (await app.fetch(
      new Request('http://localhost/metrics', { headers: { authorization: 'Bearer tok' } }),
    )).text();

    expect(body).toMatch(/clow_errors_total\{[^}]*route="\/explode"[^}]*status="500"[^}]*\} 1/);
  });
});

describe('Domain counters — incAiMessage / incWebhookReceived', () => {
  it('incAiMessage tags by tenant_id + plan', async () => {
    process.env.METRICS_TOKEN = 'tok';
    incAiMessage('tenant-A', 'profissional');
    incAiMessage('tenant-A', 'profissional');
    incAiMessage('tenant-B', 'starter');

    const body = await (await buildApp().fetch(
      new Request('http://localhost/metrics', { headers: { authorization: 'Bearer tok' } }),
    )).text();

    expect(body).toMatch(/clow_ai_messages_total\{[^}]*tenant_id="tenant-A"[^}]*plan="profissional"[^}]*\} 2/);
    expect(body).toMatch(/clow_ai_messages_total\{[^}]*tenant_id="tenant-B"[^}]*plan="starter"[^}]*\} 1/);
  });

  it('incWebhookReceived tags by channel', async () => {
    process.env.METRICS_TOKEN = 'tok';
    incWebhookReceived('meta');
    incWebhookReceived('meta');
    incWebhookReceived('zapi');
    incWebhookReceived('stripe');

    const body = await (await buildApp().fetch(
      new Request('http://localhost/metrics', { headers: { authorization: 'Bearer tok' } }),
    )).text();

    expect(body).toMatch(/clow_webhooks_received_total\{[^}]*channel="meta"[^}]*\} 2/);
    expect(body).toMatch(/clow_webhooks_received_total\{[^}]*channel="zapi"[^}]*\} 1/);
    expect(body).toMatch(/clow_webhooks_received_total\{[^}]*channel="stripe"[^}]*\} 1/);
  });
});

describe('Lazy gauges', () => {
  it('clow_tenants_active is computed on scrape (no tenants → 0)', async () => {
    process.env.METRICS_TOKEN = 'tok';
    const body = await (await buildApp().fetch(
      new Request('http://localhost/metrics', { headers: { authorization: 'Bearer tok' } }),
    )).text();
    expect(body).toMatch(/clow_tenants_active(\{[^}]*\})? 0/);
  });

  it('clow_db_size_bytes is collected on scrape', async () => {
    process.env.METRICS_TOKEN = 'tok';
    const body = await (await buildApp().fetch(
      new Request('http://localhost/metrics', { headers: { authorization: 'Bearer tok' } }),
    )).text();
    // No DB exists in tmpHome → gauge reports 0. We just want to see the metric line.
    expect(body).toMatch(/clow_db_size_bytes(\{[^}]*\})? \d+/);
  });
});
