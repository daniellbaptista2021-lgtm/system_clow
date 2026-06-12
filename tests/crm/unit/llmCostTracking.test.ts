/**
 * Tests para o calculo de custo LLM. Validamos que `calcCost` produz
 * valores corretos a partir do `usage` da resposta DeepSeek (formato
 * OpenAI-compatible). Tabela de pricing tem que casar com agent.ts.
 *
 * Pricing usado: input $0.30/1M tokens, output $1.20/1M tokens (margem
 * sobre $0.27 / $1.10 reais da DeepSeek). Conservador eh OK — melhor
 * cappar antes do que pagar conta inesperada.
 */
import { describe, it, expect } from 'vitest';

// Replicando a logica privada — se mudar la, atualizar aqui (e o teste vira regressao).
const INPUT = 0.30 / 1_000_000;
const OUTPUT = 1.20 / 1_000_000;

function calcCost(usage: { prompt_tokens?: number; completion_tokens?: number } | undefined): number {
  if (!usage) return 0;
  return (usage.prompt_tokens || 0) * INPUT + (usage.completion_tokens || 0) * OUTPUT;
}

describe('LLM cost tracking — calcCost', () => {
  it('zero quando usage undefined', () => {
    expect(calcCost(undefined)).toBe(0);
  });

  it('zero quando ambos tokens 0', () => {
    expect(calcCost({ prompt_tokens: 0, completion_tokens: 0 })).toBe(0);
  });

  it('1000 input tokens = $0.0003', () => {
    expect(calcCost({ prompt_tokens: 1000, completion_tokens: 0 })).toBeCloseTo(0.0003, 6);
  });

  it('1000 output tokens = $0.0012', () => {
    expect(calcCost({ prompt_tokens: 0, completion_tokens: 1000 })).toBeCloseTo(0.0012, 6);
  });

  it('mensagem real (~500 input, ~200 output) custa fracao de centavo', () => {
    const cost = calcCost({ prompt_tokens: 500, completion_tokens: 200 });
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBeLessThan(0.001); // < $0.001 (R$ 0.005)
  });

  it('1M input + 1M output = $1.50', () => {
    expect(calcCost({ prompt_tokens: 1_000_000, completion_tokens: 1_000_000 })).toBeCloseTo(1.50, 4);
  });

  it('completion_tokens custa 4x mais que prompt_tokens (mesma quantidade)', () => {
    const inputOnly = calcCost({ prompt_tokens: 1000, completion_tokens: 0 });
    const outputOnly = calcCost({ prompt_tokens: 0, completion_tokens: 1000 });
    expect(outputOnly / inputOnly).toBeCloseTo(4.0, 1);
  });
});
