/**
 * Apresentação MetLife — o PDF.
 *
 * Reproduz o modelo de 38 páginas que a equipe usa (projeto "Milena"):
 *
 *   1  capa do corretor                 (gerada)
 *   2  cotação que o corretor subiu     (imagem ou PDF dele, como veio)
 *   3-10 diagnóstico do cliente         (geradas a partir de calculos.ts)
 *   11 abertura do anexo               (gerada, só se houver explicações)
 *   12+ explicação das coberturas       (páginas fixas da MetLife, só as
 *                                        das coberturas que estão na proposta)
 *   fim "muito obrigado" + encerramento (gerada, SEMPRE a última página)
 *
 * No modelo original o "obrigado" vinha antes das tabelas da MetLife, e o PDF
 * terminava numa tabela de cirurgias: nem o cliente nem o corretor sabiam que
 * tinha acabado. Por isso o anexo ganhou uma página que o anuncia e o
 * agradecimento passou para o fim.
 *
 * As páginas geradas são desenhadas com pdfkit e costuradas com as fixas e a
 * cotação via pdf-lib — assim as páginas da MetLife e o PDF da cotação entram
 * vetoriais, sem virar foto.
 *
 * Todas as medidas abaixo estão em "pixels de 1100": a largura da página do
 * modelo renderizada a 1100px. Foi nessa escala que o modelo foi medido, e
 * `P()` converte para pontos (a página tem 720×405 pt). Mexer num número
 * aqui é mexer no mesmo número que se lê na imagem do modelo.
 */
import fs from 'fs';
import path from 'path';
import PDFDocument from 'pdfkit';
import { PDFDocument as PdfLib } from 'pdf-lib';
import { calcular, brl, COBERTURAS, type DadosApresentacao, type Calculo } from './calculos.js';

export interface PerfilCorretor {
  nome: string;
  cargo?: string;
  telefone?: string;
  email?: string;
  susep?: string;
  /** PNG ou JPEG */
  foto?: Buffer | null;
  logo?: Buffer | null;
}

export interface Cotacao { dados: Buffer; tipo: string }

const LARG = 720;
const ALT = 405;
const K = LARG / 1100;
const P = (v: number) => v * K;

const AZUL = '#3D63B5';
const TEXTO = '#2B2B2B';
const CINZA_TEXTO = '#4A4A4A';

export function pastaModelos(): string {
  return process.env.APRESENTACAO_MODELOS || path.resolve(process.cwd(), 'modelos/apresentacao');
}

type Doc = PDFKit.PDFDocument;

function registrarFontes(doc: Doc, pasta: string) {
  const f = (n: string) => path.join(pasta, 'fontes', `Poppins-${n}.ttf`);
  doc.registerFont('R', f('Regular'));
  doc.registerFont('M', f('Medium'));
  doc.registerFont('SB', f('SemiBold'));
  doc.registerFont('B', f('Bold'));
  doc.registerFont('XB', f('ExtraBold'));
  doc.registerFont('I', f('Italic'));
  doc.registerFont('SBI', f('SemiBoldItalic'));
  doc.registerFont('BI', f('BoldItalic'));
}

interface OpTexto {
  fonte?: string; tam?: number; cor?: string; largura?: number;
  alinhar?: 'left' | 'center' | 'right'; espaco?: number;
}

/** Texto numa linha só, em px de 1100. Encolhe a fonte se não couber. */
function texto(doc: Doc, s: string, x: number, y: number, o: OpTexto = {}) {
  const fonte = o.fonte || 'R';
  let tam = o.tam || 14;
  doc.font(fonte).fontSize(P(tam));
  if (o.largura) {
    while (tam > 6 && doc.widthOfString(s, { characterSpacing: P(o.espaco || 0) }) > P(o.largura)) {
      tam -= 0.5;
      doc.fontSize(P(tam));
    }
  }
  doc.fillColor(o.cor || TEXTO).text(s, P(x), P(y), {
    width: o.largura ? P(o.largura) : undefined,
    align: o.alinhar || 'left',
    lineBreak: false,
    characterSpacing: P(o.espaco || 0),
  });
}

/** Texto centralizado vertical e horizontalmente numa caixa. */
function noCentro(doc: Doc, s: string, x: number, y: number, w: number, h: number, o: OpTexto = {}) {
  const tam = o.tam || 14;
  doc.font(o.fonte || 'R').fontSize(P(tam));
  const alturaLinha = doc.currentLineHeight();
  const topo = P(y) + (P(h) - alturaLinha) / 2 + P(tam) * 0.08;
  texto(doc, s, x + 4, topo / K, { ...o, largura: w - 8, alinhar: o.alinhar || 'center' });
}

/** Retângulo com cantos arredondados só em cima (cabeçalho de tabela). */
function topoArredondado(doc: Doc, x: number, y: number, w: number, h: number, r: number) {
  const [X, Y, W, H, R] = [P(x), P(y), P(w), P(h), P(r)];
  doc.moveTo(X, Y + H).lineTo(X, Y + R).quadraticCurveTo(X, Y, X + R, Y)
    .lineTo(X + W - R, Y).quadraticCurveTo(X + W, Y, X + W, Y + R)
    .lineTo(X + W, Y + H).closePath();
}

function caixa(doc: Doc, x: number, y: number, w: number, h: number, cor: string, raio = 0) {
  if (raio) doc.roundedRect(P(x), P(y), P(w), P(h), P(raio));
  else doc.rect(P(x), P(y), P(w), P(h));
  doc.fill(cor);
}

