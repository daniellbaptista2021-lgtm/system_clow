/**
 * outputValidator — validação programática da resposta do LLM ANTES de enviar.
 *
 * Defesa em camadas, complementar ao looksLikeMetaCommentary (regex). Foca no
 * problema real visto em prod (caso Adriana 2026-04-29): LLM inventou um plano
 * "Familiar Ampliado por R$ 133,90/mês pra 10 pessoas" — produto e preço que
 * não existem. Regex de meta-commentary não pega isso porque o texto é uma
 * mensagem normal pro cliente, só com valor fabricado.
 *
 * REGRA ATUAL (única):
 *   Se o texto cita valor monetário (R$ XX,XX / R$ XX / R$ XX mil), o LLM
 *   PRECISA ter chamado uma tool de cotação NESTE TURNO com sucesso. Senão,
 *   bloqueia e devolve erro pro LLM regenerar.
 *
 * Não cobre toda alucinação possível, mas cobre o vetor mais doloroso (preço
 * inventado) com falso-positivo baixo. Whitelist de coberturas + checagem
 * de auto-despedida ficam fora do escopo desta versão.
 */

/** Match de valores monetários em texto pt-BR.
 *  Cobre: R$ 50, R$50,00, R$ 1.297, R$50.000, R$ 50 mil, R$ 1 milhão.
 *  NÃO cobre números soltos (idades, quantidade) — exige prefixo R$. */
const MONEY_REGEX = /R\$\s*[\d.,]+(?:\s*(?:mil|milhão|milhões))?/gi;

/** Tools cuja chamada bem-sucedida AUTORIZA o LLM a citar valor monetário. */
const COTACAO_TOOLS = new Set([
  'cotar_sulamerica_api',
  'gerar_cotacao_sulamerica',  // legacy fallback
]);

/** Resultado da validação. */
export interface OutputValidation {
  ok: boolean;
  reason?: 'unbacked_currency';
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

/** Valida o texto que o LLM gerou. Se contém valor monetário sem cotação
 *  fundamentada neste turno, retorna ok:false + feedback pro LLM. */
export function validateOutput(
  text: string,
  toolCalls: ReadonlyArray<ToolCallRecord>,
): OutputValidation {
  if (!text) return { ok: true };

  const matches = text.match(MONEY_REGEX);
  if (!matches || matches.length === 0) {
    return { ok: true }; // sem valor citado → passa
  }

  const cotouComSucesso = toolCalls.some((tc) => COTACAO_TOOLS.has(tc.name) && tc.ok);
  if (cotouComSucesso) {
    return { ok: true }; // tem cotação backed → confia
  }

  // Valor citado SEM cotação → bloqueia.
  return {
    ok: false,
    reason: 'unbacked_currency',
    detectedMatches: matches.slice(0, 5),
    feedback:
      `BLOQUEADO: sua resposta cita valor(es) monetário(s) [${matches.slice(0, 3).join(', ')}] mas você NÃO chamou cotar_sulamerica_api neste turno. ` +
      `Regra dura: NUNCA invente preço. Primeiro chame cotar_sulamerica_api com idade/sexo/composição corretos e use o valor que ela retornar. ` +
      `Se o cliente perguntou preço e você ainda não tem dados pra cotar, responda pedindo a informação que falta (idade, composição familiar, etc). NUNCA chuta valor.`,
  };
}
