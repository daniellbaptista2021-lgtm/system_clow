/**
 * Apresentação MetLife — as contas.
 *
 * O corretor digita poucos números do cliente e o resto sai daqui. As
 * fórmulas foram tiradas do modelo que a equipe usa (projeto "Milena", com
 * 38 páginas) e há teste que confere cada número contra aquele PDF — se uma
 * conta mudar, o teste diz qual página deixou de bater.
 *
 * Função pura: sem banco, sem arquivo. O gerador do PDF só desenha o que
 * ela devolve.
 */

export interface Filho { nome: string; idade: number }

export interface LinhaProposta {
  /** Chave do catálogo (COBERTURAS) ou 'outra'. */
  cobertura: string;
  /** Nome livre, usado quando cobertura = 'outra' (ou para sobrescrever). */
  nome?: string;
  situacao?: string;
  capital: number;
  periodo?: string;
  valor: number;
}

export interface DadosApresentacao {
  cliente: {
    nome: string;
    idade: number;
    rendaFamiliar: number;
    despesaMensal: number;
    rendaConjuge: number;
    idadeAposentadoria?: number;
  };
  filhos?: Filho[];
  educacaoPercentual?: number;
  educacaoAteIdade?: number;
  patrimonio?: { imoveis?: number; veiculos?: number; financeiro?: number };
  inventarioPercentual?: number;
  garantias?: { aplicacaoPercentual?: number; mesesAfastamento?: number };
  proposta?: {
    linhas?: LinhaProposta[];
    investimentoMensal?: number;
    investimentoAnual?: number;
    /** Sobrescreve a soma dos capitais (o modelo da Milena traz um total
     * que não é a soma das linhas — o corretor pode ter motivo). */
    capitalDisponibilizado?: number;
  };
  /** Páginas que o corretor desligou. Ausente = todas ligadas. */
  paginas?: Partial<Record<PaginaOpcional, boolean>>;
}

export type PaginaOpcional =
  | 'planejamento' | 'padraoVida' | 'filhos' | 'aposentadoria' | 'ausencia'
  | 'sucessorio' | 'garantias' | 'protecao' | 'explicacoes';

/**
 * Catálogo das coberturas da tabela "Proteção Financeira", na ordem e nas
 * cores do modelo. `explicacao` aponta para as páginas fixas da MetLife
 * (índices dentro de modelos/apresentacao/metlife-coberturas.pdf, que são
 * as páginas 12-38 do modelo).
 */
export const COBERTURAS: Record<string, {
  nome: string; situacao: string; cor: string; fundo: string; explicacao: number[];
}> = {
  invalidez_acidente_majorada: { nome: 'Invalidez por acidente majorada', situacao: 'Aposentadoria precoce', cor: '#3D63B5', fundo: '#EEF3FC', explicacao: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13] },
  invalidez_acidente: { nome: 'Invalidez por acidente', situacao: 'Aposentadoria precoce', cor: '#3D63B5', fundo: '#EEF3FC', explicacao: [2, 3, 4, 5, 6, 7, 8, 9, 10] },
  doenca_grave: { nome: 'Doença grave + proteção', situacao: 'Proteção de patrimônio', cor: '#D27A6F', fundo: '#F6DEDB', explicacao: [0, 1] },
  diaria_hospitalar: { nome: 'Diária hospitalar', situacao: 'Garantia de despesas', cor: '#F0B952', fundo: '#FBF0DC', explicacao: [21] },
  fratura_ossea: { nome: 'Fratura óssea', situacao: 'Acidente pessoal', cor: '#5FC54A', fundo: '#E5FBE1', explicacao: [22, 23] },
  cirurgias: { nome: 'Cirurgias', situacao: 'Suporte financeiro', cor: '#4C992A', fundo: '#E3F2DD', explicacao: [14, 15, 16, 17, 18, 19, 20] },
  invalidez_doenca: { nome: 'Invalidez por doença', situacao: 'Aposentadoria antecipada', cor: '#E0645A', fundo: '#FBECEB', explicacao: [25, 26] },
  diaria_incapacidade: { nome: 'Diária incap temporária', situacao: 'Garantia de renda', cor: '#4A78C6', fundo: '#EEF3FC', explicacao: [24] },
  vida_segura: { nome: 'Vida segura', situacao: 'Garantia financeira', cor: '#78A1A5', fundo: '#E6F1F2', explicacao: [] },
  vida_total_legado: { nome: 'Vida total legado', situacao: 'Inventário', cor: '#518FDA', fundo: '#EEF4FC', explicacao: [] },
  amparo_funeral: { nome: 'Amparo funeral familiar', situacao: 'Amparo familiar', cor: '#75757A', fundo: '#EFEFEF', explicacao: [] },
  outra: { nome: 'Outra cobertura', situacao: '', cor: '#5F6B7A', fundo: '#F1F3F5', explicacao: [] },
};

const n = (v: unknown, def = 0): number => {
  const x = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(x) ? x : def;
};
const centavos = (v: number) => Math.round(v * 100) / 100;