/** Faixa degradê verde→azul da borda esquerda das páginas internas. */
function faixaEsquerda(doc: Doc, largura = 15) {
  const g = doc.linearGradient(0, 0, 0, ALT);
  g.stop(0, '#83C196').stop(0.5, '#6BAFB3').stop(1, '#599CD0');
  doc.rect(0, 0, P(largura), ALT).fill(g);
}

/** Título em duas linhas: preto em cima, azul embaixo, filete preto. */
function titulo(doc: Doc, l1: string, l2: string) {
  texto(doc, l1, 35, 26, { fonte: 'B', tam: 24 });
  texto(doc, l2, 35, 52, { fonte: 'XB', tam: 34, cor: AZUL });
  doc.font('XB').fontSize(P(34));
  const w = Math.max(doc.widthOfString(l2), doc.font('B').fontSize(P(24)).widthOfString(l1)) / K;
  doc.rect(P(35), P(96), P(w + 4), P(2.5)).fill('#111111');
}

/** Título numa linha: parte preta + parte azul. */
function tituloLinha(doc: Doc, preto: string, azul: string, tam = 32, y = 18) {
  texto(doc, preto, 38, y, { fonte: 'B', tam, cor: '#111111' });
  doc.font('B').fontSize(P(tam));
  const wp = doc.widthOfString(preto + ' ') / K;
  texto(doc, azul, 38 + wp, y, { fonte: 'XB', tam, cor: AZUL });
  doc.font('XB').fontSize(P(tam));
  const wa = doc.widthOfString(azul) / K;
  doc.rect(P(38), P(y + tam * 1.55), P(wp + wa + 4), P(2.5)).fill('#111111');
}

function painelDireito(doc: Doc, pasta: string, arquivo: string) {
  doc.image(path.join(pasta, arquivo), P(830), 0, { width: P(270), height: ALT });
}

function fotoCircular(doc: Doc, foto: Buffer | null | undefined, cx: number, cy: number, r: number, aro: number) {
  doc.circle(P(cx), P(cy), P(r + aro)).fill('#FFFFFF');
  if (!foto) {
    doc.circle(P(cx), P(cy), P(r)).fill('#DDE3EA');
    return;
  }
  doc.save();
  doc.circle(P(cx), P(cy), P(r)).clip();
  doc.image(foto, P(cx - r), P(cy - r), { cover: [P(2 * r), P(2 * r)], align: 'center', valign: 'center' });
  doc.restore();
}

/** Ícone a partir de um path SVG 24×24 (Material Icons). */
function icone(doc: Doc, d: string, x: number, y: number, tam: number, cor: string) {
  doc.save();
  doc.translate(P(x), P(y)).scale(P(tam) / 24);
  doc.path(d).fill(cor);
  doc.restore();
}
const ICONE_TELEFONE = 'M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z';
const ICONE_EMAIL = 'M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z';
const ICONE_CADEIRA = 'M12 4a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm7 9v-2c-1.54.02-3.09-.75-4.07-1.83l-1.29-1.43c-.17-.19-.38-.34-.61-.45-.01 0-.01-.01-.02-.01H13c-.35-.2-.75-.3-1.19-.26C10.76 7.11 10 8.04 10 9.09V15c0 1.1.9 2 2 2h5v5h2v-5.5c0-1.1-.9-2-2-2h-3v-3.45c1.29 1.07 3.25 1.94 5 1.95zm-6.17 5c-.41 1.16-1.52 2-2.83 2-1.66 0-3-1.34-3-3 0-1.31.84-2.41 2-2.83V12.1c-2.28.46-4 2.48-4 4.9 0 2.76 2.24 5 5 5 2.42 0 4.44-1.72 4.9-4h-2.07z';

// ─── Páginas ─────────────────────────────────────────────────────────────

function paginaCapa(doc: Doc, pasta: string, perfil: PerfilCorretor) {
  doc.rect(0, 0, LARG, ALT).fill('#FCFBFC');
  doc.image(path.join(pasta, 'capa-painel.jpg'), P(785), 0, { width: P(315), height: ALT });
  if (perfil.logo) {
    doc.image(perfil.logo, P(55), P(18), { fit: [P(140), P(115)], align: 'center', valign: 'center' });
  }
  doc.rect(P(63), P(197), P(5), P(213)).fill('#111111');
  texto(doc, perfil.nome || 'Seu nome', 84, 192, { fonte: 'B', tam: 60, cor: '#111111', largura: 500 });
  let y = 266;
  if (perfil.cargo) { texto(doc, perfil.cargo, 84, y, { tam: 20, largura: 480 }); y += 52; } else y += 30;
  if (perfil.telefone) { texto(doc, perfil.telefone, 84, y, { tam: 20, largura: 480 }); y += 25; }
  if (perfil.email) { texto(doc, perfil.email, 84, y, { tam: 20, largura: 480 }); y += 25; }
  if (perfil.susep) {
    texto(doc, 'SUSEP:', 84, y, { fonte: 'B', tam: 20 });
    doc.font('B').fontSize(P(20));
    const w = doc.widthOfString('SUSEP: ') / K;
    texto(doc, perfil.susep, 84 + w, y, { tam: 20 });
  }
  texto(doc, 'Em parceria com', 62, 548, { fonte: 'SB', tam: 11, cor: '#111111' });
  doc.image(path.join(pasta, 'metlife.png'), P(55), P(570), { width: P(110) });
  fotoCircular(doc, perfil.foto, 785, 308, 177, 11);
}

