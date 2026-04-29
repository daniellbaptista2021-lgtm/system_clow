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
import { logger } from '../utils/logger.js';

const app = new Hono();

/**
 * Resolve tenantId pra endpoints de billing autenticados (whatsapp-addon,
 * portal). Antes aceitava `body.tenantId || header('x-clow-tenant-id')`
 * sem validar — qualquer user logado podia adicionar/remover WA-addon ou
 * abrir Customer Portal de outro tenant. Agora:
 *   - se contexto tem tenantId (user_session ou api_key) → usa ele,
 *     ignorando body/header (impossível operar fora do próprio tenant).
 *   - se for admin (admin_session ou clow_sonnet) → aceita body.tenantId
 *     ou header pra impersonação intencional.
 *   - senão → null (caller retorna 403).
 */
function resolveBillingTenant(c: any, body: any): string | null {
  const ctxTid = c.get?.('tenantId');
  if (typeof ctxTid === 'string' && ctxTid.trim()) return ctxTid;
  const authMode = c.get?.('authMode');
  if (authMode === 'admin_session' || authMode === 'clow_sonnet') {
    const t = body?.tenantId || c.req.header('x-clow-tenant-id');
    if (typeof t === 'string' && t.trim()) return t;
  }
  return null;
}

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

// Piloto Empresarial — antes era endpoint dedicado, agora e cupom no Stripe:
// promotion_code "CORRETOR2026" zera R$1297 -> R$120/mes (forever, so empresarial).
// Cliente do grupo de corretores entra em /pricing, escolhe Empresarial, e
// digita o codigo no campo "Adicionar cupom" do Stripe Checkout.

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

// ─── GET /api/billing/config — publishable key pro frontend ──────────
// Necessario pro Stripe.js no client. Publishable key e PUBLICO por
// design (pk_live_*), seguro expor no browser.
app.get('/api/billing/config', (c) => {
  return c.json({
    publishable_key: process.env.STRIPE_PUBLISHABLE_KEY || '',
    embedded_supported: true,
  });
});

