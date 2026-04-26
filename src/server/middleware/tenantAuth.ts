/**
 * tenantAuth.ts — Multi-tenant auth middleware
 *
 * Authenticates via Bearer API key, resolves tenant, propagates to context.
 * Skips auth for /health and /webhooks/* endpoints.
 * Checks tenant status: active/trial → proceed, suspended/cancelled → 403.
 */

import type { Context, Next } from 'hono';
import { createHmac, timingSafeEqual } from 'crypto';
import { hashApiKey, findTenantByApiKeyHash, touchApiKey, type Tenant } from '../../tenancy/tenantStore.js';
import { verifyUserToken } from '../../auth/authRoutes.js';

const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function getAdminSessionSecret(): string | null {
  return process.env.CLOW_ADMIN_SESSION_SECRET || process.env.JWT_SECRET || process.env.CLOW_ADMIN_KEY || null;
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, 'utf-8').toString('base64url');
}

function base64UrlDecode(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf-8');
}

function signAdminSessionPayload(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function createAdminSessionToken(username: string): string {
  const secret = getAdminSessionSecret();
  if (!secret) {
    throw new Error('admin_session_secret_not_configured');
  }

  const payload = JSON.stringify({
    sub: username,
    iat: Date.now(),
    exp: Date.now() + ADMIN_SESSION_TTL_MS,
    type: 'admin_session',
  });
  const encodedPayload = base64UrlEncode(payload);
  const signature = signAdminSessionPayload(encodedPayload, secret);
  return `${encodedPayload}.${signature}`;
}

export function verifyAdminSessionToken(token: string | undefined): { ok: boolean; username?: string } {
  const secret = getAdminSessionSecret();
  if (!secret || !token) return { ok: false };

  const parts = token.split('.');
  if (parts.length !== 2) return { ok: false };

  const [encodedPayload, signature] = parts;
  const expected = signAdminSessionPayload(encodedPayload, secret);
  const expectedBuf = Buffer.from(expected, 'utf-8');
  const receivedBuf = Buffer.from(signature, 'utf-8');

  if (expectedBuf.length !== receivedBuf.length) return { ok: false };
  if (!timingSafeEqual(expectedBuf, receivedBuf)) return { ok: false };

  try {
    const parsed = JSON.parse(base64UrlDecode(encodedPayload)) as {
      sub?: string;
      exp?: number;
      type?: string;
    };
    if (parsed.type !== 'admin_session') return { ok: false };
    if (typeof parsed.exp !== 'number' || parsed.exp < Date.now()) return { ok: false };
    if (typeof parsed.sub !== 'string' || !parsed.sub) return { ok: false };
    return { ok: true, username: parsed.sub };
  } catch {
    return { ok: false };
  }
}

function extractBearerToken(authHeader: string | undefined): string | undefined {
  if (!authHeader?.startsWith('Bearer ')) return undefined;
  return authHeader.slice(7);
}

// ─── Tenant Auth Middleware ─────────────────────────────────────────────────

export async function tenantAuth(c: Context, next: Next): Promise<Response | void> {
  const reqPath = c.req.path;

  // Skip auth for health and webhooks
  if (reqPath === '/health' || reqPath.startsWith('/webhooks/') || reqPath.startsWith('/v1/admin/')) {
    return next();
  }

  // Skip auth if clowSonnetGuard already authenticated this request
  const alreadyAuthed = (c as unknown as { get?: (k: string) => unknown }).get?.('authMode');
  if (alreadyAuthed === 'clow_sonnet' || alreadyAuthed === 'admin_session') {
    return next();
  }

  // Extract API key
  const auth = c.req.header('Authorization');
  const bearerToken = extractBearerToken(auth);
  if (!bearerToken) {
    return c.json({ error: 'missing_api_key', message: 'Authorization: Bearer <api_key> required' }, 401);
  }
    console.log("[tenantAuth-debug] path=" + c.req.path + " len=" + (bearerToken || "").length + " prefix=" + (bearerToken || "").slice(0,30) + " startsClow=" + (bearerToken || "").startsWith("clow_"));
  const adminSession = verifyAdminSessionToken(bearerToken);
  if (adminSession.ok) {
    c.set('adminUser', adminSession.username);
    c.set('authMode', 'admin_session');
    return next();
  }

  // User session token (multi-tenant SaaS)
  const userPayload = verifyUserToken(bearerToken);
  if (userPayload) {
    c.set('tenantId', userPayload.tid);
    c.set('userId', userPayload.uid);
    c.set('userEmail', userPayload.email);
    c.set('userRole', userPayload.role);
    c.set('authMode', 'user_session');
    return next();
  }

  const apiKey = bearerToken;

  // Validate prefix
  if (!apiKey.startsWith('clow_')) {
    return c.json({ error: 'invalid_api_key', message: 'API key must start with clow_' }, 401);
  }

  // Lookup tenant by key hash
  const keyHash = hashApiKey(apiKey);
  const tenant = findTenantByApiKeyHash(keyHash);

  if (!tenant) {
    return c.json({ error: 'invalid_api_key', message: 'API key not found or revoked' }, 401);
  }

  // Check tenant status
  if (tenant.status === 'suspended') {
    return c.json({
      error: 'tenant_suspended',
      message: 'Your account is suspended. Please contact support or update payment.',
    }, 403);
  }

  if (tenant.status === 'cancelled') {
    return c.json({
      error: 'tenant_cancelled',
      message: 'Your account has been cancelled.',
    }, 403);
  }

  if (tenant.status === 'over_quota_disk') {
    return c.json({
      error: 'workspace_quota_exceeded',
      message: 'Workspace disk quota exceeded. Delete files or upgrade your plan.',
    }, 402);
  }

  // Check trial expiry
  if (tenant.status === 'trial' && tenant.trial_ends_at) {
    if (new Date(tenant.trial_ends_at) < new Date()) {
      return c.json({
        error: 'trial_expired',
        message: 'Your trial has expired. Please upgrade to continue.',
      }, 403);
    }
  }

  // Touch API key (background, non-blocking)
  void Promise.resolve().then(() => touchApiKey(keyHash));

  // Propagate tenant to context
  c.set('tenant', tenant);
  c.set('tenantId', tenant.id);

  return next();
}

// ─── Admin Auth (separate, simple) ──────────────────────────────────────────

export async function adminAuth(c: Context, next: Next): Promise<Response | void> {
  const adminKey = process.env.CLOW_ADMIN_KEY;
  if (!adminKey) {
    return c.json({ error: 'admin_not_configured' }, 500);
  }

  const auth = c.req.header('Authorization');
  const bearerToken = extractBearerToken(auth);
    console.log("[tenantAuth-debug] path=" + c.req.path + " len=" + (bearerToken || "").length + " prefix=" + (bearerToken || "").slice(0,30) + " startsClow=" + (bearerToken || "").startsWith("clow_"));
  const adminSession = verifyAdminSessionToken(bearerToken);
  if (adminSession.ok) {
    c.set('adminUser', adminSession.username);
    return next();
  }

  if (auth !== `Bearer ${adminKey}`) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  return next();
}
