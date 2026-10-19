/**
 * As contas da apresentação conferidas contra o modelo real da equipe
 * (projeto "Milena", 38 páginas). Cada expect cita a página de onde saiu
 * o número — se uma fórmula mudar, o teste aponta qual página deixou de bater.
 */
import { describe, it, expect } from 'vitest';
import { calcular, brl, COBERTURAS } from '../../src/crm/apresentacao/calculos.js';

const milena = {
  cliente: { nome: 'Milena', idade: 37, rendaFamiliar: 50000, despesaMensal: 35000, rendaConjuge: 25000 },
  filhos: [{ nome: 'Melissa', idade: 4 }],
  patrimonio: { imoveis: 850000, veiculos: 125000, financeiro: 300000 },
  proposta: {
    linhas: [
      { cobertura: 'invalidez_acidente_majorada', capital: 2500000, periodo: 'até 72 anos', valor: 161.52 },
      { cobertura: 'doenca_grave', capital: 240000, periodo: 'até 77 anos', valor: 183.02 },
      { cobertura: 'diaria_hospitalar', capital: 1000, periodo: 'até 77 anos', valor: 59.88 },
      { cobertura: 'fratura_ossea', capital: 300000, periodo: 'até 77 anos', valor: 122.97 },
      { cobertura: 'cirurgias', capital: 100000, periodo: 'até 72 anos', valor: 46.58 },
      { cobertura: 'invalidez_doenca', capital: 840000, periodo: 'até 57 anos', valor: 76.64 },
      { cobertura: 'diaria_incapacidade', capital: 833, periodo: 'até 57 anos', valor: 592.72 },
      { cobertura: 'vida_segura', capital: 900000, periodo: 'por 20 anos', valor: 188.80 },
      { cobertura: 'vida_total_legado', capital: 140250, periodo: 'por 10 anos', valor: 356.69 },
      { cobertura: 'amparo_funeral', capital: 10000, periodo: 'até 97 anos', valor: 18.80 },
    ],
    investimentoMensal: 1807.62,
    investimentoAnual: 20824.87,
  },
};

describe('apresentação MetLife — contas do modelo', () => {
  const r = calcular(milena);

  it('pág. 3: a despesa consome 70% da renda', () => {
    expect(r.comprometimento).toBeCloseTo(0.7, 5);
  });

  it('pág. 4: padrão de vida = 35 mil × 12 × 28 anos', () => {
    expect(r.anosProdutivos).toBe(28);
    expect(r.responsabilidade).toBe(11760000);
  });

  it('pág. 5: filha de 4 anos tem 17 anos até os 22, a 23% da despesa', () => {
    expect(r.educacao.filhos[0]).toMatchObject({ nome: 'Melissa', anos: 17, mensal: 8050, total: 1642200 });
    expect(r.educacao.total).toBe(1642200);
  });

  it('pág. 8: inventário = 11% de 1.275.000', () => {
    expect(r.totalPatrimonio).toBe(1275000);
    expect(r.inventario).toBe(140250);
  });

  it('pág. 9: gap de 10 mil vira 1 milhão (invalidez) e 240 mil (doença grave)', () => {
    expect(r.garantias.rendaTitular).toBe(25000);
    expect(r.garantias.gap).toBe(10000);
    expect(r.garantias.necessarioInvalidez).toBe(1000000);
    expect(r.garantias.necessarioDoenca).toBe(240000);
  });

  it('pág. 10: capital disponibilizado é a soma das linhas, e o diário é o mensal / 30', () => {
    // O PDF da Milena mostra R$ 5.091.833,00, que NÃO é a soma das 10 linhas
    // da própria tabela (5.032.083). Por isso existe o campo de sobrescrever.
    expect(r.capitalDisponibilizado).toBe(5032083);
    expect(r.investimentoDiario).toBe(60.25);
  });

  it('pág. 10: o corretor pode sobrescrever o capital disponibilizado', () => {
    const s = calcular({ ...milena, proposta: { ...milena.proposta, capitalDisponibilizado: 5091833 } });
    expect(brl(s.capitalDisponibilizado)).toBe('R$ 5.091.833,00');
  });

  it('explicações: só as das coberturas da proposta, sem repetir, em ordem', () => {
    const esperado = [...new Set([
      ...COBERTURAS.invalidez_acidente_majorada.explicacao, ...COBERTURAS.doenca_grave.explicacao,
      ...COBERTURAS.diaria_hospitalar.explicacao, ...COBERTURAS.fratura_ossea.explicacao,
      ...COBERTURAS.cirurgias.explicacao, ...COBERTURAS.invalidez_doenca.explicacao,
      ...COBERTURAS.diaria_incapacidade.explicacao,
    ])].sort((a, b) => a - b);
    expect(r.explicacoes).toEqual(esperado);
    // A Milena tem todas: as 27 páginas fixas entram.
    expect(r.explicacoes).toHaveLength(27);
  });

  it('proposta só com vida segura não leva página de explicação', () => {
    const s = calcular({ ...milena, proposta: { linhas: [{ cobertura: 'vida_segura', capital: 1, valor: 1 }] } });
    expect(s.explicacoes).toEqual([]);
  });

  it('sem investimento mensal informado, usa a soma das linhas', () => {
    const s = calcular({ ...milena, proposta: { linhas: milena.proposta.linhas } });
    expect(s.investimentoMensal).toBeCloseTo(1807.62, 2);
  });

  it('cobertura desconhecida vira "outra" em vez de quebrar', () => {
    const s = calcular({ ...milena, proposta: { linhas: [{ cobertura: 'xyz', nome: 'Seguro viagem', capital: 10, valor: 1 }] } });
    expect(s.linhas[0]).toMatchObject({ chave: 'outra', nome: 'Seguro viagem' });
  });
});
