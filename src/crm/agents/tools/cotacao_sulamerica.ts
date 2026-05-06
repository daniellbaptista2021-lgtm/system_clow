/**
 * cotar_sulamerica_api — chama a API REAL do cotador SulAmerica
 * (https://cotador.sulamerica.pvcorretor01.com.br/api/cotar) e devolve
 * a cotacao oficial com valores corretos.
 *
 * Substitui o cálculo offline da `gerar_cotacao_sulamerica` (PR 5.1) que
 * usava regras inventadas (Real Pax) e gerava preços errados. Agora os
 * valores vêm direto da SulAmerica via PV Corretora.
 *
 * Estrutura da API:
 *   POST /api/cotar
 *   body: { nome, data_nascimento: "DD/MM/YYYY", sexo: "MASCULINO"|"FEMININO" }
 *   resp: { ok, produtos: [{ nome, codigo, coberturas: [...], servicos: [...], beneficios: [...] }] }
 *
 * Cada cobertura tem capital_atual + premio_mensal — premio escala linearmente
 * com capital escolhido pelo cliente (premio = base * capital_escolhido/capital_atual).
 *
 * Cache em memoria 5min por {idade,sexo} — preco nao varia por idade entre
 * 18-74 (validado), entao o cache eh muito eficaz.
 */
import { logger } from '../../../utils/logger.js';
import {
  getCardAgentState,
  upsertCardAgentState,
  recordAgentMetric,
} from '../../store/cardAgentStateStore.js';
import type { ToolDef } from './types.js';

// ── Config ─────────────────────────────────────────────────────────────
const API_URL = 'https://cotador.sulamerica.pvcorretor01.com.br/api/cotar';
const TIMEOUT_MS = 90_000; // FIX 2026-05-06: era 60s, mas API SulAmerica timeoutava 4x/dia. 90s reduz timeouts sem prender o LLM.
const RETRIES = 2; // total de tentativas = 1 + RETRIES = 3
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min

// ── Tipos da API ───────────────────────────────────────────────────────
interface ApiCobertura {
  id?: string | number;
  nome: string;
  obrigatoria?: boolean;
  capital_atual?: number;
  capital_min?: number;
  capital_max?: number;
  premio_mensal?: number;
  premio_mensal_desconto?: number;
}
interface ApiServico {
  id?: string | number;
  nome: string;
  premio_mensal?: number;
  premio_mensal_desconto?: number;
  valor?: number;
}
interface ApiProduto {
  nome: string;
  codigo: string;
  coberturas?: ApiCobertura[];
  servicos?: ApiServico[];
  beneficios?: Array<{ nome: string; descricao?: string }>;
}
interface ApiResponse {
  ok: boolean;
  erro?: string;
  produtos?: ApiProduto[];
  input?: Record<string, unknown>;
}

// ── Cache em memoria ───────────────────────────────────────────────────
interface CacheEntry { ts: number; data: ApiResponse }
const cache = new Map<string, CacheEntry>();

function cacheKey(idade: number, sexo: string): string {
  return `${idade}|${sexo}`;
}

// ── Helpers ────────────────────────────────────────────────────────────

/** Constroi DD/MM/YYYY pra idade alvo — a API exige data, mas preco nao
 *  varia entre 18-74, entao usamos data sintetica consistente. */
function dataNascimentoFromIdade(idade: number): string {
  const ano = new Date().getFullYear() - idade;
  return `15/06/${ano}`; // dia 15, mes 6 — nada de borda
}

/** Normaliza sexo pro formato da API. */
function normalizarSexo(s: string | undefined): 'MASCULINO' | 'FEMININO' | null {
  if (!s) return null;
  const u = s.trim().toUpperCase();
  if (u === 'M' || u === 'MASCULINO' || u === 'MASC' || u === 'HOMEM') return 'MASCULINO';
  if (u === 'F' || u === 'FEMININO' || u === 'FEM' || u === 'MULHER') return 'FEMININO';
  return null;
}

function brl(n: number): string {
  return `R$ ${n.toFixed(2).replace('.', ',')}`;
}

