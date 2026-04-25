/**
 * stripeRoutes.ts — Stripe Checkout + webhook handler + polling.
 *
 * Fluxo:
 *   1. POST /api/billing/checkout — cria session (retorna Stripe URL + session_id)
 *   2. Cliente paga na nova aba (cartão, débito, pix, boleto)
 *   3. Stripe manda checkout.session.completed → POST /webhooks/stripe
 *   4. Webhook cria tenant + envia credenciais via EMAIL + WHATSAPP
 *   5. Pricing modal faz poll em GET /api/billing/session/:id
 *      quando status=paid → redireciona pra /signup/success
 *
 * Métodos de pagamento:
 *   - card: crédito + débito (Stripe detecta automático no BR)
 *   - boleto: boleto bancário (subscription com boleto recorrente)
 *   - pix: pix instantâneo (subscription com pix mensal)
 *
 * Notas:
 *   - Pra subscription mode no BR, Stripe aceita ['card'] + payment_method_options
 *     para boleto/pix. Alguns tipos requerem ativação no Dashboard.
 *   - Se fornecedor bloquear algum método, /checkout retorna 502 e mostra mensagem.
 */

import { Hono } from 'hono';
import { findTenantByEmail, createTenant, updateTenant } from '../tenancy/tenantStore.js';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { sendWelcomeEmail } from '../notifications/mailer.js';
import { sendWelcomeWhatsApp } from '../notifications/whatsapper.js';

const app = new Hono();

// Price IDs resolvidos em REQUEST time (env carrega depois do import)
function priceIds(): Record<string, string | undefined> {
  return {
    starter: process.env.STRIPE_PRICE_STARTER,
    profissional: process.env.STRIPE_PRICE_PROFISSIONAL,
    empresarial: process.env.STRIPE_PRICE_EMPRESARIAL,
  };
}

// Onda 53: Add-on WhatsApp (Z-API extra), R$ 100/mes recorrente por numero
function whatsappAddonPriceId(): string | undefined {
  return process.env.STRIPE_PRICE_WHATSAPP_ADDON;
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

// Quais métodos habilitar por tier: todos aceitam os mesmos, mas deixo parametrizável
function paymentMethodsFor(_plan: string): string[] {
  // Stripe subscription mode no BR aceita:
  //   - card (credit + debit)
  //   - boleto (recorrente mensal)
  //   - Para pix recorrente: precisa habilitar no Dashboard e usar
  //     automatic_payment_methods. Por ora, habilita via env var.
  const configured = (process.env.STRIPE_PAYMENT_METHODS || 'card,boleto').split(',').map(s => s.trim()).filter(Boolean);
  return configured;
}

// ─── POST /api/billing/checkout — cria Stripe Checkout session ────────
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
    const cpfDigits = String(cpf).replace(/\D/g, '');
    const phoneDigits = String(phone).replace(/\D/g, '');

    const sessionParams: any = {
      mode: 'subscription',
      payment_method_types: paymentMethodsFor(plan),
      line_items: [{ price: priceIds()[plan], quantity: 1 }],
      customer_email: email,
      locale: 'pt-BR',
      billing_address_collection: 'required',
      // boleto + pix exigem CPF/CNPJ (tax ID)
      tax_id_collection: { enabled: true },
      // boleto: dar 3 dias pra pagar
      payment_method_options: {
        boleto: { expires_after_days: 3 },
      },
      success_url: `${publicBase()}/signup/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${publicBase()}/pricing`,
      metadata: {
        plan, email, full_name, cpf: cpfDigits,
        phone: phoneDigits,
      },
      subscription_data: {
        metadata: { plan, email, full_name, cpf: cpfDigits, phone: phoneDigits },
      },
    };

    const session = await sk.checkout.sessions.create(sessionParams);
    return c.json({ ok: true, url: session.url, session_id: session.id });
  } catch (err: any) {
    console.error('[stripe checkout] error:', err.message);
    // Se boleto/pix derem problema na conta, tenta fallback só com card
    if (/payment_method_type|not_allowed|not.*enabled/i.test(err.message || '')) {
      try {
        const sk = await stripe();
        const cpfDigits = String(cpf).replace(/\D/g, '');
        const phoneDigits = String(phone).replace(/\D/g, '');
        const session = await sk.checkout.sessions.create({
          mode: 'subscription',
          payment_method_types: ['card'],
          line_items: [{ price: priceIds()[plan], quantity: 1 }],
          customer_email: email,
          locale: 'pt-BR',
          billing_address_collection: 'required',
          success_url: `${publicBase()}/signup/success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${publicBase()}/pricing`,
          metadata: { plan, email, full_name, cpf: cpfDigits, phone: phoneDigits },
          subscription_data: { metadata: { plan, email, full_name, cpf: cpfDigits, phone: phoneDigits } },
        });
        console.warn('[stripe checkout] fallback card-only (boleto/pix não habilitado na conta)');
        return c.json({ ok: true, url: session.url, session_id: session.id, fallback: 'card_only' });
      } catch (err2: any) {
        return c.json({ error: 'checkout_failed', message: err2.message }, 502);
      }
    }
    return c.json({ error: 'checkout_failed', message: err.message }, 502);
  }
});

