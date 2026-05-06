/**
 * outputValidator — validação programática da resposta do LLM ANTES de enviar.
 *
 * Defesa em camadas, complementar ao looksLikeMetaCommentary (regex). Foca em
 * 3 vetores de erro vistos em prod:
 *
 *   1) `unbacked_currency` — LLM cita valor monetário sem ter chamado a tool
 *      de cotação no turno (caso Adriana 2026-04-29: "R$ 133,90 pra 10 pessoas").
 *
 *   2) `forbidden_term` — LLM vaza termo técnico interno proibido pelo prompt
 *      ("API", "sistema oficial", "cotador"). Caso Neide 2026-05-06:
 *      "Vou cotar aqui com a API oficial da SulAmérica".
 *
 *   3) `price_below_floor` ou `price_diverged_from_quote` — LLM cita
 *      mensalidade abaixo do piso (R$ 29,90 individual / R$ 39,90 familiar)
 *      OU substancialmente diferente da última cotação salva. Caso Claudio
 *      2026-05-06: tool retornou R$ 9,98 (bug pré-piso) e LLM perpetuou esse
 *      valor mesmo após nova cotação retornar R$ 29,90.
 *
 * Regra `unbacked_currency` cobre quando NÃO houve tool. Regras 2 e 3 cobrem
 * o caminho onde a tool foi chamada mas LLM reescreveu/vazou.
 */

import { logger } from '../../utils/logger.js';

/** Match de valores monetários em texto pt-BR.
 *  Cobre: R$ 50, R$50,00, R$ 1.297, R$50.000, R$ 50 mil, R$ 1 milhão.
 *  NÃO cobre números soltos (idades, quantidade) — exige prefixo R$. */
const MONEY_REGEX = /R\$\s*[\d.,]+(?:\s*(?:mil|milh(?:ão|ões)))?/gi;

/** Tools cuja chamada bem-sucedida AUTORIZA o LLM a citar valor monetário. */
const COTACAO_TOOLS = new Set([
  'cotar_sulamerica_api',
  'gerar_cotacao_sulamerica',  // legacy fallback
]);

/** Termos técnicos internos proibidos no texto pro cliente. Prompt do
 *  vendedor já diz pra não usar, mas LLM vaza recorrentemente. Bloquear
 *  aqui é a defesa final. */
const FORBIDDEN_TERMS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /\bAPI\b/i, label: 'API' },
  { pattern: /cotador/i, label: 'cotador' },
  { pattern: /sistema\s+oficial/i, label: 'sistema oficial' },
  { pattern: /cota[çc][aã]o\s+oficial/i, label: 'cotação oficial' },
  { pattern: /vou\s+consultar\s+o\s+sistema/i, label: 'vou consultar o sistema' },
  { pattern: /calcular\s+ao\s+vivo/i, label: 'calcular ao vivo' },
];

/** Piso de mensalidade aplicado pela tool (ver cotacao_sulamerica.ts).
 *  Plano individual: R$ 29,90. Plano familiar: R$ 39,90. Aqui usamos o
 *  MAIS BAIXO dos dois (R$ 29,90 = 2990 cents) como piso absoluto de venda:
 *  qualquer valor mensal abaixo é alucinação ou bug histórico. */
const PISO_MENSAL_CENTS_ABS = 2990;

/** Tolerância pra divergência entre valor citado e última cotação salva.
 *  Se o LLM cita R$ XX,XX e last_quotation_cents existe, o valor citado
 *  precisa estar dentro de ±15% (margem cobre arredondamento e variação
 *  por capital escolhido). Fora disso, bloqueia. */
const QUOTE_DIVERGENCE_TOLERANCE = 0.15;

/** Resultado da validação. */
export interface OutputValidation {
  ok: boolean;
  reason?:
    | 'unbacked_currency'
    | 'forbidden_term'
    | 'price_below_floor'
    | 'price_diverged_from_quote';
  detectedMatches?: string[];
  /** Mensagem actionable pro LLM regenerar (vai como tool_response). */
  feedback?: string;
}

/** Histórico de tool_calls do turno atual. Cada entry tem o nome da tool e
 *  se o resultado foi `ok=true`. Vem de quem está rodando o tool loop. */
export interface ToolCallRecord {
  name: string;
  ok: boolean;
}

/** Contexto opcional pra validação contra estado salvo. */
export interface ValidationContext {
  /** Total da última cotação bem-sucedida pra esse card, em cents.
   *  Vem de `collected_data.last_quotation.total_cents`. */
  lastQuotationCents?: number;
}

/** Tenta interpretar um match de R$ XX como cents.
 *  Ignora valores com "mil"/"milhão" (capital, não mensalidade) e valores
 *  >= R$ 10.000 (provavelmente capital também). Retorna null se não for
 *  classificável como mensalidade. */
function parseMonthlyToCents(match: string): number | null {
  const m = match.toLowerCase();
  if (/mil|milh/.test(m)) return null; // capital
  // Extrai dígitos com vírgula/ponto
  const numStr = m.replace(/r\$\s*/i, '').trim();
  // Formato pt-BR: "29,90" ou "1.297,50" ou "50" ou "50.000"
  // Heurística: se tem vírgula, parte antes é inteiro (ponto = milhar), depois = decimal
  // Se não tem vírgula mas tem ponto E 3+ dígitos depois, é milhar
  let cents: number;
  if (numStr.includes(',')) {
    const [int, dec] = numStr.split(',');
    const intClean = int.replace(/\./g, '');
    const decClean = (dec || '00').padEnd(2, '0').slice(0, 2);
    cents = parseInt(intClean, 10) * 100 + parseInt(decClean, 10);
  } else if (/^\d{1,3}(\.\d{3})+$/.test(numStr)) {
    // "50.000" — formato milhar sem decimal
    cents = parseInt(numStr.replace(/\./g, ''), 10) * 100;
  } else {
    cents = parseInt(numStr, 10) * 100;
  }
  if (!Number.isFinite(cents) || cents <= 0) return null;
  // > R$ 10.000 = capital, não mensalidade
  if (cents > 1_000_000) return null;
  return cents;
}

