/**
 * sulamericaRules — regras de cotacao SulAmerica AP Flex (PR 5.1, Onda 62).
 *
 * Substitui o antigo realPaxRules.ts. SulAmerica AP Flex tem 4 modalidades
 * com selecao automatica baseada na composicao familiar do lead:
 *
 *   1. Individual (R$ 29,90)         — só titular
 *   2. Casal (R$ 39,90)              — titular + cônjuge
 *   3. Familiar (R$ 49,90)           — titular + cônjuge + filhos <= 21
 *   4. Familiar Ampliado (R$ 89,90)  — todos + pais ou sogros, sem limite idade dep.
 *
 * Adicionais (somam ao base):
 *   - Cada filho > 21 anos: +R$ 8
 *   - Cada dependente extra (alem dos categorizados): +R$ 10
 *
 * Regra de elegibilidade:
 *   - Titular precisa ter <= 74 anos. Se >74, oferecer pra entrar como
 *     dependente de outro titular (filho/parente).
 *
 * Memorias do Daniel:
 *   - SEMPRE escrever "AP Flex" ou "Acidentes Pessoais Flex" — NUNCA "Real Pax"
 *   - Cobertura nacional, SEM surcharge regional ("fora do Rio" era do Real Pax)
 *   - "Familiar" eh R$ 49,90, NAO R$ 59,90 (corrigido nesse PR)
 *   - Foco em beneficios EM VIDA (telemedicina, sorteios, descontos farmacia)
 */

import type {
  TenantPlan,
  QualificationData,
  PricedPlan,
  Modalidade,
} from '../../types.js';

// ─── Constantes do produto ──────────────────────────────────────────────

export const SULAMERICA_BASE_PRICES_CENTS: Record<Modalidade, number> = {
  individual: 2990,         // R$ 29,90
  casal: 3990,              // R$ 39,90
  familiar: 4990,           // R$ 49,90 (corrigido — era 5990 no Real Pax)
  familiar_ampliado: 8990,  // R$ 89,90
};

export const FILHO_MAIOR_21_SURCHARGE_CENTS = 800;   // +R$ 8 cada
export const DEPENDENTE_EXTRA_SURCHARGE_CENTS = 1000; // +R$ 10 cada

export const TITULAR_MAX_AGE = 74;

/** Heuristica: detecta planos SulAmerica pelo nome (substring "AP Flex" ou "SulAmérica"). */
export function isSulamericaPlan(plan: TenantPlan): boolean {
  return /\bAP\s*Flex\b/i.test(plan.name) || /\bSulAm[ée]rica\b/i.test(plan.name);
}

/** Defesa: se nome do plano contiver "Real Pax" (cadastro errado), substitui
 *  por "SulAmérica AP Flex". Memoria do Daniel — produto antigo nao existe mais. */
export function scrubPlanName(name: string): string {
  return name
    .replace(/\bReal\s*Pax\b/gi, 'SulAmérica AP Flex')
    .replace(/\bPopular\b/gi, 'Essencial');
}

/** Formata centavos como BRL "R$ 29,90". */
export function formatBRL(cents: number): string {
  const reais = (cents / 100).toFixed(2).replace('.', ',');
  return `R$ ${reais}`;
}

// ─── Selecao de modalidade ──────────────────────────────────────────────

/**
 * Decide qual modalidade aplicar baseado na composicao familiar.
 * Logica (em ordem):
 *   IF tem pais OU sogros → familiar_ampliado
 *   ELSEIF tem conjuge AND filhos<21 → familiar
 *   ELSEIF tem conjuge → casal
 *   ELSEIF tem filhos<21 → familiar
 *   ELSE → individual
 */
export function selectModalidade(qual: QualificationData): Modalidade {
  if (qual.pais === true || qual.sogros === true) return 'familiar_ampliado';
  const temConjuge = !!qual.conjuge;
  const temFilhosMenores = (qual.filhosMenores21?.length ?? 0) > 0;
  if (temConjuge && temFilhosMenores) return 'familiar';
  if (temConjuge) return 'casal';
  if (temFilhosMenores) return 'familiar';
  return 'individual';
}

