import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { revokeToken, isTokenRevoked, cleanupExpiredRevocations, _resetForTests } from '../../src/auth/tokenRevocation.js';
import { getCrmDb } from '../../src/crm/schema.js';
import { applyMigrations } from '../../src/crm/migrator.js';

describe('tokenRevocation', () => {
  beforeAll(() => {
    applyMigrations(getCrmDb());
  });

  beforeEach(() => {
    _resetForTests();
  });

  it('isTokenRevoked retorna false pra token nao revogado', () => {
    expect(isTokenRevoked('usr.fake-token.fake-sig')).toBe(false);
  });

  it('revokeToken + isTokenRevoked: round-trip', () => {
    const token = 'usr.payload-abc.sig-xyz';
    const expIn1h = Date.now() + 3600_000;
    revokeToken(token, expIn1h, 'logout');
    expect(isTokenRevoked(token)).toBe(true);
  });

  it('isTokenRevoked NAO confunde tokens parecidos', () => {
    const a = 'usr.aaa.bbb';
    const b = 'usr.aaa.ccc';
    revokeToken(a, Date.now() + 1000_000);
    expect(isTokenRevoked(a)).toBe(true);
    expect(isTokenRevoked(b)).toBe(false);
  });

  it('revokeToken e idempotente (chamar 2x nao falha)', () => {
    const t = 'usr.x.y';
    const exp = Date.now() + 60_000;
    revokeToken(t, exp);
    revokeToken(t, exp);
    expect(isTokenRevoked(t)).toBe(true);
  });

  it('cleanupExpiredRevocations remove expirados', () => {
    const live = 'usr.live.sig';
    const expired = 'usr.expired.sig';
    revokeToken(live, Date.now() + 60_000);
    revokeToken(expired, Date.now() - 1000); // ja expirou
    const r = cleanupExpiredRevocations();
    expect(r.removed).toBe(1);
    expect(isTokenRevoked(live)).toBe(true);
    expect(isTokenRevoked(expired)).toBe(false);
  });

  it('isTokenRevoked false pra token vazio/null/undefined', () => {
    expect(isTokenRevoked('')).toBe(false);
    expect(isTokenRevoked(undefined)).toBe(false);
  });

  it('token expirado nao e mais considerado revogado (fail-open natural)', () => {
    const t = 'usr.soon-expire.sig';
    revokeToken(t, Date.now() - 1); // ja expirou
    expect(isTokenRevoked(t)).toBe(false);
  });
});