/** Valida o texto que o LLM gerou. */
export function validateOutput(
  text: string,
  toolCalls: ReadonlyArray<ToolCallRecord>,
  context?: ValidationContext,
): OutputValidation {
  if (!text) return { ok: true };

  // ───────────────────────────────────────────────────────────────────
  // 1) Termos técnicos proibidos
  // ───────────────────────────────────────────────────────────────────
  const forbidden = FORBIDDEN_TERMS.find(({ pattern }) => pattern.test(text));
  if (forbidden) {
    return {
      ok: false,
      reason: 'forbidden_term',
      detectedMatches: [forbidden.label],
      feedback:
        `BLOQUEADO: sua resposta usa o termo "${forbidden.label}" — isso é proibido no texto pro cliente. ` +
        `Pro cliente você É a corretora; você simplesmente "monta a cotação" ou "vê o valor", nunca "consulta API/sistema/cotador". ` +
        `Reescreva sem usar termos técnicos internos. Exemplo: em vez de "vou consultar o sistema", use "deixa eu montar pra você".`,
    };
  }

  // ───────────────────────────────────────────────────────────────────
  // 2) Valores monetários
  // ───────────────────────────────────────────────────────────────────
  const matches = text.match(MONEY_REGEX);
  if (!matches || matches.length === 0) {
    return { ok: true };
  }

  const cotouComSucesso = toolCalls.some((tc) => COTACAO_TOOLS.has(tc.name) && tc.ok);

  // 2a) Valor sem cotação no turno → bloqueia (regra original)
  if (!cotouComSucesso && !context?.lastQuotationCents) {
    return {
      ok: false,
      reason: 'unbacked_currency',
      detectedMatches: matches.slice(0, 5),
      feedback:
        `BLOQUEADO: sua resposta cita valor(es) monetário(s) [${matches.slice(0, 3).join(', ')}] mas você NÃO chamou cotar_sulamerica_api neste turno e não há cotação salva. ` +
        `Regra dura: NUNCA invente preço. Primeiro chame cotar_sulamerica_api com idade/sexo/composição corretos e use o valor que ela retornar. ` +
        `Se o cliente perguntou preço e você ainda não tem dados pra cotar, responda pedindo a informação que falta. NUNCA chuta valor.`,
    };
  }

  // 2b) Mensalidade abaixo do piso absoluto (R$ 29,90)
  for (const match of matches) {
    const cents = parseMonthlyToCents(match);
    if (cents === null) continue; // não é mensalidade
    if (cents < PISO_MENSAL_CENTS_ABS) {
      return {
        ok: false,
        reason: 'price_below_floor',
        detectedMatches: [match],
        feedback:
          `BLOQUEADO: você citou ${match} como mensalidade, mas o piso absoluto de venda é R$ 29,90/mês (individual) ou R$ 39,90/mês (familiar). ` +
          `NUNCA cite valor mensal abaixo de R$ 29,90 — não existe esse plano. ` +
          `Se a tool de cotação retornou um valor menor, é bug — chame cotar_sulamerica_api de novo e use o total_cents corrigido. ` +
          `Reescreva sem esse valor abaixo do piso.`,
      };
    }
  }

  // 2c) Mensalidade divergente da última cotação salva
  if (context?.lastQuotationCents && context.lastQuotationCents > 0) {
    const lastCents = context.lastQuotationCents;
    const minAccepted = Math.round(lastCents * (1 - QUOTE_DIVERGENCE_TOLERANCE));
    const maxAccepted = Math.round(lastCents * (1 + QUOTE_DIVERGENCE_TOLERANCE));
    for (const match of matches) {
      const cents = parseMonthlyToCents(match);
      if (cents === null) continue;
      // só valida se valor citado é razoavelmente próximo da escala da cotação
      // (mensal: 1k-100k cents = R$10 a R$1000). Capital já foi filtrado acima.
      if (cents < minAccepted || cents > maxAccepted) {
        // Heurística extra: ignora se é múltiplo claro da cotação (parcelado),
        // ex.: cotação R$ 39,90 e LLM cita "R$ 478,80/ano". Aqui não cobrimos
        // todos os casos — só bloqueia se a divergência for unidirecional
        // suspeita (mensalidade muito menor que cotação).
        if (cents < minAccepted) {
          logger.warn(`[outputValidator] price diverged: cited=${cents} last=${lastCents} match="${match}"`);
          return {
            ok: false,
            reason: 'price_diverged_from_quote',
            detectedMatches: [match],
            feedback:
              `BLOQUEADO: você citou ${match} como mensalidade, mas a última cotação oficial salva foi R$ ${(lastCents / 100).toFixed(2).replace('.', ',')}. ` +
              `Esses valores são incompatíveis. Use o valor da cotação atual (R$ ${(lastCents / 100).toFixed(2).replace('.', ',')}) — não invente. ` +
              `Se você quer cotar um cenário diferente, chame cotar_sulamerica_api de novo com os parâmetros novos e use o total_cents que ela retornar.`,
          };
        }
      }
    }
  }

  return { ok: true };
}