function paginaPlanejamento(doc: Doc, pasta: string, c: Calculo) {
  doc.image(path.join(pasta, 'fundo-planejamento.jpg'), 0, 0, { width: LARG, height: ALT });
  caixa(doc, 42, 52, 1016, 528, '#FFFFFF', 12);
  texto(doc, 'Planejamento Financeiro Sustentável', 86, 66, { fonte: 'B', tam: 38, cor: '#111111' });
  texto(doc, 'Renda familiar:', 86, 124, { fonte: 'B', tam: 22, cor: '#111111' });
  doc.font('B').fontSize(P(22));
  const w = doc.widthOfString('Renda familiar: ') / K;
  texto(doc, brl(c.renda), 86 + w, 121, { fonte: 'M', tam: 25, cor: '#111111' });

  // Pizza: a fatia é quanto a despesa consome da renda, a partir do topo.
  const cx = P(725), cy = P(370), r = P(185);
  const frac = Math.max(0.001, c.comprometimento);
  if (frac >= 0.999) {
    doc.circle(cx, cy, r).fill('#4A7BD0');
  } else {
    const a0 = -Math.PI / 2, a1 = a0 + frac * 2 * Math.PI;
    const big = frac > 0.5 ? 1 : 0;
    doc.path(`M ${cx} ${cy} L ${cx + r * Math.cos(a0)} ${cy + r * Math.sin(a0)} A ${r} ${r} 0 ${big} 1 ${cx + r * Math.cos(a1)} ${cy + r * Math.sin(a1)} Z`).fill('#4A7BD0');
  }
  // Rótulo dentro da fatia, no meio do arco.
  const am = -Math.PI / 2 + frac * Math.PI;
  const lx = cx + r * 0.55 * Math.cos(am), ly = cy + r * 0.55 * Math.sin(am);
  doc.font('B').fontSize(P(14)).fillColor('#111111');
  const lw = doc.widthOfString(brl(c.despesa));
  doc.text(brl(c.despesa), lx - lw / 2, ly - P(8), { lineBreak: false });
  // Linha até a legenda "PRESENTE".
  doc.moveTo(lx + lw / 2 + P(4), ly + P(30)).lineTo(P(1032), ly + P(30)).lineWidth(0.6).stroke('#666666');
  doc.circle(lx + lw / 2 + P(4), ly + P(30), 1.2).fill('#999999');
  texto(doc, 'PRESENTE', 958, ly / K + 12, { fonte: 'B', tam: 13, cor: '#111111', largura: 74, alinhar: 'right' });
  texto(doc, `${(c.comprometimento * 100).toFixed(1).replace('.', ',')}%`, 958, ly / K + 32, { fonte: 'M', tam: 12, cor: '#8A8A8A', largura: 74, alinhar: 'right' });
}

function tabelaCabecalho(doc: Doc, cols: Array<[number, number, string, number?]>, y: number, h: number, cor = AZUL) {
  for (const [x, w, rotulo, tam] of cols) {
    topoArredondado(doc, x, y, w, h, 8);
    doc.fill(cor);
    const linhas = rotulo.split('\n');
    if (linhas.length === 1) noCentro(doc, rotulo, x, y, w, h, { fonte: 'B', tam: tam || 18, cor: '#FFFFFF' });
    else {
      noCentro(doc, linhas[0], x, y + 2, w, h / 2, { fonte: 'B', tam: tam || 14, cor: '#FFFFFF' });
      noCentro(doc, linhas[1], x, y + h / 2 - 2, w, h / 2, { fonte: 'B', tam: tam || 14, cor: '#FFFFFF' });
    }
  }
}

function caixaTotal(doc: Doc, frase: string, valor: number, yFrase: number, yCaixa: number, x0 = 266, w = 346) {
  texto(doc, frase, 40, yFrase, { fonte: 'M', tam: 22, cor: CINZA_TEXTO, largura: 790, alinhar: 'center' });
  caixa(doc, x0, yCaixa, w, 63, '#F0F0F0', 5);
  noCentro(doc, brl(valor), x0, yCaixa, w, 63, { fonte: 'B', tam: 31, cor: '#3A3A3A' });
}

function paginaPadraoVida(doc: Doc, pasta: string, c: Calculo) {
  faixaEsquerda(doc);
  painelDireito(doc, pasta, 'painel-p04.jpg');
  titulo(doc, 'PADRÃO', 'DE VIDA');
  const cols: Array<[number, number, string, number?]> = [
    [57, 225, 'Despesa mensal', 18], [291, 71, 'Idade', 13],
    [371, 173, `Fase produtiva\naté ${c.aposentadoria} anos`, 15], [552, 234, 'Responsabilidade total', 16],
  ];
  tabelaCabecalho(doc, cols, 180, 47);
  const valores = [brl(c.despesa), String(c.idade), `${c.anosProdutivos} anos`, brl(c.responsabilidade)];
  cols.forEach(([x, w], i) => {
    caixa(doc, x, 234, w, 48, '#F6FAFF', 4);
    noCentro(doc, valores[i], x, 234, w, 48, { fonte: 'SB', tam: 19, cor: TEXTO });
  });
  caixaTotal(doc, 'Valor total para manutenção do padrão de vida:', c.responsabilidade, 365, 430);
}

