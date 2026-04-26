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

// ─── Per-IP rate limiter (sliding minute, in-memory) ──────────────────────

interface IpBucket {
  count: number;
  resetAt: number;
}

const HEALTH_RATE_LIMIT_PER_MIN = 60;
const ipBuckets = new Map<string, IpBucket>();

// Periodic GC so this doesn't grow unbounded under DDoS attempts.
setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of ipBuckets) {
    if (now >= bucket.resetAt) ipBuckets.delete(ip);
  }
}, 60_000).unref?.();

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
  const now = Date.now();
  const bucket = ipBuckets.get(ip);

  if (!bucket || now >= bucket.resetAt) {
    ipBuckets.set(ip, { count: 1, resetAt: now + 60_000 });
    return next();
  }

  if (bucket.count >= HEALTH_RATE_LIMIT_PER_MIN) {
    const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    c.header('Retry-After', String(retryAfterSec));
    return c.json(
      {
        error: 'rate_limit_exceeded',
        limit: HEALTH_RATE_LIMIT_PER_MIN,
        window_seconds: 60,
        retry_after_seconds: retryAfterSec,
      },
      429,
    );
  }

  bucket.count += 1;
  return next();
};

// Test-only: reset the IP rate limiter state between tests.
export function _resetHealthRateLimitForTests(): void {
  ipBuckets.clear();
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

  return health;
}
