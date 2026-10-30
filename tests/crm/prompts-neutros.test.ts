/**
 * Agentes do funil do EVOX: textos neutros. O EVOX é vendido para qualquer
 * corretor — nenhum texto padrão pode citar a PV Corretora, a SulAmérica,
 * um corretor pelo nome ou preço de plano (os textos antigos citavam todos).
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_PROMPTS } from '../../src/crm/agents/defaultPrompts.js';

describe('prompts padrão do funil', () => {
  for (const [papel, texto] of Object.entries(DEFAULT_PROMPTS)) {
    it(`${papel}: sem corretora, seguradora, pessoa ou preço gravados`, () => {
      expect(texto).not.toMatch(/PV Corretora|SulAm[eé]rica|Daniel|Leandro|Nilson/i);
      expect(texto).not.toMatch(/R\$\s*\d/);
      expect(texto).toMatch(/Nunca\s+invente/i);
      expect(texto).toContain('{{persona_name}}');
    });
  }
  it('coletor pede consentimento LGPD antes dos dados', () => {
    expect(DEFAULT_PROMPTS.coletor).toMatch(/consentimento LGPD/i);
  });
});