// ─── POST /api/billing/checkout — cria Stripe Checkout session ────────
// Suporta ui_mode='embedded' (default 'hosted'). Embedded retorna
// client_secret pra Stripe.js renderizar inline; hosted retorna URL.
// User pediu: card embutido na propria tela, tipo ChatGPT/Claude.
app.post('/api/billing/checkout', async (c) => {
  const body = await c.req.json().catch(() => ({})) as any;
  const { plan, email, full_name, cpf, phone, ui_mode } = body;
  if (!plan || !priceIds()[plan]) {
    return c.json({ error: 'invalid_plan', message: 'Plano deve ser starter, profissional ou empresarial.' }, 400);
  }
  if (!email || !full_name || !cpf || !phone) {
    return c.json({ error: 'missing_fields', message: 'Preencha email, nome, CPF e telefone.' }, 400);
  }
  if (findTenantByEmail(String(email).toLowerCase())) {
    return c.json({ error: 'email_in_use' }, 409);
  }

  const isEmbedded = ui_mode === 'embedded';

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
      // Habilita campo "Adicionar codigo promocional" no Checkout. Cupons sao
      // geridos via Dashboard/API (ex.: CORRETOR2026 zera R$1297 -> R$120/mes
      // forever pra grupo piloto de corretores).
      allow_promotion_codes: true,
      metadata: {
        plan, email, full_name, cpf: cpfDigits,
        phone: phoneDigits,
      },
      subscription_data: {
        metadata: { plan, email, full_name, cpf: cpfDigits, phone: phoneDigits },
      },
    };
    if (isEmbedded) {
      sessionParams.ui_mode = 'embedded';
      sessionParams.return_url = `${publicBase()}/signup/success?session_id={CHECKOUT_SESSION_ID}`;
    } else {
      sessionParams.success_url = `${publicBase()}/signup/success?session_id={CHECKOUT_SESSION_ID}`;
      sessionParams.cancel_url = `${publicBase()}/pricing`;
    }

    const session = await sk.checkout.sessions.create(sessionParams);
    return c.json(isEmbedded
      ? { ok: true, client_secret: session.client_secret, session_id: session.id, ui_mode: 'embedded' }
      : { ok: true, url: session.url, session_id: session.id, ui_mode: 'hosted' });
  } catch (err: any) {
    logger.error('[stripe checkout] error:', err.message);
    // Se boleto/pix derem problema na conta, tenta fallback só com card
    if (/payment_method_type|not_allowed|not.*enabled/i.test(err.message || '')) {
      try {
        const sk = await stripe();
        const cpfDigits = String(cpf).replace(/\D/g, '');
        const phoneDigits = String(phone).replace(/\D/g, '');
        const fallbackParams: any = {
          mode: 'subscription',
          payment_method_types: ['card'],
          line_items: [{ price: priceIds()[plan], quantity: 1 }],
          customer_email: email,
          locale: 'pt-BR',
          billing_address_collection: 'required',
          metadata: { plan, email, full_name, cpf: cpfDigits, phone: phoneDigits },
          subscription_data: { metadata: { plan, email, full_name, cpf: cpfDigits, phone: phoneDigits } },
        };
        if (isEmbedded) {
          fallbackParams.ui_mode = 'embedded';
          fallbackParams.return_url = `${publicBase()}/signup/success?session_id={CHECKOUT_SESSION_ID}`;
        } else {
          fallbackParams.success_url = `${publicBase()}/signup/success?session_id={CHECKOUT_SESSION_ID}`;
          fallbackParams.cancel_url = `${publicBase()}/pricing`;
        }
        const session = await sk.checkout.sessions.create(fallbackParams);
        logger.warn('[stripe checkout] fallback card-only (boleto/pix não habilitado na conta)');
        return c.json(isEmbedded
          ? { ok: true, client_secret: session.client_secret, session_id: session.id, ui_mode: 'embedded', fallback: 'card_only' }
          : { ok: true, url: session.url, session_id: session.id, ui_mode: 'hosted', fallback: 'card_only' });
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
  const { incWebhookReceived } = await import('../server/metrics.js');
  incWebhookReceived('stripe');

  const sig = c.req.header('stripe-signature');
  const wh = process.env.STRIPE_WEBHOOK_SECRET;
  if (!sig || !wh) return c.text('webhook_not_configured', 503);

  let event: any;
  try {
    const sk = await stripe();
    const raw = await c.req.text();
    event = sk.webhooks.constructEvent(raw, sig, wh);
  } catch (err: any) {
    logger.error('[stripe webhook] signature error:', err.message);
    return c.text('invalid_signature', 400);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        // Para boleto/pix: session.status=complete mas payment_status=unpaid até pagar
        // Só provisiona quando payment_status === 'paid'
        if (session.payment_status !== 'paid') {
          logger.info(`[stripe] session completed mas payment_status=${session.payment_status} — aguardando confirmação`);
          break;
        }
        await provisionFromSession(session);
        break;
      }
      case 'checkout.session.async_payment_succeeded': {
        // Pix/boleto confirmado (pagamento assíncrono)
        const session = event.data.object;
        logger.info(`[stripe] async payment succeeded — provisionando ${session.customer_email}`);
        await provisionFromSession(session);
        break;
      }
      case 'checkout.session.async_payment_failed': {
        const session = event.data.object;
        logger.warn(`[stripe] async payment FAILED para ${session.customer_email} (boleto/pix expirou)`);
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
    logger.error('[stripe webhook] processing error:', err.message);
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
    logger.info(`[stripe] upgraded ${email} to ${md.plan}`);
    return;
  }

  const tempPassword = randomBytes(9).toString('base64url'); // 12 chars, legível
  const password_hash = await bcrypt.hash(tempPassword, 10);
  const { tenant } = createTenant({ email, name: md.full_name || email, tier: (md.plan as any) || 'starter' });
  const isPilot = md.is_pilot === 'true' || md.is_pilot === true;
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
    ...(isPilot ? { is_pilot: true, pilot_started_at: new Date().toISOString() } : {}),
  } as any);
  logger.info(`[stripe] created tenant ${email} (${md.plan}${isPilot ? ' PILOT' : ''}); disparando email + whatsapp`);

  // Dispara email + WhatsApp em paralelo; nenhum é bloqueante
  const loginUrl = process.env.CLOW_PUBLIC_BASE_URL || 'https://system-clow.pvcorretor01.com.br';
  Promise.allSettled([
    sendWelcomeEmail(email, md.full_name || email, tempPassword, md.plan || 'starter'),
    md.phone ? sendWelcomeWhatsApp(md.phone, md.full_name || email, tempPassword, md.plan || 'starter', loginUrl) : Promise.resolve({ ok: false, error: 'no_phone' }),
  ]).then(results => {
    const [emailR, waR] = results;
    logger.info('[stripe] welcome:', {
      email: emailR.status === 'fulfilled' ? (emailR.value as any)?.ok : 'rejected',
      whatsapp: waR.status === 'fulfilled' ? (waR.value as any)?.ok : 'rejected',
    });
  });
}

