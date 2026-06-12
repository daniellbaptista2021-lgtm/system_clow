/**
 * authRoutes.ts — Multi-user signup + login + session management.
 *
 * Architecture (transition from admin-only to SaaS):
 *   - Each tenant has ONE owner user (email + password). Multi-user per
 *     tenant comes via crm_agents (already implemented).
 *   - Signup creates tenant + owner user atomically.
 *   - Login validates email+password against tenant.password_hash, returns
 *     a session token signed with HMAC (same secret as admin sessions).
 *   - Token contains: tenantId, userId, email, role, exp.
 *   - tenantAuth middleware accepts this token (in addition to admin token
 *     and clow_live_* api keys).
 *
 * Endpoints:
 *   POST /auth/signup    — create tenant + user (or via Stripe webhook)
 *   POST /auth/login     — email + password → token
 *   GET  /auth/me        — current user info from token
 *   POST /auth/logout    — client-side only (clears localStorage)
 *   POST /auth/change-password
 */

import { Hono } from 'hono';
import bcrypt from 'bcryptjs';
import { createHmac, timingSafeEqual, randomUUID } from 'crypto';
import {
  createTenant, findTenantByEmail, findTenantByAnyLogin, touchAdditionalLogin,
  getTenant, updateTenant, listTenants,
  type Tenant,
} from '../tenancy/tenantStore.js';
import { createAgent, listAgents } from '../crm/store/agentsStore.js';
import { seedDefaultRoles, listRoles, assignRoleToAgent } from '../crm/security.js';
import { revokeToken, isTokenRevoked } from './tokenRevocation.js';
import { logger } from '../utils/logger.js';

const app = new Hono();

// ─── Token signing (HMAC, JWT-like) ─────────────────────────────────────
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function getSecret(): string {
  return process.env.CLOW_USER_SESSION_SECRET
    || process.env.CLOW_ADMIN_SESSION_SECRET
    || process.env.JWT_SECRET
    || '';
}

function b64u(s: string): string { return Buffer.from(s, 'utf-8').toString('base64url'); }
function b64uDec(s: string): string { return Buffer.from(s, 'base64url').toString('utf-8'); }

export interface UserSessionPayload {
  type: 'user_session';
  tid: string; // tenant id
  uid: string; // user id (= tenant id since 1:1 owner)
  email: string;
  role: 'owner' | 'admin' | 'agent';
  iat: number;
  exp: number;
}

export function signUserToken(payload: Omit<UserSessionPayload, 'type' | 'iat' | 'exp'>): string {
  const secret = getSecret();
  if (!secret) throw new Error('session_secret_not_configured');
  const full: UserSessionPayload = {
    type: 'user_session',
    ...payload,
    iat: Date.now(),
    exp: Date.now() + SESSION_TTL_MS,
  };
  const body = b64u(JSON.stringify(full));
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `usr.${body}.${sig}`;
}

