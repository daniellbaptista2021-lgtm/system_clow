/**
 * quotaGuard.ts — Per-tenant quota enforcement for AI messages + n8n flows.
 *
 * Limits per tier:
 *   starter:      500 msgs IA/mês  · 1 fluxo n8n
 *   profissional: 3.000             · 4
 *   empresarial:  8.000             · 8
 *   business/legacy: 100.000        · 50 (admin)
 *
 * Usage:
 *   - checkAndIncrementMessageQuota(tenantId) before calling AI
 *     returns { allowed, remaining, overage?, limit }
 *   - resetMonthlyUsage(tenantId) on subscription renewal
 *
 * The counter lives in tenants.json as current_month_messages.
 * Scheduler rotates it on month boundary (or on stripe invoice.paid event).
 */

import { getTenant, updateTenant, listTenants } from '../tenancy/tenantStore.js';

export const PLAN_LIMITS: Record<string, { messages: number; flows: number; contacts: number; boards: number; automations: number; users: number; channels: number; overage_cents_per_msg: number }> = {
  starter:      { messages: 500,    flows: 1, contacts: 500,    boards: 2,  automations: 5,   users: 1,  channels: 1,  overage_cents_per_msg: 20 },
  profissional: { messages: 3000,   flows: 4, contacts: 5000,   boards: 10, automations: 30,  users: 5,  channels: 3,  overage_cents_per_msg: 15 },
  empresarial:  { messages: 8000,   flows: 8, contacts: 50000,  boards: 30, automations: 100, users: 20, channels: 10, overage_cents_per_msg: 12 },
  // Legacy admin tiers (before SaaS)
  business:     { messages: 100000, flows: 50, contacts: 1000000, boards: 1000, automations: 1000, users: 100, channels: 100, overage_cents_per_msg: 0 },
  one:          { messages: 1500,  flows: 1, contacts: 500,    boards: 2,  automations: 5,   users: 1,  channels: 1,  overage_cents_per_msg: 20 },
  smart:        { messages: 5000,  flows: 4, contacts: 5000,   boards: 10, automations: 30,  users: 5,  channels: 3,  overage_cents_per_msg: 15 },
};

export interface QuotaCheck {
  allowed: boolean;
  reason?: 'over_limit' | 'over_hard_limit' | 'tenant_not_found' | 'tenant_suspended';
  current: number;
  limit: number;
  remaining: number;
  overage_msgs: number;
  overage_cost_cents: number;
  tier: string;
}

/**
 * Check quota + increment counter atomically.
 * Returns allowed=true until hard_limit (2× plan limit). After plan limit,
 * each extra message bills overage. Beyond 2× hard limit, blocks.
 */
export function checkAndIncrementMessageQuota(tenantId: string): QuotaCheck {
  const tenant: any = getTenant(tenantId);
  if (!tenant) {
    return { allowed: false, reason: 'tenant_not_found', current: 0, limit: 0, remaining: 0, overage_msgs: 0, overage_cost_cents: 0, tier: 'none' };
  }
  if (tenant.status === 'suspended' || tenant.status === 'cancelled') {
    return { allowed: false, reason: 'tenant_suspended', current: 0, limit: 0, remaining: 0, overage_msgs: 0, overage_cost_cents: 0, tier: tenant.tier };
  }

  const tier = String(tenant.tier || 'starter');
  const planLimits = PLAN_LIMITS[tier] || PLAN_LIMITS.starter;
  const limit = planLimits.messages;
  const hardLimit = limit * 2; // allow 100% overage then block

  const current = tenant.current_month_messages || 0;
  const next = current + 1;

  if (next > hardLimit) {
    return {
      allowed: false, reason: 'over_hard_limit',
      current, limit, remaining: 0,
      overage_msgs: current - limit, overage_cost_cents: Math.max(0, (current - limit)) * planLimits.overage_cents_per_msg,
      tier,
    };
  }

  // Increment
  updateTenant(tenantId, { current_month_messages: next } as any);

  const overage_msgs = Math.max(0, next - limit);
  return {
    allowed: true,
    current: next, limit, remaining: Math.max(0, limit - next),
    overage_msgs,
    overage_cost_cents: overage_msgs * planLimits.overage_cents_per_msg,
    tier,
  };
}

/** Reset counter (called monthly or on Stripe invoice.paid). */
export function resetMonthlyUsage(tenantId: string): void {
  updateTenant(tenantId, {
    current_month_messages: 0,
    current_month_cost_usd: 0,
    current_month_started_at: new Date().toISOString(),
  } as any);
}

/** Check if a new resource fits within the tier limit (pre-creation check). */
export function checkResourceLimit(tenantId: string, resource: 'flows' | 'contacts' | 'boards' | 'automations' | 'users' | 'channels', currentCount: number): { allowed: boolean; limit: number } {
  const tenant: any = getTenant(tenantId);
  if (!tenant) return { allowed: false, limit: 0 };
  const tier = String(tenant.tier || 'starter');
  const planLimits = PLAN_LIMITS[tier] || PLAN_LIMITS.starter;
  const limit = planLimits[resource];
  return { allowed: currentCount < limit, limit };
}

export function getQuotaStatus(tenantId: string) {
  const tenant: any = getTenant(tenantId);
  if (!tenant) return null;
  const tier = String(tenant.tier || 'starter');
  const planLimits = PLAN_LIMITS[tier] || PLAN_LIMITS.starter;
  const current = tenant.current_month_messages || 0;
  const since = tenant.current_month_started_at;
  return {
    tier,
    messages: {
      current,
      limit: planLimits.messages,
      remaining: Math.max(0, planLimits.messages - current),
      overage_msgs: Math.max(0, current - planLimits.messages),
      overage_cost_cents: Math.max(0, current - planLimits.messages) * planLimits.overage_cents_per_msg,
      hard_limit: planLimits.messages * 2,
    },
    flows: { limit: planLimits.flows },
    contacts: { limit: planLimits.contacts },
    boards: { limit: planLimits.boards },
    automations: { limit: planLimits.automations },
    users: { limit: planLimits.users },
    channels: { limit: planLimits.channels },
    month_started_at: since,
  };
}

/** Called by scheduler at month boundary. Resets all tenants. */
export function rotateMonthlyAllTenants(): void {
  const tenants = listTenants();
  for (const t of tenants) {
    resetMonthlyUsage(t.id);
  }
  console.log(`[quota] rotated monthly counters for ${tenants.length} tenants`);
}