// ─── Calculo de preco ───────────────────────────────────────────────────

export interface PriceResult {
  modalidade: Modalidade;
  basePriceCents: number;        // sem adicionais
  filhosMaiores21Count: number;
  dependentesExtras: number;
  totalCents: number;            // valor final mensal
  /** Linha-a-linha pra exibir composicao do valor. */
  breakdownLines: string[];
}

/**
 * Calcula o preco final SulAmerica AP Flex aplicando:
 *  1. base por modalidade (individual / casal / familiar / familiar_ampliado)
 *  2. + R$ 8 cada filho >21
 *  3. + R$ 10 cada dependente extra
 */
export function calculateSulamericaPrice(qual: QualificationData): PriceResult {
  const modalidade = qual.modalidade ?? selectModalidade(qual);
  const basePriceCents = SULAMERICA_BASE_PRICES_CENTS[modalidade];

  const filhosMaiores21Count = qual.filhosMaiores21?.length ?? 0;
  const dependentesExtras = qual.dependentesExtras ?? 0;

  const surchargeFilhos21 = filhosMaiores21Count * FILHO_MAIOR_21_SURCHARGE_CENTS;
  const surchargeExtras = dependentesExtras * DEPENDENTE_EXTRA_SURCHARGE_CENTS;
  const totalCents = basePriceCents + surchargeFilhos21 + surchargeExtras;

  const modalidadeLabel: Record<Modalidade, string> = {
    individual: 'Individual',
    casal: 'Casal',
    familiar: 'Familiar',
    familiar_ampliado: 'Familiar Ampliado',
  };

  const breakdownLines: string[] = [];
  breakdownLines.push(`${modalidadeLabel[modalidade]}: ${formatBRL(basePriceCents)}`);
  if (filhosMaiores21Count > 0) {
    breakdownLines.push(`+ ${filhosMaiores21Count} filho(s) maior(es) de 21 anos: ${formatBRL(surchargeFilhos21)} (${formatBRL(FILHO_MAIOR_21_SURCHARGE_CENTS)} cada)`);
  }
  if (dependentesExtras > 0) {
    breakdownLines.push(`+ ${dependentesExtras} dependente(s) extra(s): ${formatBRL(surchargeExtras)} (${formatBRL(DEPENDENTE_EXTRA_SURCHARGE_CENTS)} cada)`);
  }

  return {
    modalidade,
    basePriceCents,
    filhosMaiores21Count,
    dependentesExtras,
    totalCents,
    breakdownLines,
  };
}

/** Retorna PricedPlan se titular eh elegivel, senao com rejectedReason. */
export function calculateForPlan(plan: TenantPlan, qual: QualificationData): PricedPlan {
  const idadeTitular = qual.idadeTitular ?? qual.idade;
  if (typeof idadeTitular === 'number') {
    if (idadeTitular > TITULAR_MAX_AGE) {
      return {
        plan, basePriceCents: 0,
        eligible: false,
        rejectedReason: 'titular_acima_idade_maxima',
      };
    }
    if (typeof plan.minAge === 'number' && idadeTitular < plan.minAge) {
      return { plan, basePriceCents: 0, eligible: false, rejectedReason: 'titular_abaixo_idade_minima' };
    }
  }

  const result = calculateSulamericaPrice(qual);
  return {
    plan,
    basePriceCents: result.totalCents, // total final ja considerando adicionais
    eligible: true,
  };
}

// ─── Formatacao da mensagem (template do n8n) ───────────────────────────

export interface FormatQuotationInput {
  qualification: QualificationData;
  priceResult: PriceResult;
  customerName?: string;
}

const MODALIDADE_LABEL: Record<Modalidade, string> = {
  individual: 'Individual',
  casal: 'Casal',
  familiar: 'Familiar',
  familiar_ampliado: 'Familiar Ampliado',
};

