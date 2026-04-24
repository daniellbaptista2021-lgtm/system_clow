/**
 * Rate limiter per tenant — Onda 30.
 *
 * Sliding-window token bucket stored in SQLite.
 * Tiers (configurable em crm_api_tiers):
 *   free:     60 req/min,  1000 req/hour
 *   pro:     300 req/min,  10000 req/hour
 *   business: 1000 req/min, 50000 req/hour
 *   unlimited: skip all limits
 *
 * Middleware emits X-RateLimit-* headers e retorna 429 com Retry-After quando exceed.
 */

import { getCrmDb } from './schema.js';

const DEFAULT_TIER = 'free';
const TIER_DEFAULTS: Record<string, { perMin: number; perHour: number }> = {
  free:      { perMin: 60,   perHour: 1000 },
  pro:       { perMin: 300,  perHour: 10000 },
  business:  { perMin: 1000, perHour: 50000 },
  unlimited: { perMin: Infinity, perHour: Infinity },
};

export function getTenantTier(tenantId: string): { tier: string; perMin: number; perHour: number } {
  const db = getCrmDb();
  const row = db.prepare('SELECT * FROM crm_api_tiers WHERE tenant_id = ?').get(tenantId) as any;
  if (!row) return { tier: DEFAULT_TIER, ...TIER_DEFAULTS[DEFAULT_TIER] };
  const defaults = TIER_DEFAULTS[row.tier_name] || TIER_DEFAULTS[DEFAULT_TIER];
  return {
    tier: row.tier_name,
    perMin: row.max_req_per_min ?? defaults.perMin,
    perHour: row.max_req_per_hour ?? defaults.perHour,
  };
}

export function setTenantTier(tenantId: string, tier: string, overrides: { perMin?: number; perHour?: number } = {}): void {
  const db = getCrmDb();
  const defaults = TIER_DEFAULTS[tier] || TIER_DEFAULTS[DEFAULT_TIER];
  const perMin = overrides.perMin ?? defaults.perMin;
  const perHour = overrides.perHour ?? defaults.perHour;
  db.prepare(`
    INSERT INTO crm_api_tiers (tenant_id, tier_name, max_req_per_min, max_req_per_hour, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(tenant_id) DO UPDATE SET tier_name = ?, max_req_per_min = ?, max_req_per_hour = ?, updated_at = ?
  `).run(tenantId, tier, perMin, perHour, Date.now(), tier, perMin, perHour, Date.now());
}

export interface RateLimitCheck {
  allowed: boolean;
  tier: string;
  perMin: number;
  perHour: number;
  countLastMin: number;
  countLastHour: number;
  retryAfterSeconds: number;
}

export function checkLimit(tenantId: string): RateLimitCheck {
  const { tier, perMin, perHour } = getTenantTier(tenantId);
  if (tier === 'unlimited' || !isFinite(perMin)) {
    return { allowed: true, tier, perMin, perHour, countLastMin: 0, countLastHour: 0, retryAfterSeconds: 0 };
  }

  const db = getCrmDb();
  const now = Date.now();
  const minuteStart = now - 60_000;
  const hourStart = now - 3600_000;

  // Count requests in the last minute and hour
  const rows = db.prepare(`
    SELECT
      SUM(CASE WHEN window_start >= ? THEN count ELSE 0 END) AS min_count,
      SUM(CASE WHEN window_start >= ? THEN count ELSE 0 END) AS hour_count
    FROM crm_rate_limit_buckets
    WHERE tenant_id = ?
  `).get(minuteStart, hourStart, tenantId) as any;

  const countLastMin = rows?.min_count || 0;
  const countLastHour = rows?.hour_count || 0;

  if (countLastMin >= perMin) {
    return {
      allowed: false, tier, perMin, perHour, countLastMin, countLastHour,
      retryAfterSeconds: 60,
    };
  }
  if (countLastHour >= perHour) {
    return {
      allowed: false, tier, perMin, perHour, countLastMin, countLastHour,
      retryAfterSeconds: 3600,
    };
  }
  return { allowed: true, tier, perMin, perHour, countLastMin, countLastHour, retryAfterSeconds: 0 };
}

export function recordHit(tenantId: string): void {
  const db = getCrmDb();
  const now = Date.now();
  const windowStart = Math.floor(now / 60_000) * 60_000; // 1-minute bucket
  db.prepare(`
    INSERT INTO crm_rate_limit_buckets (tenant_id, window_start, count)
    VALUES (?, ?, 1)
    ON CONFLICT(tenant_id, window_start) DO UPDATE SET count = count + 1
  `).run(tenantId, windowStart);
}

/** Cleanup old buckets (> 2h). Called from scheduler occasionally. */
export function pruneOldBuckets(): number {
  const cutoff = Date.now() - 2 * 3600_000;
  return getCrmDb().prepare('DELETE FROM crm_rate_limit_buckets WHERE window_start < ?').run(cutoff).changes;
}

/** Hono middleware. Extracts tenantId from context, enforces limit, adds headers. */
export function rateLimitMiddleware() {
  return async (c: any, next: () => Promise<void>) => {
    const tenantId = c.get?.('tenantId') || c.get?.('tenant_id');
    if (!tenantId) return next();

    const check = checkLimit(tenantId);
    // Always emit headers for client introspection
    c.res.headers.set('X-RateLimit-Tier', check.tier);
    c.res.headers.set('X-RateLimit-Limit-Minute', String(check.perMin));
    c.res.headers.set('X-RateLimit-Remaining-Minute', String(Math.max(0, check.perMin - check.countLastMin - 1)));

    if (!check.allowed) {
      c.res.headers.set('Retry-After', String(check.retryAfterSeconds));
      return c.json({
        error: 'rate_limit_exceeded',
        message: `Limite excedido (${check.countLastMin}/${check.perMin} per minute, ${check.countLastHour}/${check.perHour} per hour)`,
        tier: check.tier, retryAfterSeconds: check.retryAfterSeconds,
      }, 429);
    }

    recordHit(tenantId);
    return next();
  };
}
