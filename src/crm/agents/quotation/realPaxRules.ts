/**
 * realPaxRules — regras especificas dos planos do Real Pax (PV Corretora).
 *
 * Memorias do Daniel (PR 5 da Onda 62):
 *   1. Sempre escrever "Essencial", NUNCA "Popular".
 *   2. NAO mencionar "Rio de Janeiro" no header de cotacao.
 *   3. NAO incluir telefone/footer.
 *   4. Quando regiao = "fora do Rio" → mostrar 2 valores (com e sem
 *      surcharge). Cliente decide qual aplica.
 *   5. NAO escrever explicacao do "+R$8" — so mostrar valor final.
 *
 * Esse modulo isola TODA logica especifica do produto pra que
 * quotationEngine.ts permaneca generico (futuro: outros produtos com
 * outras regras vivem em arquivos paralelos).
 */
import type { TenantPlan, PricedPlan } from '../../types.js';

/** Heuristic: detecta planos do Real Pax pelo nome (substring "Real Pax"). */
export function isRealPaxPlan(plan: TenantPlan): boolean {
  return /\bReal\s*Pax\b/i.test(plan.name);
}

/** Defesa: se o nome do plano contiver "Popular" (cadastro errado),
 *  substituiu por "Essencial". Memoria do Daniel — nunca pode aparecer. */
export function scrubPlanName(name: string): string {
  return name.replace(/\bPopular\b/gi, 'Essencial');
}

/** Formata centavos como BRL no padrão "R$ 29,90". */
export function formatBRL(cents: number): string {
  const reais = (cents / 100).toFixed(2).replace('.', ',');
  return `R$ ${reais}`;
}

/**
 * Renderiza o bloco de preco do plano respeitando regiao.
 *   - regiao=rio:        "R$ 29,90/mês"
 *   - regiao=fora_do_rio: "R$ 29,90/mês  |  Total fora do Rio: R$ 37,90 (já incluso adicional)"
 *   - regiao=desconhecida: padrao = mostra o preco base, sem surcharge
 *     (cliente ainda nao informou onde mora — agente vai perguntar)
 *
 * Importante: "(já incluso adicional)" eh a UNICA explicacao — NAO
 * descreve "+R$8 surcharge". Memoria do Daniel.
 */
export function formatPriceLine(priced: PricedPlan, region: 'rio' | 'fora_do_rio' | 'desconhecida'): string {
  const base = formatBRL(priced.basePriceCents);
  if (region === 'fora_do_rio' && priced.outsideRioPriceCents !== undefined) {
    const out = formatBRL(priced.outsideRioPriceCents);
    return `💰 ${base}/mês  |  Total fora do Rio: ${out} (já incluso adicional)`;
  }
  return `💰 ${base}/mês`;
}

/** Header da mensagem — SEM "Rio de Janeiro", SEM telefone, SEM footer. */
export function formatHeader(customerName?: string): string {
  const nome = (customerName || '').trim();
  return nome
    ? `Oi ${nome}! Aqui estão as opções pra você:`
    : `Aqui estão as opções pra você:`;
}

/** Pergunta final — chama o cliente pra interagir, sem assinatura/telefone. */
export function formatCallToAction(): string {
  return `Qual chamou mais atenção? Posso te explicar melhor!`;
}