/**
 * Renderiza a mensagem completa SulAmerica AP Flex no formato exato do
 * n8n tool fornecido pelo Daniel. Texto inteiro vai como userVisible
 * pra o LLM mandar palavra-por-palavra (sem reformular).
 */
export function formatSulamericaQuotation(input: FormatQuotationInput): string {
  const { qualification, priceResult, customerName } = input;
  const modalidadeLabel = MODALIDADE_LABEL[priceResult.modalidade];
  const isFamiliar = priceResult.modalidade === 'familiar' || priceResult.modalidade === 'familiar_ampliado';
  const telemedicinaLabel = isFamiliar ? 'familiar' : 'individual';

  // Composicao do valor (breakdown)
  const composicao = priceResult.breakdownLines.join('\n');

  const lines: string[] = [];
  lines.push(`🛡️ *Cotação — Assistência Funeral SulAmérica*`);
  lines.push('');
  lines.push(`📋 *Plano:* ${modalidadeLabel}`);
  lines.push('');
  lines.push(`⚰️ *Assistência Funeral Completa em Todo o Brasil:*`);
  lines.push(`🚐 Translado nacional`);
  lines.push(`🌸 Ornamentação completa`);
  lines.push(`💐 Duas coroas de flores`);
  lines.push(`⚱️ Urnas exclusivas`);
  lines.push(`🧴 Tanatopraxia`);
  lines.push(`🪦 Sepultamento em gaveta, carneiro ou cova`);
  lines.push(`🔥 Cremação inclusa`);
  lines.push(`📜 Certidão de óbito`);
  lines.push(`🏛️ Taxas cemiteriais inclusas`);
  lines.push(`📋 Taxa de exumação inclusa`);
  lines.push('');
  lines.push(`🎯 *A família não paga nada por fora!*`);
  lines.push('');
  lines.push(`✅ *Mais benefícios incluídos:*`);
  lines.push(`💰 R$ 50.000 em caso de morte acidental`);
  lines.push(`🩺 Telemedicina ${telemedicinaLabel}`);
  lines.push(`💊 Desconto em farmácias e medicamentos`);
  lines.push('');
  lines.push(`💰 *Composição do valor:*`);
  lines.push(composicao);
  lines.push('');
  lines.push(`✅ Sem taxa de adesão`);
  lines.push(`💳 Boleto, Pix, débito ou cartão de crédito`);
  lines.push('');
  lines.push(`💰 *Tudo isso por apenas ${formatBRL(priceResult.totalCents)}/mês!*`);
  lines.push('');
  lines.push(`────────────────────`);
  lines.push(`📄 *Como funciona a contratação?*`);
  lines.push(`1️⃣ Enviamos toda a documentação e proposta *antes* de qualquer pagamento`);
  lines.push(`2️⃣ Você recebe a proposta em mãos, confere todos os detalhes com calma`);
  lines.push(`3️⃣ Após conferir e aprovar, realiza o pagamento para ativar as coberturas`);
  lines.push(`4️⃣ Recebe acesso ao *Portal de Clientes SulAmérica*`);
  lines.push('');
  lines.push(`🔐 *Total transparência — sem surpresas!*`);
  lines.push('');
  lines.push(`────────────────────`);
  lines.push(`🔒 *Quer uma proteção ainda mais completa?*`);
  lines.push(`Personalize seu plano com:`);
  lines.push(`  🛡️ Seguro de vida por morte natural`);
  lines.push(`  🏥 Seguro para descoberta de doenças graves`);
  lines.push(`  🔪 Cobertura para cirurgias`);
  lines.push(`  🛏️ Diária de internação hospitalar`);
  lines.push(`  _...e muito mais!_`);
  lines.push('');
  const greeting = customerName ? customerName.split(/\s+/)[0] : '';
  lines.push(greeting
    ? `Me diz o que achou da cobertura, _${greeting}_! Estou aguardando seu retorno 😊`
    : `Me diz o que achou da cobertura! Estou aguardando seu retorno 😊`);

  return lines.join('\n');
}
