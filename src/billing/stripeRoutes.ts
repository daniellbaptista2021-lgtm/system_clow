/**
 * stripeRoutes.ts — Stripe Checkout + webhook handler.
 *
 * Flow:
 *   1. POST /api/billing/checkout — create checkout session (returns Stripe URL)
 *   2. User pays on Stripe (collects card + customer details)
 *   3. Stripe sends checkout.session.completed → POST /webhooks/stripe
 *   4. Webhook validates signature, extracts customer details, calls signup
 *      OR upgrades existing tenant.
 *
 * Required env:
 *   STRIPE_SECRET_KEY        — sk_live_... or sk_test_...
 *   STRIPE_WEBHOOK_SECRET    — whsec_...
 *   STRIPE_PRICE_STARTER     — price_id of starter plan
 *   STRIPE_PRICE_PROFISSIONAL
 *   STRIPE_PRICE_EMPRESARIAL
 *   STRIPE_SUCCESS_URL       — redirect after payment (default: /signup/success)
 *   STRIPE_CANCEL_URL        — default: /signup
 */

import { Hono } from 'hono';
import { findTenantByEmail, createTenant, updateTenant } from '../tenancy/tenantStore.js';
import { signUserToken } from '../auth/authRoutes.js';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { sendWelcomeEmail } from '../notifications/mailer.js';

const app = new Hono();

// Price IDs are resolved at REQUEST time — env is loaded after module import
function priceIds(): Record<string, string | undefined> {
  return {
    starter: process.env.STRIPE_PRICE_STARTER,
    profissional: process.env.STRIPE_PRICE_PROFISSIONAL,
    empresarial: process.env.STRIPE_PRICE_EMPRESARIAL,
  };
}

function publicBase(): string {
  return process.env.CLOW_PUBLIC_BASE_URL || 'https://system-clow.pvcorretor01.com.br';
}

let _stripeClient: any = null;
async function stripe(): Promise<any> {
  if (_stripeClient) return _stripeClient;
  const sk = process.env.STRIPE_SECRET_KEY;
  if (!sk) throw new Error('STRIPE_SECRET_KEY not configured');
  const Stripe = (await import('stripe')).default;
  _stripeClient = new Stripe(sk, { apiVersion: '2024-12-18.acacia' as any });
  return _stripeClient;
}

// ─── POST /api/billing/checkout — create Stripe Checkout session ────────
app.post('/api/billing/checkout', async (c) => {
  const body = await c.req.json().catch(() => ({})) as any;
  const { plan, email, full_name, cpf, phone } = body;
  if (!plan || !priceIds()[plan]) {
    return c.json({ error: 'invalid_plan', message: 'Plano deve ser starter, profissional ou empresarial.' }, 400);
  }
  if (!email || !full_name || !cpf || !phone) {
    return c.json({ error: 'missing_fields', message: 'Preencha email, nome, CPF e telefone.' }, 400);
  }
  if (findTenantByEmail(String(email).toLowerCase())) {
    return c.json({ error: 'email_in_use' }, 409);
  }

  try {
    const sk = await stripe();
    const session = await sk.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceIds()[plan], quantity: 1 }],
      customer_email: email,
      success_url: (process.env.STRIPE_SUCCESS_URL || `${publicBase()}/signup/success`) + '?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: process.env.STRIPE_CANCEL_URL || `${publicBase()}/signup`,
      metadata: {
        plan, email, full_name, cpf,
        phone: String(phone).replace(/\D/g, ''),
      },
      subscription_data: {
        metadata: { plan, email, full_name, cpf, phone: String(phone).replace(/\D/g, '') },
      },
    });
    return c.json({ ok: true, url: session.url, session_id: session.id });
  } catch (err: any) {
    console.error('[stripe checkout] error:', err.message);
    return c.json({ error: 'checkout_failed', message: err.message }, 502);
  }
});

