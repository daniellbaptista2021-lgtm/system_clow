/**
 * quotationEngine — calculo de cotacao real plugado nos planos do tenant.
 *
 * Pra a tool gerar_cotacao (PR 5 da Onda 62) substituir o mock fixo
 * antigo. Pega planos ativos do tenant, calcula preco com base nos
 * dados de qualificacao (idade, dependentes, regiao), filtra elegiveis,
 * formata mensagem WhatsApp-friendly.
 *
 * Regras especificas do produto (Real Pax) ficam em realPaxRules.ts
 * pra esse arquivo permanecer agnostico.
 */
import type {
  TenantPlan,
  QualificationData,
  PricedPlan,
  QuotationSnapshot,
  ProductType,
} from '../../types.js';
import { listPlansForTenant } from '../../store/tenantPlansStore.js';
import {
  scrubPlanName,
  formatPriceLine,
  formatHeader,
  formatCallToAction,
} from './realPaxRules.js';

const MAX_PLANS_IN_QUOTE = 4;

/** Calcula o preco final pra um plano dado os dados de qualificacao.
 *  Retorna PricedPlan com eligible=false + rejectedReason se idade fora
 *  da faixa. Senao calcula:
 *    - basePriceCents = plan.basePriceCents + (numeroDependentes * additional_per_dep)
 *    - outsideRioPriceCents = basePriceCents + plan.surchargeOutsideRioCents (se >0) */
export function calculatePriceForPlan(plan: TenantPlan, qual: QualificationData): PricedPlan {
  const { idade, numeroDependentes } = qual;

  // 1) Idade fora da faixa?
  if (typeof idade === 'number') {
    if (typeof plan.minAge === 'number' && idade < plan.minAge) {
      return { plan, basePriceCents: 0, eligible: false, rejectedReason: 'min_age_below' };
    }
    if (typeof plan.maxAge === 'number' && idade > plan.maxAge) {
      return { plan, basePriceCents: 0, eligible: false, rejectedReason: 'max_age_exceeded' };
    }
  }

  // 2) Calcula preco base com dependentes (se aplicavel)
  let basePriceCents = plan.basePriceCents;
  if (plan.allowsDependents && plan.additionalPerDependentCents > 0 && numeroDependentes && numeroDependentes > 0) {
    basePriceCents += numeroDependentes * plan.additionalPerDependentCents;
  }

  // 3) Preco fora do Rio (se surcharge > 0)
  const outsideRioPriceCents = plan.surchargeOutsideRioCents > 0
    ? basePriceCents + plan.surchargeOutsideRioCents
    : undefined;

  return { plan, basePriceCents, outsideRioPriceCents, eligible: true };
}

export interface QuotationResult {
  ok: boolean;
  error?: 'tenant_sem_planos_cadastrados' | 'sem_plano_compativel_idade' | string;
  message?: string; // texto pronto pro cliente
  snapshot?: QuotationSnapshot;
  plans?: PricedPlan[];
}

export interface BuildQuotationInput {
  tenantId: string;
  productType: ProductType;
  qualification: QualificationData;
  customerName?: string;
}

/** Pipeline completo: lista planos → calcula precos → filtra elegiveis →
 *  formata mensagem → retorna texto + snapshot. */
export function buildQuotation(input: BuildQuotationInput): QuotationResult {
  const { tenantId, productType, qualification, customerName } = input;
  const region: 'rio' | 'fora_do_rio' | 'desconhecida' = qualification.regiao || 'desconhecida';

  // 1) Lista planos do tenant pro tipo
  const plans = listPlansForTenant(tenantId, productType);
  if (plans.length === 0) {
    return { ok: false, error: 'tenant_sem_planos_cadastrados' };
  }

  // 2) Calcula preco pra cada
  const priced = plans.map((p) => calculatePriceForPlan(p, qualification));

  // 3) Filtra elegiveis
  const eligible = priced.filter((p) => p.eligible);
  if (eligible.length === 0) {
    return { ok: false, error: 'sem_plano_compativel_idade', plans: priced };
  }

  // 4) Pega top N (ja vem ordenado por priority do store)
  const top = eligible.slice(0, MAX_PLANS_IN_QUOTE);

  // 5) Formata mensagem
  const message = formatQuotationMessage({ priced: top, region, customerName });

  // 6) Snapshot pra cache no card_agent_state
  const snapshot: QuotationSnapshot = {
    productType,
    region,
    customerName,
    qualification,
    plans: top.map((p) => ({
      name: scrubPlanName(p.plan.name),
      coverageSummary: p.plan.coverageSummary,
      basePriceCents: p.basePriceCents,
      outsideRioPriceCents: p.outsideRioPriceCents,
    })),
    calculatedAt: Date.now(),
  };

  return { ok: true, message, snapshot, plans: top };
}

interface FormatInput {
  priced: PricedPlan[];
  region: 'rio' | 'fora_do_rio' | 'desconhecida';
  customerName?: string;
}

/** Renderiza a mensagem final pra mandar pro cliente via WhatsApp. */
export function formatQuotationMessage(input: FormatInput): string {
  const { priced, region, customerName } = input;
  const lines: string[] = [];
  lines.push(formatHeader(customerName));
  lines.push(''); // espaco apos header
  for (const p of priced) {
    const safeName = scrubPlanName(p.plan.name);
    lines.push(`📋 *${safeName}*`);
    lines.push(p.plan.coverageSummary);
    lines.push(formatPriceLine(p, region));
    lines.push(''); // espaco entre planos
  }
  lines.push(formatCallToAction());
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
