import { describe, it, expect } from 'vitest';
import { custoUsd, mesAtual, renovaEm, LIMITE_PLANO_BRL, creditoDaRecarga } from '../../src/tenancy/usoIa.js';

// O limite que o Daniel definiu (29/10/2026) e a conta que vira a barra de uso.
describe('uso da IA por plano', () => {
  it('limites dos planos', () => {
    expect(LIMITE_PLANO_BRL).toEqual({ essencial: 80, completo: 100 });
  });
  it('recarga paga vira 85% de crédito (15% fica com o EVOX)', () => {
    expect(creditoDaRecarga(50)).toBe(42.5);
    expect(creditoDaRecarga(100)).toBe(85);
    expect(creditoDaRecarga(150)).toBe(127.5);
  });
  it('token em cache custa menos que token novo', () => {
    const semCache = custoUsd({ inputTokens: 1_000_000, outputTokens: 0 });
    const comCache = custoUsd({ inputTokens: 1_000_000, cachedTokens: 1_000_000, outputTokens: 0 });
    expect(comCache).toBeLessThan(semCache);
    expect(custoUsd({ inputTokens: 0, outputTokens: 1_000_000 })).toBeGreaterThan(0);
  });
  it('o mês vira no horário de Brasília e renova no dia 1', () => {
    expect(mesAtual(new Date('2026-11-01T02:00:00Z'))).toBe('2026-10');
    expect(mesAtual(new Date('2026-11-01T04:00:00Z'))).toBe('2026-11');
    expect(renovaEm(new Date('2026-12-15T12:00:00Z'))).toBe('2027-01-01');
  });
});
