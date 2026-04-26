/**
 * AI Features — Unit Tests
 */
import { describe, it, expect } from 'vitest';
import { sentimentForText } from '../../../src/crm/ai.js';

describe('AI — sentimentForText', () => {
  it('detects positive sentiment', () => {
    const r = sentimentForText('Obrigado, a proposta ficou otima! Pode enviar o contrato, fechado.');
    expect(r.label).toBe('positive');
    expect(r.score).toBeGreaterThan(0);
    expect(r.triggers.length).toBeGreaterThan(0);
  });

  it('detects negative sentiment with strong words', () => {
    const r = sentimentForText('Achei caro demais, vou cancelar esse orcamento. Nao tenho interesse.');
    expect(r.label).toBe('negative');
    expect(r.score).toBeLessThan(0);
    expect(r.triggers).toContain('cancelar');
  });

  it('returns neutral for empty text', () => {
    const r = sentimentForText('');
    expect(r.label).toBe('neutral');
    expect(r.score).toBe(0);
    expect(r.triggers).toHaveLength(0);
  });

  it('returns neutral for text with no keywords', () => {
    const r = sentimentForText('Enviei o arquivo conforme combinado.');
    expect(r.label).toBe('neutral');
    expect(r.triggers).toHaveLength(0);
  });

  it('handles mixed sentiment', () => {
    // "bom" (positive) + "caro" (negative) — depends on weights
    const r = sentimentForText('O produto e bom mas esta caro');
    // just check it produces a valid result
    expect(['positive', 'neutral', 'negative']).toContain(r.label);
  });
});