async function postCotar(payload: Record<string, unknown>): Promise<ApiResponse> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
  // FIX 2026-05-06: log latência sempre (sucesso e falha). Daniel quer
  // observar instabilidade da API SulAmérica — antes só timeout aparecia.
  const startedAt = Date.now();
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const latencyMs = Date.now() - startedAt;
    const data = await res.json().catch(() => ({})) as ApiResponse;
    if (!res.ok) {
      logger.warn(`[cotar_sulamerica_api] HTTP ${res.status} latency=${latencyMs}ms`);
      return { ok: false, erro: `HTTP ${res.status}: ${JSON.stringify(data)}` };
    }
    logger.info(`[cotar_sulamerica_api] OK latency=${latencyMs}ms produtos=${data.produtos?.length ?? 0}`);
    return data;
  } catch (err: any) {
    const latencyMs = Date.now() - startedAt;
    const isTimeout = err?.name === 'AbortError';
    logger.warn(`[cotar_sulamerica_api] ${isTimeout ? 'TIMEOUT' : 'FETCH_FAIL'} latency=${latencyMs}ms err="${err?.message || 'unknown'}"`);
    return { ok: false, erro: isTimeout ? `timeout_${TIMEOUT_MS}ms` : (err?.message || 'fetch_failed') };
  } finally {
    clearTimeout(t);
  }
}

async function fetchCotacaoComRetry(idade: number, sexo: 'MASCULINO' | 'FEMININO', nome: string): Promise<ApiResponse> {
  // Cache hit?
  const k = cacheKey(idade, sexo);
  const hit = cache.get(k);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS && hit.data.ok) {
    return hit.data;
  }

  const payload = {
    nome: (nome || 'Cliente').slice(0, 60),
    data_nascimento: dataNascimentoFromIdade(idade),
    sexo,
  };

  let lastErr: string | undefined;
  for (let i = 0; i <= RETRIES; i++) {
    if (i > 0) {
      // backoff: 2s, 5s
      const wait = i === 1 ? 2000 : 5000;
      await new Promise((r) => setTimeout(r, wait));
    }
    const res = await postCotar(payload);
    if (res.ok && res.produtos && res.produtos.length > 0) {
      cache.set(k, { ts: Date.now(), data: res });
      return res;
    }
    lastErr = res.erro || 'sem_produtos';
    logger.warn(`[cotar_sulamerica_api] tentativa ${i + 1}/${RETRIES + 1} falhou: ${lastErr}`);
  }
  return { ok: false, erro: lastErr || 'falha_apos_retries' };
}

// ── Tool: cotar_sulamerica_api ─────────────────────────────────────────

interface CotarArgs {
  idade?: number;
  sexo?: string;
  capital_morte_acidente?: number;
  capital_invalidez?: number;
  funeral_nivel?: 'nenhum' | 'individual' | 'casal_filhos' | 'casal_filhos_pais_sogros';
  filhos_maior_21?: number;
  outros_familiares?: number;
  incluir_despesas_medicas?: boolean;
  incluir_acessibilidade?: boolean;
  incluir_diaria_internacao?: boolean;
  incluir_medico_tela?: boolean;
  incluir_rede_saude?: boolean;
}

const FUNERAL_NOME_RX: Record<string, RegExp> = {
  individual: /^funeral\s+individual$/i,
  casal_filhos: /^funeral\s+casal\s+e\s+filhos$/i,
  casal_filhos_pais_sogros: /^funeral\s+casal,?\s+filhos,?\s+pais\s+e\s+sogros$/i,
};

const PRECO_FILHO_MAIOR_21 = 10; // R$/mes — confirmado no front cotador
const PRECO_OUTRO_FAMILIAR = 12;

// PISO DE PRECO (Daniel 2026-05-06): NUNCA vender abaixo desses valores.
// Plano Individual: minimo R$ 29,90/mes. Plano Familiar (qualquer
// composicao com cobertura > so titular): minimo R$ 39,90/mes.
// Aplicado APOS calculo da API. Se calculo da scaled price der menos,
// usa piso.
const PISO_INDIVIDUAL_CENTS = 2990;
const PISO_FAMILIAR_CENTS = 3990;

interface BreakdownLine { rotulo: string; valor_cents: number }

function findCobertura(coberturas: ApiCobertura[], regex: RegExp): ApiCobertura | undefined {
  return coberturas.find((c) => regex.test(c.nome || ''));
}

function findServico(servicos: ApiServico[], regex: RegExp): ApiServico | undefined {
  return servicos.find((s) => regex.test(s.nome || ''));
}