// ─── GET /api/billing/session/:id — poll status pro modal ─────────────
app.get('/api/billing/session/:id', async (c) => {
  const id = c.req.param('id');
  if (!id || !id.startsWith('cs_')) return c.json({ error: 'invalid_session' }, 400);
  try {
    const sk = await stripe();
    const session = await sk.checkout.sessions.retrieve(id);
    return c.json({
      ok: true,
      payment_status: session.payment_status, // paid | unpaid | no_payment_required
      status: session.status,                 // open | complete | expired
      customer_email: session.customer_email,
    });
  } catch (err: any) {
    return c.json({ error: 'session_fetch_failed', message: err.message }, 502);
  }
});

// ─── POST /webhooks/stripe ─────────────────────────────────────────────
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
        // Para boleto/pix: session.status=complete mas payment_status=unpaid até pagar
        // Só provisiona quando payment_status === 'paid'
        if (session.payment_status !== 'paid') {
          console.log(`[stripe] session completed mas payment_status=${session.payment_status} — aguardando confirmação`);
          break;
        }
        await provisionFromSession(session);
        break;
      }
      case 'checkout.session.async_payment_succeeded': {
        // Pix/boleto confirmado (pagamento assíncrono)
        const session = event.data.object;
        console.log(`[stripe] async payment succeeded — provisionando ${session.customer_email}`);
        await provisionFromSession(session);
        break;
      }
      case 'checkout.session.async_payment_failed': {
        const session = event.data.object;
        console.warn(`[stripe] async payment FAILED para ${session.customer_email} (boleto/pix expirou)`);
        break;
      }
      case 'customer.subscription.updated': {
        const sub = event.data.object;
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

// Provisiona tenant a partir da session (email + wa welcome)
async function provisionFromSession(session: any): Promise<void> {
  const md = session.metadata || {};
  const email = String(md.email || session.customer_email || '').toLowerCase();
  if (!email) return;

  const existing = findTenantByEmail(email);
  if (existing) {
    updateTenant(existing.id, {
      tier: md.plan || existing.tier,
      stripe_customer_id: session.customer,
      stripe_subscription_id: session.subscription,
      status: 'active',
    } as any);
    console.log(`[stripe] upgraded ${email} to ${md.plan}`);
    return;
  }

  const tempPassword = randomBytes(9).toString('base64url'); // 12 chars, legível
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
    temp_password_for_email: tempPassword,
  } as any);
  console.log(`[stripe] created tenant ${email} (${md.plan}); disparando email + whatsapp`);

  // Dispara email + WhatsApp em paralelo; nenhum é bloqueante
  const loginUrl = process.env.CLOW_PUBLIC_BASE_URL || 'https://system-clow.pvcorretor01.com.br';
  Promise.allSettled([
    sendWelcomeEmail(email, md.full_name || email, tempPassword, md.plan || 'starter'),
    md.phone ? sendWelcomeWhatsApp(md.phone, md.full_name || email, tempPassword, md.plan || 'starter', loginUrl) : Promise.resolve({ ok: false, error: 'no_phone' }),
  ]).then(results => {
    const [emailR, waR] = results;
    console.log('[stripe] welcome:', {
      email: emailR.status === 'fulfilled' ? (emailR.value as any)?.ok : 'rejected',
      whatsapp: waR.status === 'fulfilled' ? (waR.value as any)?.ok : 'rejected',
    });
  });
}

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
    '.card{position:relative;max-width:540px;background:#0F0F24;border:1px solid rgba(155,89,252,.3);border-radius:22px;padding:46px 38px;text-align:center;box-shadow:0 30px 90px rgba(0,0,0,.55)}',
    '.logo img{height:38px;margin-bottom:22px;filter:drop-shadow(0 4px 12px rgba(155,89,252,.35))}',
    '.check{width:72px;height:72px;margin:0 auto 22px;border-radius:50%;background:linear-gradient(135deg,#22C55E,#16A34A);display:flex;align-items:center;justify-content:center;box-shadow:0 10px 30px rgba(34,197,94,.35)}',
    '.check svg{width:38px;height:38px;color:#fff;stroke-width:3}',
    'h1{background:linear-gradient(135deg,#9B59FC,#4A9EFF);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;font-size:28px;margin:0 0 12px;letter-spacing:-.02em;font-weight:800}',
    'p{color:#B8B8D0;line-height:1.6;font-size:14.5px;margin:10px 0}',
    '.channels{display:flex;gap:12px;margin:22px 0}',
    '.ch{flex:1;background:rgba(155,89,252,.08);border:1px solid rgba(155,89,252,.22);border-radius:12px;padding:14px 10px;display:flex;flex-direction:column;align-items:center;gap:6px;font-size:12px;color:#E8E8F0}',
    '.ch svg{width:26px;height:26px;color:#9B59FC}',
    '.info{background:rgba(155,89,252,.08);border:1px solid rgba(155,89,252,.2);border-radius:12px;padding:18px;margin:24px 0;text-align:left;font-size:13px;color:#B8B8D0;line-height:1.75}',
    '.info strong{color:#E8E8F0}',
    '.btn{display:inline-block;margin-top:14px;padding:14px 30px;background:linear-gradient(135deg,#9B59FC,#4A9EFF);color:#fff;text-decoration:none;border-radius:12px;font-weight:700;font-size:14.5px;box-shadow:0 8px 24px rgba(155,89,252,.35);transition:transform .15s ease}',
    '.btn:hover{transform:translateY(-2px)}',
    '.note{font-size:11.5px;color:#6E6E8C;margin-top:16px}',
    '</style></head><body>',
    '<div class="card">',
    '<div class="logo"><img src="/assets/logo-official-full-white.png" alt="System Clow"></div>',
    '<div class="check"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div>',
    '<h1>Pagamento confirmado!</h1>',
    '<p>Sua conta foi criada. Enviamos sua <strong>senha temporária</strong> por:</p>',
    '<div class="channels">',
    '<div class="ch"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><polyline points="3 7 12 13 21 7"/></svg><span>Email</span></div>',
    '<div class="ch"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg><span>WhatsApp</span></div>',
    '</div>',
    '<div class="info">',
    '<strong>Próximos passos</strong><br>',
    '1. Pegue a senha temporária no email (ou WhatsApp)<br>',
    '2. Faça login — troca de senha acontece automática no 1º acesso<br>',
    '3. Complete o onboarding (3 min): conecta WhatsApp + instala automações<br>',
    '4. Sua IA começa a atender 24/7',
    '</div>',
    '<a href="/" class="btn">Ir pro login →</a>',
    '<div class="note">Não recebeu? Verifica o spam ou <a href="mailto:contato@pvcorretor01.com.br" style="color:#9B59FC">contato@pvcorretor01.com.br</a></div>',
    '</div></body></html>',
  ].join('');
  return c.html(html);
});



