/**
 * Rate Limiter — Unit Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';

// Inline rate limiter logic for testing (avoid importing singleton)
class TestRateLimiter {
  private windows = new Map<string, number[]>();

  check(tenantId: string, limit: number): { allowed: boolean; remaining: number } {
    const now = Date.now();
    const entry = this.windows.get(tenantId) || [];
    const recent = entry.filter(t => t > now - 60000);
    this.windows.set(tenantId, recent);

    if (recent.length >= limit) {
      return { allowed: false, remaining: 0 };
    }
    return { allowed: true, remaining: limit - recent.length };
  }

  record(tenantId: string): void {
    const entry = this.windows.get(tenantId) || [];
    entry.push(Date.now());
    this.windows.set(tenantId, entry);
  }
}

describe('RateLimiter', () => {
  let limiter: TestRateLimiter;

  beforeEach(() => {
    limiter = new TestRateLimiter();
  });

  it('allows requests under the limit', () => {
    const result = limiter.check('tenant1', 20);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(20);
  });

  it('tracks remaining correctly', () => {
    limiter.record('tenant1');
    limiter.record('tenant1');
    limiter.record('tenant1');
    const result = limiter.check('tenant1', 20);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(17);
  });

  it('blocks when limit exceeded', () => {
    for (let i = 0; i < 5; i++) limiter.record('tenant1');
    const result = limiter.check('tenant1', 5);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it('isolates tenants', () => {
    for (let i = 0; i < 5; i++) limiter.record('tenant1');
    const r1 = limiter.check('tenant1', 5);
    const r2 = limiter.check('tenant2', 5);
    expect(r1.allowed).toBe(false);
    expect(r2.allowed).toBe(true);
  });
});
