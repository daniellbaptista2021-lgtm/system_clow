/**
 * SSO Auth — Unit Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { generateSSOToken, verifySSOToken } from '../../src/server/ssoAuth.js';

describe('SSO Authentication', () => {
  beforeEach(() => {
    process.env.CLOW_SSO_SECRET = 'test-secret-key-for-sso';
  });

  it('generates a valid SSO token', () => {
    const token = generateSSOToken({
      email: 'user@test.com',
      tenantId: 'tenant_123',
      tier: 'pro',
      hasSystemClow: true,
    });

    expect(token).toBeTruthy();
    expect(token.split('.')).toHaveLength(2);
  });

  it('verifies a valid token', () => {
    const token = generateSSOToken({
      email: 'user@test.com',
      tenantId: 'tenant_123',
      tier: 'pro',
      hasSystemClow: true,
    });

    const payload = verifySSOToken(token);
    expect(payload).not.toBeNull();
    expect(payload!.email).toBe('user@test.com');
    expect(payload!.tenantId).toBe('tenant_123');
    expect(payload!.tier).toBe('pro');
    expect(payload!.hasSystemClow).toBe(true);
  });

  it('rejects tampered token', () => {
    const token = generateSSOToken({
      email: 'user@test.com',
      tenantId: 'tenant_123',
      tier: 'pro',
      hasSystemClow: true,
    });

    const tampered = token.slice(0, -5) + 'XXXXX';
    expect(verifySSOToken(tampered)).toBeNull();
  });

  it('rejects expired token', () => {
    // Manually create an expired token
    const crypto = require('crypto');
    const payload = {
      email: 'user@test.com',
      tenantId: 'tenant_123',
      tier: 'pro',
      hasSystemClow: true,
      iat: Date.now() - 600000,
      exp: Date.now() - 300000, // Expired 5 min ago
    };
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = crypto.createHmac('sha256', 'test-secret-key-for-sso').update(payloadB64).digest('base64url');
    const token = `${payloadB64}.${sig}`;

    expect(verifySSOToken(token)).toBeNull();
  });

  it('rejects empty token', () => {
    expect(verifySSOToken('')).toBeNull();
  });

  it('rejects garbage token', () => {
    expect(verifySSOToken('not.a.valid.token')).toBeNull();
    expect(verifySSOToken('garbage')).toBeNull();
  });
});
