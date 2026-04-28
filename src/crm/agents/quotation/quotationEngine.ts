/**
 * quotationEngine — pipeline de cotacao SulAmerica AP Flex (PR 5.1, Onda 62).
 *
 * Substitui a versao anterior baseada em Real Pax. Usa as regras de
 * sulamericaRules.ts:
 *   - selecao automatica de modalidade (Individual/Casal/Familiar/Familiar Ampliado)
 *   - calculo de preco com adicionais (filhos>21 e dependentes extras)
 *   - validacao de idade do titular (max 74)
 *   - mensagem formatada palavra-por-palavra do template do n8n
 */
import type {
  QualificationData,
  QuotationSnapshot,
  ProductType,
  Modalidade,
} from '../../types.js';
import { listPlansForTenant } from '../../store/tenantPlansStore.js';
import {
  calculateForPlan,
  calculateSulamericaPrice,
  selectModalidade,
  formatSulamericaQuotation,
  scrubPlanName,
  TITULAR_MAX_AGE,
} from './sulamericaRules.js';

// Re-export pra back-compat com PR 5 (callers de calculatePriceForPlan)
export { calculateForPlan as calculatePriceForPlan } from './sulamericaRules.js';
export { formatSulamericaQuotation as formatQuotationMessage } from './sulamericaRules.js';

export interface QuotationResult {
  ok: boolean;
  error?:
    | 'tenant_sem_planos_cadastrados'
    | 'sem_plano_compativel_idade'
    | 'titular_acima_idade_maxima'
    | string;
  message?: string;
  snapshot?: QuotationSnapshot;
  modalidade?: Modalidade;
  totalCents?: number;
}

export interface BuildQuotationInput {
  tenantId: string;
  productType?: ProductType;
  qualification: QualificationData;
  customerName?: string;
}

export function buildQuotation(input: BuildQuotationInput): QuotationResult {
  const { tenantId, qualification, customerName } = input;
  const productType = input.productType ?? 'acidentes_pessoais';

  // 1) Lista planos do tenant pra esse tipo
  const plans = listPlansForTenant(tenantId, productType);
  if (plans.length === 0) {
    return { ok: false, error: 'tenant_sem_planos_cadastrados' };
  }

  // 2) Idade do titular: regra dura SulAmerica — > 74 rejeita
  const idadeTitular = qualification.idadeTitular ?? qualification.idade;
  if (typeof idadeTitular === 'number' && idadeTitular > TITULAR_MAX_AGE) {
    return { ok: false, error: 'titular_acima_idade_maxima' };
  }

  // 3) Seleciona modalidade (se nao foi passada)
  const modalidade: Modalidade = qualification.modalidade ?? selectModalidade(qualification);
  const qualEffective: QualificationData = { ...qualification, modalidade };

  // 4) Calcula preco
  const priceResult = calculateSulamericaPrice(qualEffective);

  // 5) Valida que pelo menos 1 plano cadastrado eh elegivel (defesa contra
  //    tenant que cadastrou min/max age fora do padrao SulAmerica).
  const matchingPlans = plans.filter((p) => {
    const priced = calculateForPlan(p, qualEffective);
    return priced.eligible;
  });
  if (matchingPlans.length === 0) {
    return { ok: false, error: 'sem_plano_compativel_idade' };
  }

  // 6) Formata mensagem (palavra-por-palavra do n8n template)
  const message = formatSulamericaQuotation({
    qualification: qualEffective,
    priceResult,
    customerName,
  });

  // 7) Snapshot (so dados da cotacao, sem PII)
  const snapshot: QuotationSnapshot = {
    productType,
    region: 'desconhecida', // SulAmerica eh nacional, sem region surcharge
    customerName,
    qualification: qualEffective,
    plans: matchingPlans.slice(0, 4).map((p) => ({
      name: scrubPlanName(p.name),
      coverageSummary: p.coverageSummary,
      basePriceCents: priceResult.totalCents,
      outsideRioPriceCents: undefined,
    })),
    calculatedAt: Date.now(),
  };

  return {
    ok: true,
    message,
    snapshot,
    modalidade,
    totalCents: priceResult.totalCents,
  };
}