/** Escala premio linearmente pelo capital escolhido. */
function scaledPremio(c: ApiCobertura, capitalChosen: number): number {
  const base = c.capital_atual || 0;
  const pre = c.premio_mensal_desconto || c.premio_mensal || 0;
  if (base <= 0 || pre <= 0) return 0;
  return pre * (capitalChosen / base);
}

const cotarSulamericaApi: ToolDef = {
  name: 'cotar_sulamerica_api',
  description: [
    'Chama a API OFICIAL da SulAmerica (PV Corretora) e devolve a cotacao com valores corretos.',
    'Use SEMPRE que precisar mostrar valor pro cliente — NUNCA invente preço.',
    'Le idade/sexo da qualificacao salva (ler_dados_card antes se nao tiver certeza).',
    'Parametros mais importantes:',
    ' - capital_morte_acidente: capital escolhido em REAIS (ex 50000, 100000, 200000). Se nao passar, usa 50000.',
    ' - capital_invalidez: idem (default = capital_morte_acidente).',
    ' - funeral_nivel: "individual" (so titular) | "casal_filhos" | "casal_filhos_pais_sogros" | "nenhum".',
    ' - filhos_maior_21 e outros_familiares: contagens (so contam se funeral != "nenhum").',
    ' - incluir_despesas_medicas | incluir_acessibilidade | incluir_diaria_internacao | incluir_medico_tela | incluir_rede_saude: opcionais.',
    'Retorna mensagem pronta no formato WhatsApp em userVisible — manda LITERAL pro cliente.',
  ].join('\n'),
  roles: ['vendedor', 'vendedor_funeral', 'cotador'],
  parameters: {
    type: 'object',
    properties: {
      idade: { type: 'number', description: 'Idade do titular. Default: usa idade da qualificacao.' },
      sexo: { type: 'string', description: 'MASCULINO ou FEMININO. Default: usa qualificacao.' },
      capital_morte_acidente: { type: 'number', description: 'Capital morte por acidente em REAIS (50000, 100000, 200000, 500000). Default 50000.' },
      capital_invalidez: { type: 'number', description: 'Capital invalidez. Default = capital_morte_acidente.' },
      funeral_nivel: { type: 'string', enum: ['nenhum', 'individual', 'casal_filhos', 'casal_filhos_pais_sogros'], description: 'Qual nivel de Funeral incluir. Default "individual".' },
      filhos_maior_21: { type: 'number', description: 'IGNORADO. Filhos > 21 NAO entram na apolice principal — viram planos separados R$29,90 cada (regra Daniel). Sempre passe 0.' },
      outros_familiares: { type: 'number', description: 'IGNORADO. Outros parentes (irmao, tio, sobrinho, primo, cunhado) NAO entram na apolice principal — viram planos separados R$29,90 cada. Sempre passe 0.' },
      incluir_despesas_medicas: { type: 'boolean' },
      incluir_acessibilidade: { type: 'boolean' },
      incluir_diaria_internacao: { type: 'boolean' },
      incluir_medico_tela: { type: 'boolean' },
      incluir_rede_saude: { type: 'boolean' },
    },
  },
  async execute(args: Record<string, unknown>, ctx) {
    const a = args as CotarArgs;

    // 1) Resolve idade + sexo (args > qualification)
    const fresh = getCardAgentState(ctx.card.id) ?? ctx.state;
    const collected = (fresh.collectedData ?? {}) as Record<string, unknown>;
    const qual = (collected.qualification ?? {}) as Record<string, unknown>;

    const idade = typeof a.idade === 'number' ? a.idade : Number(qual.idade);
    const sexoRaw = a.sexo ?? (qual.sexo as string | undefined);
    const sexo = normalizarSexo(typeof sexoRaw === 'string' ? sexoRaw : undefined);

    if (!Number.isFinite(idade) || idade < 18 || idade > 74) {
      return { ok: false, error: `idade_invalida: precisa ser 18-74 (recebido=${idade}). Cliente fora da faixa SulAmerica.` };
    }
    if (!sexo) {
      return { ok: false, error: 'sexo_nao_definido: precisa ser MASCULINO ou FEMININO.' };
    }

    // 2) Defaults seguros
    const capMA = Math.max(10000, Math.min(1_000_000, a.capital_morte_acidente ?? 50000));
    const capInv = Math.max(10000, Math.min(1_000_000, a.capital_invalidez ?? capMA));
    const funeralNivel = (a.funeral_nivel as string) || 'individual';
    // Daniel 2026-05-06: filhos>21 e outros parentes NAO entram na apolice
    // principal — sao planos separados R$29,90 cada. Forcado a 0 aqui pra
    // proteger contra regressao via prompt antigo. Bot oferta planos
    // separados pelo prompt, NAO via parametro de cotacao.
    const filhos21 = 0;
    const outros = 0;

    // 3) Chama API
    const customerName = ctx.card.title || (qual.nome as string | undefined) || 'Cliente';
    const apiResp = await fetchCotacaoComRetry(idade, sexo, customerName);
    if (!apiResp.ok || !apiResp.produtos || apiResp.produtos.length === 0) {
      recordAgentMetric({
        tenantId: ctx.tenantId, columnId: ctx.column.id, cardId: ctx.card.id,
        event: 'tool_failed', reason: `cotar_api: ${apiResp.erro || 'sem_produtos'}`,
      });
      return {
        ok: false,
        error: `api_indisponivel: ${apiResp.erro || 'sem_produtos'}. Tenta de novo em 30s ou escala humano se persistir.`,
      };
    }
    const prod = apiResp.produtos[0];
    const coberturas = prod.coberturas || [];
    const servicos = prod.servicos || [];

    // 4) Aplica selecoes do cliente
    const breakdown: BreakdownLine[] = [];

    // Coberturas obrigatorias (sempre): Morte por Acidente + Invalidez
    const cMorte = findCobertura(coberturas, /morte\s+por\s+acidente/i);
    const cInval = findCobertura(coberturas, /^invalidez$/i);
    if (!cMorte || !cInval) {
      return { ok: false, error: 'api_retornou_sem_obrigatorias: morte_acidente e/ou invalidez ausentes.' };
    }
    const premioMorte = scaledPremio(cMorte, capMA);
    const premioInval = scaledPremio(cInval, capInv);
    breakdown.push({ rotulo: `Morte por Acidente (capital ${brl(capMA).replace(',00', '')})`, valor_cents: Math.round(premioMorte * 100) });
    breakdown.push({ rotulo: `Invalidez (capital ${brl(capInv).replace(',00', '')})`, valor_cents: Math.round(premioInval * 100) });

    // Coberturas opcionais
    if (a.incluir_despesas_medicas) {
      const c = findCobertura(coberturas, /despesas\s+m[eé]dicas/i);
      if (c) {
        const v = scaledPremio(c, capMA);
        breakdown.push({ rotulo: 'Despesas Médicas/Hospitalares', valor_cents: Math.round(v * 100) });
      }
    }
    if (a.incluir_acessibilidade) {
      const c = findCobertura(coberturas, /acessibilidade/i);
      if (c) {
        const v = scaledPremio(c, capMA);
        breakdown.push({ rotulo: 'Acessibilidade Física por Acidente', valor_cents: Math.round(v * 100) });
      }
    }
    if (a.incluir_diaria_internacao) {
      const c = findCobertura(coberturas, /di[aá]ria\s+por\s+interna/i);
      if (c) {
        const v = scaledPremio(c, capMA);
        breakdown.push({ rotulo: 'Diária por Internação Hospitalar', valor_cents: Math.round(v * 100) });
      }
    }

    // Funeral (servico) — Daniel 2026-05-06: produto eh Plano FUNERAL.
    // Funeral SEMPRE incluido. Se LLM passou 'nenhum', forca pro nivel
    // compativel com a composicao familiar inferida (individual default).
    let funeralEffectiveNivel = funeralNivel;
    if (funeralNivel === 'nenhum') {
      logger.warn(`[cotar_sulamerica_api] LLM pediu funeral=nenhum mas o produto eh Plano Funeral — forcando 'individual' como minimo.`);
      funeralEffectiveNivel = 'individual';
    }
    let funeralIncluido = false;
    const rx = FUNERAL_NOME_RX[funeralEffectiveNivel];
    const sv = rx ? findServico(servicos, rx) : undefined;
    if (sv) {
      const v = sv.premio_mensal_desconto || sv.premio_mensal || 0;
      breakdown.push({ rotulo: `Assistência Funeral (${funeralEffectiveNivel.replace(/_/g, ' ')})`, valor_cents: Math.round(v * 100) });
      funeralIncluido = true;
    } else {
      logger.warn(`[cotar_sulamerica_api] funeral nivel "${funeralEffectiveNivel}" nao retornado pela API.`);
    }

    // Servicos opcionais (Medico na Tela / Rede de Saude)
    if (a.incluir_medico_tela) {
      const sv = findServico(servicos, /m[eé]dico\s+na\s+tela/i);
      if (sv) {
        const v = sv.premio_mensal_desconto || sv.premio_mensal || 0;
        breakdown.push({ rotulo: 'Médico na Tela Familiar', valor_cents: Math.round(v * 100) });
      }
    }
    if (a.incluir_rede_saude) {
      const sv = findServico(servicos, /rede\s+de\s+sa[uú]de/i);
      if (sv) {
        const v = sv.premio_mensal_desconto || sv.premio_mensal || 0;
        breakdown.push({ rotulo: 'Rede de Saúde Familiar', valor_cents: Math.round(v * 100) });
      }
    }

    // Adicionais (so com funeral selecionado)
    if (funeralIncluido && filhos21 > 0) {
      breakdown.push({ rotulo: `${filhos21} filho(s) > 21 anos`, valor_cents: filhos21 * PRECO_FILHO_MAIOR_21 * 100 });
    }
    if (funeralIncluido && outros > 0) {
      breakdown.push({ rotulo: `${outros} outro(s) familiar(es)`, valor_cents: outros * PRECO_OUTRO_FAMILIAR * 100 });
    }

    const calculatedTotalCents = breakdown.reduce((s, b) => s + b.valor_cents, 0);

    // PISO DURO Daniel 2026-05-06: NUNCA vender abaixo do minimo.
    const isIndividual = funeralEffectiveNivel === 'individual';
    const piso = isIndividual ? PISO_INDIVIDUAL_CENTS : PISO_FAMILIAR_CENTS;
    const totalCents = Math.max(calculatedTotalCents, piso);
    if (totalCents > calculatedTotalCents) {
      logger.info(`[cotar_sulamerica_api] piso aplicado: calculado=${calculatedTotalCents} → piso=${piso} (nivel=${funeralEffectiveNivel})`);
    }

    // 5) Monta mensagem WhatsApp pronta — VALOR ÚNICO, coberturas como
    //    "benefícios inclusos" (estrategia de venda Daniel 2026-05-06: foco
    //    em valor agregado, nao em discriminar item por item).
    const carenciaNatural = isIndividual ? '90 dias' : '120 dias';
    const planoLabel = funeralEffectiveNivel === 'individual' ? 'Individual'
                     : funeralEffectiveNivel === 'casal_filhos' ? 'Casal e Filhos'
                     : funeralEffectiveNivel === 'casal_filhos_pais_sogros' ? 'Casal, Filhos, Pais e Sogros'
                     : 'Personalizado';

    // Lista de beneficios inclusos pra o cliente — sem valor individual.
    const beneficios: string[] = [];
    beneficios.push(`✅ *Indenização em dinheiro de ${brl(capMA).replace(',00','')}* em caso de morte ou invalidez por acidente`);
    if (funeralIncluido) {
      beneficios.push(`✅ *Assistência Funeral ${planoLabel}* completa em todo Brasil (translado, urna, ornamentação, sepultamento ou cremação à escolha)`);
    }
    if (a.incluir_despesas_medicas) {
      beneficios.push(`✅ *Despesas Médicas e Hospitalares* em caso de acidente`);
    }
    if (a.incluir_diaria_internacao) {
      beneficios.push(`✅ *Diária por Internação Hospitalar* em caso de acidente`);
    }
    if (a.incluir_acessibilidade) {
      beneficios.push(`✅ *Acessibilidade Física por Acidente* (adaptações)`);
    }
    if (a.incluir_medico_tela) {
      beneficios.push(`✅ *Médico na Tela ${isIndividual ? 'Individual' : 'Familiar'}* — telemedicina 24h`);
    }
    if (a.incluir_rede_saude) {
      beneficios.push(`✅ *Rede de Saúde Familiar* — descontos em farmácias, exames e consultas`);
    }
    if (filhos21 > 0) {
      beneficios.push(`✅ ${filhos21} filho(s) com mais de 21 anos no plano`);
    }
    if (outros > 0) {
      beneficios.push(`✅ ${outros} familiar(es) extra(s) na assistência funeral`);
    }

    // Quem está coberto pela apólice única (regras Daniel 2026-05-06).
    const coberturaParentesco: string[] = [];
    if (funeralEffectiveNivel === 'individual') {
      coberturaParentesco.push('• *Titular* (você)');
    } else if (funeralEffectiveNivel === 'casal_filhos') {
      coberturaParentesco.push('• *Titular* (você)');
      coberturaParentesco.push('• *Cônjuge* (esposa/marido)');
      coberturaParentesco.push('• *Filhos até 21 anos* (sem custo extra)');
    } else if (funeralEffectiveNivel === 'casal_filhos_pais_sogros') {
      coberturaParentesco.push('• *Titular* (você)');
      coberturaParentesco.push('• *Cônjuge*');
      coberturaParentesco.push('• *Filhos até 21 anos*');
      coberturaParentesco.push('• *Pai e mãe* (sem limite de idade)');
      coberturaParentesco.push('• *Sogro e sogra* (sem limite de idade)');
    }

    const lines: string[] = [];
    lines.push('🛡️ *Plano Funeral SulAmérica — sua proteção completa*');
    lines.push('');
    lines.push('*Tudo isso incluso pra você:*');
    lines.push('');
    for (const b of beneficios) lines.push(b);
    lines.push('');
    lines.push('*Assistência Funeral em todo Brasil — cobertura completa:*');
    lines.push('🚐 Translado nacional');
    lines.push('🏛️ Capela e velório');
    lines.push('🌸 Ornamentação completa');
    lines.push('💐 Flores elegantes');
    lines.push('⚱️ Urnas exclusivas cromadas com 12 anos de garantia');
    lines.push('🔥 Cremação inclusa (cobertura nacional)');
    lines.push('📜 Certidão de óbito');
    lines.push('🏛️ Taxas cemiteriais e de exumação inclusas');
    lines.push('');
    if (coberturaParentesco.length > 0) {
      lines.push('*Quem está coberto na apólice:*');
      for (const c of coberturaParentesco) lines.push(c);
      lines.push('');
    }
    lines.push(`💰 *Tudo isso por apenas ${brl(totalCents / 100)}/mês*`);
    lines.push('');
    lines.push('*Carências oficiais SulAmérica:*');
    lines.push('• Morte/invalidez por acidente: _zero_ (cobre já no 1º dia)');
    lines.push(`• Morte natural: ${carenciaNatural}`);
    lines.push('');
    lines.push('✅ *Sem declaração de saúde* · *sem taxa de adesão*');
    lines.push('💳 Pagamento por *cartão recorrente*, *boleto mensal* ou *Pix*');
    lines.push('');
    const greeting = customerName ? customerName.split(/\s+/)[0] : '';
    lines.push(greeting
      ? `E aí, _${greeting}_? O que achou? 😊`
      : 'E aí? O que achou? 😊');
    const userVisible = lines.join('\n');

    // 6) Salva snapshot completo em collected_data.cotacao_api
    const snapshot = {
      at: Date.now(),
      idade,
      sexo,
      capital_morte_acidente: capMA,
      capital_invalidez: capInv,
      funeral_nivel: funeralEffectiveNivel,
      filhos_maior_21: filhos21,
      outros_familiares: outros,
      breakdown,
      total_cents: totalCents,
      api_produto: { nome: prod.nome, codigo: prod.codigo },
    };
    upsertCardAgentState({
      cardId: ctx.card.id,
      columnId: ctx.column.id,
      currentAgentRole: ctx.role,
      tenantId: ctx.tenantId,
      collectedData: { ...collected, cotacao_api: snapshot, last_quotation: snapshot },
    });
    recordAgentMetric({
      tenantId: ctx.tenantId, columnId: ctx.column.id, cardId: ctx.card.id,
      event: 'tool_called',
      reason: `cotar_api total_cents=${totalCents} funeral=${funeralNivel} capMA=${capMA}`,
    });

    return {
      ok: true,
      result: {
        total_cents: totalCents,
        breakdown,
        funeral_nivel: funeralEffectiveNivel,
        capital_morte_acidente: capMA,
      },
      userVisible,
    };
  },
};

export const COTACAO_SULAMERICA_TOOLS: ToolDef[] = [cotarSulamericaApi];