// ─── GET /signup/success — landing após pagamento ───────────────────────
// Mostra email + senha temp INLINE na tela. Email/WhatsApp viram backup,
// nao caminho critico — se mailer cair ou cair no spam, cliente AINDA tem
// as credenciais aqui na hora. Lookup: session_id → Stripe → tenant.email
// → tenant.temp_password_for_email (limpo em /auth/login com troca forçada).
app.get('/signup/success', async (c) => {
  const sessionId = c.req.query('session_id') || '';
  let creds: { email: string; tempPassword: string; tier: string } | null = null;

  if (sessionId) {
    try {
      const sk = await stripe();
      const session = await sk.checkout.sessions.retrieve(sessionId);
      const md = session.metadata || {};
      const email = String(md.email || session.customer_email || '').toLowerCase();
      if (email) {
        const tenant = findTenantByEmail(email);
        if (tenant && (tenant as any).temp_password_for_email) {
          creds = {
            email,
            tempPassword: String((tenant as any).temp_password_for_email),
            tier: tenant.tier || md.plan || 'starter',
          };
        }
      }
    } catch (err: any) {
      logger.warn('[stripe success] could not load creds:', err?.message);
    }
  }

  const credsBlock = creds ? [
    '<div class="creds">',
    '<div class="creds-header">🔑 Suas credenciais de acesso</div>',
    '<div class="creds-row"><span class="creds-label">Email</span><code id="credsEmail">' + escapeHtml(creds.email) + '</code><button class="copy-btn" onclick="copyText(\'credsEmail\',this)" type="button">Copiar</button></div>',
    '<div class="creds-row"><span class="creds-label">Senha temp</span><code id="credsPass">' + escapeHtml(creds.tempPassword) + '</code><button class="copy-btn" onclick="copyText(\'credsPass\',this)" type="button">Copiar</button></div>',
    '<div class="creds-warn">⚠️ Anote ou copie agora. Troque a senha no 1º login em <strong>Configurações → Segurança</strong>.</div>',
    '</div>',
  ].join('') : [
    '<div class="info">',
    '<strong>Sua conta foi criada!</strong><br>',
    'Enviamos sua senha temporária por <strong>email</strong> e <strong>WhatsApp</strong>. Verifica também o spam.',
    '</div>',
  ].join('');

  const html = [
    '<!DOCTYPE html><html lang="pt-BR"><head>',
    '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>System Clow — Bem-vindo!</title>',
    '<link rel="icon" href="/assets/favicon-gold.png">',
    '<style>',
    'body{margin:0;background:#08081a;color:#E8E8F0;font-family:-apple-system,BlinkMacSystemFont,Inter,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:30px}',
    'body::before{content:"";position:fixed;inset:0;background:radial-gradient(50% 50% at 50% 30%,rgba(155,89,252,.12),transparent 65%);pointer-events:none}',
    '.card{position:relative;max-width:560px;background:#0F0F24;border:1px solid rgba(155,89,252,.3);border-radius:22px;padding:46px 38px;text-align:center;box-shadow:0 30px 90px rgba(0,0,0,.55)}',
    '.logo img{height:38px;margin-bottom:22px;filter:drop-shadow(0 4px 12px rgba(155,89,252,.35))}',
    '.check{width:72px;height:72px;margin:0 auto 22px;border-radius:50%;background:linear-gradient(135deg,#22C55E,#16A34A);display:flex;align-items:center;justify-content:center;box-shadow:0 10px 30px rgba(34,197,94,.35)}',
    '.check svg{width:38px;height:38px;color:#fff;stroke-width:3}',
    'h1{background:linear-gradient(135deg,#9B59FC,#4A9EFF);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;font-size:28px;margin:0 0 12px;letter-spacing:-.02em;font-weight:800}',
    'p{color:#B8B8D0;line-height:1.6;font-size:14.5px;margin:10px 0}',
    '.creds{background:linear-gradient(135deg,rgba(155,89,252,.12),rgba(74,158,255,.08));border:1px solid rgba(155,89,252,.32);border-radius:14px;padding:22px 22px 18px;margin:24px 0;text-align:left}',
    '.creds-header{font-size:13px;color:#9B59FC;font-weight:700;letter-spacing:.4px;text-transform:uppercase;margin-bottom:14px}',
    '.creds-row{display:flex;align-items:center;gap:10px;background:#14142A;border:1px solid rgba(155,89,252,.18);border-radius:10px;padding:12px 14px;margin-bottom:10px}',
    '.creds-label{font-size:11px;color:#9898B8;text-transform:uppercase;letter-spacing:1px;flex-shrink:0;width:78px}',
    '.creds-row code{flex:1;background:transparent;color:#E8E8F0;font-family:"SF Mono",Consolas,Monaco,monospace;font-size:14.5px;font-weight:600;letter-spacing:.5px;word-break:break-all}',
    '.copy-btn{background:rgba(155,89,252,.2);border:1px solid rgba(155,89,252,.4);color:#E8E8F0;padding:6px 12px;border-radius:8px;font-size:11px;font-weight:600;cursor:pointer;flex-shrink:0;transition:all .15s ease;font-family:inherit}',
    '.copy-btn:hover{background:rgba(155,89,252,.32);transform:translateY(-1px)}',
    '.copy-btn.ok{background:rgba(34,197,94,.25);border-color:rgba(34,197,94,.5);color:#86EFAC}',
    '.creds-warn{color:#F59E0B;font-size:12px;line-height:1.5;margin-top:12px}',
    '.creds-warn strong{color:#FCD34D}',
    '.info{background:rgba(155,89,252,.08);border:1px solid rgba(155,89,252,.2);border-radius:12px;padding:18px;margin:24px 0;text-align:left;font-size:13.5px;color:#B8B8D0;line-height:1.75}',
    '.info strong{color:#E8E8F0}',
    '.steps{text-align:left;color:#B8B8D0;font-size:13.5px;line-height:1.85;margin:20px 0 8px;padding:18px 18px 14px;background:rgba(255,255,255,.025);border-radius:12px;border:1px solid rgba(255,255,255,.06)}',
    '.steps strong{color:#E8E8F0;display:block;margin-bottom:8px;font-size:13px;text-transform:uppercase;letter-spacing:.5px}',
    '.btn{display:inline-block;margin-top:14px;padding:14px 30px;background:linear-gradient(135deg,#9B59FC,#4A9EFF);color:#fff;text-decoration:none;border-radius:12px;font-weight:700;font-size:14.5px;box-shadow:0 8px 24px rgba(155,89,252,.35);transition:transform .15s ease}',
    '.btn:hover{transform:translateY(-2px)}',
    '.note{font-size:11.5px;color:#6E6E8C;margin-top:16px}',
    '</style></head><body>',
    '<div class="card">',
    '<div class="logo"><img src="/assets/logo-official-full-white.png" alt="System Clow"></div>',
    '<div class="check"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div>',
    '<h1>Pagamento confirmado!</h1>',
    '<p>Sua conta foi criada. ' + (creds ? 'Aqui estão suas credenciais:' : 'Confira seu email e WhatsApp.') + '</p>',
    credsBlock,
    '<div class="steps">',
    '<strong>🚀 Próximos passos</strong>',
    '1. Faz login com as credenciais acima<br>',
    '2. Troca a senha em Configurações → Segurança<br>',
    '3. Conecta seu WhatsApp (Meta API ou Z-API) em CRM → Canais<br>',
    '4. Sua IA começa a atender 24/7 ✨',
    '</div>',
    '<a href="/" class="btn">Entrar agora →</a>',
    '<div class="note">Suporte: <a href="mailto:contato@pvcorretor01.com.br" style="color:#9B59FC">contato@pvcorretor01.com.br</a></div>',
    '</div>',
    '<script>',
    'function copyText(id,btn){var el=document.getElementById(id);if(!el)return;var t=el.textContent;if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t).then(function(){btn.textContent="Copiado!";btn.classList.add("ok");setTimeout(function(){btn.textContent="Copiar";btn.classList.remove("ok")},1500)}).catch(function(){fallback(t,btn)})}else{fallback(t,btn)}}',
    'function fallback(t,btn){var ta=document.createElement("textarea");ta.value=t;document.body.appendChild(ta);ta.select();try{document.execCommand("copy");btn.textContent="Copiado!";btn.classList.add("ok");setTimeout(function(){btn.textContent="Copiar";btn.classList.remove("ok")},1500)}catch(e){}document.body.removeChild(ta)}',
    '</script>',
    '</body></html>',
  ].join('');
  return c.html(html);
});

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}



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
      logger.warn('[wa-addon status] subscription fetch failed:', err.message);
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
  const tenantId = resolveBillingTenant(c, body);
  if (!tenantId) return c.json({ error: 'forbidden', message: 'Você só pode operar billing do seu próprio tenant.' }, 403);
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
    logger.error('[wa-addon add] error:', err.message);
    return c.json({ error: 'addon_add_failed', message: err.message }, 502);
  }
});

// POST /api/billing/whatsapp-addon/remove  body: { tenantId }
app.post('/api/billing/whatsapp-addon/remove', async (c) => {
  const body = await c.req.json().catch(() => ({})) as any;
  const tenantId = resolveBillingTenant(c, body);
  if (!tenantId) return c.json({ error: 'forbidden', message: 'Você só pode operar billing do seu próprio tenant.' }, 403);
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
    logger.error('[wa-addon remove] error:', err.message);
    return c.json({ error: 'addon_remove_failed', message: err.message }, 502);
  }
});

// POST /api/billing/portal — abre Customer Portal pra atualizar cartao
app.post('/api/billing/portal', async (c) => {
  const body = await c.req.json().catch(() => ({})) as any;
  const tenantId = resolveBillingTenant(c, body);
  if (!tenantId) return c.json({ error: 'forbidden', message: 'Você só pode operar billing do seu próprio tenant.' }, 403);
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
  const tenantId = resolveBillingTenant(c, body);
  if (!tenantId) return c.json({ error: 'forbidden', message: 'Você só pode operar billing do seu próprio tenant.' }, 403);
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
    logger.error('[wa-addon checkout] error:', err.message);
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