export function verifyUserToken(token: string | undefined): UserSessionPayload | null {
  if (!token || !token.startsWith('usr.')) return null;
  const parts = token.slice(4).split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const secret = getSecret();
  if (!secret) return null;
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(expected, 'utf-8');
  const b = Buffer.from(sig, 'utf-8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload: UserSessionPayload;
  try { payload = JSON.parse(b64uDec(body)) as UserSessionPayload; } catch { return null; }
  if (payload.type !== 'user_session') return null;
  if (payload.exp < Date.now()) return null;
  // Token revogado (logout / forced revoke)
  if (isTokenRevoked(token)) return null;
  return payload;
}

// ─── RBAC bootstrap (idempotent) ────────────────────────────────────────
/**
 * Garante que o tenant tem (a) roles built-in seedadas, (b) um agent owner
 * em crm_agents com active=1, role='owner', (c) RBAC role 'owner'
 * (admin.full) atribuído ao agent.
 *
 * Idempotente: pode chamar múltiplas vezes sem efeito colateral. Roda no
 * signup (path principal) e lazy no login (backfill pra tenants criados
 * antes desse fix).
 *
 * NÃO modifica registros existentes — só adiciona o que falta. Cliente que
 * tem RBAC granular configurado manualmente não tem nada sobrescrito.
 */
export function bootstrapTenantRBAC(tenantId: string, name: string, email: string, phone?: string): void {
  // 1) Seed roles built-in (no-op se já tem)
  seedDefaultRoles(tenantId);

  // 2) Garante agent owner
  const agents = listAgents(tenantId);
  let owner = agents.find((a) => a.email === email.toLowerCase());
  if (!owner) {
    owner = createAgent(tenantId, {
      name, email: email.toLowerCase(), phone, role: 'owner' as any,
    });
  }

  // 3) Atribui RBAC owner (admin.full)
  const ownerRole = listRoles(tenantId).find((r) => r.name === 'owner' && r.isAdmin);
  if (ownerRole) {
    assignRoleToAgent(tenantId, owner.id, ownerRole.id);
  }
}

// ─── Validation helpers ─────────────────────────────────────────────────
function isValidEmail(s: string): boolean { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s); }
function normalizePhone(s: string): string { return (s || '').replace(/\D/g, ''); }
function isValidPhoneBR(s: string): boolean {
  const d = normalizePhone(s);
  return d.length >= 10 && d.length <= 13;
}
function isValidCPF(cpf: string): boolean {
  const c = (cpf || '').replace(/\D/g, '');
  if (c.length !== 11 || /^(\d)\1{10}$/.test(c)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += parseInt(c[i], 10) * (10 - i);
  let d1 = 11 - (sum % 11); if (d1 >= 10) d1 = 0;
  if (d1 !== parseInt(c[9], 10)) return false;
  sum = 0;
  for (let i = 0; i < 10; i++) sum += parseInt(c[i], 10) * (11 - i);
  let d2 = 11 - (sum % 11); if (d2 >= 10) d2 = 0;
  return d2 === parseInt(c[10], 10);
}

// ─── Signup ─────────────────────────────────────────────────────────────
app.post('/signup', async (c) => {
  // Rate-limit por IP — protege signup de bot/abuse antes de existir tenant.
  // Politica: 5 signups/min/IP, 30/h/IP. Cluster-safe via clusterStore.
  const ip = c.req.header('x-forwarded-for')?.split(',')[0].trim()
    || c.req.header('x-real-ip')
    || 'unknown';
  try {
    const { rateLimiter } = await import('../server/rateLimiter.js');
    const rl = await rateLimiter.checkSignup(ip);
    if (!rl.allowed) {
      logger.warn(`[auth/signup] rate_limit ip=${ip}`);
      return c.json({ ok: false, error: 'rate_limit', message: 'Muitas tentativas, aguarde alguns minutos.', retryAfterMs: rl.retryAfterMs }, 429);
    }
  } catch (err: any) {
    logger.warn('[auth/signup] rate-limit check falhou (allow):', err?.message);
  }

  const body = await c.req.json().catch(() => ({})) as any;
  const {
    email, password, full_name, cpf, birth_date, phone, address,
    plan_tier, stripe_customer_id, stripe_subscription_id,
  } = body;

  // Validations
  if (!email || !isValidEmail(email)) return c.json({ error: 'invalid_email' }, 400);
  if (!password || password.length < 8) return c.json({ error: 'password_too_short', message: 'Senha precisa de no mínimo 8 caracteres.' }, 400);
  if (!full_name || full_name.length < 3) return c.json({ error: 'invalid_name' }, 400);
  if (!cpf || !isValidCPF(cpf)) return c.json({ error: 'invalid_cpf' }, 400);
  if (!birth_date || !/^\d{4}-\d{2}-\d{2}$/.test(birth_date)) return c.json({ error: 'invalid_birth_date', message: 'Data no formato YYYY-MM-DD.' }, 400);
  if (!phone || !isValidPhoneBR(phone)) return c.json({ error: 'invalid_phone' }, 400);

  // Email already in use?
  if (findTenantByEmail(email.toLowerCase())) {
    return c.json({ error: 'email_in_use', message: 'Esse email já tem conta.' }, 409);
  }

  const password_hash = await bcrypt.hash(password, 10);
  // So aceita os 3 tiers publicos do /pricing. Tiers legacy (one/smart/business)
  // existem em tiers.ts pra back-compat de tenants antigos, mas signup novo cai
  // em starter por default.
  const validTiers = ['starter', 'profissional', 'empresarial'];
  const tier = validTiers.includes(plan_tier) ? plan_tier : 'starter';

  // Create tenant with all user fields embedded
  const { tenant } = createTenant({
    email: email.toLowerCase(),
    name: full_name,
    tier: tier as any,
    // Embed user/billing fields via updateTenant after create
  });
  // Email verification token — 32 hex chars, 7 dias TTL.
  const emailToken = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
  const emailTokenExp = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  // Embed extra fields
  updateTenant(tenant.id, {
    password_hash,
    full_name,
    cpf: cpf.replace(/\D/g, ''),
    birth_date,
    phone_e164: normalizePhone(phone),
    address: address || null,
    stripe_customer_id: stripe_customer_id || null,
    stripe_subscription_id: stripe_subscription_id || null,
    authorized_phones: [normalizePhone(phone)],
    email_verification_token: emailToken,
    email_verification_token_expires_at: emailTokenExp,
    // email_verified_at fica undefined ate o usuario clicar no link
  } as any);

  // Envia email de verificacao (best-effort — nao bloqueia signup se falhar)
  try {
    const { sendMail } = await import('../utils/mailer.js');
    const baseUrl = process.env.PUBLIC_BASE_URL || process.env.CLOW_PUBLIC_BASE_URL || 'https://system-clow.pvcorretor01.com.br';
    const verifyUrl = `${baseUrl}/auth/verify-email?token=${emailToken}`;
    await sendMail({
      to: email.toLowerCase(),
      subject: 'Confirme seu cadastro — System Clow',
      text:
        `Olá, ${full_name}!\n\n` +
        `Seu cadastro no System Clow foi recebido. Clique no link abaixo pra confirmar seu email:\n\n` +
        `${verifyUrl}\n\n` +
        `O link expira em 7 dias.\n\n` +
        `Se você não fez esse cadastro, pode ignorar essa mensagem.\n\n` +
        `— Equipe System Clow`,
      html:
        `<p>Olá, <strong>${full_name}</strong>!</p>` +
        `<p>Seu cadastro no System Clow foi recebido. Clique no link abaixo pra confirmar seu email:</p>` +
        `<p><a href="${verifyUrl}">${verifyUrl}</a></p>` +
        `<p>O link expira em 7 dias.</p>` +
        `<p>Se você não fez esse cadastro, pode ignorar essa mensagem.</p>` +
        `<p>— Equipe System Clow</p>`,
    });
  } catch (err: any) {
    logger.warn('[auth/signup] sendMail falhou (segue):', err?.message);
  }

  // Bootstrap RBAC + owner agent (idempotente — ver bootstrapTenantRBAC).
  // Falha aqui não bloqueia signup; loga e segue (cliente ainda consegue
  // logar e usar painel — RBAC backfill roda lazy no /login se faltar).
  try {
    bootstrapTenantRBAC(tenant.id, full_name, email.toLowerCase(), normalizePhone(phone));
  } catch (err) {
    logger.warn('[auth/signup] bootstrapTenantRBAC falhou (segue mesmo assim):', (err as Error).message);
  }

  const token = signUserToken({
    tid: tenant.id, uid: tenant.id, email: email.toLowerCase(), role: 'owner',
  });

  return c.json({
    ok: true,
    token,
    user: { id: tenant.id, email: email.toLowerCase(), name: full_name, tier, role: 'owner', email_verified: false },
    email_verification_required: true,
  }, 201);
});

// ─── /auth/verify-email ─────────────────────────────────────────────────
// Single-use: limpa token apos primeiro uso. Valida expiracao. Retorna
// HTML simples se acessado via browser (clicou no link do email).
app.get('/verify-email', async (c) => {
  const token = c.req.query('token');
  if (!token || token.length < 32) {
    return c.html('<h1>Link inválido</h1><p>O link de confirmação está malformado.</p>', 400);
  }
  const tenants = listTenants();
  const tenant = tenants.find((t) => (t as any).email_verification_token === token);
  if (!tenant) {
    return c.html('<h1>Link inválido ou expirado</h1><p>Esse link já foi usado ou está incorreto.</p>', 404);
  }
  const tnAny = tenant as any;
  const expIso = tnAny.email_verification_token_expires_at;
  if (expIso && new Date(expIso).getTime() < Date.now()) {
    return c.html('<h1>Link expirado</h1><p>Esse link expirou. Pede pra reenviar pelo painel.</p>', 410);
  }
  // Marca como verificado e limpa o token (single-use)
  updateTenant(tenant.id, {
    email_verified_at: new Date().toISOString(),
    email_verification_token: null as any,
    email_verification_token_expires_at: null as any,
  } as any);
  logger.info(`[auth/verify-email] tenant=${tenant.id} email confirmado`);
  const baseUrl = process.env.PUBLIC_BASE_URL || process.env.CLOW_PUBLIC_BASE_URL || '';
  return c.html(
    `<!doctype html><html><head><meta charset="utf-8"><title>Email confirmado</title>` +
    `<style>body{font-family:system-ui,sans-serif;max-width:560px;margin:80px auto;padding:0 20px;line-height:1.5}` +
    `.box{background:#f0fdf4;border:1px solid #86efac;padding:24px;border-radius:12px}` +
    `a.btn{display:inline-block;margin-top:16px;background:#2563eb;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px}</style></head>` +
    `<body><div class="box"><h1>✓ Email confirmado</h1><p>Pronto! Seu email foi verificado. Você já pode entrar no painel.</p>` +
    (baseUrl ? `<a class="btn" href="${baseUrl}/login.html">Entrar agora</a>` : '') +
    `</div></body></html>`,
    200,
  );
});

// ─── /auth/resend-verification ──────────────────────────────────────────
// Reenvio do email de verificacao. Idempotente — gera token novo a cada chamada.
// Rate-limited via mesma politica do signup (IP).
app.post('/resend-verification', async (c) => {
  const ip = c.req.header('x-forwarded-for')?.split(',')[0].trim() || c.req.header('x-real-ip') || 'unknown';
  try {
    const { rateLimiter } = await import('../server/rateLimiter.js');
    const rl = await rateLimiter.checkSignup(ip);
    if (!rl.allowed) return c.json({ ok: false, error: 'rate_limit' }, 429);
  } catch { /* allow on rate-limit error */ }

  const body = await c.req.json().catch(() => ({})) as any;
  const email = String(body.email || '').toLowerCase().trim();
  if (!email || !isValidEmail(email)) return c.json({ error: 'invalid_email' }, 400);
  const tenant = findTenantByEmail(email);
  // NAO revela se email existe ou nao (anti-enumeration)
  if (!tenant) return c.json({ ok: true, message: 'Se o email existe, mandamos o link de novo.' });
  if ((tenant as any).email_verified_at) {
    return c.json({ ok: true, message: 'Email já estava verificado.' });
  }
  const newToken = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
  const newExp = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  updateTenant(tenant.id, {
    email_verification_token: newToken,
    email_verification_token_expires_at: newExp,
  } as any);
  try {
    const { sendMail } = await import('../utils/mailer.js');
    const baseUrl = process.env.PUBLIC_BASE_URL || process.env.CLOW_PUBLIC_BASE_URL || 'https://system-clow.pvcorretor01.com.br';
    const verifyUrl = `${baseUrl}/auth/verify-email?token=${newToken}`;
    await sendMail({
      to: tenant.email,
      subject: 'Confirme seu cadastro — System Clow',
      text: `Clique no link pra confirmar seu email:\n\n${verifyUrl}\n\nO link expira em 7 dias.`,
      html: `<p>Clique no link pra confirmar seu email:</p><p><a href="${verifyUrl}">${verifyUrl}</a></p><p>O link expira em 7 dias.</p>`,
    });
  } catch (err: any) {
    logger.warn('[auth/resend-verification] sendMail falhou:', err?.message);
  }
  return c.json({ ok: true, message: 'Se o email existe, mandamos o link de novo.' });
});

// ─── Login ──────────────────────────────────────────────────────────────
app.post('/login', async (c) => {
  const body = await c.req.json().catch(() => ({})) as any;
  const { email, password } = body;
  if (!email || !password) return c.json({ ok: false, error: 'missing_credentials' }, 400);

  const match = findTenantByAnyLogin(String(email).toLowerCase());
  if (!match) {
    return c.json({ ok: false, error: 'invalid_credentials' }, 401);
  }
  const { tenant, login } = match;

  // Hash a comparar: owner usa tenant.password_hash; additional_login usa o seu próprio.
  const passwordHash = login ? login.password_hash : (tenant as any).password_hash;
  if (!passwordHash) {
    return c.json({ ok: false, error: 'invalid_credentials' }, 401);
  }

  if (tenant.status === 'cancelled' || tenant.status === 'suspended') {
    return c.json({ ok: false, error: 'account_blocked', message: 'Conta suspensa ou cancelada. Contate suporte.' }, 403);
  }

  const ok = await bcrypt.compare(password, passwordHash);
  if (!ok) return c.json({ ok: false, error: 'invalid_credentials' }, 401);

  // Touch last_login_at no escopo certo (owner ou additional)
  if (login) {
    touchAdditionalLogin(tenant.id, login.email);
  } else {
    updateTenant(tenant.id, { last_login_at: new Date().toISOString() } as any);
  }

  // Lazy backfill RBAC pra tenants criados antes do fix de signup. Roda só
  // pro owner (additional_logins são provisionados explicitamente já com agent).
  if (!login) {
    try {
      const t = tenant as any;
      bootstrapTenantRBAC(tenant.id, t.full_name || tenant.name, tenant.email, t.phone_e164);
    } catch (err) {
      logger.warn('[auth/login] bootstrapTenantRBAC falhou (segue mesmo assim):', (err as Error).message);
    }
  }

  const tokenEmail = login ? login.email : tenant.email;
  const tokenRole: 'owner' | 'admin' | 'agent' = login ? login.role : 'owner';
  const tokenUid = login ? login.agent_id : tenant.id;
  const tokenName = login ? login.full_name : ((tenant as any).full_name || tenant.name);

  const token = signUserToken({
    tid: tenant.id, uid: tokenUid, email: tokenEmail, role: tokenRole,
  });

  return c.json({
    ok: true,
    token,
    user: {
      id: tokenUid, email: tokenEmail, name: tokenName,
      tier: tenant.tier, role: tokenRole,
    },
  });
});

// ─── /auth/logout ───────────────────────────────────────────────────────
// Adiciona o token a uma blacklist com TTL = exp do JWT. Tentativas
// futuras com o mesmo token retornam 401, mesmo antes da expiracao
// natural. Idempotente — chamar 2x nao falha.
app.post('/logout', async (c) => {
  const auth = c.req.header('Authorization') || c.req.header('X-Auth-Token') || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) return c.json({ ok: true, revoked: false, reason: 'no_token' });

  // Tenta token de tenant primeiro
  const userPayload = verifyUserToken(token);
  if (userPayload) {
    revokeToken(token, userPayload.exp, 'logout');
    return c.json({ ok: true, revoked: true, kind: 'user' });
  }

  // Fallback: token de admin
  try {
    const { verifyAdminSessionToken } = await import('../server/middleware/tenantAuth.js');
    const adm = verifyAdminSessionToken(token);
    if (adm.ok) {
      // Admin sessions tem exp embutido no payload — extrai pra usar como TTL
      // Default 12h se nao conseguir extrair
      let expMs = Date.now() + 12 * 60 * 60 * 1000;
      try {
        const decoded = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
        if (decoded?.exp) expMs = Number(decoded.exp);
      } catch { /* fica com default */ }
      revokeToken(token, expMs, 'logout');
      return c.json({ ok: true, revoked: true, kind: 'admin' });
    }
  } catch { /* nao era admin token */ }

  // Token invalido — 200 mesmo assim (nao expoe se token existia)
  return c.json({ ok: true, revoked: false, reason: 'invalid_token' });
});

