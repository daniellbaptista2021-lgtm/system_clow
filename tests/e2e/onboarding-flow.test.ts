/**
 * E2E onboarding flow — the canary test for the critical product path.
 *
 * If this passes, a new corretor can sign up, get billing in order, log in,
 * exchange a CRM key, configure their pipeline, plug in a WhatsApp channel,
 * receive an inbound message, and have it reach the AI agent. If it
 * breaks, the product is broken.
 *
 * Steps (10):
 *   1. POST /auth/signup with valid CPF + email + E.164 phone
 *   2. Tenant created — status check
 *   3. Stripe webhook (checkout.session.completed) for that email
 *   4. Tenant ends with stripe IDs + tier wired up
 *   5. POST /auth/login → JWT token
 *   6. POST /v1/crm/auth/exchange → CRM api_key
 *   7. CRM CRUD: create board / column / contact / channel via api_key
 *   8. POST /auth/authorized-phones — set phone whitelist
 *   9. POST /webhooks/crm/zapi/:secret with a real Z-API ReceivedCallback
 *      payload — verify it parses + logs activity (AI response loop is
 *      mocked at the adapter boundary so we don't need a real Anthropic
 *      key in CI)
 *   10. Read crm_activities — verify the message landed on the contact
 *
 * Important divergences from the user's command spec (kept as inline
 * comments so future readers see what's real vs. what was assumed):
 *
 *   - The user said "Valida que tenant foi criado em estado pending_payment".
 *     Reality: src/auth/authRoutes.ts:108 creates tenants with status='active'
 *     (the default in createTenant). There is no pending_payment state in
 *     the tenant lifecycle today; the flow assumes Stripe has already
 *     succeeded by the time signup is hit (the SaaS frontend serializes
 *     checkout-then-signup, with the webhook running in parallel as a
 *     belt-and-suspenders backfill). We assert status='active' instead.
 *
 *   - The user said "/v1/crm/auth/exchange" returns api_key. Reality
 *     confirmed (src/crm/routes/auth-exchange.ts).
 *
 *   - Step 9: testing the FULL chain (Anthropic stream + Z-API outbound)
 *     would need live keys. We mock the Anthropic SDK + sendOutbound; the
 *     test verifies inbound is RECEIVED + ACTIVITY-LOGGED, which is the
 *     part that runs in the http handler synchronously. The AI roundtrip
 *     is exercised by the unit tests for the engine/sessionPool layer.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';

// ─── Mocks (must hoist before any module imports route handlers) ─────────

const sendOutboundSpy = vi.fn().mockResolvedValue({ ok: true, providerMessageId: 'wamid.mock_001' });
vi.mock('../../src/crm/inbox.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/crm/inbox.js')>();
  return {
    ...actual,
    sendOutbound: sendOutboundSpy,
  };
});

vi.mock('../../src/notifications/mailer.js', () => ({
  sendWelcomeEmail: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock('../../src/notifications/whatsapper.js', () => ({
  sendWelcomeWhatsApp: vi.fn().mockResolvedValue({ ok: true }),
}));

// Mock Stripe SDK for the checkout webhook step.
const { stripeEventRef } = vi.hoisted(() => ({ stripeEventRef: { value: null as any } }));
vi.mock('stripe', () => {
  class StripeMock {
    webhooks = {
      constructEvent: () => stripeEventRef.value,
    };
    checkout = { sessions: { retrieve: vi.fn(), create: vi.fn() } };
  }
  return { default: StripeMock };
});

// Stable env BEFORE imports.
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_dummy';
process.env.CLOW_USER_SESSION_SECRET = 'test-session-secret-do-not-use-prod';
process.env.CLOW_CRM_SECRET = 'test-crm-encryption-key-do-not-use-prod';

// ─── Test setup ───────────────────────────────────────────────────────────

let tmpHome: string;
let app: Hono;

beforeAll(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), 'clow-e2e-'));
  process.env.CLOW_HOME = tmpHome;
  process.env.CRM_DB_PATH = join(tmpHome, 'crm.sqlite3');

  // Boot the bare minimum of the server: auth + crm + stripe webhook +
  // crm webhooks. We do NOT call createServer() because that wires up
  // PM2-only pieces (LiteLLM proxy, MCP, scheduler intervals, etc.) we
  // don't need for an http-level e2e.
  const authRoutes = (await import('../../src/auth/authRoutes.js')).default;
  const stripeRoutes = (await import('../../src/billing/stripeRoutes.js')).default;
  const crmRoutes = (await import('../../src/crm/routes.js')).default;
  const crmWebhooks = (await import('../../src/crm/webhooks.js')).default;
  const { tenantAuth } = await import('../../src/server/middleware/tenantAuth.js');
  const { getCrmDb } = await import('../../src/crm/schema.js');
  getCrmDb(); // Force migrations to run.

  app = new Hono();
  app.route('/auth', authRoutes);
  app.route('/', stripeRoutes);
  app.use('/v1/crm/*', tenantAuth);
  app.use('/v1/crm', tenantAuth);
  app.route('/v1/crm', crmRoutes);
  app.route('/webhooks/crm', crmWebhooks);
});

afterAll(async () => {
  const { closeCrmDb } = await import('../../src/crm/schema.js');
  closeCrmDb();
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.CLOW_HOME;
  delete process.env.CRM_DB_PATH;
});

async function api<T = any>(
  path: string,
  init: { method?: string; body?: any; token?: string; rawBody?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers || {}),
  };
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  const r = await app.fetch(
    new Request(`http://localhost${path}`, {
      method: init.method ?? 'POST',
      headers,
      body: init.rawBody ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
    }),
  );
  const text = await r.text();
  let parsed: any = text;
  try { parsed = JSON.parse(text); } catch { /* leave as text */ }
  return { status: r.status, body: parsed };
}

