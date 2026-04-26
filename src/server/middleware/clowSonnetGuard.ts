/**
 * clowSonnetGuard.ts — Validate Clow-issued Sonnet tokens and gate on credits
 *
 * When a request arrives with a "clow_sonnet_<payload>.<sig>" bearer token,
 * this middleware:
 *   1. Verifies HMAC-SHA256 signature against CLOW_SONNET_SECRET
 *   2. Checks token expiry
 *   3. Calls Clow /api/v1/internal/sonnet/check/:user_id to verify credit
 *   4. Sets tenant context as pseudo-tenant "clow_sonnet_<user_id>"
 *
 * If token is absent, passes through to standard tenantAuth.
 */

import type { Context, Next } from 'hono';
import { createHmac, timingSafeEqual } from 'crypto';

export const CLOW_SONNET_PREFIX = 'clow_sonnet_';

type ClowPayload = {
  user_id: string;
  email?: string;
  iat: number;
  exp: number;
  src?: string;
  is_admin?: boolean;
};

function base64UrlDecode(s: string): Buffer {
  // Restore padding
  const pad = 4 - (s.length % 4);
  const padded = pad < 4 ? s + '='.repeat(pad) : s;
  return Buffer.from(padded, 'base64url');
}

export function verifyClowToken(token: string, secret: string): ClowPayload | null {
  if (!token.startsWith(CLOW_SONNET_PREFIX)) return null;
  const rest = token.slice(CLOW_SONNET_PREFIX.length);
  const dot = rest.indexOf('.');
  if (dot <= 0) return null;
  const payloadB64 = rest.slice(0, dot);
  const sigB64 = rest.slice(dot + 1);

  const expected = createHmac('sha256', secret).update(payloadB64).digest();
  let received: Buffer;
  try {
    received = base64UrlDecode(sigB64);
  } catch {
    return null;
  }
  if (expected.length !== received.length) return null;
  if (!timingSafeEqual(expected, received)) return null;

  let payload: ClowPayload;
  try {
    payload = JSON.parse(base64UrlDecode(payloadB64).toString('utf-8')) as ClowPayload;
  } catch {
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < now) return null;
  if (typeof payload.user_id !== 'string' || !payload.user_id) return null;
  return payload;
}

type CreditCheck = {
  allowed: boolean;
  reason?: string;
  balance_brl?: number;
  daily?: { remaining: number; limit: number };
  weekly?: { remaining: number; limit: number };
};

async function callClowCreditCheck(userId: string, backend: string, secret: string): Promise<CreditCheck> {
  try {
    const url = `${backend.replace(/\/$/, '')}/api/v1/internal/sonnet/check/${encodeURIComponent(userId)}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'x-clow-secret': secret },
    });
    if (!res.ok) {
      return { allowed: false, reason: 'credit_service_http_' + res.status };
    }
    const data = await res.json();
    return data as CreditCheck;
  } catch (err: any) {
    console.error('[clowSonnetGuard] credit check failed:', err?.message || err);
    return { allowed: false, reason: 'credit_service_unreachable' };
  }
}

export async function recordClowUsage(params: {
  userId: string;
  sessionId: string;
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens: number;
}): Promise<void> {
  const backend = process.env.CLOW_BACKEND_URL;
  const secret = process.env.CLOW_SONNET_SECRET;
  if (!backend || !secret) return;
  const url = `${backend.replace(/\/$/, '')}/api/v1/internal/sonnet/record`;
  try {
    await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-clow-secret': secret,
      },
      body: JSON.stringify({
        user_id: params.userId,
        session_id: params.sessionId,
        input_tokens: params.inputTokens,
        output_tokens: params.outputTokens,
        cache_hit_tokens: params.cacheHitTokens,
      }),
    });
  } catch (err: any) {
    console.error('[clowSonnetGuard] record failed:', err?.message || err);
  }
}

export async function clowSonnetGuard(c: Context, next: Next): Promise<Response | void> {
  const auth = c.req.header('Authorization') || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const tokenCandidate = bearer || c.req.header('x-clow-token') || '';

  if (!tokenCandidate || !tokenCandidate.startsWith(CLOW_SONNET_PREFIX)) {
    return next();
  }

  const secret = process.env.CLOW_SONNET_SECRET;
  const backend = process.env.CLOW_BACKEND_URL;
  if (!secret || !backend) {
    return c.json({ error: 'clow_integration_not_configured' }, 500);
  }

  const payload = verifyClowToken(tokenCandidate, secret);
  if (!payload) {
    return c.json({ error: 'invalid_clow_token', message: 'Token Clow invalido ou expirado' }, 401);
  }

  // Check credits — skip the check for idempotent reads (GET session/history)
  const method = c.req.method;
  const path = c.req.path;
  const isWriteOp = (
    method === 'POST' && (path.endsWith('/messages') || path === '/v1/sessions')
  );

  const userIsAdmin = payload.is_admin === true;

  if (isWriteOp && !userIsAdmin) {
    const check = await callClowCreditCheck(payload.user_id, backend, secret);
    if (!check.allowed) {
      return c.json({
        error: 'no_sonnet_credit',
        reason: check.reason || 'no_credit',
        message: creditReasonMessage(check.reason),
        balance_brl: check.balance_brl,
        daily: check.daily,
        weekly: check.weekly,
      }, 402);
    }
  }

  // Synthesise tenant context. Admin -> full admin_session, regular -> clow_sonnet tenant.
  if (userIsAdmin) {
    c.set('tenant', {
      id: 'admin_clow_' + payload.user_id,
      tier: 'admin',
      status: 'active',
      clow_user_id: payload.user_id,
      email: payload.email || '',
      is_admin: true,
    });
    c.set('tenantId', 'admin_clow_' + payload.user_id);
    c.set('clowUserId', payload.user_id);
    c.set('clowIsAdmin', true);
    c.set('adminUser', payload.email || payload.user_id);
    c.set('authMode', 'admin_session');
  } else {
    const pseudoTenantId = 'clow_sonnet_' + payload.user_id;
    c.set('tenant', {
      id: pseudoTenantId,
      tier: 'sonnet_clow',
      status: 'active',
      clow_user_id: payload.user_id,
      email: payload.email || '',
      workspaceRoot: '/opt/clow-workspaces/sonnet/' + payload.user_id,
    });
    c.set('tenantId', pseudoTenantId);
    c.set('clowUserId', payload.user_id);
    c.set('authMode', 'clow_sonnet');
  }

  return next();
}

function creditReasonMessage(reason?: string): string {
  switch (reason) {
    case 'no_credit':
      return 'Voce nao tem creditos Sonnet. Compre um pacote para continuar.';
    case 'daily_limit':
      return 'Limite diario de mensagens atingido. Tente novamente amanha.';
    case 'weekly_limit':
      return 'Limite semanal de mensagens atingido. Aguarde o reset semanal.';
    case 'credit_service_unreachable':
      return 'Servico de creditos temporariamente indisponivel.';
    default:
      return 'Acesso negado: ' + (reason || 'sem credito');
  }
}