function paginaFilhos(doc: Doc, pasta: string, c: Calculo) {
  faixaEsquerda(doc);
  painelDireito(doc, pasta, 'painel-p05.jpg');
  titulo(doc, 'CRIAÇÃO E', 'EDUCAÇÃO DOS FILHOS');
  const cols: Array<[number, number, string, number?]> = [
    [37, 301, 'Filho(a)', 19], [345, 70, 'Idade', 14], [423, 101, `Até os\n${c.educacao.ate} anos`, 15],
    [531, 116, `Média\nmensal ${String(c.educacao.pct).replace('.', ',')}%`, 13], [655, 167, 'Valor total', 18],
  ];
  tabelaCabecalho(doc, cols, 152, 48);
  const filhos = c.educacao.filhos;
  const alturaCorpo = Math.max(113, 28 + filhos.length * 30);
  doc.roundedRect(P(37), P(200), P(785), P(alturaCorpo), P(10)).fill('#F3F7FE');
  filhos.forEach((f, i) => {
    const y = 210 + i * 30;
    const vals = [f.nome.toUpperCase(), String(f.idade), String(f.anos), brl(f.mensal), brl(f.total)];
    const tams = [15, 16, 16, 13, 15];
    cols.forEach(([x, w], j) => noCentro(doc, vals[j], x, y, w, 26, { fonte: j === 3 ? 'SB' : 'SB', tam: tams[j], cor: TEXTO }));
  });
  if (!filhos.length) noCentro(doc, 'Nenhum filho informado', 37, 210, 785, 26, { tam: 14, cor: '#8A8A8A' });
  caixaTotal(doc, 'Valor total para investimento na criação e educação dos filhos:', c.educacao.total, 470, 514);
}

function paginaGrafico(doc: Doc, pasta: string, c: Calculo, l1: string, l2: string, painel: string) {
  faixaEsquerda(doc);
  painelDireito(doc, pasta, painel);
  titulo(doc, l1, l2);

  // Legenda
  doc.rect(P(247), P(122), P(15), P(15)).fill('#58B25D');
  texto(doc, 'DESPESA FAMILIAR', 273, 120, { tam: 14, cor: '#333333' });
  doc.moveTo(P(432), P(130)).lineTo(P(474), P(130)).lineWidth(P(3)).dash(P(10), { space: P(6) }).stroke('#5B6FE0');
  doc.undash();
  texto(doc, 'RENDA FAMILIAR', 486, 120, { tam: 14, cor: '#333333' });

  // Eixos: 5 marcos igualmente espaçados, como no modelo.
  const x0 = 115, x1 = 798, yTopo = 162, yBase = 517;
  const xs = [0, 1, 2, 3, 4].map((i) => x0 + (x1 - x0) * i / 4);
  const marcos = ['0', String(c.idade), String(c.idade + 1), String(c.aposentadoria), '100'];
  const maximo = Math.max(10000, Math.ceil(Math.max(c.renda, c.despesa) / 10000) * 10000);
  const yv = (v: number) => yBase - (yBase - yTopo) * (v / maximo);

  for (let i = 0; i <= 5; i++) {
    const y = yBase - (yBase - yTopo) * i / 5;
    doc.moveTo(P(x0), P(y)).lineTo(P(x1), P(y)).lineWidth(0.5).stroke('#D5D9DD');
  }
  // Área da despesa
  const yD = yv(c.despesa);
  doc.rect(P(x0), P(yD), P(x1 - x0), P(yBase - yD)).fill('#E1EFE1');
  doc.moveTo(P(x0), P(yD)).lineTo(P(x1), P(yD)).lineWidth(P(2.5)).stroke('#58B25D');
  doc.moveTo(P(x0), P(yTopo)).lineTo(P(x0), P(yBase)).lineTo(P(x1), P(yBase)).lineWidth(P(1.5)).stroke('#333333');

  // Renda: igual até a idade atual e zera no ano seguinte — o seguro é
  // individual, então não se conta com a renda de mais ninguém.
  const rendaPts = [c.renda, c.renda, 0, 0, 0];
  doc.moveTo(P(xs[0]), P(yv(rendaPts[0])));
  for (let i = 1; i < 5; i++) doc.lineTo(P(xs[i]), P(yv(rendaPts[i])));
  doc.lineWidth(P(3)).dash(P(10), { space: P(6) }).stroke('#5B6FE0');
  doc.undash();

  // Rótulos: o de cima vai ACIMA da sua linha e o de baixo ABAIXO da dele.
  // Antes os dois iam abaixo, e com valores próximos um escrevia por cima
  // do outro.
  xs.forEach((x, i) => {
    const w = 120;
    texto(doc, marcos[i], x - 30, yBase + 8, { tam: 14, cor: '#333333', largura: 60, alinhar: 'center' });
    const yr = yv(rendaPts[i]);
    const rendaEmCima = yr <= yD;
    texto(doc, brl(c.despesa), x - w / 2, rendaEmCima ? yD + 10 : yD - 28, { fonte: 'B', tam: 14, cor: '#4CAF50', largura: w, alinhar: 'center' });
    // Renda zerada não ganha rótulo: a linha no chão já diz, e o "R$ 0,00"
    // cairia em cima das idades do eixo.
    if (rendaPts[i] > 0 && Math.abs(yr - yD) > 3) texto(doc, brl(rendaPts[i]), x - w / 2, rendaEmCima ? yr - 32 : yr + 10, { fonte: 'B', tam: 14, cor: '#6C7FE0', largura: w, alinhar: 'center' });
  });
}

