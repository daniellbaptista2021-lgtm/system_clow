/**
 * quotaGuard.ts — Quota enforcement for multi-tenant
 *
 * Called before each turn in QueryEngine.
 * Checks: messages, cost, concurrent sessions, features.
 * Returns error object or null (clear to proceed).
 */

import {
  getTenant,
  countActiveSessions,
  type Tenant,
} from './tenantStore.js';
import { tierHasFeature } from './tiers.js';

export interface QuotaError {
  code: string;
  message: string;
  httpStatus: number;
}

/**
 * Check all quotas before processing a message.
 * Returns null if all clear, QuotaError if blocked.
 */
export function checkQuota(tenant: Tenant): QuotaError | null {
  // Message quota
  if (tenant.current_month_messages >= tenant.max_messages_per_month) {
    return {
      code: 'quota_exceeded_messages',
      message: `Monthly message limit reached (${tenant.current_month_messages}/${tenant.max_messages_per_month}). Upgrade your plan or wait for next billing cycle.`,
      httpStatus: 429,
    };
  }

  // Cost quota
  if (tenant.current_month_cost_usd >= tenant.max_cost_usd_per_month) {
    return {
      code: 'quota_exceeded_cost',
      message: `Monthly cost limit reached ($${tenant.current_month_cost_usd.toFixed(2)}/$${tenant.max_cost_usd_per_month}). Upgrade your plan.`,
      httpStatus: 429,
    };
  }

  // Concurrent sessions
  const activeSessions = countActiveSessions(tenant.id);
  if (activeSessions >= tenant.max_concurrent_sessions) {
    return {
      code: 'too_many_sessions',
      message: `Maximum concurrent sessions reached (${activeSessions}/${tenant.max_concurrent_sessions}). Close existing sessions or upgrade.`,
      httpStatus: 429,
    };
  }

  return null; // All clear
}

/**
 * Check if a specific tool is allowed for this tenant's tier.
 */
export function isToolAllowedForTier(toolName: string, tier: string): boolean {
  // Built-in tools available to everyone
  const ALWAYS_ALLOWED = new Set([
    'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'TodoWrite',
    'WebFetch',
  ]);

  if (ALWAYS_ALLOWED.has(toolName)) return true;

  // Feature-gated tools
  if (toolName === 'Agent') return tierHasFeature(tier, 'agent_tool');
  if (toolName === 'WebSearch') return tierHasFeature(tier, 'basic_tools'); // needs API key anyway
  if (toolName === 'EnterPlanMode' || toolName === 'ExitPlanMode') {
    return tierHasFeature(tier, 'plan_mode');
  }

  // MCP tools
  if (toolName.startsWith('mcp__')) {
    return tierHasFeature(tier, 'mcp_full') || tierHasFeature(tier, 'mcp_basic');
  }

  return true; // Unknown tools — allow by default (fail-open for extensibility)
}

/**
 * Filter tool list based on tenant tier.
 */
export function filterToolsForTier(tools: any[], tier: string): any[] {
  return tools.filter((t) => isToolAllowedForTier(t.name, tier));
}
