/**
 * Stripe webhook integration tests.
 *
 * Drives src/billing/stripeRoutes.ts via app.fetch(Request) and verifies
 * the side effects on tenantStore. Stripe SDK is mocked at the module
 * boundary so the test never makes a real Stripe API call.
 *
 * Coverage:
 *   - checkout.session.completed (paid)        → tenant created, status=active
 *   - checkout.session.completed (unpaid)      → no tenant created (waiting confirmation)
 *   - checkout.session.async_payment_succeeded → tenant created
 *   - customer.subscription.deleted            → tenant status=cancelled
 *   - invoice.payment_failed                    → tenant status=past_due
 *   - customer.subscription.updated (active)   → tenant status=active
 *   - customer.subscription.updated (past_due) → tenant status=suspended
 *   - existing tenant + checkout.session.completed → upgraded in place
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mutable holder for the event the mocked Stripe SDK returns. Lives in
// vi.hoisted() so the mock factory can close over it (vi.mock factories
// are hoisted to the top of the file and can't see normal `let` bindings).
const { eventRef } = vi.hoisted(() => ({ eventRef: { value: null as any } }));

// Mock the Stripe SDK at the module boundary — every `await import('stripe')`
// or `import Stripe from 'stripe'` inside the codebase resolves to this.
// Class form (rather than vi.fn()) so `new Stripe(...)` works.
vi.mock('stripe', () => {
  class StripeMock {
    webhooks = {
      constructEvent: (..._args: unknown[]) => {
        if (eventRef.value instanceof Error) throw eventRef.value;
        if (!eventRef.value) throw new Error('test forgot to set eventRef.value');
        return eventRef.value;
      },
    };
    checkout = {
      sessions: {
        retrieve: vi.fn().mockResolvedValue({ payment_status: 'paid', status: 'complete' }),
        create: vi.fn(),
      },
    };
  }
  return { default: StripeMock };
});

// Silence the welcome notifications — they hit external HTTP endpoints
// which we don't want to reach during tests.
vi.mock('../../../src/notifications/mailer.js', () => ({
  sendWelcomeEmail: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock('../../../src/notifications/whatsapper.js', () => ({
  sendWelcomeWhatsApp: vi.fn().mockResolvedValue({ ok: true }),
}));

// Stable env BEFORE importing the route module.
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_dummy';

// Now the imports are safe.
const { default: stripeRoutes } = await import('../../../src/billing/stripeRoutes.js');
const tenantStore = await import('../../../src/tenancy/tenantStore.js');

// ─── Test helpers ─────────────────────────────────────────────────────────

function buildCheckoutSessionEvent(overrides: Record<string, any> = {}): any {
  return {
    id: 'evt_test_' + Math.random().toString(36).slice(2, 8),
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_' + Math.random().toString(36).slice(2, 8),
        object: 'checkout.session',
        customer: 'cus_test_abc',
        customer_email: 'corretor@example.com',
        subscription: 'sub_test_xyz',
        payment_status: 'paid',
        status: 'complete',
        metadata: {
          email: 'corretor@example.com',
          full_name: 'Corretor Teste',
          plan: 'profissional',
          phone: '+5511999999999',
          cpf: '12345678900',
        },
        ...overrides,
      },
    },
  };
}

function buildSubscriptionEvent(type: string, subscription: any): any {
  return { id: 'evt_test', type, data: { object: subscription } };
}

function buildInvoiceEvent(type: string, invoice: any): any {
  return { id: 'evt_test', type, data: { object: invoice } };
}

async function postWebhook(): Promise<Response> {
  return stripeRoutes.fetch(
    new Request('http://localhost/webhooks/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': 'sig_does_not_matter_we_mock' },
      body: '{"unused":"the SDK mock returns eventRef.value regardless"}',
    }),
  );
}

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'clow-billing-'));
  process.env.CLOW_HOME = tmpHome;
  eventRef.value = null;
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.CLOW_HOME;
});

// ─── Tests ────────────────────────────────────────────────────────────────

describe('Stripe webhook — checkout.session.completed', () => {
  it('creates a tenant and sets status=active when payment_status=paid', async () => {
    eventRef.value =buildCheckoutSessionEvent();
    const r = await postWebhook();

    expect(r.status).toBe(200);
    const t = tenantStore.findTenantByEmail('corretor@example.com');
    expect(t).not.toBeNull();
    expect(t!.status).toBe('active');
    expect(t!.tier).toBe('profissional');
    expect(t!.stripe_customer_id).toBe('cus_test_abc');
    expect(t!.stripe_subscription_id).toBe('sub_test_xyz');
    expect((t as any).cpf).toBe('12345678900');
    expect((t as any).phone_e164).toBe('+5511999999999');
  });

  it('does NOT provision when payment_status is not "paid" (boleto/pix awaiting)', async () => {
    eventRef.value =buildCheckoutSessionEvent({ payment_status: 'unpaid' });
    const r = await postWebhook();

    expect(r.status).toBe(200);
    expect(tenantStore.findTenantByEmail('corretor@example.com')).toBeNull();
  });

  it('upgrades an existing tenant in place rather than creating a duplicate', async () => {
    // Seed an existing tenant on a lower tier.
    tenantStore.createTenant({ email: 'existing@example.com', name: 'Existing', tier: 'starter' });

    eventRef.value =buildCheckoutSessionEvent({
      customer_email: 'existing@example.com',
      metadata: { email: 'existing@example.com', plan: 'empresarial' },
    });
    await postWebhook();

    const all = tenantStore.listTenants().filter((t) => t.email === 'existing@example.com');
    expect(all).toHaveLength(1);
    expect(all[0]!.tier).toBe('empresarial');
    expect(all[0]!.status).toBe('active');
    expect(all[0]!.stripe_customer_id).toBe('cus_test_abc');
  });
});

describe('Stripe webhook — async payment events', () => {
  it('async_payment_succeeded provisions the tenant (Pix/boleto confirmed)', async () => {
    eventRef.value ={
      ...buildCheckoutSessionEvent({ payment_status: 'paid' }),
      type: 'checkout.session.async_payment_succeeded',
    };
    await postWebhook();

    const t = tenantStore.findTenantByEmail('corretor@example.com');
    expect(t).not.toBeNull();
    expect(t!.status).toBe('active');
  });

  it('async_payment_failed does NOT provision (payment expired)', async () => {
    eventRef.value ={
      ...buildCheckoutSessionEvent(),
      type: 'checkout.session.async_payment_failed',
    };
    const r = await postWebhook();

    expect(r.status).toBe(200);
    expect(tenantStore.findTenantByEmail('corretor@example.com')).toBeNull();
  });
});

describe('Stripe webhook — subscription lifecycle', () => {
  it('customer.subscription.deleted sets status=cancelled', async () => {
    const { tenant } = tenantStore.createTenant({
      email: 'tobe-cancelled@example.com', name: 'X', tier: 'profissional',
    });
    tenantStore.updateTenant(tenant.id, { stripe_subscription_id: 'sub_cancel_me' } as any);

    eventRef.value =buildSubscriptionEvent('customer.subscription.deleted', { id: 'sub_cancel_me' });
    await postWebhook();

    const after = tenantStore.getTenant(tenant.id);
    expect(after!.status).toBe('cancelled');
    expect((after as any).cancelled_at).toBeDefined();
  });

  it('customer.subscription.updated → active sets tenant status=active', async () => {
    const { tenant } = tenantStore.createTenant({
      email: 'sub-active@example.com', name: 'X', tier: 'profissional',
    });
    tenantStore.updateTenant(tenant.id, { stripe_subscription_id: 'sub_active', status: 'suspended' });

    eventRef.value =buildSubscriptionEvent('customer.subscription.updated', { id: 'sub_active', status: 'active' });
    await postWebhook();

    expect(tenantStore.getTenant(tenant.id)!.status).toBe('active');
  });

  it('customer.subscription.updated → past_due (any non-active) sets status=suspended', async () => {
    const { tenant } = tenantStore.createTenant({
      email: 'sub-pastdue@example.com', name: 'X', tier: 'profissional',
    });
    tenantStore.updateTenant(tenant.id, { stripe_subscription_id: 'sub_pd' });

    eventRef.value =buildSubscriptionEvent('customer.subscription.updated', { id: 'sub_pd', status: 'past_due' });
    await postWebhook();

    expect(tenantStore.getTenant(tenant.id)!.status).toBe('suspended');
  });

  it('invoice.payment_failed sets tenant status=past_due', async () => {
    const { tenant } = tenantStore.createTenant({
      email: 'pay-failed@example.com', name: 'X', tier: 'profissional',
    });
    tenantStore.updateTenant(tenant.id, { stripe_customer_id: 'cus_pf', status: 'active' });

    eventRef.value =buildInvoiceEvent('invoice.payment_failed', { customer: 'cus_pf' });
    await postWebhook();

    expect(tenantStore.getTenant(tenant.id)!.status).toBe('past_due' as any);
  });
});

describe('Stripe webhook — unknown event types', () => {
  it('200s and ignores events the handler does not implement', async () => {
    eventRef.value ={ id: 'evt_unknown', type: 'product.updated', data: { object: {} } };
    const r = await postWebhook();

    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.received).toBe(true);
  });
});