function paginaSucessorio(doc: Doc, pasta: string, c: Calculo) {
  faixaEsquerda(doc);
  painelDireito(doc, pasta, 'painel-p08.jpg');
  titulo(doc, 'PLANEJAMENTO', 'SUCESSÓRIO FAMILIAR');
  // Patrimônio
  topoArredondado(doc, 67, 152, 334, 47, 8); doc.fill(AZUL);
  noCentro(doc, 'Patrimônio familiar', 67, 152, 334, 47, { fonte: 'SB', tam: 19, cor: '#FFFFFF' });
  const pat: Array<[string, number]> = [['Imóveis', c.patrimonio.imoveis], ['Veículos', c.patrimonio.veiculos], ['Financeiro', c.patrimonio.financeiro], ['Valor total', c.totalPatrimonio]];
  pat.forEach(([rot, v], i) => {
    const y = 199 + i * 37;
    caixa(doc, 67, y, 116, 37, AZUL);
    noCentro(doc, rot, 67, y, 116, 37, { fonte: 'SB', tam: 15, cor: '#FFFFFF' });
    caixa(doc, 183, y, 218, 37, i === 3 ? '#DCE7F8' : '#F2F6FD');
    noCentro(doc, brl(v), 183, y, 210, 37, { fonte: i === 3 ? 'B' : 'M', tam: i === 3 ? 18 : 17, cor: TEXTO, alinhar: 'right' });
  });
  // Custos
  topoArredondado(doc, 456, 152, 333, 47, 8); doc.fill('#93C443');
  noCentro(doc, 'Custos para inventário', 456, 152, 333, 47, { fonte: 'SB', tam: 19, cor: '#FFFFFF' });
  const custos: Array<[string, string]> = [['ITCMD', '2-8%'], ['Advogados', '5-10%'], ['Documentação', '1-3%'], ['Valor total', `${String(c.pctInventario).replace('.', ',')}%`]];
  custos.forEach(([rot, v], i) => {
    const y = 199 + i * 37;
    caixa(doc, 456, y, 154, 37, '#B1D25F');
    noCentro(doc, rot, 456, y, 154, 37, { fonte: 'SB', tam: 15, cor: '#FFFFFF' });
    caixa(doc, 610, y, 179, 37, i === 3 ? '#E6FCA8' : '#F8FEE8');
    noCentro(doc, v, 610, y, 179, 37, { fonte: 'SB', tam: 17, cor: TEXTO });
  });
  texto(doc, 'Valor estimado para realização do processo de inventário:', 40, 388, { fonte: 'M', tam: 22, cor: CINZA_TEXTO, largura: 800, alinhar: 'center' });
  // "OBS: Prazo legal ...: 60 dias" com o destaque amarelo no prazo.
  doc.font('I').fontSize(P(14));
  const f1 = 'OBS: Prazo legal para iniciar o processo: ';
  const w1 = doc.widthOfString(f1) / K;
  doc.font('BI').fontSize(P(14));
  const w2 = doc.widthOfString('60 dias') / K;
  const xi = 440 - (w1 + w2) / 2;
  texto(doc, f1, xi, 418, { fonte: 'I', tam: 14, cor: '#333333' });
  caixa(doc, xi + w1 - 2, 418, w2 + 4, 21, '#FFF3B0', 3);
  texto(doc, '60 dias', xi + w1, 418, { fonte: 'BI', tam: 14, cor: '#333333' });
  caixa(doc, 275, 476, 346, 63, '#F0F0F0', 5);
  noCentro(doc, brl(c.inventario), 275, 476, 346, 63, { fonte: 'B', tam: 31, cor: '#3A3A3A' });
}

function paginaGarantias(doc: Doc, pasta: string, c: Calculo) {
  faixaEsquerda(doc);
  painelDireito(doc, pasta, 'painel-p09.jpg');
  tituloLinha(doc, 'GARANTIAS EM', 'SITUAÇÕES DE IMPREVISTOS', 30, 18);
  const g = c.garantias;
  const [xL, wL, xA, wA, xB, wB] = [38, 203, 249, 191, 440, 187];
  // Cabeçalhos
  topoArredondado(doc, xA, 84, wA, 37, 10); doc.fill('#E4C865');
  noCentro(doc, 'INVALIDEZ', xA, 84, wA - 30, 37, { fonte: 'B', tam: 15, cor: '#FFFFFF' });
  icone(doc, ICONE_CADEIRA, xA + wA - 42, 90, 24, '#FFFFFF');
  topoArredondado(doc, xB, 84, wB, 37, 10); doc.fill('#D27A6F');
  noCentro(doc, 'DOENÇA GRAVE', xB, 84, wB - 30, 37, { fonte: 'B', tam: 15, cor: '#FFFFFF' });
  doc.circle(P(xB + wB - 26), P(102), P(11)).fill('#FFFFFF');
  doc.rect(P(xB + wB - 32), P(100), P(12), P(4)).fill('#D27A6F');
  doc.rect(P(xB + wB - 28), P(96), P(4), P(12)).fill('#D27A6F');

  const linha = (y: number, h: number, rotulo: string, a: string, b: string, estilo: 'normal' | 'riscado' | 'gap' | 'estrategia' | 'capital') => {
    if (estilo === 'gap' || estilo === 'capital') {
      texto(doc, rotulo, xL, y + h / 2 - 11, { fonte: 'BI', tam: 15, cor: '#333333', largura: wL - 10, alinhar: 'right' });
    } else {
      caixa(doc, xL, y, wL, h, '#A2A2A2', 4);
      noCentro(doc, rotulo, xL + 6, y, wL - 12, h, { fonte: 'B', tam: 12, cor: '#FFFFFF', alinhar: 'left' });
    }
    const fundoA = estilo === 'gap' ? '#F8EFC1' : estilo === 'capital' ? '#5E9F64' : '#FDFAE9';
    const fundoB = estilo === 'gap' ? '#F9E3E1' : estilo === 'capital' ? '#5E9F64' : '#FDF7F7';
    caixa(doc, xA, y, wA, h, fundoA);
    caixa(doc, xB, y, wB, h, fundoB);
    const op = (cor: string): OpTexto => {
      if (estilo === 'riscado') return { fonte: 'BI', tam: 16, cor: '#E03C2E' };
      if (estilo === 'gap') return { fonte: 'B', tam: 17, cor };
      if (estilo === 'estrategia') return { fonte: 'BI', tam: 10.5, cor: '#444444' };
      if (estilo === 'capital') return { fonte: 'B', tam: 18, cor: '#FFFFFF' };
      return { fonte: 'M', tam: 17, cor: TEXTO };
    };
    const escrever = (s: string, x: number, w: number, cor: string) => {
      const o = op(cor);
      noCentro(doc, s, x, y, w, h, o);
      if (estilo === 'riscado' || estilo === 'estrategia') {
        doc.font(o.fonte!).fontSize(P(o.tam!));
        const tw = doc.widthOfString(s) / K;
        const yy = estilo === 'riscado' ? y + h / 2 + 1 : y + h / 2 + 8;
        doc.moveTo(P(x + w / 2 - tw / 2), P(yy)).lineTo(P(x + w / 2 + tw / 2), P(yy)).lineWidth(P(estilo === 'riscado' ? 2 : 1)).stroke(estilo === 'riscado' ? '#E03C2E' : '#444444');
      }
    };
    escrever(a, xA, wA, '#BA9C22');
    escrever(b, xB, wB, '#D27A6F');
  };
  linha(122, 33, 'PADRÃO DE VIDA', brl(c.despesa), brl(c.despesa), 'normal');
  linha(160, 32, 'RENDA DO TITULAR', brl(g.rendaTitular), brl(g.rendaTitular), 'riscado');
  linha(198, 32, 'GAP FINANCEIRO', brl(g.gap), brl(g.gap), 'gap');
  linha(237, 31, 'ESTRATÉGIA FINANCEIRA', `APLICAÇÃO FINANCEIRA ${String(g.aplicacao).replace('.', ',')}%`, `${g.meses} MESES DE AFASTAMENTO`, 'estrategia');
  linha(275, 32, 'VALOR NECESSÁRIO', brl(g.necessarioInvalidez), brl(g.necessarioDoenca), 'normal');
  linha(313, 32, 'CAPITAL NECESSÁRIO', brl(g.necessarioInvalidez), brl(g.necessarioDoenca), 'capital');
}