describe('E2E onboarding flow — signup → checkout → CRM → inbound message', () => {
  // Test-shared state. Each step builds on the previous.
  const SIGNUP_EMAIL = `e2e-${Date.now()}@example.com`;
  const SIGNUP_PHONE = '+5511988887777';
  let tenantId: string;
  let userToken: string;
  let crmApiKey: string;
  let boardId: string;
  let columnId: string;
  let contactId: string;
  let channelId: string;
  let webhookSecret: string;

  // ─── 1. signup ────────────────────────────────────────────────────────────
  it('step 1 — POST /auth/signup with valid fields creates tenant', async () => {
    const r = await api('/auth/signup', {
      body: {
        email: SIGNUP_EMAIL,
        password: 'SuperSecret123',
        full_name: 'Daniel Teste',
        cpf: '11144477735', // valid CPF (passes mod-11)
        birth_date: '1990-01-15',
        phone: SIGNUP_PHONE,
        plan_tier: 'profissional',
      },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.ok).toBe(true);
    expect(r.body.token).toMatch(/^usr\./);
    expect(r.body.user.email).toBe(SIGNUP_EMAIL);
    tenantId = r.body.user.id;
    userToken = r.body.token;
  });

  // ─── 2. tenant state after signup ─────────────────────────────────────────
  it('step 2 — tenant exists and is active (no pending_payment state in current code)', async () => {
    const ts = await import('../../src/tenancy/tenantStore.js');
    const t = ts.findTenantByEmail(SIGNUP_EMAIL);
    expect(t).not.toBeNull();
    // Reality check: the signup endpoint creates active tenants directly.
    // The pending_payment state from the user's spec doesn't exist in the
    // current lifecycle (Stripe checkout happens BEFORE signup in the SaaS
    // frontend, with the webhook acting as a backstop).
    expect(t!.status).toBe('active');
    expect(t!.tier).toBe('profissional');
    expect((t as any).cpf).toBe('11144477735');
    // normalizePhone() in signup strips the leading '+' so we check both forms.
    const phones: string[] = (t as any).authorized_phones || [];
    expect(phones.some((p) => p === SIGNUP_PHONE || p === SIGNUP_PHONE.replace('+', ''))).toBe(true);
  });

  // ─── 3. Stripe webhook — upgrades the tenant in place ─────────────────────
  it('step 3 — POST /webhooks/stripe (checkout.session.completed) wires up Stripe IDs', async () => {
    stripeEventRef.value = {
      id: 'evt_e2e',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_e2e',
          customer: 'cus_e2e_real',
          customer_email: SIGNUP_EMAIL,
          subscription: 'sub_e2e_real',
          payment_status: 'paid',
          status: 'complete',
          metadata: { email: SIGNUP_EMAIL, plan: 'profissional' },
        },
      },
    };
    const r = await api('/webhooks/stripe', {
      headers: { 'stripe-signature': 't=1,v1=mocked' },
      rawBody: '{}',
    });
    expect(r.status).toBe(200);
  });

  it('step 4 — tenant carries stripe_customer_id + stripe_subscription_id after webhook', async () => {
    const ts = await import('../../src/tenancy/tenantStore.js');
    const t = ts.findTenantByEmail(SIGNUP_EMAIL);
    expect(t!.stripe_customer_id).toBe('cus_e2e_real');
    expect(t!.stripe_subscription_id).toBe('sub_e2e_real');
    expect(t!.status).toBe('active');
  });

  // ─── 5. login ─────────────────────────────────────────────────────────────
  it('step 5 — POST /auth/login returns a fresh user token', async () => {
    const r = await api('/auth/login', {
      body: { email: SIGNUP_EMAIL, password: 'SuperSecret123' },
    });
    expect(r.status, r.body).toBe(200);
    expect(r.body.token).toMatch(/^usr\./);
    expect(r.body.user.tier).toBe('profissional');
    userToken = r.body.token;
  });

  // ─── 6. CRM api_key exchange ──────────────────────────────────────────────
  it('step 6 — POST /v1/crm/auth/exchange returns a usable CRM api_key', async () => {
    const r = await api('/v1/crm/auth/exchange', { token: userToken });
    expect(r.status, r.body).toBe(200);
    expect(r.body.api_key).toMatch(/^clow_/);
    expect(r.body.tenant_id).toBe(tenantId);
    expect(r.body.tier).toBe('profissional');
    crmApiKey = r.body.api_key;
  });

  // ─── 7. CRM CRUD ──────────────────────────────────────────────────────────
  it('step 7a — POST /v1/crm/boards', async () => {
    const r = await api('/v1/crm/boards', { token: crmApiKey, body: { name: 'Pipeline E2E', type: 'sales' } });
    expect([200, 201]).toContain(r.status);
    expect(r.body.board?.id ?? r.body.id).toMatch(/^crm_board_/);
    boardId = r.body.board?.id ?? r.body.id;
  });

  it('step 7b — POST /v1/crm/boards/:id/columns', async () => {
    const r = await api(`/v1/crm/boards/${boardId}/columns`, { token: crmApiKey, body: { name: 'Lead novo' } });
    expect([200, 201]).toContain(r.status);
    expect(r.body.column?.id ?? r.body.id).toMatch(/^crm_col_/);
    columnId = r.body.column?.id ?? r.body.id;
  });

  it('step 7c — POST /v1/crm/contacts', async () => {
    const r = await api('/v1/crm/contacts', {
      token: crmApiKey,
      body: { name: 'Cliente E2E', phone: '+5511955554444', source: 'whatsapp' },
    });
    expect([200, 201]).toContain(r.status);
    expect(r.body.contact?.id ?? r.body.id).toMatch(/^crm_contact_/);
    contactId = r.body.contact?.id ?? r.body.id;
  });

  it('step 7d — POST /v1/crm/cards', async () => {
    const r = await api('/v1/crm/cards', {
      token: crmApiKey,
      body: { boardId, columnId, title: 'Apto centro 2 quartos', contactId, valueCents: 500000 },
    });
    expect([200, 201]).toContain(r.status);
    expect(r.body.card?.id ?? r.body.id).toMatch(/^crm_card_/);
  });

  it('step 7e — POST /v1/crm/channels (Z-API)', async () => {
    const r = await api('/v1/crm/channels', {
      token: crmApiKey,
      body: {
        type: 'zapi',
        name: 'Z-API e2e',
        credentials: { instanceId: 'inst_e2e', token: 'tok_e2e', clientToken: 'sec_e2e' },
        phoneNumber: '+5511955554444',
      },
    });
    expect([200, 201]).toContain(r.status);
    const ch = r.body.channel ?? r.body;
    expect(ch.id).toMatch(/^crm_ch_/);
    channelId = ch.id;
    webhookSecret = ch.webhookSecret;
    expect(webhookSecret).toBeTruthy();
  });

  // ─── 8. authorized phones whitelist ───────────────────────────────────────
  it('step 8 — POST /auth/authorized-phones updates the whitelist', async () => {
    const r = await api('/auth/authorized-phones', {
      token: userToken,
      body: { phones: [SIGNUP_PHONE, '+5511955554444'] },
    });
    expect(r.status, r.body).toBe(200);
    const ts = await import('../../src/tenancy/tenantStore.js');
    const t = ts.getTenant(tenantId);
    // normalizePhone strips '+', so check normalized forms.
    const normalized = (phones: string[]) => phones.map((p) => p.replace('+', ''));
    expect((t as any).authorized_phones).toEqual(expect.arrayContaining(normalized([SIGNUP_PHONE, '+5511955554444'])));
  });

  // ─── 9. inbound Z-API webhook with realistic payload ──────────────────────
  it('step 9 — POST /webhooks/crm/zapi/:secret with a valid ReceivedCallback parses + logs activity', async () => {
    const r = await api(`/webhooks/crm/zapi/${webhookSecret}`, {
      body: [
        {
          type: 'ReceivedCallback',
          phone: '5511955554444',                           // Z-API sends without +
          fromMe: false,
          messageId: 'wamid.e2e_inbound_001',
          momment: Date.now(),
          senderName: 'Cliente E2E',
          text: { message: 'Quero saber o orçamento desse apartamento' },
        },
      ],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.processed).toBeGreaterThanOrEqual(1);
  });

  // ─── 10. activity landed in crm_activities ────────────────────────────────
  it('step 10 — inbound message is stored as activity on the contact', async () => {
    // ingestInbound runs async (void ingestInbound(...) in the webhook
    // handler) — give it a moment to complete its DB writes.
    await new Promise((r) => setTimeout(r, 250));

    const { getCrmDb } = await import('../../src/crm/schema.js');
    const rows = getCrmDb()
      .prepare(`SELECT * FROM crm_activities WHERE tenant_id = ? AND content LIKE ? ORDER BY created_at DESC`)
      .all(tenantId, '%orçamento desse apartamento%') as any[];

    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].direction === 'in' || rows[0].direction === 'inbound' || rows[0].channel === 'zapi').toBe(true);
  });
});
