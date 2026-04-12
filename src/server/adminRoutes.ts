/**
 * adminRoutes.ts — Admin API + Billing webhooks
 *
 * Admin: create/manage tenants (protected by CLOW_ADMIN_KEY)
 * Billing: Asaas webhook for payment confirmation/overdue
 */

import { Hono } from 'hono';
import {
  createTenant,
  getTenant,
  updateTenant,
  listTenants,
  findTenantByExternalCustomerId,
  findTenantByEmail,
  resetMonthlyUsage,
  createApiKeyForTenant,
  revokeApiKey,
  listApiKeysForTenant,
  findOverdueTenants,
  type Tenant,
} from '../tenancy/tenantStore.js';
import { adminAuth } from './middleware/tenantAuth.js';
import type { TierName } from '../tenancy/tiers.js';

export function buildAdminRoutes(): Hono {
  const app = new Hono();

  // All admin routes require admin key (scoped to /v1/admin/*)
  app.use('/v1/admin/*', adminAuth);

  // ── Create Tenant ───────────────────────────────────────────────────
  app.post('/v1/admin/tenants', async (c) => {
    const body = await c.req.json();

    if (!body.email || !body.tier) {
      return c.json({ error: 'email and tier are required' }, 400);
    }

    try {
      const { tenant, apiKey } = createTenant({
        email: body.email,
        name: body.name || body.email,
        tier: body.tier as TierName,
        trial_days: body.trial_days,
      });

      return c.json({
        tenant_id: tenant.id,
        email: tenant.email,
        tier: tenant.tier,
        status: tenant.status,
        api_key: apiKey, // Shown ONCE — stored as hash
        message: 'Save this API key — it cannot be retrieved later.',
      }, 201);
    } catch (err: any) {
      return c.json({ error: err.message }, 400);
    }
  });

  // ── List Tenants ────────────────────────────────────────────────────
  app.get('/v1/admin/tenants', (c) => {
    const tenants = listTenants();
    return c.json({
      count: tenants.length,
      tenants: tenants.map((t) => ({
        id: t.id,
        email: t.email,
        name: t.name,
        tier: t.tier,
        status: t.status,
        messages_used: t.current_month_messages,
        messages_limit: t.max_messages_per_month,
        cost_used: t.current_month_cost_usd,
        cost_limit: t.max_cost_usd_per_month,
      })),
    });
  });

  // ── Get Tenant ──────────────────────────────────────────────────────
  app.get('/v1/admin/tenants/:id', (c) => {
    const tenant = getTenant(c.req.param('id'));
    if (!tenant) return c.json({ error: 'not_found' }, 404);
    return c.json(tenant);
  });

  // ── Update Tenant ───────────────────────────────────────────────────
  app.patch('/v1/admin/tenants/:id', async (c) => {
    const body = await c.req.json();
    const updated = updateTenant(c.req.param('id'), body);
    if (!updated) return c.json({ error: 'not_found' }, 404);
    return c.json(updated);
  });

  // ── Create Additional API Key ───────────────────────────────────────
  app.post('/v1/admin/tenants/:id/keys', async (c) => {
    const body = await c.req.json();
    try {
      const rawKey = createApiKeyForTenant(c.req.param('id'), body.name || 'additional');
      return c.json({ api_key: rawKey, message: 'Save this key — shown once only.' }, 201);
    } catch (err: any) {
      return c.json({ error: err.message }, 400);
    }
  });

  // ── List API Keys ───────────────────────────────────────────────────
  app.get('/v1/admin/tenants/:id/keys', (c) => {
    const keys = listApiKeysForTenant(c.req.param('id'));
    return c.json({
      keys: keys.map((k) => ({
        id: k.id,
        name: k.name,
        created_at: k.created_at,
        last_used_at: k.last_used_at,
        // Never expose hash or raw key
      })),
    });
  });

  // ── Revoke API Key ──────────────────────────────────────────────────
  app.delete('/v1/admin/keys/:keyId', (c) => {
    const ok = revokeApiKey(c.req.param('keyId'));
    return c.json({ revoked: ok });
  });

  // ── Manual Quota Reset ──────────────────────────────────────────────
  app.post('/v1/admin/tenants/:id/reset-usage', (c) => {
    resetMonthlyUsage(c.req.param('id'));
    return c.json({ ok: true, message: 'Monthly usage reset' });
  });

  // ── Run Overdue Suspension Check ────────────────────────────────────
  app.post('/v1/admin/run-overdue-check', (c) => {
    const overdue = findOverdueTenants(7);
    const suspended: string[] = [];

    for (const tenant of overdue) {
      updateTenant(tenant.id, { status: 'suspended' });
      suspended.push(tenant.email);
    }

    return c.json({
      checked: overdue.length,
      suspended,
    });
  });

  return app;
}

// ─── Billing Webhook (Asaas) ────────────────────────────────────────────────

export function buildBillingRoutes(): Hono {
  const app = new Hono();

  app.post('/webhooks/asaas', async (c) => {
    // Validate webhook token
    const webhookToken = process.env.ASAAS_WEBHOOK_TOKEN;
    if (webhookToken) {
      const token = c.req.header('asaas-access-token');
      if (token !== webhookToken) {
        return c.json({ error: 'invalid_signature' }, 401);
      }
    }

    const payload = await c.req.json().catch(() => ({}));
    const event = payload.event as string;
    const payment = payload.payment as any;

    if (!event || !payment) {
      return c.json({ ok: true }); // Ignore malformed
    }

    console.log(`[billing] Event: ${event} | Customer: ${payment.customer}`);

    if (event === 'PAYMENT_CONFIRMED' || event === 'PAYMENT_RECEIVED') {
      await handlePaymentConfirmed(payment);
    } else if (event === 'PAYMENT_OVERDUE') {
      await handlePaymentOverdue(payment);
    }

    return c.json({ ok: true });
  });

  return app;
}

// ─── Payment Handlers ───────────────────────────────────────────────────────

async function handlePaymentConfirmed(payment: any): Promise<void> {
  const customerId = payment.customer as string;
  if (!customerId) return;

  let tenant = findTenantByExternalCustomerId(customerId);

  if (tenant) {
    // Existing tenant — renew
    updateTenant(tenant.id, {
      status: 'active',
      last_payment_at: new Date().toISOString(),
      next_billing_at: new Date(Date.now() + 30 * 86400_000).toISOString(),
    });
    resetMonthlyUsage(tenant.id);
    console.log(`[billing] Renewed tenant ${tenant.email}`);
  } else {
    console.log(`[billing] Payment confirmed for unknown customer ${customerId} — manual resolution needed`);
  }
}

async function handlePaymentOverdue(payment: any): Promise<void> {
  const customerId = payment.customer as string;
  if (!customerId) return;

  const tenant = findTenantByExternalCustomerId(customerId);
  if (!tenant) return;

  // Don't suspend yet — 7 day grace period handled by the cron
  console.log(`[billing] Payment overdue for ${tenant.email} — grace period active`);
}