function paginaProtecao(doc: Doc, pasta: string, c: Calculo, nomeCliente: string) {
  faixaEsquerda(doc, 10);
  const gb = doc.linearGradient(P(990), 0, LARG, 0); gb.stop(0, '#4A86D0').stop(1, '#6CBF92');
  doc.rect(P(990), P(612), P(110), P(6)).fill(gb);
  doc.image(path.join(pasta, 'apx.png'), P(1050), P(6), { width: P(42) });
  tituloLinha(doc, 'PROTEÇÃO', 'FINANCEIRA', 32, 12);

  const cols: Array<[number, number, string, number]> = [
    [30, 203, 'IMPREVISTO', 14], [235, 163, 'SITUAÇÃO', 14], [400, 158, 'CAPITAL DISPONIBILIZADO', 9],
    [562, 93, 'PERÍODO', 14], [657, 113, 'VALOR', 14],
  ];
  for (const [x, w, rot, tam] of cols) {
    topoArredondado(doc, x, 73, w, 28, 8); doc.fill('#DCDCDC');
    noCentro(doc, rot, x, 73, w, 28, { fonte: 'M', tam, cor: '#333333' });
  }
  const linhas = c.linhas.slice(0, 11);
  const passo = linhas.length > 10 ? 34.5 : 38;
  linhas.forEach((l, i) => {
    const y = 106 + i * passo, h = passo - 4;
    caixa(doc, 30, y, 203, h, l.cor);
    const nome = l.nome.toUpperCase();
    doc.font('B').fontSize(P(11));
    if (doc.widthOfString(nome) / K > 190) {
      // Duas linhas, como "INVALIDEZ POR ACIDENTE / MAJORADA" no modelo.
      const partes = nome.split(' ');
      let a = '';
      while (partes.length && doc.widthOfString(a + partes[0]) / K < 185) a += partes.shift() + ' ';
      texto(doc, a.trim(), 39, y + h / 2 - 14, { fonte: 'B', tam: 11, cor: '#FFFFFF', largura: 190 });
      texto(doc, partes.join(' '), 39, y + h / 2 - 1, { fonte: 'B', tam: 11, cor: '#FFFFFF', largura: 190 });
    } else {
      noCentro(doc, nome, 39, y, 190, h, { fonte: 'B', tam: 12, cor: '#FFFFFF', alinhar: 'left' });
    }
    caixa(doc, 233, y, 537, h, l.fundo);
    noCentro(doc, l.situacao, 241, y, 157, h, { tam: l.situacao.length > 20 ? 11 : 13.5, cor: '#222222', alinhar: 'left' });
    noCentro(doc, brl(l.capital), 400, y, 152, h, { tam: 17, cor: '#222222', alinhar: 'right' });
    noCentro(doc, l.periodo, 562, y, 93, h, { fonte: 'BI', tam: 11, cor: '#222222' });
    noCentro(doc, brl(l.valor), 657, y, 106, h, { fonte: 'B', tam: 16, cor: '#222222', alinhar: 'right' });
  });

  const cx = 935;
  texto(doc, 'CAPITAL DISPONIBILIZADO', 787, 106, { fonte: 'SB', tam: 19, cor: '#222222', largura: 296, alinhar: 'center' });
  caixa(doc, 787, 133, 296, 43, '#56A84F', 5);
  noCentro(doc, brl(c.capitalDisponibilizado), 787, 133, 296, 43, { fonte: 'B', tam: 22, cor: '#FFFFFF' });
  caixa(doc, 787, 207, 296, 29, '#DCDCDC', 8);
  noCentro(doc, 'INVESTIMENTO', 787, 207, 296, 29, { fonte: 'SB', tam: 17, cor: '#333333' });
  const primeiro = (nomeCliente || '').trim().split(/\s+/)[0]?.toUpperCase() || '';
  const temAnual = c.investimentoAnual > 0; // anual vazio = 12× o mensal
  const blocos: Array<[number, string, number]> = temAnual
    ? [[787, 'mensal', c.investimentoMensal], [943, 'anual', c.investimentoAnual]]
    : [[865, 'mensal', c.investimentoMensal]];
  for (const [x, per, v] of blocos) {
    texto(doc, `Projeto ${primeiro}`, x, 250, { fonte: 'SB', tam: 12, cor: '#222222', largura: 140, alinhar: 'center' });
    texto(doc, `(${per})`, x, 266, { fonte: 'SB', tam: 12, cor: '#222222', largura: 140, alinhar: 'center' });
    caixa(doc, x, 291, 140, 42, '#E6F3FE', 6);
    noCentro(doc, brl(v), x, 291, 140, 42, { fonte: 'B', tam: 14, cor: '#4A78C6' });
  }
  texto(doc, 'Investimento diário', 787, 410, { fonte: 'SB', tam: 21, cor: '#333333', largura: 296, alinhar: 'center' });
  caixa(doc, cx - 80, 440, 160, 44, '#E7FDE3', 4);
  noCentro(doc, brl(c.investimentoDiario), cx - 80, 440, 160, 44, { fonte: 'B', tam: 20, cor: '#43A047' });

  if (c.temDoencaGrave) {
    const dg = 'COBERTURAS DG: • Câncer • Infarto • By-pass • Insuficiência Renal • Cirurgia de Válvulas do Coração • Cirurgia de Aorta • AVC • Paralisia de Membros • Cegueira • Surdez • Esclerose Múltipla • Parkinson • Alzheimer • Grande Queimado • Transplante de Fígado • Transplante de Pâncreas • Transplante de Pulmão • Transplante de Rim • Transplante de Coração • Transplante de Medula Óssea • Anemia Aplástica • Lúpus Sistêmico • Angioplastia • ELA • Perda da Fala • Pancreatite Crônica • Hepatite Viral do Tipo C • Enfisema Pulmonar • Cirrose Hepática • SIDA (HIV)';
    doc.font('R').fontSize(P(10)).fillColor('#222222').text(dg, P(14), P(568), { width: P(1060), lineGap: 1 });
  }
}