// ═══ ONDA 53: WhatsApp Add-on (Z-API extras a R$ 100/mes recorrente) ═══

import { getTenant as _getTenantOnda53 } from '../tenancy/tenantStore.js';
import { TIERS as _TIERS_O53, type TierName as _TierName_O53 } from '../tenancy/tiers.js';

// GET /api/billing/whatsapp-addon/status?tenantId=...
app.get('/api/billing/whatsapp-addon/status', async (c) => {
  const tenantId = c.req.query('tenantId') || c.req.header('x-clow-tenant-id');
  if (!tenantId) return c.json({ error: 'missing_tenant' }, 400);
  const t = _getTenantOnda53(tenantId);
  if (!t) return c.json({ error: 'tenant_not_found' }, 404);
  const tierCfg = _TIERS_O53[t.tier as _TierName_O53];
  if (!tierCfg) return c.json({ error: 'tier_not_found' }, 404);

  let currentExtraCount = 0;
  if (t.stripe_subscription_id) {
    try {
      const sk = await stripe();
      const sub = await sk.subscriptions.retrieve(t.stripe_subscription_id);
      const addonItem = sub.items.data.find((it: any) => it.price.id === whatsappAddonPriceId());
      if (addonItem) currentExtraCount = addonItem.quantity || 0;
    } catch (err: any) {
      console.warn('[wa-addon status] subscription fetch failed:', err.message);
    }
  }

  return c.json({
    ok: true,
    tier: t.tier,
    included: tierCfg.included_whatsapp_numbers,
    max: tierCfg.max_whatsapp_numbers,
    currentExtraCount,
    totalConnected: tierCfg.included_whatsapp_numbers + currentExtraCount,
    available: Math.max(0, tierCfg.max_whatsapp_numbers - tierCfg.included_whatsapp_numbers - currentExtraCount),
    pricePerExtraBrl: 100,
  });
});

