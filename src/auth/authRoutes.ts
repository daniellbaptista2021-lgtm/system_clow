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
  createTenant, findTenantByEmail, getTenant, updateTenant, listTenants,
  type Tenant,
} from '../tenancy/tenantStore.js';

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
  return payload;
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
  const validTiers = ['starter', 'profissional', 'empresarial', 'business', 'one'];
  const tier = validTiers.includes(plan_tier) ? plan_tier : 'starter';

  // Create tenant with all user fields embedded
  const { tenant } = createTenant({
    email: email.toLowerCase(),
    name: full_name,
    tier: tier as any,
    // Embed user/billing fields via updateTenant after create
  });
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
  } as any);

  const token = signUserToken({
    tid: tenant.id, uid: tenant.id, email: email.toLowerCase(), role: 'owner',
  });

  return c.json({
    ok: true,
    token,
    user: { id: tenant.id, email: email.toLowerCase(), name: full_name, tier, role: 'owner' },
  }, 201);
});

// ─── Login ──────────────────────────────────────────────────────────────
app.post('/login', async (c) => {
  const body = await c.req.json().catch(() => ({})) as any;
  const { email, password } = body;
  if (!email || !password) return c.json({ ok: false, error: 'missing_credentials' }, 400);

  const tenant = findTenantByEmail(String(email).toLowerCase());
  if (!tenant || !(tenant as any).password_hash) {
    // Fallback: legacy admin login (env-based) handled by /auth/login in server.ts
    return c.json({ ok: false, error: 'invalid_credentials' }, 401);
  }

  if (tenant.status === 'cancelled' || tenant.status === 'suspended') {
    return c.json({ ok: false, error: 'account_blocked', message: 'Conta suspensa ou cancelada. Contate suporte.' }, 403);
  }

  const ok = await bcrypt.compare(password, (tenant as any).password_hash);
  if (!ok) return c.json({ ok: false, error: 'invalid_credentials' }, 401);

  // Touch last_login_at
  updateTenant(tenant.id, { last_login_at: new Date().toISOString() } as any);

  const token = signUserToken({
    tid: tenant.id, uid: tenant.id, email: tenant.email, role: 'owner',
  });

  return c.json({
    ok: true,
    token,
    user: {
      id: tenant.id, email: tenant.email, name: (tenant as any).full_name || tenant.name,
      tier: tenant.tier, role: 'owner',
    },
  });
});

// ─── /auth/me ───────────────────────────────────────────────────────────
app.get('/me', (c) => {
  const auth = c.req.header('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  const payload = verifyUserToken(token);
  if (!payload) return c.json({ ok: false }, 401);
  const tenant = getTenant(payload.tid);
  if (!tenant) return c.json({ ok: false }, 404);
  const t = tenant as any;
  return c.json({
    ok: true,
    user: {
      id: tenant.id,
      email: tenant.email,
      name: t.full_name || tenant.name,
      tier: tenant.tier,
      status: tenant.status,
      phone: t.phone_e164,
      authorized_phones: t.authorized_phones || [],
      role: payload.role,
    },
  });
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

  const ok = await bcrypt.compare(old_password || '', tenant.password_hash);
  if (!ok) return c.json({ error: 'invalid_old_password' }, 401);

  const hash = await bcrypt.hash(new_password, 10);
  updateTenant(payload.tid, { password_hash: hash } as any);
  return c.json({ ok: true });
});

// ─── Manage authorized phones (owner only) ──────────────────────────────
app.post('/authorized-phones', async (c) => {
  const auth = c.req.header('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  const payload = verifyUserToken(token);
  if (!payload) return c.json({ error: 'unauthorized' }, 401);
  const body = await c.req.json().catch(() => ({})) as any;
  const phones: string[] = (body.phones || [])
    .map((p: string) => normalizePhone(p))
    .filter((p: string) => p.length >= 10);
  updateTenant(payload.tid, { authorized_phones: phones } as any);
  return c.json({ ok: true, phones });
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
