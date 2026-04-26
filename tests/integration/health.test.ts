/**
 * Health & readiness — integration tests.
 *
 * Drives the Hono router built by `buildHealthRoutes()` directly via
 * `app.fetch(Request)`, so we don't need to spin up a TCP listener or
 * mock the rest of the server boot path.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { buildHealthRoutes, _resetHealthRateLimitForTests } from '../../src/server/health.js';

function mountHealth(): Hono {
  const app = new Hono();
  app.route('/health', buildHealthRoutes());
  return app;
}

function fetchPath(app: Hono, path: string, headers: Record<string, string> = {}): Promise<Response> {
  return app.fetch(new Request(`http://localhost${path}`, { headers }));
}

beforeEach(() => {
  _resetHealthRateLimitForTests();
});

describe('GET /health/live', () => {
  it('always returns 200 with status ok', async () => {
    const app = mountHealth();
    const r = await fetchPath(app, '/health/live');
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toEqual({ status: 'ok' });
  });
});

describe('GET /health/version', () => {
  it('returns the expected metadata shape', async () => {
    const app = mountHealth();
    const r = await fetchPath(app, '/health/version');
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toMatchObject({
      commit_sha: expect.any(String),
      build_time: expect.any(String),
      node_version: expect.any(String),
      uptime_seconds: expect.any(Number),
    });
    expect(body.node_version).toMatch(/^v\d+\./);
    expect(body.uptime_seconds).toBeGreaterThanOrEqual(0);
    // commit_sha is either a 40-char SHA or the literal "unknown"
    expect(body.commit_sha === 'unknown' || /^[0-9a-f]{40}$/i.test(body.commit_sha)).toBe(true);
  });
});

describe('GET /health/ready', () => {
  let tmpClowHome: string;

  beforeEach(() => {
    tmpClowHome = mkdtempSync(join(tmpdir(), 'clow-health-'));
    process.env.CLOW_HOME = tmpClowHome;
    process.env.CRM_DB_PATH = join(tmpClowHome, 'crm.sqlite3');
    // Pre-create a CRM DB so the SQLite check has something to read.
    const db = new Database(process.env.CRM_DB_PATH);
    db.pragma('journal_mode = WAL');
    db.close();
    // Ensure no Redis is configured so the check returns "ok with caveat".
    delete process.env.CLOW_REDIS_URL;
    delete process.env.REDIS_URL;
    // Point LiteLLM at an unreachable port so its check fails predictably.
    process.env.LITELLM_BASE_URL = 'http://127.0.0.1:1';
    delete process.env.ANTHROPIC_BASE_URL;
  });

  it('returns JSON breakdown with the four expected check keys', async () => {
    const app = mountHealth();
    const r = await fetchPath(app, '/health/ready');
    const body = await r.json();
    expect(body).toHaveProperty('status');
    expect(body).toHaveProperty('checks');
    expect(Object.keys(body.checks).sort()).toEqual(['disk', 'litellm', 'redis', 'sqlite']);
  });

  it('returns 503 when at least one check fails (LiteLLM unreachable)', async () => {
    const app = mountHealth();
    const r = await fetchPath(app, '/health/ready');
    expect(r.status).toBe(503);
    const body = await r.json();
    expect(body.status).toBe('degraded');
    expect(body.checks.litellm.ok).toBe(false);
    // SQLite should pass — we created the file
    expect(body.checks.sqlite.ok).toBe(true);
  });
});

describe('GET /health/* — IP rate limiting', () => {
  it('returns 429 with Retry-After after 60 requests in the same minute from the same IP', async () => {
    const app = mountHealth();
    const headers = { 'x-forwarded-for': '203.0.113.42' };

    // Burn the budget — 60 allowed
    for (let i = 0; i < 60; i++) {
      const r = await fetchPath(app, '/health/live', headers);
      expect(r.status, `request ${i + 1} should be 200`).toBe(200);
    }

    // 61st request from same IP must be throttled
    const blocked = await fetchPath(app, '/health/live', headers);
    expect(blocked.status).toBe(429);
    const body = await blocked.json();
    expect(body).toMatchObject({
      error: 'rate_limit_exceeded',
      limit: 60,
      window_seconds: 60,
    });
    expect(body.retry_after_seconds).toBeGreaterThan(0);
    expect(blocked.headers.get('Retry-After')).toBeTruthy();
  });

  it('rate-limit buckets are per-IP (a different IP is unaffected)', async () => {
    const app = mountHealth();

    // Saturate one IP
    for (let i = 0; i < 60; i++) {
      await fetchPath(app, '/health/live', { 'x-forwarded-for': '198.51.100.10' });
    }
    const blocked = await fetchPath(app, '/health/live', { 'x-forwarded-for': '198.51.100.10' });
    expect(blocked.status).toBe(429);

    // Second IP still has full budget
    const fresh = await fetchPath(app, '/health/live', { 'x-forwarded-for': '198.51.100.20' });
    expect(fresh.status).toBe(200);
  });
});
