/**
 * Health & readiness endpoints — public, IP-rate-limited, no auth.
 *
 *   GET /health/live     200 always while the process is up (liveness probe).
 *   GET /health/ready    200 if every external dep is reachable and disk
 *                        usage of $CLOW_HOME is below 85%; 503 + JSON
 *                        breakdown otherwise. Suitable for Kubernetes
 *                        readiness, load-balancer drain, UptimeRobot, etc.
 *   GET /health/version  Build/runtime info (commit_sha, build_time,
 *                        node_version, uptime_seconds).
 *
 * IP-based rate limit: 60 req/min/IP across all /health/* endpoints, so
 * the public surface can't be turned into a DDoS amplifier or a noisy
 * dependency-probe vector.
 */
import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── Build / runtime metadata (resolved once at module load) ──────────────

const SERVER_START_MS = Date.now();

const COMMIT_SHA: string = (() => {
  for (const k of ['GIT_COMMIT_SHA', 'GITHUB_SHA', 'BUILD_SHA', 'CLOW_COMMIT_SHA']) {
    const v = process.env[k];
    if (v && v.trim()) return v.trim();
  }
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf-8',
      timeout: 1000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'unknown';
  }
})();

const BUILD_TIME: string = (() => {
  if (process.env.BUILD_TIME) return process.env.BUILD_TIME;
  // mtime of THIS module after tsc emits it. process.argv[1] is unreliable
  // under PM2 (it points at the cluster wrapper, mtime ≠ tsc emit time).
  try {
    return statSync(fileURLToPath(import.meta.url)).mtime.toISOString();
  } catch {
    return new Date(SERVER_START_MS).toISOString();
  }
})();

// ─── Per-IP rate limiter (1-minute fixed window, cluster-shared) ──────────
// Backed by clusterStore so the count is consistent across PM2 workers.
// Without this, /health/* would let through HEALTH_RATE_LIMIT_PER_MIN ×
// (worker count) per IP, watering down the DDoS protection.

import { getCluster, _resetClusterStoreForTests } from '../utils/clusterStore.js';

const HEALTH_RATE_LIMIT_PER_MIN = 60;
const HEALTH_RATE_WINDOW_SEC = 60;

function clientIp(c: Context): string {
  const xff = c.req.header('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0];
    if (first) return first.trim();
  }
  return c.req.header('x-real-ip') ?? c.req.header('cf-connecting-ip') ?? 'unknown';
}

const ipRateLimit: MiddlewareHandler = async (c, next) => {
  const ip = clientIp(c);
  const store = await getCluster();
  const count = await store.incr(`rl:health-ip:${ip}`, HEALTH_RATE_WINDOW_SEC);

  if (count > HEALTH_RATE_LIMIT_PER_MIN) {
    // Conservative retry-after: full window. We don't currently expose
    // a TTL read primitive on clusterStore so we report the worst case.
    c.header('Retry-After', String(HEALTH_RATE_WINDOW_SEC));
    return c.json(
      {
        error: 'rate_limit_exceeded',
        limit: HEALTH_RATE_LIMIT_PER_MIN,
        window_seconds: HEALTH_RATE_WINDOW_SEC,
        retry_after_seconds: HEALTH_RATE_WINDOW_SEC,
      },
      429,
    );
  }
  return next();
};

// Test-only: reset the cluster store between specs so each test sees a
// fresh counter regardless of which test ran last.
export async function _resetHealthRateLimitForTests(): Promise<void> {
  await _resetClusterStoreForTests();
}

// ─── Dependency probes ────────────────────────────────────────────────────

interface CheckResult {
  ok: boolean;
  latency_ms?: number;
  details?: string;
}

async function checkSqlite(): Promise<CheckResult> {
  const t0 = Date.now();
  try {
    const { getCrmDb } = await import('../crm/schema.js');
    const db = getCrmDb();
    const row = db.prepare('SELECT 1 AS x').get() as { x?: number } | undefined;
    if (row?.x !== 1) return { ok: false, details: 'unexpected SELECT 1 result' };
    return { ok: true, latency_ms: Date.now() - t0 };
  } catch (err) {
    return { ok: false, details: errorMessage(err) };
  }
}

