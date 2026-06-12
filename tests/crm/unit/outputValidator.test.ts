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
    it('passa "R$ 49,90" (tabela oficial) se cotou com sucesso', () => {
      const v = validateOutput('Sai por R$ 49,90/mês', [
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

    it('passa múltiplos valores válidos se cotou', () => {
      const v = validateOutput('De R$ 29,90 a R$ 109,90 dependendo do plano', [
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

describe('validateOutput — termos técnicos proibidos', () => {
  it('bloqueia "API" (caso Neide 2026-05-06)', () => {
    const v = validateOutput('Vou cotar aqui com a API oficial da SulAmérica', [
      { name: 'cotar_sulamerica_api', ok: true },
    ]);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('forbidden_term');
    expect(v.detectedMatches).toEqual(['API']);
  });

  it('bloqueia "cotador"', () => {
    const v = validateOutput('Já fechei no cotador, vai sair...', []);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('forbidden_term');
  });

  it('bloqueia "sistema oficial"', () => {
    const v = validateOutput('Acabei de fechar no sistema oficial', []);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('forbidden_term');
  });

  it('bloqueia "cotação oficial" (caso Claudio)', () => {
    const v = validateOutput('A cotação oficial veio com o valor correto', []);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('forbidden_term');
  });

  it('bloqueia "vou consultar o sistema"', () => {
    const v = validateOutput('Beleza, vou consultar o sistema rapidinho', []);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('forbidden_term');
  });

  it('passa frase comum sem termos proibidos', () => {
    const v = validateOutput('Vou montar sua cotação agora 😊', []);
    expect(v.ok).toBe(true);
  });

  it('feedback orienta substituição natural', () => {
    const v = validateOutput('Calculei via API', []);
    expect(v.feedback).toMatch(/API/);
    expect(v.feedback).toMatch(/montar|deixa eu/i);
  });
});

describe('validateOutput — piso de mensalidade (R$ 29,90 absoluto)', () => {
  it('bloqueia R$ 9,98/mês mesmo com tool ok (caso Claudio 2026-05-06)', () => {
    const v = validateOutput('Tudo isso por R$ 9,98/mês', [
      { name: 'cotar_sulamerica_api', ok: true },
    ]);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('price_below_floor');
    expect(v.detectedMatches).toEqual(['R$ 9,98']);
  });

  it('bloqueia R$ 10/mês cada (caso Marlene 2026-05-06)', () => {
    const v = validateOutput('Filhos > 21 entram a R$ 10/mês cada um', [
      { name: 'cotar_sulamerica_api', ok: true },
    ]);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('price_below_floor');
  });

  it('bloqueia R$ 25,90 (entre piso e tabela — regra nova price_off_table)', () => {
    const v = validateOutput('Sai por R$ 25,90 mensais', [
      { name: 'cotar_sulamerica_api', ok: true },
    ]);
    expect(v.ok).toBe(false);
    // 25,90 > piso (R$ 12) mas não está na whitelist da tabela
    expect(v.reason).toBe('price_off_table');
  });

  it('passa R$ 29,90 (no piso)', () => {
    const v = validateOutput('Sai por R$ 29,90/mês', [
      { name: 'cotar_sulamerica_api', ok: true },
    ]);
    expect(v.ok).toBe(true);
  });

  it('passa R$ 39,90 familiar', () => {
    const v = validateOutput('Plano familiar fica R$ 39,90/mês', [
      { name: 'cotar_sulamerica_api', ok: true },
    ]);
    expect(v.ok).toBe(true);
  });

  it('NÃO confunde capital R$ 50.000 com mensalidade abaixo do piso', () => {
    const v = validateOutput('Indenização de R$ 50.000 por acidente', [
      { name: 'cotar_sulamerica_api', ok: true },
    ]);
    expect(v.ok).toBe(true); // capital, não mensal
  });

  it('NÃO confunde "R$ 50 mil" com mensalidade', () => {
    const v = validateOutput('R$ 50 mil de capital', [
      { name: 'cotar_sulamerica_api', ok: true },
    ]);
    expect(v.ok).toBe(true);
  });
});

describe('validateOutput — divergência da última cotação salva', () => {
  it('bloqueia LLM citando R$ 9,98 quando última cotação foi R$ 29,90', () => {
    const v = validateOutput(
      'Vou manter o valor de R$ 9,98 da cotação anterior',
      [{ name: 'ler_dados_card', ok: true }],
      { lastQuotationCents: 2990 },
    );
    expect(v.ok).toBe(false);
    // pode bater como below_floor primeiro (9,98 < 29,90), tudo bem
    expect(['price_below_floor', 'price_diverged_from_quote']).toContain(v.reason);
  });

  it('bloqueia LLM citando R$ 29,90 quando cotação foi R$ 109,90 (diverge >15%)', () => {
    const v = validateOutput(
      'Sai por R$ 29,90 mensais',
      [{ name: 'ler_dados_card', ok: true }],
      { lastQuotationCents: 10990 },
    );
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('price_diverged_from_quote');
  });

  it('passa LLM citando R$ 49,90 quando cotação foi R$ 49,90', () => {
    const v = validateOutput(
      'Plano fica R$ 49,90/mês',
      [{ name: 'cotar_sulamerica_api', ok: true }],
      { lastQuotationCents: 4990 },
    );
    expect(v.ok).toBe(true);
  });

  it('passa LLM citando R$ 49,90 quando cotação foi R$ 49,90 (mesmo valor exato)', () => {
    const v = validateOutput(
      'Plano fica R$ 49,90/mês',
      [{ name: 'cotar_sulamerica_api', ok: true }],
      { lastQuotationCents: 4990 },
    );
    expect(v.ok).toBe(true);
  });

  it('passa quando contexto não tem lastQuotationCents (e valor está na tabela)', () => {
    const v = validateOutput(
      'Plano fica R$ 49,90/mês',
      [{ name: 'cotar_sulamerica_api', ok: true }],
      {},
    );
    expect(v.ok).toBe(true);
  });

  it('lastQuotationCents permite citar valor da tabela mesmo sem chamar tool no turno', () => {
    // cliente perguntou de novo após cotação salva — bot pode ecoar o valor
    const v = validateOutput(
      'Como te disse, fica R$ 49,90/mês',
      [{ name: 'ler_dados_card', ok: true }],
      { lastQuotationCents: 4990 },
    );
    expect(v.ok).toBe(true);
  });
});

describe('validateOutput — whitelist da tabela oficial (HARDENING 8)', () => {
  it('bloqueia mensalidade R$ 76,62 (não está na tabela)', () => {
    const v = validateOutput(
      'Sai por R$ 76,62/mês',
      [{ name: 'cotar_sulamerica_api', ok: true }],
    );
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('price_off_table');
  });

  it('bloqueia mensalidade R$ 100,00 (sem tool, fora da tabela)', () => {
    const v = validateOutput(
      'Plano fica R$ 100,00/mês',
      [{ name: 'cotar_sulamerica_api', ok: true }],
    );
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('price_off_table');
  });

  it('passa todos os 6 valores principais', () => {
    for (const v of ['29,90', '39,90', '49,90', '59,90', '89,90', '109,90']) {
      const r = validateOutput(`Sai por R$ ${v}/mês`, [
        { name: 'cotar_sulamerica_api', ok: true },
      ]);
      expect(r.ok).toBe(true);
    }
  });

  it('passa variantes com Médico na Tela (+R$ 14)', () => {
    for (const v of ['43,90', '53,90', '63,90', '73,90', '103,90', '123,90']) {
      const r = validateOutput(`Sai por R$ ${v}/mês`, [
        { name: 'cotar_sulamerica_api', ok: true },
      ]);
      expect(r.ok).toBe(true);
    }
  });

  it('passa adicional isolado: filho>21 (R$ 12) e outro dependente (R$ 14)', () => {
    expect(validateOutput('Cada filho: R$ 12,00', [
      { name: 'cotar_sulamerica_api', ok: true },
    ]).ok).toBe(true);
    expect(validateOutput('Outro dependente R$ 14,00 cada', [
      { name: 'cotar_sulamerica_api', ok: true },
    ]).ok).toBe(true);
  });

  it('passa combinação principal + 1 filho>21 (R$ 49,90 + 12 = R$ 61,90)', () => {
    const r = validateOutput('Total fica R$ 61,90/mês', [
      { name: 'cotar_sulamerica_api', ok: true },
    ]);
    expect(r.ok).toBe(true);
  });

  it('passa capital R$ 50 mil (não é mensalidade)', () => {
    const r = validateOutput('Indenização de R$ 50 mil em caso de acidente', [
      { name: 'cotar_sulamerica_api', ok: true },
    ]);
    expect(r.ok).toBe(true);
  });

  it('passa diária R$ 500 (não é mensalidade)', () => {
    const r = validateOutput('R$ 500 por dia de internação', [
      { name: 'cotar_sulamerica_api', ok: true },
    ]);
    expect(r.ok).toBe(true);
  });

  it('feedback orienta o LLM a usar valores da tabela', () => {
    const r = validateOutput('R$ 35,00 fica massa', [
      { name: 'cotar_sulamerica_api', ok: true },
    ]);
    expect(r.feedback).toMatch(/29,90.*39,90.*49,90/);
    expect(r.feedback).toMatch(/Médico na Tela|R\$ 14/);
  });
});
