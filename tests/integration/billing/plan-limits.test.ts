/**
 * Quota enforcement — plan-limits tests.
 *
 * Exercises src/billing/quotaGuard.ts directly. PLAN_LIMITS constants
 * are documented in tests/integration/billing/excedente.test.ts; this
 * file focuses on the BLOCKING behavior:
 *
 *   - allow until plan limit, then keep allowing (overage tier) until 2× limit
 *   - reject (allowed=false, reason=over_hard_limit) at 2× +1
 *   - reject suspended/cancelled tenants regardless of count
 *   - reject when tenantId doesn't exist
 *   - resetMonthlyUsage zeros the counter
 *
 * Increments live in tenants.json which we redirect to a tmp $CLOW_HOME
 * so tests don't touch the dev machine's real store.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkAndIncrementMessageQuota,
  resetMonthlyUsage,
  PLAN_LIMITS,
  getQuotaStatus,
} from '../../../src/billing/quotaGuard.js';
import { createTenant, updateTenant, getTenant } from '../../../src/tenancy/tenantStore.js';

let tmpHome: string;
let tenantId: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'clow-quota-'));
  process.env.CLOW_HOME = tmpHome;
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.CLOW_HOME;
});

function seed(tier: string, status: 'active' | 'suspended' | 'cancelled' | 'trial' = 'active'): string {
  const { tenant } = createTenant({ email: `quota+${tier}@test`, name: `Quota ${tier}`, tier: tier as any });
  updateTenant(tenant.id, { status, current_month_messages: 0 } as any);
  return tenant.id;
}

describe('checkAndIncrementMessageQuota — happy path', () => {
  it('allows up to plan limit; remaining counts down', () => {
    tenantId = seed('starter');
    const limit = PLAN_LIMITS.starter.messages;

    for (let i = 1; i <= limit; i++) {
      const r = checkAndIncrementMessageQuota(tenantId);
      expect(r.allowed, `request #${i}`).toBe(true);
      expect(r.current).toBe(i);
      expect(r.remaining).toBe(limit - i);
      expect(r.overage_msgs).toBe(0);
      expect(r.overage_cost_cents).toBe(0);
    }
  });

  it('continues to allow past plan limit (overage tier) up to hard limit (2× plan)', () => {
    tenantId = seed('starter');
    const limit = PLAN_LIMITS.starter.messages;
    // Burn the plan budget
    for (let i = 0; i < limit; i++) checkAndIncrementMessageQuota(tenantId);

    // Next request: allowed but reports overage
    const r = checkAndIncrementMessageQuota(tenantId);
    expect(r.allowed).toBe(true);
    expect(r.overage_msgs).toBe(1);
    expect(r.current).toBe(limit + 1);
    expect(r.remaining).toBe(0);
  });

  it('rejects with reason=over_hard_limit at 2× plan + 1', () => {
    tenantId = seed('starter');
    const limit = PLAN_LIMITS.starter.messages;
    // Bring tenant to exactly 2× plan via direct mutation (faster than 1000 iterations)
    updateTenant(tenantId, { current_month_messages: limit * 2 } as any);

    const r = checkAndIncrementMessageQuota(tenantId);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('over_hard_limit');
    expect(r.tier).toBe('starter');
    expect(r.limit).toBe(limit);
  });
});

describe('checkAndIncrementMessageQuota — rejection paths', () => {
  it('rejects when tenant is suspended', () => {
    tenantId = seed('starter', 'suspended');
    const r = checkAndIncrementMessageQuota(tenantId);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('tenant_suspended');
  });

  it('rejects when tenant is cancelled', () => {
    tenantId = seed('starter', 'cancelled');
    const r = checkAndIncrementMessageQuota(tenantId);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('tenant_suspended');
  });

  it('rejects when tenantId does not exist', () => {
    const r = checkAndIncrementMessageQuota('does-not-exist');
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('tenant_not_found');
  });

  it('does NOT increment current_month_messages on rejection', () => {
    tenantId = seed('starter', 'suspended');
    checkAndIncrementMessageQuota(tenantId);
    const t = getTenant(tenantId);
    expect((t as any).current_month_messages).toBe(0);
  });
});

describe('checkAndIncrementMessageQuota — per-tier limits', () => {
  for (const [tier, conf] of Object.entries(PLAN_LIMITS)) {
    it(`tier "${tier}" enforces limit=${conf.messages} and hard=${conf.messages * 2}`, () => {
      tenantId = seed(tier);

      // First call: allowed, counters initialize
      const first = checkAndIncrementMessageQuota(tenantId);
      expect(first.allowed).toBe(true);
      expect(first.limit).toBe(conf.messages);
      expect(first.tier).toBe(tier);

      // Jump to hard limit and verify next is blocked
      updateTenant(tenantId, { current_month_messages: conf.messages * 2 } as any);
      const blocked = checkAndIncrementMessageQuota(tenantId);
      expect(blocked.allowed).toBe(false);
      expect(blocked.reason).toBe('over_hard_limit');
    });
  }
});

describe('resetMonthlyUsage', () => {
  it('zeros current_month_messages and current_month_cost_usd', () => {
    tenantId = seed('starter');
    updateTenant(tenantId, { current_month_messages: 250, current_month_cost_usd: 5.5 } as any);

    resetMonthlyUsage(tenantId);

    const t: any = getTenant(tenantId);
    expect(t.current_month_messages).toBe(0);
    expect(t.current_month_cost_usd).toBe(0);
    expect(t.current_month_started_at).toBeDefined();
  });
});

describe('getQuotaStatus', () => {
  it('reports a coherent snapshot including overage projection', () => {
    tenantId = seed('starter');
    updateTenant(tenantId, { current_month_messages: PLAN_LIMITS.starter.messages + 50 } as any);

    const s = getQuotaStatus(tenantId);
    expect(s).not.toBeNull();
    expect(s!.tier).toBe('starter');
    expect(s!.messages.current).toBe(PLAN_LIMITS.starter.messages + 50);
    expect(s!.messages.overage_msgs).toBe(50);
    expect(s!.messages.overage_cost_cents).toBe(50 * PLAN_LIMITS.starter.overage_cents_per_msg);
    expect(s!.messages.hard_limit).toBe(PLAN_LIMITS.starter.messages * 2);
  });

  it('returns null for unknown tenants', () => {
    expect(getQuotaStatus('nope')).toBeNull();
  });
});

describe('checkResourceLimit', () => {
  it('allows when current count is under tier limit', async () => {
    const { checkResourceLimit } = await import('../../../src/billing/quotaGuard.js');
    const id = seed('profissional');
    const r = checkResourceLimit(id, 'boards', 5);
    expect(r.allowed).toBe(true);
    expect(r.limit).toBe(PLAN_LIMITS.profissional.boards);
  });

  it('blocks when current count is at the limit', async () => {
    const { checkResourceLimit } = await import('../../../src/billing/quotaGuard.js');
    const id = seed('starter');
    const r = checkResourceLimit(id, 'boards', PLAN_LIMITS.starter.boards);
    expect(r.allowed).toBe(false);
  });

  it('returns allowed=false with limit=0 when tenant is unknown', async () => {
    const { checkResourceLimit } = await import('../../../src/billing/quotaGuard.js');
    expect(checkResourceLimit('nope', 'boards', 0)).toEqual({ allowed: false, limit: 0 });
  });
});

describe('rotateMonthlyAllTenants', () => {
  it('zeros current_month_messages on every tenant', async () => {
    const { rotateMonthlyAllTenants } = await import('../../../src/billing/quotaGuard.js');
    const a = seed('starter');
    const b = seed('profissional');
    updateTenant(a, { current_month_messages: 250 } as any);
    updateTenant(b, { current_month_messages: 1500 } as any);

    rotateMonthlyAllTenants();

    expect((getTenant(a) as any).current_month_messages).toBe(0);
    expect((getTenant(b) as any).current_month_messages).toBe(0);
  });
});
