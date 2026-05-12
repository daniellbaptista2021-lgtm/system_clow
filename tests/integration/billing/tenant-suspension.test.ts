/**
 * Tenant suspension enforcement tests.
 *
 * The middleware src/server/middleware/tenantAuth.ts gates every
 * non-health, non-webhook, non-admin path. When a tenant's status is:
 *
 *   suspended  → 403 tenant_suspended           (most common — past due / billing failure)
 *   cancelled  → 403 tenant_cancelled
 *   over_quota_disk → 402 workspace_quota_exceeded
 *   trial + trial_ends_at < now → 403 trial_expired
 *
 * Each is enforced BEFORE any business logic runs. These tests pin that
 * behavior so a regression that lets a suspended tenant talk to the AI
 * gets caught immediately.
 *
 * Note: the user-facing concept "past_due" is set by the
 *       invoice.payment_failed webhook handler. quotaGuard treats
 *       past_due tenants as still active (not in the suspended/cancelled
 *       set) — i.e. ONE missed invoice is a soft warning, not a hard cut.
 *       Stripe usually retries before sending subscription.updated with
 *       status=past_due (which we map to suspended). That is the
 *       hard-cut signal.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { tenantAuth } from '../../../src/server/middleware/tenantAuth.js';
import { createTenant, updateTenant } from '../../../src/tenancy/tenantStore.js';
import { checkAndIncrementMessageQuota } from '../../../src/billing/quotaGuard.js';

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'clow-suspend-'));
  process.env.CLOW_HOME = tmpHome;
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.CLOW_HOME;
});

function buildApp(): Hono {
  const app = new Hono();
  app.use('/v1/crm/*', tenantAuth);
  app.use('/v1/sessions/*', tenantAuth);
  app.get('/v1/crm/contacts', (c) => c.json({ ok: true, where: 'crm' }));
  app.post('/v1/sessions', (c) => c.json({ ok: true, where: 'sessions' }));
  app.get('/health', (c) => c.json({ ok: true, where: 'health' }));
  return app;
}

async function fetchAs(app: Hono, path: string, apiKey?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return app.fetch(new Request(`http://localhost${path}`, { method: path === '/v1/sessions' ? 'POST' : 'GET', headers }));
}

describe('tenantAuth — happy path', () => {
  it('active tenant gets through to /v1/crm', async () => {
    const { apiKey } = createTenant({ email: 'happy@test', name: 'Happy', tier: 'starter' });
    const app = buildApp();

    const r = await fetchAs(app, '/v1/crm/contacts', apiKey);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, where: 'crm' });
  });
});

describe('tenantAuth — blocks suspended tenants', () => {
  it('returns 403 tenant_suspended on /v1/crm', async () => {
    const { tenant, apiKey } = createTenant({ email: 'sus@test', name: 'Sus', tier: 'starter' });
    updateTenant(tenant.id, { status: 'suspended' });

    const r = await fetchAs(buildApp(), '/v1/crm/contacts', apiKey);
    expect(r.status).toBe(403);
    const body = await r.json();
    expect(body.error).toBe('tenant_suspended');
  });

  it('returns 403 on /v1/sessions too (the AI agent surface)', async () => {
    const { tenant, apiKey } = createTenant({ email: 'sus2@test', name: 'Sus', tier: 'starter' });
    updateTenant(tenant.id, { status: 'suspended' });

    const r = await fetchAs(buildApp(), '/v1/sessions', apiKey);
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe('tenant_suspended');
  });

  it('quotaGuard.checkAndIncrement also rejects suspended tenants', () => {
    const { tenant } = createTenant({ email: 'sus3@test', name: 'Sus', tier: 'starter' });
    updateTenant(tenant.id, { status: 'suspended' });

    const r = checkAndIncrementMessageQuota(tenant.id);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('tenant_suspended');
  });
});

describe('tenantAuth — blocks cancelled tenants', () => {
  it('returns 403 tenant_cancelled', async () => {
    const { tenant, apiKey } = createTenant({ email: 'cancelled@test', name: 'X', tier: 'starter' });
    updateTenant(tenant.id, { status: 'cancelled' });

    const r = await fetchAs(buildApp(), '/v1/crm/contacts', apiKey);
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe('tenant_cancelled');
  });
});

describe('tenantAuth — over_quota_disk', () => {
  it('returns 402 workspace_quota_exceeded', async () => {
    const { tenant, apiKey } = createTenant({ email: 'fulldisk@test', name: 'X', tier: 'starter' });
    updateTenant(tenant.id, { status: 'over_quota_disk' });

    const r = await fetchAs(buildApp(), '/v1/crm/contacts', apiKey);
    expect(r.status).toBe(402);
    expect((await r.json()).error).toBe('workspace_quota_exceeded');
  });
});

describe('tenantAuth — expired trial', () => {
  it('returns 403 trial_expired when trial_ends_at < now', async () => {
    const { tenant, apiKey } = createTenant({ email: 'expired@test', name: 'X', tier: 'starter', trial_days: 14 });
    updateTenant(tenant.id, {
      status: 'trial',
      trial_ends_at: new Date(Date.now() - 3600_000).toISOString(),
    });

    const r = await fetchAs(buildApp(), '/v1/crm/contacts', apiKey);
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe('trial_expired');
  });

  it('lets active trial through (trial_ends_at in the future)', async () => {
    const { tenant, apiKey } = createTenant({ email: 'still-trial@test', name: 'X', tier: 'starter', trial_days: 14 });
    updateTenant(tenant.id, {
      status: 'trial',
      trial_ends_at: new Date(Date.now() + 86400_000).toISOString(),
    });

    const r = await fetchAs(buildApp(), '/v1/crm/contacts', apiKey);
    expect(r.status).toBe(200);
  });
});

describe('tenantAuth — bypass paths stay open', () => {
  it('/health is reachable without auth', async () => {
    const r = await buildApp().fetch(new Request('http://localhost/health'));
    expect(r.status).toBe(200);
    expect((await r.json()).where).toBe('health');
  });
});

describe('tenantAuth — auth errors', () => {
  it('returns 401 when no Authorization header', async () => {
    const r = await fetchAs(buildApp(), '/v1/crm/contacts');
    expect(r.status).toBe(401);
    expect((await r.json()).error).toBe('missing_api_key');
  });

  it('returns 401 when API key prefix is wrong', async () => {
    const r = await fetchAs(buildApp(), '/v1/crm/contacts', 'wrong_prefix_abc123');
    expect(r.status).toBe(401);
    expect((await r.json()).error).toBe('invalid_api_key');
  });

  it('returns 401 when API key is unknown', async () => {
    const r = await fetchAs(buildApp(), '/v1/crm/contacts', 'clow_live_does_not_exist');
    expect(r.status).toBe(401);
  });
});
