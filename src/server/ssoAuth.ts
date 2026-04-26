/**
 * ssoAuth.ts — Single Sign-On between Clow and System Clow
 *
 * Enables users authenticated in Clow (main product) to access
 * System Clow without re-entering credentials.
 *
 * Flow:
 * 1. Clow generates SSO token with user info + HMAC signature
 * 2. User clicks "System Clow" button in Clow sidebar
 * 3. Iframe loads System Clow with ?sso_token=... parameter
 * 4. System Clow verifies token, creates session, returns JWT
 *
 * Both sides share CLOW_SSO_SECRET environment variable.
 */

import * as crypto from 'crypto';
import { Hono } from 'hono';

// ════════════════════════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════════════════════════

export interface SSOPayload {
  email: string;
  tenantId: string;
  tier: string;
  hasSystemClow: boolean;
  iat: number;
  exp: number;
}

// ════════════════════════════════════════════════════════════════════════════
// Token Generation (called by Clow main)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Generate an SSO token for a user.
 * Called by the Clow main product when user clicks "System Clow".
 */
export function generateSSOToken(payload: Omit<SSOPayload, 'iat' | 'exp'>): string {
  const secret = getSecret();
  const fullPayload: SSOPayload = {
    ...payload,
    iat: Date.now(),
    exp: Date.now() + 5 * 60 * 1000, // 5 minutes validity
  };

  const payloadB64 = Buffer.from(JSON.stringify(fullPayload)).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');

  return `${payloadB64}.${signature}`;
}

/**
 * Verify an SSO token received from Clow main.
 * Called by System Clow when iframe loads with ?sso_token=...
 */
export function verifySSOToken(token: string): SSOPayload | null {
  try {
    const secret = getSecret();
    const [payloadB64, signature] = token.split('.');
    if (!payloadB64 || !signature) return null;

    const expectedSig = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig))) {
      return null;
    }

    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString()) as SSOPayload;

    if (payload.exp < Date.now()) return null;
    if (!payload.email || !payload.tenantId) return null;

    return payload;
  } catch {
    return null;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// SSO Routes (mounted on System Clow)
// ════════════════════════════════════════════════════════════════════════════

export function buildSSORoutes(): Hono {
  const app = new Hono();

  /**
   * POST /auth/sso — Exchange SSO token for System Clow session
   * Body: { sso_token: "..." }
   * Returns: { ok: true, token: "jwt...", email, tier }
   */
  app.post('/auth/sso', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const ssoToken = body.sso_token || c.req.query('sso_token') || '';

    if (!ssoToken) {
      return c.json({ ok: false, error: 'SSO token required' }, 400);
    }

    const payload = verifySSOToken(ssoToken);
    if (!payload) {
      return c.json({ ok: false, error: 'Invalid or expired SSO token' }, 401);
    }

    if (!payload.hasSystemClow) {
      return c.json({ ok: false, error: 'System Clow not active for this account. Contrate em https://clow.pvcorretor01.com.br' }, 403);
    }

    // Create admin session token for the SSO user
    try {
      const { createAdminSessionToken } = await import('./middleware/tenantAuth.js');
      const token = createAdminSessionToken(payload.email);
      return c.json({
        ok: true,
        token,
        email: payload.email,
        tier: payload.tier,
        tenantId: payload.tenantId,
      });
    } catch (err) {
      return c.json({ ok: false, error: 'Session creation failed' }, 500);
    }
  });

  /**
   * GET /auth/sso/verify — Check SSO token validity (for iframe preflight)
   */
  app.get('/auth/sso/verify', (c) => {
    const token = c.req.query('token') || '';
    const payload = verifySSOToken(token);
    if (!payload) {
      return c.json({ valid: false }, 401);
    }
    return c.json({ valid: true, email: payload.email, tier: payload.tier });
  });

  return app;
}

// ════════════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════════════

function getSecret(): string {
  const secret = process.env.CLOW_SSO_SECRET || process.env.JWT_SECRET || 'default-sso-secret-change-me';
  if (secret === 'default-sso-secret-change-me') {
    console.warn('[SSO] Using default secret — set CLOW_SSO_SECRET in production');
  }
  return secret;
}
