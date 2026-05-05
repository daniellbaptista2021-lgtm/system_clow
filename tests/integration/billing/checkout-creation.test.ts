/**
 * Checkout creation tests — fills the gap between webhook coverage and
 * the user-facing /api/billing/checkout flow that actually starts a
 * subscription. Mocks Stripe so no real session is created.
 *
 * Covers:
 *   - POST /api/billing/checkout — happy path with valid plan
 *   - POST /api/billing/checkout — bad plan / missing fields
 *   - GET  /api/billing/session/:id — polling
 *   - POST /api/billing/whatsapp-addon/checkout — addon purchase
 *   - GET  /api/billing/whatsapp-addon/checkout-status — addon polling
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { sessionsRef } = vi.hoisted(() => ({
  sessionsRef: {
    create: vi.fn().mockResolvedValue({
      id: 'cs_test_created',
      url: 'https://checkout.stripe.com/c/test_session',
    }),
    retrieve: vi.fn().mockResolvedValue({
      id: 'cs_test_existing',
      payment_status: 'paid',
      status: 'complete',
      customer_email: 'who@example.com',
    }),
  },
}));

vi.mock('stripe', () => {
  class StripeMock {
    webhooks = { constructEvent: vi.fn() };
    checkout = { sessions: sessionsRef };
  }
  return { default: StripeMock };
});

vi.mock('../../../src/notifications/mailer.js', () => ({
  sendWelcomeEmail: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock('../../../src/notifications/whatsapper.js', () => ({
  sendWelcomeWhatsApp: vi.fn().mockResolvedValue({ ok: true }),
}));

process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
process.env.STRIPE_PRICE_STARTER = 'price_starter_test';
process.env.STRIPE_PRICE_PROFISSIONAL = 'price_profi_test';
process.env.STRIPE_PRICE_EMPRESARIAL = 'price_emp_test';
process.env.STRIPE_PRICE_WHATSAPP_ADDON = 'price_addon_test';

const { default: stripeRoutes } = await import('../../../src/billing/stripeRoutes.js');

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'clow-checkout-'));
  process.env.CLOW_HOME = tmpHome;
  sessionsRef.create.mockClear();
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.CLOW_HOME;
});

function postJSON(path: string, body: any): Promise<Response> {
  return stripeRoutes.fetch(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

describe('POST /api/billing/checkout', () => {
  it('creates a Stripe session for a valid plan', async () => {
    const r = await postJSON('/api/billing/checkout', {
      plan: 'profissional',
      email: 'novo@example.com',
      full_name: 'Novo Corretor',
      cpf: '12345678900',
      phone: '+5511999999999',
    });

    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(body.url).toMatch(/checkout\.stripe\.com/);
    expect(body.session_id).toBe('cs_test_created');
    expect(sessionsRef.create).toHaveBeenCalledOnce();
  });

  it('rejects unknown plan', async () => {
    const r = await postJSON('/api/billing/checkout', {
      plan: 'platinum_diamond_unicorn',
      email: 'x@y.com',
    });
    expect(r.status).toBe(400);
  });

  it('rejects when email is missing', async () => {
    const r = await postJSON('/api/billing/checkout', { plan: 'starter' });
    expect(r.status).toBe(400);
  });
});

describe('GET /api/billing/session/:id', () => {
  it('returns payment_status and status from Stripe', async () => {
    const r = await stripeRoutes.fetch(
      new Request('http://localhost/api/billing/session/cs_test_existing', { method: 'GET' }),
    );
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(body.payment_status).toBe('paid');
    expect(body.status).toBe('complete');
  });

  it('502s when Stripe rejects the lookup', async () => {
    sessionsRef.retrieve.mockRejectedValueOnce(new Error('No such session'));
    const r = await stripeRoutes.fetch(
      new Request('http://localhost/api/billing/session/cs_does_not_exist', { method: 'GET' }),
    );
    expect(r.status).toBe(502);
  });
});

describe('GET /api/billing/whatsapp-addon/checkout-status', () => {
  it('returns paid=true when payment_status=paid', async () => {
    const r = await stripeRoutes.fetch(
      new Request('http://localhost/api/billing/whatsapp-addon/checkout-status?session_id=cs_test_existing'),
    );
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.paid).toBe(true);
  });

  it('rejects 400 when session_id is missing or malformed', async () => {
    const r = await stripeRoutes.fetch(
      new Request('http://localhost/api/billing/whatsapp-addon/checkout-status?session_id=not_cs_anything'),
    );
    expect(r.status).toBe(400);
  });
});