/** Separa a apresentação do anexo: diz o que vem e que o fim vem depois. */
function paginaAnexo(doc: Doc, c: Calculo) {
  faixaEsquerda(doc);
  titulo(doc, 'ANEXO', 'DETALHES DAS COBERTURAS');
  const intro = 'Nas próximas páginas estão as condições da MetLife para cada cobertura da sua proposta: '
    + 'como funciona, carências e a tabela de percentuais sobre o capital. São material de consulta — '
    + 'a sua proposta é a que você acabou de ver.';
  doc.font('R').fontSize(P(17)).fillColor(CINZA_TEXTO)
    .text(intro, P(38), P(132), { width: P(700), lineGap: P(4) });
  texto(doc, 'COBERTURAS DETALHADAS', 38, 262, { fonte: 'SB', tam: 15, cor: '#222222', espaco: 1 });
  const vistas = new Set<string>();
  let y = 296;
  for (const l of c.linhas) {
    if (vistas.has(l.chave) || !COBERTURAS[l.chave]?.explicacao.length) continue;
    vistas.add(l.chave);
    caixa(doc, 38, y, 10, 36, l.cor, 2);
    caixa(doc, 48, y, 560, 36, l.fundo);
    noCentro(doc, l.nome, 62, y, 540, 36, { fonte: 'SB', tam: 15, cor: '#222222', alinhar: 'left' });
    y += 46;
    if (y > 560) break;
  }
  texto(doc, 'Ao final, o encerramento com os contatos do seu consultor.', 38, 588, { fonte: 'I', tam: 13, cor: '#6B6B6B', largura: 760 });
}

function paginaObrigado(doc: Doc, pasta: string, perfil: PerfilCorretor, cliente: string) {
  doc.image(path.join(pasta, 'fundo-obrigado.jpg'), 0, 0, { width: LARG, height: ALT });
  // Cartão com o degradê do modelo, redesenhado por cima do original.
  const g = doc.linearGradient(P(290), 0, P(772), 0);
  g.stop(0, '#74B7A6').stop(1, '#5BA0CF');
  doc.roundedRect(P(290), P(160), P(482), P(296), P(22)).fill(g);
  texto(doc, 'MUITO OBRIGADO', 400, 196, { fonte: 'B', tam: 31, cor: '#FFFFFF', largura: 360 });
  doc.rect(P(421), P(272), P(2.5), P(148)).fill('#FFFFFF');
  texto(doc, perfil.nome || '', 430, 278, { fonte: 'B', tam: 30, cor: '#FFFFFF', largura: 330 });
  let y = 330;
  if (perfil.telefone) {
    doc.circle(P(442), P(y + 14), P(10)).fill('#FFFFFF');
    icone(doc, ICONE_TELEFONE, 434, y + 6, 16, '#5BA0CF');
    texto(doc, perfil.telefone, 460, y, { tam: 19, cor: '#FFFFFF', largura: 300 });
    y += 29;
  }
  if (perfil.email) {
    doc.circle(P(442), P(y + 14), P(10)).fill('#FFFFFF');
    icone(doc, ICONE_EMAIL, 434, y + 6, 16, '#5BA0CF');
    texto(doc, perfil.email, 460, y, { tam: 19, cor: '#FFFFFF', largura: 300 });
  }
  fotoCircular(doc, perfil.foto, 235, 308, 150, 9);
  // Encerramento explícito: a última página tem de dizer que é a última.
  const hoje = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const para = cliente.trim() ? `Proposta preparada para ${cliente.trim()} · ${hoje}` : `Proposta preparada em ${hoje}`;
  caixa(doc, 290, 500, 482, 58, '#FFFFFF', 12);
  texto(doc, 'FIM DA APRESENTAÇÃO', 290, 508, { fonte: 'B', tam: 15, cor: '#3D63B5', largura: 482, alinhar: 'center', espaco: 2 });
  texto(doc, para, 290, 532, { tam: 12, cor: '#4A4A4A', largura: 482, alinhar: 'center' });
}

