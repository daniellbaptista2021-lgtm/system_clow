import { describe, it, expect, beforeEach } from 'vitest';
import { tryConsume, _resetForTests } from '../../../src/crm/outboundRateLimit.js';

describe('outboundRateLimit', () => {
  beforeEach(() => _resetForTests());

  it('permite ate 60 msgs/min pro mesmo numero', () => {
    const phone = '5521990423520';
    for (let i = 0; i < 60; i++) {
      const r = tryConsume(phone);
      expect(r.ok).toBe(true);
    }
  });

  it('bloqueia a 61a msg pro mesmo numero', () => {
    const phone = '5521990423520';
    for (let i = 0; i < 60; i++) tryConsume(phone);
    const r = tryConsume(phone);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.current).toBe(60);
      expect(r.limit).toBe(60);
      expect(r.retryAfterMs).toBeGreaterThan(0);
      expect(r.retryAfterMs).toBeLessThanOrEqual(60_000);
    }
  });

  it('numeros diferentes tem buckets independentes', () => {
    const a = '5521990423520';
    const b = '5511988887777';
    for (let i = 0; i < 60; i++) tryConsume(a);
    expect(tryConsume(a).ok).toBe(false); // a estourou
    expect(tryConsume(b).ok).toBe(true);  // b livre
  });

  it('normaliza diferentes formatos do mesmo numero', () => {
    const formato1 = '5521990423520';
    const formato2 = '+5521990423520';
    const formato3 = '(21) 99042-3520'; // 11 digitos
    // Formato 1 e 2 devem cair no mesmo bucket (mesmos digitos)
    for (let i = 0; i < 60; i++) tryConsume(formato1);
    expect(tryConsume(formato2).ok).toBe(false);
    // Formato 3 tem digitos diferentes (sem 55) — bucket separado
    expect(tryConsume(formato3).ok).toBe(true);
  });

  it('numero invalido (sem digitos) passa', () => {
    expect(tryConsume('').ok).toBe(true);
    expect(tryConsume('abc').ok).toBe(true);
  });
});
