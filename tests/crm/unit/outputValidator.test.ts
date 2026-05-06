/**
 * Tests pro outputValidator (FIX 2026-05-06).
 *
 * Caso real: Adriana 2026-04-29 — bot inventou plano "Familiar Ampliado por
 * R$ 133,90/mês pra 10 pessoas" sem chamar cotar_sulamerica_api. Texto era
 * normal pro cliente, regex de meta-commentary não pega. Validador
 * programático precisa bloquear esse vetor.
 */
import { describe, it, expect } from 'vitest';
import { validateOutput } from '../../../src/crm/agents/outputValidator.js';

describe('validateOutput — anti-currency hallucination', () => {
  describe('BLOQUEIA: cita valor sem chamar cotar_sulamerica_api', () => {
    it('bloqueia "R$ 133,90/mês" sem cotação (caso Adriana)', () => {
      const v = validateOutput('Pra 10 pessoas fica R$ 133,90/mês', []);
      expect(v.ok).toBe(false);
      expect(v.reason).toBe('unbacked_currency');
      expect(v.detectedMatches).toEqual(['R$ 133,90']);
    });

    it('bloqueia "R$50,00" sem cotação', () => {
      const v = validateOutput('O plano sai por R$50,00 mensais', []);
      expect(v.ok).toBe(false);
    });

    it('bloqueia "R$ 50 mil" sem cotação', () => {
      const v = validateOutput('Capital de R$ 50 mil', []);
      expect(v.ok).toBe(false);
    });

    it('bloqueia "R$1.297" sem cotação', () => {
      const v = validateOutput('Total R$1.297 anual', []);
      expect(v.ok).toBe(false);
    });

    it('bloqueia mesmo se chamou OUTRA tool (não cotação)', () => {
      const v = validateOutput('R$ 50,00', [
        { name: 'ler_dados_card', ok: true },
        { name: 'aplicar_tag', ok: true },
      ]);
      expect(v.ok).toBe(false);
    });

    it('bloqueia se cotar_sulamerica_api falhou', () => {
      const v = validateOutput('R$ 50,00', [
        { name: 'cotar_sulamerica_api', ok: false },
      ]);
      expect(v.ok).toBe(false);
    });

    it('feedback é actionable pro LLM', () => {
      const v = validateOutput('R$ 100', []);
      expect(v.feedback).toMatch(/cotar_sulamerica_api/);
      expect(v.feedback).toMatch(/NUNCA invente|NUNCA chuta/i);
    });
  });

  describe('AUTORIZA: cotar_sulamerica_api foi chamada com sucesso', () => {
    it('passa "R$ 50,00" se cotou com sucesso', () => {
      const v = validateOutput('Sai por R$ 50,00/mês', [
        { name: 'cotar_sulamerica_api', ok: true },
      ]);
      expect(v.ok).toBe(true);
    });

    it('passa fallback gerar_cotacao_sulamerica (legacy)', () => {
      const v = validateOutput('R$ 39,90/mês', [
        { name: 'gerar_cotacao_sulamerica', ok: true },
      ]);
      expect(v.ok).toBe(true);
    });

    it('passa múltiplos valores se cotou', () => {
      const v = validateOutput('De R$ 50,00 a R$ 1.000,00 dependendo', [
        { name: 'cotar_sulamerica_api', ok: true },
      ]);
      expect(v.ok).toBe(true);
    });
  });

  describe('PASSA: texto sem valor monetário', () => {
    it('passa texto sem R$', () => {
      const v = validateOutput('Oi! Como posso te ajudar?', []);
      expect(v.ok).toBe(true);
    });

    it('passa números soltos (idade)', () => {
      const v = validateOutput('Você tem 65 anos, certo?', []);
      expect(v.ok).toBe(true);
    });

    it('passa "200 mil" sem R$', () => {
      const v = validateOutput('A cobertura é de 200 mil de capital', []);
      expect(v.ok).toBe(true);
    });

    it('passa string vazia', () => {
      const v = validateOutput('', []);
      expect(v.ok).toBe(true);
    });

    it('passa quantidade ("10 pessoas")', () => {
      const v = validateOutput('Pra 10 pessoas você precisa de plano separado', []);
      expect(v.ok).toBe(true);
    });
  });

  describe('Casos de borda', () => {
    it('detecta "R$" colado no número (R$50)', () => {
      const v = validateOutput('Sai R$50 por mês', []);
      expect(v.ok).toBe(false);
    });

    it('detecta "R$ 1 milhão"', () => {
      const v = validateOutput('Capital até R$ 1 milhão', []);
      expect(v.ok).toBe(false);
    });

    it('limita matches retornados a 5', () => {
      const text = 'R$1, R$2, R$3, R$4, R$5, R$6, R$7';
      const v = validateOutput(text, []);
      expect(v.ok).toBe(false);
      expect(v.detectedMatches!.length).toBeLessThanOrEqual(5);
    });
  });
});