// ─── Montagem ────────────────────────────────────────────────────────────

function temAnexo(dados: DadosApresentacao, c: Calculo): boolean {
  return dados.paginas?.explicacoes !== false && c.explicacoes.length > 0;
}

/** Gera só as páginas desenhadas. Devolve o PDF e quantas vêm antes da cotação. */
function gerarPaginas(dados: DadosApresentacao, perfil: PerfilCorretor, c: Calculo, pasta: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: [LARG, ALT], margin: 0, autoFirstPage: false, info: { Title: `Apresentação — ${dados.cliente.nome}`, Author: perfil.nome || 'EVOX' } });
    const partes: Buffer[] = [];
    doc.on('data', (b: Buffer) => partes.push(b));
    doc.on('end', () => resolve(Buffer.concat(partes)));
    doc.on('error', reject);
    registrarFontes(doc, pasta);
    const liga = (p: keyof NonNullable<DadosApresentacao['paginas']>) => dados.paginas?.[p] !== false;
    const nova = () => doc.addPage({ size: [LARG, ALT], margin: 0 });

    nova(); paginaCapa(doc, pasta, perfil);
    if (liga('planejamento')) { nova(); paginaPlanejamento(doc, pasta, c); }
    if (liga('padraoVida')) { nova(); paginaPadraoVida(doc, pasta, c); }
    if (liga('filhos') && c.educacao.filhos.length) { nova(); paginaFilhos(doc, pasta, c); }
    if (liga('aposentadoria')) { nova(); paginaGrafico(doc, pasta, c, 'APOSENTADORIA', 'PRECOCE', 'painel-p06.jpg'); }
    if (liga('ausencia')) { nova(); paginaGrafico(doc, pasta, c, 'AUSÊNCIA', 'PREMATURA', 'painel-p07.jpg'); }
    if (liga('sucessorio') && c.totalPatrimonio > 0) { nova(); paginaSucessorio(doc, pasta, c); }
    if (liga('garantias')) { nova(); paginaGarantias(doc, pasta, c); }
    if (liga('protecao') && c.linhas.length) { nova(); paginaProtecao(doc, pasta, c, dados.cliente.nome); }
    if (temAnexo(dados, c)) { nova(); paginaAnexo(doc, c); }
    nova(); paginaObrigado(doc, pasta, perfil, dados.cliente.nome || '');
    doc.end();
  });
}

export async function gerarApresentacao(dados: DadosApresentacao, perfil: PerfilCorretor, cotacao?: Cotacao | null): Promise<Buffer> {
  const pasta = pastaModelos();
  const c = calcular(dados);
  const geradas = await PdfLib.load(await gerarPaginas(dados, perfil, c, pasta));
  const final = await PdfLib.create();
  final.setTitle(`Apresentação — ${dados.cliente.nome}`);
  final.setAuthor(perfil.nome || 'EVOX');

  const total = geradas.getPageCount();
  const [capa] = await final.copyPages(geradas, [0]);
  final.addPage(capa);

  // A cotação entra logo depois da capa, do jeito que o corretor subiu.
  if (cotacao?.dados?.length) {
    if (cotacao.tipo === 'application/pdf') {
      const cot = await PdfLib.load(cotacao.dados, { ignoreEncryption: true });
      const pags = await final.copyPages(cot, cot.getPageIndices());
      pags.forEach((p) => final.addPage(p));
    } else {
      const img = cotacao.tipo === 'image/png' ? await final.embedPng(cotacao.dados) : await final.embedJpg(cotacao.dados);
      const altura = Math.round(LARG * img.height / img.width);
      const pg = final.addPage([LARG, altura]);
      pg.drawImage(img, { x: 0, y: 0, width: LARG, height: altura });
    }
  }

  // Diagnóstico (e a abertura do anexo, se houver) — tudo menos capa e obrigado.
  const meio = await final.copyPages(geradas, Array.from({ length: total - 2 }, (_, i) => i + 1));
  meio.forEach((p) => final.addPage(p));

  if (temAnexo(dados, c)) {
    const fixas = await PdfLib.load(fs.readFileSync(path.join(pasta, 'metlife-coberturas.pdf')));
    const pags = await final.copyPages(fixas, c.explicacoes.filter((i) => i < fixas.getPageCount()));
    pags.forEach((p) => final.addPage(p));
  }

  const [obrigado] = await final.copyPages(geradas, [total - 1]);
  final.addPage(obrigado);
  return Buffer.from(await final.save());
}
