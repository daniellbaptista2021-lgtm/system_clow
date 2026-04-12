/**
 * tenantAuth.ts — Multi-tenant auth middleware
 *
 * Authenticates via Bearer API key, resolves tenant, propagates to context.
 * Skips auth for /health and /webhooks/* endpoints.
 * Checks tenant status: active/trial → proceed, suspended/cancelled → 403.
 */

import type { Context, Next } from 'hono';
import { hashApiKey, findTenantByApiKeyHash, touchApiKey, type Tenant } from '../../tenancy/tenantStore.js';

// ─── Tenant Auth Middleware ─────────────────────────────────────────────────

export async function tenantAuth(c: Context, next: Next): Promise<Response | void> {
  const reqPath = c.req.path;

  // Skip auth for health and webhooks
  if (reqPath === '/health' || reqPath.startsWith('/webhooks/') || reqPath.startsWith('/v1/admin/')) {
    return next();
  }

  // Extract API key
  const auth = c.req.header('Authorization');
  if (!auth?.startsWith('Bearer ')) {
    return c.json({ error: 'missing_api_key', message: 'Authorization: Bearer <api_key> required' }, 401);
  }

  const apiKey = auth.slice(7);

  // Validate prefix
  if (!apiKey.startsWith('clow_')) {
    return c.json({ error: 'invalid_api_key', message: 'API key must start with clow_' }, 401);
  }

  // Lookup tenant by key hash
  const keyHash = hashApiKey(apiKey);
  const tenant = findTenantByApiKeyHash(keyHash);

  if (!tenant) {
    return c.json({ error: 'invalid_api_key', message: 'API key not found or revoked' }, 401);
  }

  // Check tenant status
  if (tenant.status === 'suspended') {
    return c.json({
      error: 'tenant_suspended',
      message: 'Your account is suspended. Please contact support or update payment.',
    }, 403);
  }

  if (tenant.status === 'cancelled') {
    return c.json({
      error: 'tenant_cancelled',
      message: 'Your account has been cancelled.',
    }, 403);
  }

  if (tenant.status === 'over_quota_disk') {
    return c.json({
      error: 'workspace_quota_exceeded',
      message: 'Workspace disk quota exceeded. Delete files or upgrade your plan.',
    }, 402);
  }

  // Check trial expiry
  if (tenant.status === 'trial' && tenant.trial_ends_at) {
    if (new Date(tenant.trial_ends_at) < new Date()) {
      return c.json({
        error: 'trial_expired',
        message: 'Your trial has expired. Please upgrade to continue.',
      }, 403);
    }
  }

  // Touch API key (background, non-blocking)
  void Promise.resolve().then(() => touchApiKey(keyHash));

  // Propagate tenant to context
  c.set('tenant', tenant);
  c.set('tenantId', tenant.id);

  return next();
}

// ─── Admin Auth (separate, simple) ──────────────────────────────────────────

export async function adminAuth(c: Context, next: Next): Promise<Response | void> {
  const adminKey = process.env.CLOW_ADMIN_KEY;
  if (!adminKey) {
    return c.json({ error: 'admin_not_configured' }, 500);
  }

  const auth = c.req.header('Authorization');
  if (auth !== `Bearer ${adminKey}`) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  return next();
}