async function checkRedis(): Promise<CheckResult> {
  const url = process.env.CLOW_REDIS_URL ?? process.env.REDIS_URL;
  if (!url) {
    // Redis is optional — the session store falls back to an in-memory Map.
    // "ok with caveat" instead of failing readiness.
    return { ok: true, details: 'not configured (in-memory fallback active)' };
  }
  const t0 = Date.now();
  // Loose type — ioredis is loaded dynamically (matches the rest of the
  // codebase), and the surface we touch is small enough to type ad-hoc.
  let client: any = null;
  try {
    const { default: Redis } = (await import('ioredis' as string)) as any;
    client = new Redis(url, {
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      connectTimeout: 1500,
      enableOfflineQueue: false,
    });
    await client.connect();
    const reply: string = await client.ping();
    return {
      ok: reply === 'PONG',
      latency_ms: Date.now() - t0,
      details: reply === 'PONG' ? undefined : `unexpected reply: ${reply}`,
    };
  } catch (err) {
    return { ok: false, latency_ms: Date.now() - t0, details: errorMessage(err) };
  } finally {
    try { await client?.quit?.(); } catch { /* best effort */ }
    try { client?.disconnect?.(); } catch { /* best effort */ }
  }
}

async function checkLiteLLM(): Promise<CheckResult> {
  const base = (
    process.env.LITELLM_BASE_URL ??
    process.env.ANTHROPIC_BASE_URL ??
    'http://127.0.0.1:4000'
  ).replace(/\/$/, '');
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1500);
  try {
    // LiteLLM exposes /health/readiness; if 404, fall back to GET /. Either
    // way, any TCP-level response means the proxy is alive.
    let res: Response;
    try {
      res = await fetch(`${base}/health/readiness`, { signal: ctrl.signal });
      if (res.status === 404) {
        res = await fetch(`${base}/`, { signal: ctrl.signal });
      }
    } catch {
      res = await fetch(`${base}/`, { signal: ctrl.signal });
    }
    return {
      ok: res.status < 500,
      latency_ms: Date.now() - t0,
      details: `HTTP ${res.status}`,
    };
  } catch (err) {
    return { ok: false, latency_ms: Date.now() - t0, details: errorMessage(err) };
  } finally {
    clearTimeout(timer);
  }
}

async function checkDisk(): Promise<CheckResult> {
  const dir = process.env.CLOW_HOME ?? path.join(os.homedir(), '.clow');
  if (!existsSync(dir)) return { ok: true, details: `${dir} not yet created` };

  // Cross-platform note: Windows lacks `df`. We only deploy to Linux/macOS,
  // so we delegate to df on POSIX and skip on Windows (returning ok keeps
  // local Windows dev from failing readiness).
  if (process.platform === 'win32') {
    return { ok: true, details: 'disk check skipped on win32' };
  }

  const t0 = Date.now();
  try {
    const out = execFileSync('df', ['-P', dir], {
      encoding: 'utf-8',
      timeout: 1000,
    });
    const lines = out.trim().split('\n');
    const last = lines[lines.length - 1] ?? '';
    const cols = last.split(/\s+/);
    // df -P columns: Filesystem  1024-blocks  Used  Available  Capacity  Mounted-on
    const capStr = cols[4] ?? '';
    const usedPct = parseInt(capStr.replace('%', ''), 10);
    if (Number.isNaN(usedPct)) {
      return { ok: false, details: `could not parse df output: ${last}` };
    }
    return {
      ok: usedPct < 85,
      latency_ms: Date.now() - t0,
      details: `${usedPct}% used (threshold 85%)`,
    };
  } catch (err) {
    return { ok: false, details: errorMessage(err) };
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ─── Router ───────────────────────────────────────────────────────────────

export function buildHealthRoutes(): Hono {
  const health = new Hono();

  health.use('*', ipRateLimit);

  health.get('/live', (c) => c.json({ status: 'ok' }));

  health.get('/ready', async (c) => {
    const [sqlite, redis, litellm, disk] = await Promise.all([
      checkSqlite(),
      checkRedis(),
      checkLiteLLM(),
      checkDisk(),
    ]);
    const checks = { sqlite, redis, litellm, disk };
    const ok = Object.values(checks).every((r) => r.ok);
    return c.json(
      {
        status: ok ? 'ok' : 'degraded',
        checks,
      },
      ok ? 200 : 503,
    );
  });

  health.get('/version', (c) =>
    c.json({
      commit_sha: COMMIT_SHA,
      build_time: BUILD_TIME,
      node_version: process.version,
      uptime_seconds: Math.floor((Date.now() - SERVER_START_MS) / 1000),
    }),
  );

  // Daniel 2026-05-07 — Fase 3.1: dashboard de saúde da pipeline PV
  // Corretora. Snapshot completo: cards aguardando, bloqueios validator,
  // tool failures, meta-commentary, pipeline 24h, alertas críticos.
  health.get('/clow-dashboard', async (c) => {
    try {
      const { collectClowHealthSnapshot } = await import('../crm/observability/healthMetrics.js');
      const tenantId = c.req.query('tenant_id') || undefined;
      const snap = collectClowHealthSnapshot(tenantId);
      return c.json(snap);
    } catch (err: any) {
      return c.json({ ok: false, error: err?.message || 'snapshot_failed' }, 500);
    }
  });

  return health;
}