// POST /api/billing/whatsapp-addon/add  body: { tenantId }
app.post('/api/billing/whatsapp-addon/add', async (c) => {
  const body = await c.req.json().catch(() => ({})) as any;
  const tenantId = body.tenantId || c.req.header('x-clow-tenant-id');
  if (!tenantId) return c.json({ error: 'missing_tenant' }, 400);
  const t = _getTenantOnda53(tenantId);
  if (!t) return c.json({ error: 'tenant_not_found' }, 404);
  if (!t.stripe_subscription_id) return c.json({ error: 'no_subscription', message: 'Cliente sem assinatura ativa.' }, 400);

  const tierCfg = _TIERS_O53[t.tier as _TierName_O53];
  if (!tierCfg) return c.json({ error: 'tier_not_found' }, 404);

  const addonPid = whatsappAddonPriceId();
  if (!addonPid) return c.json({ error: 'addon_not_configured' }, 500);

  try {
    const sk = await stripe();
    const sub = await sk.subscriptions.retrieve(t.stripe_subscription_id);
    const addonItem = sub.items.data.find((it: any) => it.price.id === addonPid);
    const currentExtra = addonItem?.quantity || 0;
    const totalAfter = tierCfg.included_whatsapp_numbers + currentExtra + 1;

    if (totalAfter > tierCfg.max_whatsapp_numbers) {
      return c.json({
        error: 'limit_reached',
        message: 'Plano ' + t.tier + ' permite no maximo ' + tierCfg.max_whatsapp_numbers + ' numeros.',
      }, 403);
    }

    if (addonItem) {
      await sk.subscriptionItems.update(addonItem.id, {
        quantity: currentExtra + 1,
        proration_behavior: 'create_prorations',
      });
    } else {
      await sk.subscriptionItems.create({
        subscription: t.stripe_subscription_id,
        price: addonPid,
        quantity: 1,
        proration_behavior: 'create_prorations',
      });
    }

    return c.json({
      ok: true,
      newExtraCount: currentExtra + 1,
      totalConnected: tierCfg.included_whatsapp_numbers + currentExtra + 1,
      message: '+1 numero WhatsApp adicionado. Cobranca recorrente R$ 100/mes (proporcional ate fim do ciclo atual).',
    });
  } catch (err: any) {
    console.error('[wa-addon add] error:', err.message);
    return c.json({ error: 'addon_add_failed', message: err.message }, 502);
  }
});

// POST /api/billing/whatsapp-addon/remove  body: { tenantId }
app.post('/api/billing/whatsapp-addon/remove', async (c) => {
  const body = await c.req.json().catch(() => ({})) as any;
  const tenantId = body.tenantId || c.req.header('x-clow-tenant-id');
  if (!tenantId) return c.json({ error: 'missing_tenant' }, 400);
  const t = _getTenantOnda53(tenantId);
  if (!t || !t.stripe_subscription_id) return c.json({ error: 'no_subscription' }, 400);

  const addonPid = whatsappAddonPriceId();
  if (!addonPid) return c.json({ error: 'addon_not_configured' }, 500);

  try {
    const sk = await stripe();
    const sub = await sk.subscriptions.retrieve(t.stripe_subscription_id);
    const addonItem = sub.items.data.find((it: any) => it.price.id === addonPid);
    if (!addonItem || (addonItem.quantity || 0) <= 0) {
      return c.json({ error: 'no_addon', message: 'Cliente nao tem numeros adicionais.' }, 400);
    }
    const newQty = (addonItem.quantity || 0) - 1;
    if (newQty <= 0) {
      await sk.subscriptionItems.del(addonItem.id, { proration_behavior: 'create_prorations' });
    } else {
      await sk.subscriptionItems.update(addonItem.id, {
        quantity: newQty,
        proration_behavior: 'create_prorations',
      });
    }
    return c.json({ ok: true, newExtraCount: newQty });
  } catch (err: any) {
    console.error('[wa-addon remove] error:', err.message);
    return c.json({ error: 'addon_remove_failed', message: err.message }, 502);
  }
});