// ─── POST /webhooks/stripe — handle subscription events ────────────────
app.post('/webhooks/stripe', async (c) => {
  const sig = c.req.header('stripe-signature');
  const wh = process.env.STRIPE_WEBHOOK_SECRET;
  if (!sig || !wh) return c.text('webhook_not_configured', 503);

  let event: any;
  try {
    const sk = await stripe();
    const raw = await c.req.text();
    event = sk.webhooks.constructEvent(raw, sig, wh);
  } catch (err: any) {
    console.error('[stripe webhook] signature error:', err.message);
    return c.text('invalid_signature', 400);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const md = session.metadata || {};
        const email = String(md.email || session.customer_email || '').toLowerCase();
        if (!email) return c.json({ ok: true, skipped: 'no_email' });

        // Already exists? upgrade if needed
        const existing = findTenantByEmail(email);
        if (existing) {
          updateTenant(existing.id, {
            tier: md.plan || existing.tier,
            stripe_customer_id: session.customer,
            stripe_subscription_id: session.subscription,
            status: 'active',
          } as any);
          console.log(`[stripe] upgraded ${email} to ${md.plan}`);
          break;
        }

        // New tenant: generate temp password (sent via email later) — but for now use a random
        // strong one; user resets via reset-password flow that we'll add when needed.
        const tempPassword = randomBytes(12).toString('base64url');
        const password_hash = await bcrypt.hash(tempPassword, 10);
        const { tenant } = createTenant({ email, name: md.full_name || email, tier: (md.plan as any) || 'starter' });
        updateTenant(tenant.id, {
          password_hash,
          full_name: md.full_name,
          cpf: md.cpf,
          phone_e164: md.phone,
          authorized_phones: [md.phone],
          stripe_customer_id: session.customer,
          stripe_subscription_id: session.subscription,
          status: 'active',
          temp_password_for_email: tempPassword, // mark for email-sender to grab
        } as any);
        console.log(`[stripe] created tenant ${email} (${md.plan}); sending welcome email`);
          void sendWelcomeEmail(email, md.full_name || email, tempPassword, md.plan || 'starter');
        break;
      }
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        // Find tenant by stripe_subscription_id
        const tenants = (await import('../tenancy/tenantStore.js')).listTenants();
        const t = tenants.find((tt: any) => tt.stripe_subscription_id === sub.id);
        if (t) {
          updateTenant(t.id, { status: sub.status === 'active' ? 'active' : 'suspended' } as any);
        }
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const tenants = (await import('../tenancy/tenantStore.js')).listTenants();
        const t = tenants.find((tt: any) => tt.stripe_subscription_id === sub.id);
        if (t) updateTenant(t.id, { status: 'cancelled', cancelled_at: new Date().toISOString() } as any);
        break;
      }
      case 'invoice.payment_failed': {
        const inv = event.data.object;
        const tenants = (await import('../tenancy/tenantStore.js')).listTenants();
        const t = tenants.find((tt: any) => tt.stripe_customer_id === inv.customer);
        if (t) updateTenant(t.id, { status: 'past_due' } as any);
        break;
      }
    }
    return c.json({ received: true });
  } catch (err: any) {
    console.error('[stripe webhook] processing error:', err.message);
    return c.json({ received: true, error: err.message });
  }
});

// ─── GET /signup/success — landing após pagamento ───────────────────────
app.get('/signup/success', (c) => {
  const html = [
    '<!DOCTYPE html><html lang="pt-BR"><head>',
    '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>System Clow — Bem-vindo!</title>',
    '<link rel="icon" href="/assets/favicon-gold.png">',
    '<style>',
    'body{margin:0;background:#08081a;color:#E8E8F0;font-family:-apple-system,BlinkMacSystemFont,Inter,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:30px}',
    'body::before{content:"";position:fixed;inset:0;background:radial-gradient(50% 50% at 50% 30%,rgba(155,89,252,.12),transparent 65%);pointer-events:none}',
    '.card{position:relative;max-width:520px;background:#0F0F24;border:1px solid rgba(155,89,252,.3);border-radius:22px;padding:46px 38px;text-align:center;box-shadow:0 30px 90px rgba(0,0,0,.55)}',
    '.logo img{height:38px;margin-bottom:22px;filter:drop-shadow(0 4px 12px rgba(155,89,252,.35))}',
    '.check{width:72px;height:72px;margin:0 auto 22px;border-radius:50%;background:linear-gradient(135deg,#22C55E,#16A34A);display:flex;align-items:center;justify-content:center;box-shadow:0 10px 30px rgba(34,197,94,.35)}',
    '.check svg{width:38px;height:38px;color:#fff;stroke-width:3}',
    'h1{background:linear-gradient(135deg,#9B59FC,#4A9EFF);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;font-size:28px;margin:0 0 12px;letter-spacing:-.02em;font-weight:800}',
    'p{color:#B8B8D0;line-height:1.6;font-size:14.5px;margin:10px 0}',
    '.info{background:rgba(155,89,252,.08);border:1px solid rgba(155,89,252,.2);border-radius:12px;padding:18px;margin:24px 0;text-align:left;font-size:13px;color:#B8B8D0;line-height:1.75}',
    '.info strong{color:#E8E8F0}',
    '.btn{display:inline-block;margin-top:22px;padding:14px 30px;background:linear-gradient(135deg,#9B59FC,#4A9EFF);color:#fff;text-decoration:none;border-radius:12px;font-weight:700;font-size:14.5px;box-shadow:0 8px 24px rgba(155,89,252,.35);transition:transform .15s ease}',
    '.btn:hover{transform:translateY(-2px)}',
    '.note{font-size:11.5px;color:#6E6E8C;margin-top:16px}',
    '</style></head><body>',
    '<div class="card">',
    '<div class="logo"><img src="/assets/logo-official-full-white.png" alt="System Clow"></div>',
    '<div class="check"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div>',
    '<h1>Pagamento confirmado!</h1>',
    '<p>Sua conta foi criada e sua assinatura tá ativa.</p>',
    '<div class="info">',
    '<strong>Próximos passos</strong><br>',
    '1. Verifique seu email — enviamos sua <strong>senha temporária</strong><br>',
    '2. Faça login em system-clow.pvcorretor01.com.br<br>',
    '3. Complete o onboarding (3 min): conecta WhatsApp + instala automações<br>',
    '4. Sua IA começa a atender 24/7',
    '</div>',
    '<a href="/" class="btn">Fazer login →</a>',
    '<div class="note">Email não chegou? Verifica o spam. Ainda sem? <a href="mailto:contato@pvcorretor01.com.br" style="color:#9B59FC">contato@pvcorretor01.com.br</a></div>',
    '</div></body></html>',
  ].join('');
  return c.html(html);
});

export default app;
