/**
 * rateLimiter.ts — Per-tenant sliding window rate limiter
 *
 * Prevents any single tenant from overwhelming the server.
 * Limits vary by tier. Returns 429 when exceeded.
 * In-memory — resets on server restart (acceptable for rate limiting).
 */

// ════════════════════════════════════════════════════════════════════════════
// Configuration
// ════════════════════════════════════════════════════════════════════════════

const TIER_LIMITS: Record<string, number> = {
  one: 20,            // 20 requests/minute
  smart: 60,          // 60 requests/minute
  profissional: 120,  // 120 requests/minute
  business: 300,      // 300 requests/minute
  admin: 9999,        // Effectively unlimited
};

const WINDOW_MS = 60_000; // 1 minute
const SESSION_CREATE_LIMIT = 10; // Max 10 session creates per minute per tenant

// ════════════════════════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════════════════════════

interface WindowEntry {
  timestamps: number[];
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  retryAfterMs?: number;
}

// ════════════════════════════════════════════════════════════════════════════
// RateLimiter Class
// ════════════════════════════════════════════════════════════════════════════

class TenantRateLimiter {
  private windows = new Map<string, WindowEntry>();
  private sessionCreateWindows = new Map<string, WindowEntry>();

  /**
   * Check if a request is allowed for the given tenant.
   */
  checkRequest(tenantId: string, tier: string = 'one'): RateLimitResult {
    return this.check(this.windows, tenantId, this.getLimit(tier));
  }

  /**
   * Check if session creation is allowed (stricter limit).
   */
  checkSessionCreate(tenantId: string): RateLimitResult {
    return this.check(this.sessionCreateWindows, tenantId, SESSION_CREATE_LIMIT);
  }

  /**
   * Record a request for rate limiting.
   */
  recordRequest(tenantId: string): void {
    this.record(this.windows, tenantId);
  }

  /**
   * Record a session creation for rate limiting.
   */
  recordSessionCreate(tenantId: string): void {
    this.record(this.sessionCreateWindows, tenantId);
  }

  /**
   * Get current stats for a tenant.
   */
  getStats(tenantId: string, tier: string = 'one'): { requestsInWindow: number; limit: number } {
    const entry = this.windows.get(tenantId);
    const now = Date.now();
    const count = entry ? entry.timestamps.filter(t => t > now - WINDOW_MS).length : 0;
    return { requestsInWindow: count, limit: this.getLimit(tier) };
  }

  /**
   * Cleanup expired entries (call periodically).
   */
  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.windows) {
      entry.timestamps = entry.timestamps.filter(t => t > now - WINDOW_MS);
      if (entry.timestamps.length === 0) this.windows.delete(key);
    }
    for (const [key, entry] of this.sessionCreateWindows) {
      entry.timestamps = entry.timestamps.filter(t => t > now - WINDOW_MS);
      if (entry.timestamps.length === 0) this.sessionCreateWindows.delete(key);
    }
  }

  // ─── Internal ──────────────────────────────────────────────────

  private getLimit(tier: string): number {
    return TIER_LIMITS[tier.toLowerCase()] || TIER_LIMITS.one;
  }

  private check(store: Map<string, WindowEntry>, tenantId: string, limit: number): RateLimitResult {
    const now = Date.now();
    const entry = store.get(tenantId);

    if (!entry) {
      return { allowed: true, remaining: limit, limit };
    }

    // Clean old timestamps
    entry.timestamps = entry.timestamps.filter(t => t > now - WINDOW_MS);
    const count = entry.timestamps.length;

    if (count >= limit) {
      const oldest = entry.timestamps[0];
      const retryAfterMs = oldest + WINDOW_MS - now;
      return { allowed: false, remaining: 0, limit, retryAfterMs };
    }

    return { allowed: true, remaining: limit - count, limit };
  }

  private record(store: Map<string, WindowEntry>, tenantId: string): void {
    let entry = store.get(tenantId);
    if (!entry) {
      entry = { timestamps: [] };
      store.set(tenantId, entry);
    }
    entry.timestamps.push(Date.now());
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Singleton + Cleanup Timer
// ════════════════════════════════════════════════════════════════════════════

export const rateLimiter = new TenantRateLimiter();

// Cleanup every 2 minutes
setInterval(() => rateLimiter.cleanup(), 120_000).unref();