// POST /api/billing/portal — abre Customer Portal pra atualizar cartao
app.post('/api/billing/portal', async (c) => {
  const body = await c.req.json().catch(() => ({})) as any;
  const tenantId = body.tenantId || c.req.header('x-clow-tenant-id');
  if (!tenantId) return c.json({ error: 'missing_tenant' }, 400);
  const t = _getTenantOnda53(tenantId);
  if (!t || !t.stripe_customer_id) return c.json({ error: 'no_customer' }, 400);
  try {
    const sk = await stripe();
    const portal = await sk.billingPortal.sessions.create({
      customer: t.stripe_customer_id,
      return_url: publicBase() + '/crm/',
    });
    return c.json({ ok: true, url: portal.url });
  } catch (err: any) {
    return c.json({ error: 'portal_failed', message: err.message }, 502);
  }
});




// ═══ ONDA 53h: Stripe Checkout pra adicionar Z-API ═══════════════════

// POST /api/billing/whatsapp-addon/checkout
// Cria Checkout Session em modo subscription pra cobrar +R$ 100/mes.
// Apos pagamento, webhook adiciona item a subscription principal.
app.post('/api/billing/whatsapp-addon/checkout', async (c) => {
  const body = await c.req.json().catch(() => ({})) as any;
  const tenantId = body.tenantId || c.req.header('x-clow-tenant-id');
  if (!tenantId) return c.json({ error: 'missing_tenant' }, 400);
  const t = _getTenantOnda53(tenantId);
  if (!t) return c.json({ error: 'tenant_not_found' }, 404);

  const tierCfg = _TIERS_O53[t.tier as _TierName_O53];
  if (!tierCfg) return c.json({ error: 'tier_not_found' }, 404);

  const addonPid = whatsappAddonPriceId();
  if (!addonPid) return c.json({ error: 'addon_not_configured' }, 500);

  // Checar limite ANTES de criar checkout
  const channelsCount = body.currentTotal || 0;
  if (channelsCount + 1 > tierCfg.max_whatsapp_numbers) {
    return c.json({
      error: 'limit_reached',
      message: 'Plano ' + t.tier + ' permite no maximo ' + tierCfg.max_whatsapp_numbers + ' numeros.',
    }, 403);
  }

  try {
    const sk = await stripe();
    const sessionParams: any = {
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: addonPid, quantity: 1 }],
      locale: 'pt-BR',
      success_url: publicBase() + '/crm/?wa_addon_paid=1&session_id={CHECKOUT_SESSION_ID}',
      cancel_url: publicBase() + '/crm/?wa_addon_cancelled=1',
      metadata: {
        type: 'whatsapp_addon_zapi',
        tenant_id: t.id,
        tenant_email: t.email,
      },
      subscription_data: {
        metadata: {
          type: 'whatsapp_addon_zapi',
          tenant_id: t.id,
          parent_subscription_id: t.stripe_subscription_id || '',
        },
      },
    };
    // Reusar customer existente se ja tem (cartao salvo)
    if (t.stripe_customer_id) {
      sessionParams.customer = t.stripe_customer_id;
    } else if (t.email) {
      sessionParams.customer_email = t.email;
    }

    const session = await sk.checkout.sessions.create(sessionParams);
    return c.json({ ok: true, url: session.url, session_id: session.id });
  } catch (err: any) {
    console.error('[wa-addon checkout] error:', err.message);
    return c.json({ error: 'checkout_failed', message: err.message }, 502);
  }
});

// GET /api/billing/whatsapp-addon/checkout-status?session_id=cs_...
// Polling pra UI saber quando o cliente terminou de pagar.
app.get('/api/billing/whatsapp-addon/checkout-status', async (c) => {
  const sessionId = c.req.query('session_id');
  if (!sessionId || !sessionId.startsWith('cs_')) {
    return c.json({ error: 'invalid_session' }, 400);
  }
  try {
    const sk = await stripe();
    const session = await sk.checkout.sessions.retrieve(sessionId);
    return c.json({
      ok: true,
      paid: session.payment_status === 'paid',
      payment_status: session.payment_status,
      status: session.status,
    });
  } catch (err: any) {
    return c.json({ error: 'fetch_failed', message: err.message }, 502);
  }
});


export default app;