// ─── /auth/me ───────────────────────────────────────────────────────────
app.get('/me', async (c) => {
  const auth = c.req.header('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();

  // 1) Tentar token de tenant (formato usr.payload.sig)
  const payload = verifyUserToken(token);
  if (payload) {
    const tenant = getTenant(payload.tid);
    if (!tenant) return c.json({ ok: false }, 404);
    const t = tenant as any;
    // Quando logado como additional_login, identidade vem do login adicional
    // (id=agent_id, email/name dele). Tenant-level fields (tier/status/phone)
    // continuam vindo do tenant pai.
    const extra = (t.additional_logins as any[] | undefined)?.find(
      (l) => l.email?.toLowerCase() === payload.email.toLowerCase(),
    );
    return c.json({
      ok: true,
      user: {
        id: extra ? extra.agent_id : tenant.id,
        email: extra ? extra.email : tenant.email,
        name: extra ? extra.full_name : (t.full_name || tenant.name),
        tier: tenant.tier,
        status: tenant.status,
        phone: t.phone_e164,
        authorized_phones: t.authorized_phones || [],
        // UI usa pra mostrar "X de Y" e bloquear botão quando cheio
        max_authorized_phones: (await import('../tenancy/tiers.js')).getTierConfig(tenant.tier)?.max_authorized_phones ?? 1,
        role: payload.role,
      },
    });
  }

  // 2) Fallback: token de admin (payload.sig, 2 partes) — retorna pseudo-user admin
  try {
    const { verifyAdminSessionToken } = await import('../server/middleware/tenantAuth.js');
    const adm = verifyAdminSessionToken(token);
    if (adm.ok && adm.username) {
      let adminPhones: string[] = [];
      try {
        const { getAdminPhones } = await import('../admin/adminConfig.js');
        adminPhones = getAdminPhones();
      } catch { /* fallback silencioso */ }
      return c.json({
        ok: true,
        user: {
          id: 'admin',
          email: adm.username + '@system-clow',
          name: adm.username,
          tier: 'admin',
          status: 'active',
          phone: null,
          authorized_phones: adminPhones,
          role: 'admin',
          is_admin: true,
        },
      });
    }
  } catch { /* ignore */ }

  return c.json({ ok: false }, 401);
});

// ─── Change password ────────────────────────────────────────────────────
app.post('/change-password', async (c) => {
  const auth = c.req.header('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  const payload = verifyUserToken(token);
  if (!payload) return c.json({ error: 'unauthorized' }, 401);
  const body = await c.req.json().catch(() => ({})) as any;
  const { old_password, new_password } = body;
  if (!new_password || new_password.length < 8) return c.json({ error: 'password_too_short' }, 400);

  const tenant = getTenant(payload.tid) as any;
  if (!tenant?.password_hash) return c.json({ error: 'not_found' }, 404);

  // Additional_login não pode trocar a senha do tenant-owner — só o owner.
  // (Suporte a self-service de senha pra additional_login fica pra depois.)
  const isOwner = payload.email.toLowerCase() === String(tenant.email).toLowerCase();
  if (!isOwner) {
    return c.json({ error: 'forbidden_for_additional_login', message: 'Login adicional não pode trocar a senha do dono. Peça pro administrador.' }, 403);
  }

  const ok = await bcrypt.compare(old_password || '', tenant.password_hash);
  if (!ok) return c.json({ error: 'invalid_old_password' }, 401);

  const hash = await bcrypt.hash(new_password, 10);
  updateTenant(payload.tid, { password_hash: hash } as any);
  return c.json({ ok: true });
});

// ─── Manage authorized phones (admin OR tenant owner) ─────────────────
app.post('/authorized-phones', async (c) => {
  const auth = c.req.header('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  const body = await c.req.json().catch(() => ({})) as any;
  const rawPhones: string[] = Array.isArray(body.phones) ? body.phones : [];

  // 1) Tenant token (3 partes: usr.payload.sig)
  const payload = verifyUserToken(token);
  if (payload) {
    const phones = rawPhones.map((p: string) => normalizePhone(p)).filter((p: string) => p.length >= 10);
    // Enforca limite por tier (Starter:1 / Profissional:3 / Empresarial:5).
    // Sem isso, qualquer um pagando R$347 podia adicionar 50 telefones e
    // virar revenda da IA.
    const tenant = (await import('../tenancy/tenantStore.js')).getTenant(payload.tid);
    if (tenant) {
      const { getTierConfig } = await import('../tenancy/tiers.js');
      const tier = getTierConfig(tenant.tier);
      if (tier && phones.length > tier.max_authorized_phones) {
        return c.json({
          error: 'tier_phone_limit_exceeded',
          message: `Seu plano permite no máximo ${tier.max_authorized_phones} telefone(s) autorizado(s). Faça upgrade pra adicionar mais.`,
          limit: tier.max_authorized_phones,
          tier: tenant.tier,
        }, 403);
      }
    }
    updateTenant(payload.tid, { authorized_phones: phones } as any);
    return c.json({ ok: true, phones });
  }

  // 2) Admin token (2 partes: payload.sig) — salva no admin config
  try {
    const { verifyAdminSessionToken } = await import('../server/middleware/tenantAuth.js');
    const adm = verifyAdminSessionToken(token);
    if (adm.ok) {
      const { setAdminPhones } = await import('../admin/adminConfig.js');
      const saved = setAdminPhones(rawPhones);
      return c.json({ ok: true, phones: saved });
    }
  } catch (err: any) {
    logger.error('[authorized-phones admin branch]', err?.message);
  }

  return c.json({ error: 'unauthorized' }, 401);
});

// ─── /auth/usage — current month usage per limits ──────────────────────
app.get('/usage', async (c) => {
  const auth = c.req.header('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  const payload = verifyUserToken(token);
  if (!payload) return c.json({ error: 'unauthorized' }, 401);
  const { getQuotaStatus } = await import('../billing/quotaGuard.js');
  const status = getQuotaStatus(payload.tid);
  if (!status) return c.json({ error: 'tenant_not_found' }, 404);
  return c.json(status);
});

export default app;
