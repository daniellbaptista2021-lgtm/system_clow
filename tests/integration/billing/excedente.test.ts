/**
 * Excedente (overage) pricing tests.
 *
 * Pins the per-tier overage costs codified in src/billing/quotaGuard.ts:
 *
 *   starter      → R$0.20/msg  ( 20¢)
 *   profissional → R$0.15/msg  ( 15¢)
 *   empresarial  → R$0.12/msg  ( 12¢)
 *   business     → R$0.00/msg  (   0)  legacy admin tier
 *   one          → R$0.20/msg  ( 20¢)  early SaaS launch
 *   smart        → R$0.15/msg  ( 15¢)  early SaaS launch
 *
 * If anyone changes a tier price, this file is the canary that shouts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkAndIncrementMessageQuota,
  PLAN_LIMITS,
  getQuotaStatus,
} from '../../../src/billing/quotaGuard.js';
import { createTenant, updateTenant } from '../../../src/tenancy/tenantStore.js';

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'clow-excedente-'));
  process.env.CLOW_HOME = tmpHome;
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.CLOW_HOME;
});

describe('Excedente — per-tier price table is correct', () => {
  it('starter cobra R$0.20/msg', () => {
    expect(PLAN_LIMITS.starter.overage_cents_per_msg).toBe(20);
  });
  it('profissional cobra R$0.15/msg', () => {
    expect(PLAN_LIMITS.profissional.overage_cents_per_msg).toBe(15);
  });
  it('empresarial cobra R$0.12/msg', () => {
    expect(PLAN_LIMITS.empresarial.overage_cents_per_msg).toBe(12);
  });
  it('business (legacy admin) does not bill overage', () => {
    expect(PLAN_LIMITS.business.overage_cents_per_msg).toBe(0);
  });
  it('one (legacy SaaS) cobra R$0.20/msg', () => {
    expect(PLAN_LIMITS.one.overage_cents_per_msg).toBe(20);
  });
  it('smart (legacy SaaS) cobra R$0.15/msg', () => {
    expect(PLAN_LIMITS.smart.overage_cents_per_msg).toBe(15);
  });
});

describe('Excedente — checkAndIncrementMessageQuota reports cost while allowing', () => {
  function seed(tier: string): string {
    const { tenant } = createTenant({ email: `over+${tier}@test`, name: `Over ${tier}`, tier: tier as any });
    updateTenant(tenant.id, { status: 'active' });
    return tenant.id;
  }

  it('starter: 1 msg over plan = 20¢ overage', () => {
    const id = seed('starter');
    updateTenant(id, { current_month_messages: PLAN_LIMITS.starter.messages } as any);
    const r = checkAndIncrementMessageQuota(id);
    expect(r.allowed).toBe(true);
    expect(r.overage_msgs).toBe(1);
    expect(r.overage_cost_cents).toBe(20);
  });

  it('profissional: 100 msgs over plan = R$15.00 overage (1500¢)', () => {
    const id = seed('profissional');
    updateTenant(id, { current_month_messages: PLAN_LIMITS.profissional.messages + 99 } as any);
    const r = checkAndIncrementMessageQuota(id);
    expect(r.allowed).toBe(true);
    expect(r.overage_msgs).toBe(100);
    expect(r.overage_cost_cents).toBe(100 * 15);
  });

  it('empresarial: 500 msgs over plan = R$60.00 overage (6000¢)', () => {
    const id = seed('empresarial');
    updateTenant(id, { current_month_messages: PLAN_LIMITS.empresarial.messages + 499 } as any);
    const r = checkAndIncrementMessageQuota(id);
    expect(r.allowed).toBe(true);
    expect(r.overage_msgs).toBe(500);
    expect(r.overage_cost_cents).toBe(500 * 12);
  });

  it('business: never charges overage even when over plan', () => {
    const id = seed('business');
    updateTenant(id, { current_month_messages: PLAN_LIMITS.business.messages + 5000 } as any);
    const r = checkAndIncrementMessageQuota(id);
    expect(r.allowed).toBe(true);
    expect(r.overage_msgs).toBe(5001);
    expect(r.overage_cost_cents).toBe(0);
  });

  it('overage cost is monotonic: msg N costs N×price', () => {
    const id = seed('starter');
    updateTenant(id, { current_month_messages: PLAN_LIMITS.starter.messages } as any);

    const r1 = checkAndIncrementMessageQuota(id);
    expect(r1.overage_cost_cents).toBe(20);

    const r2 = checkAndIncrementMessageQuota(id);
    expect(r2.overage_cost_cents).toBe(40);

    const r3 = checkAndIncrementMessageQuota(id);
    expect(r3.overage_cost_cents).toBe(60);
  });
});

describe('Excedente — getQuotaStatus projection', () => {
  it('reports overage cost for tenant currently over plan', () => {
    const { tenant } = createTenant({ email: 'overstatus@test', name: 'X', tier: 'profissional' });
    updateTenant(tenant.id, {
      status: 'active',
      current_month_messages: PLAN_LIMITS.profissional.messages + 200,
    } as any);

    const s = getQuotaStatus(tenant.id)!;
    expect(s.messages.overage_msgs).toBe(200);
    expect(s.messages.overage_cost_cents).toBe(200 * 15);
  });

  it('reports zero overage when tenant is under plan', () => {
    const { tenant } = createTenant({ email: 'underplan@test', name: 'X', tier: 'starter' });
    updateTenant(tenant.id, { status: 'active', current_month_messages: 100 } as any);

    const s = getQuotaStatus(tenant.id)!;
    expect(s.messages.overage_msgs).toBe(0);
    expect(s.messages.overage_cost_cents).toBe(0);
  });
});