export function calcular(d: DadosApresentacao) {
  const c = d.cliente;
  const idade = Math.max(0, Math.floor(n(c.idade)));
  const despesa = n(c.despesaMensal);
  const renda = n(c.rendaFamiliar);
  const conjuge = n(c.rendaConjuge);
  const aposentadoria = Math.floor(n(c.idadeAposentadoria, 65)) || 65;

  // Padrão de vida: despesa × 12 × anos até a aposentadoria.
  const anosProdutivos = Math.max(0, aposentadoria - idade);
  const responsabilidade = centavos(despesa * 12 * anosProdutivos);

  // Filhos: uma fatia da despesa (23%) por mês até os 22 anos. O modelo
  // conta "anos completos que faltam" — 4 anos de idade dá 17, não 18.
  const pct = n(d.educacaoPercentual, 23);
  const ate = Math.floor(n(d.educacaoAteIdade, 22)) || 22;
  const filhos = (d.filhos || [])
    .filter((f) => f && String(f.nome || '').trim())
    .map((f) => {
      const anos = Math.max(0, ate - 1 - Math.floor(n(f.idade)));
      const mensal = centavos(despesa * pct / 100);
      return { nome: String(f.nome).trim(), idade: Math.floor(n(f.idade)), anos, mensal, total: centavos(mensal * 12 * anos) };
    });
  const totalFilhos = centavos(filhos.reduce((s, f) => s + f.total, 0));

  // Planejamento: quanto da renda a despesa consome.
  const comprometimento = renda > 0 ? Math.min(1, despesa / renda) : 0;

  // Sucessório: o inventário custa ~11% do patrimônio.
  const p = d.patrimonio || {};
  const patrimonio = { imoveis: n(p.imoveis), veiculos: n(p.veiculos), financeiro: n(p.financeiro) };
  const totalPatrimonio = centavos(patrimonio.imoveis + patrimonio.veiculos + patrimonio.financeiro);
  const pctInventario = n(d.inventarioPercentual, 11);
  const inventario = centavos(totalPatrimonio * pctInventario / 100);

  // Garantias: se o titular para de render, a família vive da renda do
  // cônjuge e falta a diferença (o "gap"). Invalidez cobre o gap com um
  // capital que, aplicado a 1% ao mês, rende o gap; doença grave cobre
  // 24 meses de afastamento.
  const g = d.garantias || {};
  const rendaTitular = Math.max(0, renda - conjuge);
  const gap = Math.max(0, despesa - conjuge);
  const aplicacao = n(g.aplicacaoPercentual, 1);
  const meses = Math.floor(n(g.mesesAfastamento, 24)) || 24;
  const necessarioInvalidez = aplicacao > 0 ? centavos(gap / (aplicacao / 100)) : 0;
  const necessarioDoenca = centavos(gap * meses);

  // Proteção financeira: soma do que a proposta entrega.
  const linhas = (d.proposta?.linhas || [])
    .filter((l) => l && (n(l.capital) > 0 || n(l.valor) > 0))
    .map((l) => {
      const cat = COBERTURAS[l.cobertura] || COBERTURAS.outra;
      return {
        chave: COBERTURAS[l.cobertura] ? l.cobertura : 'outra',
        nome: (l.nome && l.nome.trim()) || cat.nome,
        situacao: (l.situacao && l.situacao.trim()) || cat.situacao,
        capital: n(l.capital),
        periodo: (l.periodo || '').trim(),
        valor: n(l.valor),
        cor: cat.cor,
        fundo: cat.fundo,
      };
    });
  const capitalDisponibilizado = n(d.proposta?.capitalDisponibilizado) || centavos(linhas.reduce((s, l) => s + l.capital, 0));
  const somaValores = centavos(linhas.reduce((s, l) => s + l.valor, 0));
  // Vazio = automático: mensal é a soma das coberturas, anual é 12× o mensal
  // (o corretor digita o anual da cotação quando a MetLife dá desconto à vista).
  const investimentoMensal = n(d.proposta?.investimentoMensal) || somaValores;
  const investimentoAnual = n(d.proposta?.investimentoAnual) || centavos(investimentoMensal * 12);
  const automatico = {
    investimentoMensal: !n(d.proposta?.investimentoMensal),
    investimentoAnual: !n(d.proposta?.investimentoAnual),
    capitalDisponibilizado: !n(d.proposta?.capitalDisponibilizado),
  };
  const investimentoDiario = centavos(investimentoMensal / 30);

  // Páginas fixas da MetLife: só as das coberturas que estão na proposta,
  // na ordem do modelo e sem repetir.
  const explicacoes = [...new Set(linhas.flatMap((l) => (COBERTURAS[l.chave]?.explicacao || [])))].sort((a, b) => a - b);

  return {
    idade, despesa, renda, conjuge, aposentadoria,
    anosProdutivos, responsabilidade,
    educacao: { pct, ate, filhos, total: totalFilhos },
    comprometimento,
    patrimonio, totalPatrimonio, pctInventario, inventario,
    garantias: { rendaTitular, gap, aplicacao, meses, necessarioInvalidez, necessarioDoenca },
    linhas, capitalDisponibilizado, investimentoMensal, investimentoAnual, investimentoDiario, automatico,
    temDoencaGrave: linhas.some((l) => l.chave === 'doenca_grave'),
    explicacoes,
  };
}

export type Calculo = ReturnType<typeof calcular>;

/** R$ 1.234.567,89 */
export function brl(v: number): string {
  return 'R$ ' + n(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
