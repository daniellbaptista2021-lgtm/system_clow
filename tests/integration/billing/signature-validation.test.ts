/**
 * Webhook signature validation — security-critical.
 *
 * The /webhooks/stripe endpoint MUST reject:
 *   - missing stripe-signature header                → 503 (config error)
 *   - missing STRIPE_WEBHOOK_SECRET env var          → 503 (config error)
 *   - signature that fails Stripe SDK constructEvent → 400
 *
 * If any of these regress, an attacker can post arbitrary "events" and
 * trigger tenant creation / status changes. Treat these as canary tests.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { eventRef } = vi.hoisted(() => ({ eventRef: { value: null as any } }));

// Mock Stripe so constructEvent can be made to throw on demand.
vi.mock('stripe', () => {
  class StripeMock {
    webhooks = {
      constructEvent: (..._args: unknown[]) => {
        if (eventRef.value instanceof Error) throw eventRef.value;
        if (!eventRef.value) throw new Error('signature mock not primed');
        return eventRef.value;
      },
    };
    checkout = { sessions: { retrieve: vi.fn(), create: vi.fn() } };
  }
  return { default: StripeMock };
});

// Silence external services.
vi.mock('../../../src/notifications/mailer.js', () => ({
  sendWelcomeEmail: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock('../../../src/notifications/whatsapper.js', () => ({
  sendWelcomeWhatsApp: vi.fn().mockResolvedValue({ ok: true }),
}));

const { default: stripeRoutes } = await import('../../../src/billing/stripeRoutes.js');

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'clow-billing-sig-'));
  process.env.CLOW_HOME = tmpHome;
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_dummy';
  eventRef.value = null;
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.CLOW_HOME;
});

function postWebhook(opts: { signature?: string | null; body?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.signature !== null && opts.signature !== undefined) headers['stripe-signature'] = opts.signature;
  return stripeRoutes.fetch(
    new Request('http://localhost/webhooks/stripe', {
      method: 'POST',
      headers,
      body: opts.body ?? '{}',
    }),
  );
}

describe('Stripe webhook — signature validation', () => {
  it('rejects 503 when stripe-signature header is missing', async () => {
    eventRef.value = { id: 'evt_x', type: 'checkout.session.completed', data: { object: {} } };
    const r = await postWebhook({ signature: null });

    expect(r.status).toBe(503);
    expect(await r.text()).toMatch(/webhook_not_configured/);
  });

  it('rejects 503 when STRIPE_WEBHOOK_SECRET is unset', async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    eventRef.value = { id: 'evt_x', type: 'checkout.session.completed', data: { object: {} } };
    const r = await postWebhook({ signature: 't=1,v1=cafebabe' });

    expect(r.status).toBe(503);
    expect(await r.text()).toMatch(/webhook_not_configured/);
  });

  it('rejects 400 when SDK constructEvent throws (invalid signature)', async () => {
    // Force the mock SDK to behave as if the signature is bad.
    eventRef.value = new Error('Webhook payload signature verification failed');
    const r = await postWebhook({ signature: 't=1,v1=deadbeef', body: '{"id":"evt_anything"}' });

    expect(r.status).toBe(400);
    expect(await r.text()).toMatch(/invalid_signature/);
  });

  it('does NOT mutate any tenant on signature failure', async () => {
    const tenantStore = await import('../../../src/tenancy/tenantStore.js');
    tenantStore.createTenant({ email: 'attacker-target@example.com', name: 'X', tier: 'starter' });
    const before = tenantStore.findTenantByEmail('attacker-target@example.com');

    eventRef.value = new Error('signature mismatch');
    const r = await postWebhook({ signature: 'forged' });

    expect(r.status).toBe(400);
    const after = tenantStore.findTenantByEmail('attacker-target@example.com');
    expect(after).toEqual(before);
  });

  it('successful signature flow returns 200 (sanity check the test harness)', async () => {
    eventRef.value = { id: 'evt_ok', type: 'product.updated', data: { object: {} } };
    const r = await postWebhook({ signature: 'valid' });

    expect(r.status).toBe(200);
    expect((await r.json()).received).toBe(true);
  });
});
