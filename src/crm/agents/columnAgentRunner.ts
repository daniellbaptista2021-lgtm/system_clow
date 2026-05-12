/**
 * columnAgentRunner — executa um turno do agente de coluna.
 *
 * Fluxo (PR 2 da Onda 62):
 *   1. Acquire cluster lock por messageId (setNxEx; TTL 60s).
 *   2. Carrega/cria card_agent_state.
 *   3. Verifica turns_count >= max_turns → marca status='stuck',
 *      grava metric blocked/max_turns, return.
 *   4. Verifica horario ativo (timezone America/Sao_Paulo) → fora →
 *      manda mensagem padrao, grava metric blocked/out_of_hours, return.
 *   5. Resolve texto (transcreve audio se preciso).
 *   6. Substitui placeholders no system prompt
 *      ({{persona_name}}, {{tenant_name}}, {{customer_name}}, {{customer_phone}}).
 *   7. Chama DeepSeek com history + nova msg.
 *   8. Anti-loop: bloqueia se resposta quase identica a anterior.
 *   9. Envia via canal (sendOutbound já loga message_out).
 *   10. recordAgentTurn(side='client') + side='agent', grava metric executed.
 *
 * NAO implementa tools de promocao, gerar_cotacao, escalate_humano —
 * isso e PR 3+. PR 2 e so: agente certo selecionado, contexto montado,
 * mensagem gerada e enviada, estado persistido.
 */
import { logger } from '../../utils/logger.js';
import { getCluster } from '../../utils/clusterStore.js';
import { getTenant } from '../../tenancy/tenantStore.js';
import {
  callDeepSeekWithTools,
  transcribeAudio,
  loadRecentHistory,
  sendReply,
  type ChatMessage,
  type DeepSeekToolMessage,
} from '../ai/agent.js';
import {
  getCardAgentState,
  upsertCardAgentState,
  recordAgentTurn,
  setCardAgentStatus,
  recordAgentMetric,
} from '../store/cardAgentStateStore.js';
import { getToolsForRole, toLLMTools, executeToolCall } from './tools/registry.js';
import { cardHasTag } from './tools/tags.js';
import { maybeAutoPromote } from './tools/common.js';
import { validateOutput, type ToolCallRecord } from './outputValidator.js';
import { synthesizeSpeech, isValidVoice, type TtsVoice } from './tts.js';
import { sendOutbound } from '../inbox.js';
import type { ToolContext } from './tools/types.js';
import * as store from '../store.js';
import { getCrmDb } from '../schema.js';
import type { Channel2, Card, BoardColumn, ColumnAgentRole } from '../types.js';

// ─── Kill switch absoluto ─────────────────────────────────────────────────
// Lê crm_columns.agent_enabled DIRETO do DB, ignorando o objeto column
// passado por parametro (pode estar stale se o admin acabou de desligar).
// Daniel 2026-04-30: "se ta desligado na chave nao deve funcionar nem
// mandar msg pro cliente de maneira nenhuma".
function isAgentEnabledFresh(columnId: string): boolean {
  try {
    const r = getCrmDb()
      .prepare('SELECT agent_enabled FROM crm_columns WHERE id = ?')
      .get(columnId) as { agent_enabled?: number } | undefined;
    return !!(r && r.agent_enabled === 1);
  } catch {
    // Em caso de erro de DB, falha CLOSED (kill switch e prioridade).
    return false;
  }
}

/** Refaz query DB pra resolver a coluna ATUAL do card e ver se ela tem
 *  agente ativo. Daniel 2026-05-05: cliente em Atendimento Humano nunca
 *  pode receber msg automatica — se card foi movido durante o turno do
 *  agente (ex: promover_para_vendedor_funeral disparou e moveu), o envio
 *  da mensagem final tem que ser suprimido. Falha CLOSED em erro de DB. */
function isCardStillOnAgentColumn(tenantId: string, cardId: string, allowedMovedToColumnId?: string): boolean {
  try {
    const row = getCrmDb()
      .prepare(`
        SELECT col.id AS column_id, col.agent_enabled AS enabled
        FROM crm_cards c
        JOIN crm_columns col ON col.id = c.column_id
        WHERE c.id = ? AND c.tenant_id = ?
      `)
      .get(cardId, tenantId) as { column_id?: string; enabled?: number } | undefined;
    if (!row) return false;
    if (row.enabled === 1) return true;
    return !!(allowedMovedToColumnId && row.column_id === allowedMovedToColumnId);
  } catch {
    return false; // fail closed
  }
}

/** Lê o total_cents da última cotação salva no card (se houver). Usado pelo
 *  outputValidator pra detectar divergência entre valor citado pelo LLM e o
 *  valor que a tool retornou. Falha silenciosa retorna undefined — validator
 *  só pula a checagem de divergência, mas piso e termos seguem ativos. */
/**
 * Onda 63 (refino 2026-05-07): decide se a resposta deve sair por audio (TTS)
 * ou texto. Mesmo com voice_enabled=1 e cliente tendo mandado audio, certos
 * tipos de resposta NUNCA devem virar audio:
 *
 *   - Valores monetarios (R$): cliente precisa conferir o numero por escrito
 *     e o validator de cotacao bloqueia divergencias frequentes.
 *   - CPF / CNPJ / CEP / email: dados estruturados que cliente vai precisar
 *     ler/copiar.
 *   - Texto >400 chars: vira audio de >25s, ninguem ouve.
 *   - Tool de cotacao/salvar dados executou: significa que a resposta tem
 *     resumo de plano/dados → manda escrito.
 *   - Lista com 3+ bullets: estrutura visual.
 *
 * Default → audio (saudacao, duvida curta, conversa rasa).
 */
function shouldUseVoice(
  text: string,
  toolCalls: ReadonlyArray<ToolCallRecord>,
): { use: boolean; reason: string } {
  if (!text) return { use: false, reason: 'empty_text' };
  if (/R\$\s*[\d.,]+/i.test(text)) return { use: false, reason: 'has_currency' };
  if (/\b\d{3}[.\s]?\d{3}[.\s]?\d{3}[-\s]?\d{2}\b/.test(text)) return { use: false, reason: 'has_cpf' };
  if (/\b\d{2}[.\s]?\d{3}[.\s]?\d{3}[\/.\s]?\d{4}[-\s]?\d{2}\b/.test(text)) return { use: false, reason: 'has_cnpj' };
  if (/\b\d{5}[-\s]?\d{3}\b/.test(text)) return { use: false, reason: 'has_cep' };
  if (/\b[\w._%+-]+@[\w.-]+\.[a-z]{2,}\b/i.test(text)) return { use: false, reason: 'has_email' };
  if (text.length > 400) return { use: false, reason: 'too_long' };
  const STRUCTURED_TOOLS = new Set([
    'cotar_sulamerica_api',
    'gerar_cotacao_sulamerica',
    'salvar_dados_qualificacao',
    'salvar_dados_proposta',
    'gerar_cotacao_pdf',
    'promover_para_lancar_venda',
    'promover_pendente_daniel',
  ]);
  if (toolCalls.some((tc) => STRUCTURED_TOOLS.has(tc.name) && tc.ok)) {
    return { use: false, reason: 'structured_tool_called' };
  }
  const bulletLines = (text.match(/^\s*(?:[-*•]|\d+[\.\)])\s+/gm) || []).length;
  if (bulletLines >= 3) return { use: false, reason: 'has_list' };
  return { use: true, reason: 'ok' };
}

/** Mensagem generica de transicao quando outputValidator bloqueia 2x.
 *  Sai como TEXTO (nao TTS) pra cliente nao ficar em silencio. */
const VALIDATOR_FALLBACK_TEXT = 'Só um instante que estou montando isso aqui certinho pra você 😊';

function readLastQuotationCents(cardId: string): number | undefined {
  try {
    const row = getCrmDb()
      .prepare('SELECT collected_data FROM crm_card_agent_state WHERE card_id = ?')
      .get(cardId) as { collected_data?: string } | undefined;
    const raw = row?.collected_data;
    if (!raw) return undefined;
    const data = JSON.parse(raw) as { last_quotation?: { total_cents?: number }; cotacao_api?: { total_cents?: number } };
    const cents = data.last_quotation?.total_cents ?? data.cotacao_api?.total_cents;
    return typeof cents === 'number' && cents > 0 ? cents : undefined;
  } catch {
    return undefined;
  }
}

// ─── Defaults ────────────────────────────────────────────────────────────

const DEFAULT_PERSONA_NAME = 'Safira';
const DEFAULT_MAX_HISTORY = 20;
const DEFAULT_MAX_TURNS = 30;
// PR 5.3: default 24/7. Tenant que quiser limitar configura explicitamente.
const DEFAULT_HOURS_START = '00:00';
const DEFAULT_HOURS_END = '23:59';
const LOCK_TTL_SECONDS = 60;
const TENANT_TIMEZONE = 'America/Sao_Paulo'; // hardcoded — decisao 4 do PR 2
const MAX_TOOL_ITERATIONS = 4; // PR 3: limite LLM↔tool por turno

/** Mensagem padrao fora de horario. {{start}} eh substituido pelo horario
 *  inicial da coluna. Justificativa pra hardcode em decisao 3 do PR 2. */
const OUT_OF_HOURS_TEMPLATE =
  'Recebi sua mensagem! 😊 Volto a te responder a partir das {{start}}.';

// ─── Input ───────────────────────────────────────────────────────────────

export interface RunColumnAgentInput {
  channel: Channel2;
  card: Card;
  column: BoardColumn;
  customerPhone: string;
  /** Texto da mensagem (ja resolvido) OU audioUrl pra transcrever. */
  text?: string;
  audioUrl?: string;
  /** Onda 63: flag pro voice-mirror. True se cliente mandou audio (mesmo que
   *  ja tenha sido transcrito antes — caso Meta). Z-API tambem seta. */
  clientSentAudio?: boolean;
  imageUrl?: string;
  senderName?: string;
  /** Provider message id — usado pro cluster lock. Se faltar, lock degrada
   *  pra phone+timestamp (menos preciso, mas funcional). */
  messageId?: string;
}

export type RunResult =
  | { status: 'executed'; reply: string }
  | { status: 'blocked'; reason: 'out_of_hours' | 'max_turns' | 'anti_loop' | 'no_text' | 'audio_disabled' | 'transcribe_failed' | 'meta_commentary' | 'agent_disabled' }
  | { status: 'locked_out' }
  | { status: 'error'; message: string };

// ─── Public API ──────────────────────────────────────────────────────────

export async function runColumnAgent(input: RunColumnAgentInput): Promise<RunResult> {
  const { channel, card, column, customerPhone } = input;
  const tenantId = channel.tenantId;
  const role = (column.agentRole ?? 'custom') as ColumnAgentRole;

  // 0) KILL SWITCH — checa crm_columns.agent_enabled DIRETO do DB.
  //    Se admin desligou, NAO executa nada — nem lock, nem mensagem.
  if (!isAgentEnabledFresh(column.id)) {
    logger.info(`[col-agent.runner] aborted card=${card.id} column=${column.id} reason=agent_disabled`);
    recordAgentMetric({
      tenantId, columnId: column.id, cardId: card.id,
      event: 'blocked', reason: 'agent_disabled',
    });
    return { status: 'blocked', reason: 'agent_disabled' };
  }

  // 1) Cluster lock
  const lockKey = buildLockKey(input);
  try {
    const cluster = await getCluster();
    const ok = await cluster.setNxEx(lockKey, '1', LOCK_TTL_SECONDS);
    if (!ok) {
      logger.info(`[col-agent.runner] locked_out card=${card.id} key=${lockKey}`);
      recordAgentMetric({
        tenantId, columnId: column.id, cardId: card.id,
        event: 'locked_out', reason: 'lock_held_by_other_worker',
      });
      return { status: 'locked_out' };
    }
  } catch (err: any) {
    logger.warn('[col-agent.runner] cluster lock failed (continuing):', err?.message);
    // Falha no lock NAO bloqueia execucao — degrada pra modo single-worker.
    // Em produçao com Redis, isso e raro; em testes (in-memory) nunca falha.
  }

  // 2) Estado atual (cria se for primeiro turno do agente neste card)
  let state = getCardAgentState(card.id);
  if (!state || state.columnId !== column.id || state.currentAgentRole !== role) {
    // Card mudou de coluna ou e a 1a vez — sincroniza row de estado.
    // turnsCount nao reseta automatico aqui (PR 3 vai resetar quando
    // promocao acontecer); pra 1a row, vai pra 0.
    state = upsertCardAgentState({
      cardId: card.id,
      columnId: column.id,
      currentAgentRole: role,
      tenantId,
      turnsCount: state?.turnsCount ?? 0,
      status: state?.status ?? 'active',
      collectedData: state?.collectedData,
      promotionLog: state?.promotionLog,
    });
  }

  // 3) Limite de turnos
  const maxTurns = column.agentMaxTurns ?? DEFAULT_MAX_TURNS;
  if (state.turnsCount >= maxTurns) {
    setCardAgentStatus(card.id, 'stuck');
    recordAgentMetric({
      tenantId, columnId: column.id, cardId: card.id,
      event: 'blocked', reason: 'max_turns',
      turnsInColumn: state.turnsCount,
    });
    logger.info(`[col-agent.runner] BLOCKED card=${card.id} max_turns (${state.turnsCount}/${maxTurns})`);
    return { status: 'blocked', reason: 'max_turns' };
  }

  // 4) Horario ativo
  const hoursStart = column.agentActiveHoursStart || DEFAULT_HOURS_START;
  const hoursEnd = column.agentActiveHoursEnd || DEFAULT_HOURS_END;
  if (!isWithinActiveHours(hoursStart, hoursEnd)) {
    const ofMessage = OUT_OF_HOURS_TEMPLATE.replace('{{start}}', hoursStart);
    // Manda a msg via canal (loga message_out via sendOutbound).
    // Resolve contactId pra que a activity vincule ao card.
    const contact = store.findContactByPhone(tenantId, customerPhone);
    try {
      await sendReply(channel, customerPhone, ofMessage, contact?.id ?? null);
    } catch (err: any) {
      logger.warn('[col-agent.runner] out-of-hours send falhou:', err?.message);
    }
    recordAgentMetric({
      tenantId, columnId: column.id, cardId: card.id,
      event: 'blocked', reason: 'out_of_hours',
    });
    logger.info(`[col-agent.runner] BLOCKED card=${card.id} out_of_hours (${hoursStart}-${hoursEnd})`);
    return { status: 'blocked', reason: 'out_of_hours' };
  }

  // 5) Resolve texto da mensagem (transcreve audio se preciso)
  let userMessage = (input.text ?? '').trim();
  if (!userMessage && input.audioUrl) {
    userMessage = (await transcribeAudio(input.audioUrl)).trim();
    if (!userMessage) {
      // Avisa cliente que nao deu — usando sendReply (loga message_out)
      const contact = store.findContactByPhone(tenantId, customerPhone);
      try {
        await sendReply(channel, customerPhone,
          'Não consegui entender o áudio. Pode mandar por escrito? 🙂',
          contact?.id ?? null);
      } catch { /* nao bloqueia o return */ }
      recordAgentMetric({
        tenantId, columnId: column.id, cardId: card.id,
        event: 'blocked', reason: 'transcribe_failed',
      });
      return { status: 'blocked', reason: 'transcribe_failed' };
    }
  }
  if (!userMessage) {
    recordAgentMetric({
      tenantId, columnId: column.id, cardId: card.id,
      event: 'blocked', reason: 'no_text',
    });
    return { status: 'blocked', reason: 'no_text' };
  }

  // 6) Monta system prompt — substitui placeholders
  const personaName = column.agentName?.trim() || DEFAULT_PERSONA_NAME;
  const tenant = getTenant(tenantId);
  const tenantName = tenant?.name || 'a empresa';
  const customerName = input.senderName || 'cliente';

  const systemPrompt = renderPrompt(column.agentSystemPrompt!, {
    persona_name: personaName,
    tenant_name: tenantName,
    customer_name: customerName,
    customer_phone: customerPhone,
  });

  // Reforco anti-regressao + briefing das tools disponiveis
  const contextRules = `

# REGRAS DE CONTEXTO (CRITICAS — NAO IGNORAR)
- Voce ESTA no meio de uma conversa em andamento. Leia atentamente as ultimas mensagens trocadas antes de responder.
- NUNCA se reapresente se ja fez sua apresentacao nesta conversa (basta olhar o historico acima).
- NUNCA pergunte algo que o cliente JA respondeu nas mensagens anteriores. Use a informacao que ele ja deu.
- Continue de ONDE PAROU.

# COLUNA ATUAL
Voce esta na coluna "${column.name}" (role: ${role}).

# CRITERIOS DE PROMOCAO
Voce SO PODE chamar a tool de promocao quando TODOS os itens abaixo forem true:
${column.agentPromotionCriteria || '(criterios nao definidos pelo admin — promote pode ser chamado por contexto)'}

# COMO USAR TOOLS
- Voce tem acesso a tools especificas (vide tools list no payload).
- USE SEMPRE A TOOL CERTA: ex: "salvar_dados_qualificacao" pra gravar dados, "promover_*" pra avancar.
- NAO chame a mesma tool de promocao 2x na mesma resposta — se chamar 2x, o sistema retorna 'already_promoted' e voce pode parar.
- Se cliente pede humano, xinga, ou voce ficou sem saber prosseguir → escalar_humano(motivo).
`;

  // Regras especiais pra lead aleatorio (sem origem upstream paga).
  // Aplica em qualquer coluna se o card foi marcado como tal por inbox.ts.
  const isLeadAleatorio = cardHasTag(card.id, 'lead_aleatorio');
  const leadAleatorioRules = isLeadAleatorio ? `

# CASO ESPECIAL — LEAD ALEATORIO (sem campanha upstream)
Esse cliente NAO veio de link de campanha (extrato pago). Mandou mensagem
aleatoria no WhatsApp da empresa. Trate em DOIS passos:

PASSO 1 — PRIMEIRA INTERACAO: manda APENAS uma saudacao curta apropriada a hora
do dia ("Oi, bom dia! 😊", "Oi, boa tarde 😊", "Oi, boa noite 😊"). NAO se
apresenta como vendedora, NAO faz perguntas, NAO oferece nada. PARA. Espera
o cliente falar o que quer.

PASSO 2 — SEGUNDA INTERACAO em diante (cliente respondeu): avalia o contexto
do que ele falou:
  (a) Cliente DEU contexto — mencionou plano, seguro, cotacao, saude, funeral,
      preco, faixa etaria, dependentes ou similar → segue fluxo normal de
      qualificacao (sua missao default).
  (b) Cliente foi VAGO — so respondeu saudacao, perguntou algo generico ("vi
      seu numero", "queria saber sobre voces", "voces vendem o que?", "tudo bem
      por ai?", repetiu "oi") → chama handoff_para_corretor(motivo: "lead
      aleatorio sem contexto") e manda EXATAMENTE este texto pro cliente:
      "Beleza! Vou te encaminhar pro *Daniel*, nosso corretor — ele te chama AQUI mesmo em alguns minutos. 😊"

NAO insiste em qualificar lead aleatorio que nao deu contexto — direciona pro
Daniel. Sem pressa, melhor encaminhar do que conduzir errado.
` : '';

  const finalSystemPrompt = systemPrompt + contextRules + leadAleatorioRules;

  // 7) History
  const { contactId, messages: history } = loadRecentHistory(
    tenantId, customerPhone, DEFAULT_MAX_HISTORY,
  );

  // Marca turno do cliente ANTES de chamar LLM (turns_count++).
  // Se o LLM falhar, ja contamos esse turno — evita loop infinito.
  recordAgentTurn(card.id, 'client');
  state = getCardAgentState(card.id) ?? state;

  // 8) Tool loop (PR 3 da Onda 62) — max MAX_TOOL_ITERATIONS
  const tools = getToolsForRole(role);
  const llmTools = toLLMTools(tools);

  // Monta messages no formato DeepSeek/OpenAI
  const messages: DeepSeekToolMessage[] = [
    { role: 'system', content: finalSystemPrompt },
    ...history.map((m: ChatMessage) => ({ role: m.role, content: m.content })),
    { role: 'user', content: userMessage },
  ];

  let finalText = '';
  let iteration = 0;
  let lastReplyForAntiLoop = '';
  // FIX 2026-05-06 — track tool calls do turno pra validar valor monetário
  // (caso Adriana: bot inventou "Familiar Ampliado R$133,90" sem chamar
  // cotar_sulamerica_api). Validador anti-currency precisa saber.
  const toolCallsThisTurn: ToolCallRecord[] = [];
  let validationRetried = false;
  let validationFailedTwice = false;

  while (iteration < MAX_TOOL_ITERATIONS) {
    iteration++;
    let llmMsg: DeepSeekToolMessage;
    try {
      llmMsg = await callDeepSeekWithTools(messages, llmTools, 'deepseek-chat', tenantId);
    } catch (err: any) {
      logger.error('[col-agent.runner] DeepSeek falhou:', err?.message);
      recordAgentMetric({
        tenantId, columnId: column.id, cardId: card.id,
        event: 'blocked', reason: 'llm_error',
      });
      return { status: 'error', message: err?.message || 'llm_error' };
    }

    const toolCalls = llmMsg.tool_calls ?? [];
    if (toolCalls.length === 0) {
      // Sem tool_calls — texto final candidato
      const candidate = String(llmMsg.content || '').trim();

      // VALIDAÇÃO PROGRAMÁTICA: regras anti-currency, anti-termo-técnico,
      // anti-piso-violado e anti-divergência da última cotação salva.
      // Injeta feedback como user message e deixa LLM regenerar UMA vez.
      const lastQuotationCents = readLastQuotationCents(card.id);
      const v = validateOutput(candidate, toolCallsThisTurn, { lastQuotationCents });
      if (!v.ok && !validationRetried) {
        logger.warn(`[col-agent.runner] output_validator BLOQUEOU card=${card.id} reason=${v.reason} matches=[${v.detectedMatches?.join(',')}] — retry`);
        recordAgentMetric({
          tenantId, columnId: column.id, cardId: card.id,
          event: 'blocked', reason: `output_validator_${v.reason}`,
        });
        // Injeta como user message (LLM regenera)
        messages.push({ role: 'assistant', content: candidate });
        messages.push({ role: 'user', content: v.feedback || 'Refaça a resposta sem inventar valor.' });
        validationRetried = true;
        continue; // próxima iteração do while
      }
      if (!v.ok && validationRetried) {
        // Ja tentou regenerar e ainda alucinou. Em vez de abortar e deixar
        // cliente em silencio, manda mensagem generica de transicao em TEXTO.
        // validationFailedTwice forca texto (sem TTS) no envio abaixo.
        logger.error(`[col-agent.runner] output_validator BLOQUEOU 2x card=${card.id} — fallback texto generico`);
        recordAgentMetric({
          tenantId, columnId: column.id, cardId: card.id,
          event: 'blocked', reason: `output_validator_${v.reason}_persistent`,
        });
        finalText = VALIDATOR_FALLBACK_TEXT;
        validationFailedTwice = true;
        break;
      }
      finalText = candidate;
      break;
    }

    // Append assistant message com tool_calls + executa cada tool + append results
    messages.push({
      role: 'assistant',
      content: llmMsg.content ?? '',
      tool_calls: toolCalls,
    });

    // Re-resolve state pre tools (importante: card pode ter sido movido
    // por uma promocao em iteracao anterior; ctx precisa do estado atual
    // pra que validatePromotionTarget detecte idempotencia).
    const freshState = getCardAgentState(card.id) ?? state;
    // Re-resolve coluna + card atualizados
    const refreshedCard = store.getCard?.(tenantId, card.id) ?? card;
    const refreshedColumn = store.listColumns(tenantId, card.boardId!)
      .find((c) => c.id === refreshedCard.columnId) ?? column;
    const refreshedRole = (refreshedColumn.agentRole ?? freshState.currentAgentRole ?? role) as ColumnAgentRole;

    const toolCtx: ToolContext = {
      tenantId,
      channel,
      card: refreshedCard,
      column: refreshedColumn,
      state: freshState,
      customerPhone,
      role: refreshedRole,
    };

    for (const tc of toolCalls) {
      const result = await executeToolCall(tc, toolCtx);
      toolCallsThisTurn.push({ name: tc.function.name, ok: result.ok });
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        name: tc.function.name,
        content: JSON.stringify(result),
      });
    }
    // Volta o loop pra LLM processar os results
    lastReplyForAntiLoop = String(llmMsg.content || '');
  }

  if (iteration >= MAX_TOOL_ITERATIONS && !finalText) {
    // Hit limit — registra e retorna erro
    logger.warn(`[col-agent.runner] tool_loop_max card=${card.id}`);
    recordAgentMetric({
      tenantId, columnId: column.id, cardId: card.id,
      event: 'tool_loop_max',
      reason: `iterations=${iteration}`,
      turnsInColumn: state.turnsCount,
    });
    return { status: 'error', message: 'tool_loop_max_iterations' };
  }

  // Auto-promote deterministico precisa rodar ANTES de qualquer bloqueio de
  // texto final. Caso real 2026-05-12: LLM salvou nome/idade/tipo_plano,
  // mandou mensagem final ao cliente, mas a rodada seguinte retornou
  // meta-commentary e saiu antes do antigo auto-promote pos-envio.
  // Se os dados minimos ja estao no state, o card nao pode ficar preso.
  try {
    const freshStateForPromote = getCardAgentState(card.id) ?? state;
    const refreshedCard = store.getCard?.(tenantId, card.id) ?? card;
    const refreshedColumn = store.listColumns(tenantId, card.boardId!)
      .find((c) => c.id === refreshedCard.columnId) ?? column;
    const autoCtx: ToolContext = {
      tenantId, channel, card: refreshedCard, column: refreshedColumn,
      state: freshStateForPromote, customerPhone, role,
    };
    maybeAutoPromote(autoCtx);
  } catch (err: any) {
    logger.warn(`[col-agent.runner] pre-send auto-promote falhou card=${card.id}: ${err?.message}`);
  }

  // FIX 2026-05-06 — barra "" / single-emoji / so pontuacao chegando ao cliente
  if (isReplyEmptyish(finalText)) {
    if (finalText) {
      logger.warn(`[col-agent.runner] emptyish reply suprimido card=${card.id}: "${finalText.slice(0, 50)}"`);
      recordAgentMetric({
        tenantId, columnId: column.id, cardId: card.id,
        event: 'blocked', reason: 'emptyish_reply',
      });
    } else {
      logger.info(`[col-agent.runner] no final text card=${card.id} (so tools)`);
      recordAgentMetric({
        tenantId, columnId: column.id, cardId: card.id,
        event: 'executed', reason: 'tools_only_no_reply',
      });
    }
    return { status: 'executed', reply: '' };
  }

  // 9) Anti-loop (texto final vs ultima resposta do bot no historico)
  const recentOut = history.filter((m: ChatMessage) => m.role === 'assistant').slice(-1)[0];
  if (recentOut?.content) {
    const norm = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 100).toLowerCase();
    if (norm(recentOut.content) === norm(finalText)) {
      logger.warn(`[col-agent.runner] anti-loop bloqueou resposta para ${customerPhone}`);
      recordAgentMetric({
        tenantId, columnId: column.id, cardId: card.id,
        event: 'blocked', reason: 'anti_loop',
      });
      return { status: 'blocked', reason: 'anti_loop' };
    }
  }

  // 9.5) Anti-meta-commentary: se o LLM retornou texto que parece ser
  //      relato interno em vez de mensagem pro cliente, descarta e nao envia.
  if (looksLikeMetaCommentary(finalText)) {
    logger.warn(`[col-agent.runner] meta_commentary bloqueou envio para ${customerPhone}: "${finalText.slice(0, 100)}"`);
    recordAgentMetric({
      tenantId, columnId: column.id, cardId: card.id,
      event: 'blocked', reason: 'meta_commentary',
    });
    return { status: 'blocked', reason: 'meta_commentary' };
  }

  // 9.5b) FIX 2026-05-08 — Classificador LLM 2a passada. Pega parafrases
  //       novas que regex nao cobre. Fail-open em erro de rede.
  const addressee = await classifyAddressee(finalText, tenantId);
  if (addressee === 'about_client') {
    logger.warn(`[col-agent.runner] meta_commentary_llm bloqueou envio para ${customerPhone}: "${finalText.slice(0, 100)}"`);
    recordAgentMetric({
      tenantId, columnId: column.id, cardId: card.id,
      event: 'blocked', reason: 'meta_commentary_llm',
    });
    return { status: 'blocked', reason: 'meta_commentary' };
  }

  // 9.6) KILL SWITCH: card foi movido pra coluna SEM agente durante o turno?
  //      Daniel 2026-05-05: "cliente na tabela de atendimento humano nao deve
  //      receber msg de bot nenhum". Se promover_* moveu o card durante o
  //      tool loop, a coluna atual pode ser Atendimento Humano (agent_enabled=0)
  //      e enviar agora vazaria msg pro cliente. Refaz query do DB e aborta.
  if (!isCardStillOnAgentColumn(tenantId, card.id, column.agentPromoteToColumnId)) {
    logger.warn(`[col-agent.runner] card=${card.id} foi movido pra coluna sem agente durante o turno — abort send para ${customerPhone}`);
    recordAgentMetric({
      tenantId, columnId: column.id, cardId: card.id,
      event: 'blocked', reason: 'card_moved_to_human_column',
    });
    return { status: 'blocked', reason: 'agent_disabled' };
  }

  // 10) Envia (sendOutbound loga message_out + bumpa card pro topo)
  // Onda 63: TTS so quando (a) coluna tem voice_enabled, (b) cliente mandou
  // audio, (c) shouldUseVoice aprova (saudacao/duvida curta — sem R$, CPF,
  // CEP, email, lista, tool de cotacao, ou texto >400 chars), (d) validator
  // nao caiu no fallback generico.
  const clientSentAudio = !!(input.clientSentAudio || input.audioUrl);
  let wantsVoice = column.agentVoiceEnabled === true && clientSentAudio && !validationFailedTwice;
  let voiceSkipReason: string | null = null;
  if (wantsVoice) {
    const dec = shouldUseVoice(finalText, toolCallsThisTurn);
    wantsVoice = dec.use;
    if (!dec.use) voiceSkipReason = dec.reason;
  } else if (validationFailedTwice) {
    voiceSkipReason = 'validator_fallback';
  }
  if (voiceSkipReason) {
    logger.info(`[col-agent.runner] tts skipped card=${card.id} reason=${voiceSkipReason}`);
  }
  try {
    if (wantsVoice) {
      await sendVoiceReply(
        channel, customerPhone, finalText, contactId,
        column.agentVoiceId || 'nova', tenantId, card.id, column.id,
      );
    } else {
      await sendReply(channel, customerPhone, finalText, contactId);
    }
  } catch (err: any) {
    logger.error('[col-agent.runner] send falhou:', err?.message);
    return { status: 'error', message: err?.message || 'send_failed' };
  }

  recordAgentTurn(card.id, 'agent');
  // turnsCount conta turnos do CLIENTE (incrementado em recordAgentTurn 'client'
  // logo antes da chamada LLM). Reload do state reflete esse valor.
  const finalState = getCardAgentState(card.id) ?? state;
  recordAgentMetric({
    tenantId, columnId: column.id, cardId: card.id,
    event: 'executed',
    turnsInColumn: finalState.turnsCount,
  });
  logger.info(
    `[col-agent.runner] ✓ executed card=${card.id} role=${role} ` +
      `column="${column.name}" turns=${finalState.turnsCount} iter=${iteration}`,
  );

  void lastReplyForAntiLoop; // kept for future debugging
  return { status: 'executed', reply: finalText };
}

// ─── PR 4: runFromInactivityFire ─────────────────────────────────────────
//
// Entry point chamado pelo inactivityScheduler quando um timer dispara.
// Diferencas do runColumnAgent normal:
//  - NAO tem mensagem do cliente — injetamos uma instrucao "[SYSTEM]" como
//    pseudo-user message pro LLM decidir o que fazer.
//  - NAO chama recordAgentTurn('client') — nao houve turno do cliente.
//  - NAO checa max_turns — o ponto eh ele decidir, nao bloquear.
//  - NAO checa horario ativo — o scheduler ja postergou se preciso.
//  - Cluster lock ja foi adquirido pelo scheduler.
//  - Tem acesso a TODAS as tools do role (escalar/morno/perdido/promover frio).

export interface InactivityFireInput {
  channel: Channel2;
  card: Card;
  column: BoardColumn;
  /** Numero do disparo (1 = primeira vez, 2 = segunda). 3+ ja foi forcado morno
   *  pelo scheduler antes de chegar aqui. */
  fireCount: number;
  /** Minutos desde que o timer venceu. */
  elapsedMin: number;
  /** Daniel 2026-05-07: flag pra safety net (findUnrespondedInboundCards).
   *  A safety net EXISTE precisamente pra cobrir quando o inbound flow
   *  falhou em disparar o agente. O guard `client_replied_after_bot`
   *  bloquearia a safety net por achar que "inbound vai responder" — mas
   *  inbound já falhou. Quando true, esse guard é pulado.
   *  Os outros guards (kill switch, rapid_fire 60s, max_turns) seguem. */
  fromUnrespondedSafetyNet?: boolean;
}

export async function runFromInactivityFire(input: InactivityFireInput): Promise<RunResult> {
  const { channel, card, column, fireCount, elapsedMin, fromUnrespondedSafetyNet } = input;
  const tenantId = channel.tenantId;
  const role = (column.agentRole ?? 'custom') as ColumnAgentRole;

  // 0) KILL SWITCH — mesmo guard do runColumnAgent.
  //    Bot desligado nao dispara via timer/inactivity tampouco.
  if (!isAgentEnabledFresh(column.id)) {
    logger.info(`[col-agent.runFromFire] aborted card=${card.id} column=${column.id} reason=agent_disabled fireCount=${fireCount}`);
    recordAgentMetric({
      tenantId, columnId: column.id, cardId: card.id,
      event: 'blocked', reason: 'agent_disabled_inactivity',
    });
    return { status: 'blocked', reason: 'agent_disabled' };
  }

  // FIX 2026-05-06 (Daniel) — anti-rapid-fire: se bot acabou de mandar
  // mensagem (<60s) ou se cliente respondeu DEPOIS do último bot msg,
  // suprime esse fire. Evita "uma msg atrás da outra" (caso Sandra Maria) e
  // evita disparar chase em cima de cliente engajado.
  try {
    const recent = getCrmDb()
      .prepare(`SELECT last_bot_message_at, last_inbound_at, last_client_message_at FROM crm_cards WHERE id = ?`)
      .get(card.id) as { last_bot_message_at?: number; last_inbound_at?: number; last_client_message_at?: number } | undefined;
    const now = Date.now();
    if (recent?.last_bot_message_at && (now - recent.last_bot_message_at) < 60_000) {
      logger.info(`[col-agent.runFromFire] suprimido card=${card.id} bot_just_sent (${Math.round((now - recent.last_bot_message_at)/1000)}s atras)`);
      recordAgentMetric({
        tenantId, columnId: column.id, cardId: card.id,
        event: 'blocked', reason: 'rapid_fire_cooldown',
      });
      return { status: 'blocked', reason: 'agent_disabled' };
    }
    // Cliente respondeu DEPOIS do último bot msg → fluxo inbound vai responder, scheduler nao.
    // EXCEÇÃO (Daniel 2026-05-07): se a chamada veio da safety net
    // (fromUnrespondedSafetyNet=true), bypass — a safety net é justamente
    // o fallback pra quando o inbound flow já falhou em responder.
    const clientLast = recent?.last_inbound_at ?? recent?.last_client_message_at;
    if (
      !fromUnrespondedSafetyNet &&
      clientLast && recent?.last_bot_message_at && clientLast > recent.last_bot_message_at
    ) {
      logger.info(`[col-agent.runFromFire] suprimido card=${card.id} client_replied_after_bot — inbound flow vai responder`);
      recordAgentMetric({
        tenantId, columnId: column.id, cardId: card.id,
        event: 'blocked', reason: 'client_replied_inbound_will_handle',
      });
      return { status: 'blocked', reason: 'agent_disabled' };
    }
  } catch (err: any) {
    // Se DB query falhar, prossegue (degrada open) — o resto dos guards pega.
    logger.warn(`[col-agent.runFromFire] cooldown_check err: ${err?.message}`);
  }

  // Tenta resolver phone do contato pra context
  const contact = card.contactId ? store.getContact?.(tenantId, card.contactId) : null;
  const customerPhone = contact?.phone || '';

  // Estado atual
  let state = getCardAgentState(card.id);
  if (!state) {
    state = upsertCardAgentState({
      cardId: card.id, columnId: column.id, currentAgentRole: role,
      tenantId, status: 'active',
    });
  }

  // Persona
  const personaName = column.agentName?.trim() || DEFAULT_PERSONA_NAME;
  const tenant = getTenant(tenantId);
  const tenantName = tenant?.name || 'a empresa';

  const systemPrompt = renderPrompt(column.agentSystemPrompt!, {
    persona_name: personaName,
    tenant_name: tenantName,
    customer_name: contact?.name || 'cliente',
    customer_phone: customerPhone,
  });

  // FIX 2026-05-06 (Daniel): scheduler-fired runs DEVEM aplicar as MESMAS
  // regras especiais que runColumnAgent (lead_aleatorio + contextRules).
  // Sem isso, scheduler dispara mensagem que ignora "primeira interação =
  // só saudação" e pergunta dados direto pro cliente (caso Sandra Maria
  // 2026-05-05: "Oii boa tarde" → bot 1h depois "Legal! Qual seu nome e idade?"
  // ignorando regra lead_aleatorio).
  const isLeadAleatorio = cardHasTag(card.id, 'lead_aleatorio');
  const leadAleatorioRules = isLeadAleatorio ? `

# CASO ESPECIAL — LEAD ALEATORIO (sem campanha upstream)
Esse cliente NAO veio de link de campanha (extrato pago). Mandou mensagem
aleatoria no WhatsApp da empresa.

Se essa eh a PRIMEIRA INTERACAO do bot (historico vazio ou so com msg do cliente
sem resposta sua), manda APENAS uma saudacao curta ("Oi, bom dia! 😊", "Oi, boa
tarde 😊", "Oi, boa noite 😊") e PARA. NAO se apresenta. NAO faz perguntas. NAO
oferece nada.

Se cliente JA respondeu sua saudacao com algo VAGO ("oi", "tudo bem", "queria
saber sobre voces"), chama handoff_para_corretor(motivo: "lead aleatorio sem
contexto") e manda EXATAMENTE:
"Beleza! Vou te encaminhar pro *Daniel*, nosso corretor — ele te chama AQUI mesmo em alguns minutos. 😊"

Se cliente DEU contexto (mencionou plano/seguro/cotacao/saude/funeral/preco/
faixa etaria/dependentes), segue fluxo normal de qualificacao.
` : '';

  const contextRules = `

# REGRAS DE CONTEXTO (CRITICAS — NAO IGNORAR)
- Voce ESTA no meio de uma conversa em andamento. Leia atentamente as ultimas mensagens trocadas antes de responder.
- NUNCA se reapresente se ja fez sua apresentacao nesta conversa (basta olhar o historico acima).
- NUNCA pergunte algo que o cliente JA respondeu nas mensagens anteriores. Use a informacao que ele ja deu.
- Continue de ONDE PAROU.
`;

  // Instrucao especial — injetada como user-msg porque DeepSeek lida melhor
  // assim. Cliente NAO ve essa msg (so o LLM).
  const instruction = buildInactivityInstruction(fireCount, elapsedMin, role);

  // History real (sem incluir a injecao — historico do CRM)
  const { contactId, messages: history } = loadRecentHistory(
    tenantId, customerPhone, DEFAULT_MAX_HISTORY,
  );

  // Tool loop simplificado (sem recordAgentTurn 'client', sem anti-loop)
  const tools = getToolsForRole(role);
  const llmTools = toLLMTools(tools);
  const messages: DeepSeekToolMessage[] = [
    { role: 'system', content: systemPrompt + contextRules + leadAleatorioRules + INACTIVITY_CONTEXT_BLURB },
    ...history.map((m: ChatMessage) => ({ role: m.role, content: m.content })),
    { role: 'user', content: instruction },
  ];

  let finalText = '';
  let iter = 0;
  // FIX 2026-05-06 — track tool calls pra validador anti-currency
  const toolCallsThisFire: ToolCallRecord[] = [];
  let validationRetried = false;

  while (iter < MAX_TOOL_ITERATIONS) {
    iter++;
    let llmMsg: DeepSeekToolMessage;
    try {
      llmMsg = await callDeepSeekWithTools(messages, llmTools, 'deepseek-chat', tenantId);
    } catch (err: any) {
      logger.error('[col-agent.runFromFire] DeepSeek falhou:', err?.message);
      return { status: 'error', message: err?.message || 'llm_error' };
    }
    const toolCalls = llmMsg.tool_calls ?? [];
    if (toolCalls.length === 0) {
      const candidate = String(llmMsg.content || '').trim();
      const lastQuotationCents = readLastQuotationCents(card.id);
      const v = validateOutput(candidate, toolCallsThisFire, { lastQuotationCents });
      if (!v.ok && !validationRetried) {
        logger.warn(`[col-agent.runFromFire] output_validator BLOQUEOU card=${card.id} reason=${v.reason} matches=[${v.detectedMatches?.join(',')}] — retry`);
        recordAgentMetric({
          tenantId, columnId: column.id, cardId: card.id,
          event: 'blocked', reason: `output_validator_${v.reason}_inactivity`,
        });
        messages.push({ role: 'assistant', content: candidate });
        messages.push({ role: 'user', content: v.feedback || 'Refaça sem inventar valor.' });
        validationRetried = true;
        continue;
      }
      if (!v.ok && validationRetried) {
        // Disparos de inatividade: se validator bloqueia 2x, melhor nao
        // mandar nada do que mandar fallback generico (cobranca espontanea
        // com texto vazio confunde mais que ajuda). Mantem abort silencioso.
        logger.error(`[col-agent.runFromFire] output_validator BLOQUEOU 2x card=${card.id} — abort silencioso`);
        recordAgentMetric({
          tenantId, columnId: column.id, cardId: card.id,
          event: 'blocked', reason: `output_validator_${v.reason}_persistent_inactivity`,
        });
        return { status: 'blocked', reason: 'meta_commentary' };
      }
      finalText = candidate;
      break;
    }
    messages.push({ role: 'assistant', content: llmMsg.content ?? '', tool_calls: toolCalls });

    // Re-resolve state apos potential promote
    const fresh = getCardAgentState(card.id) ?? state;
    const refreshedCard = store.getCard?.(tenantId, card.id) ?? card;
    const refreshedColumn = store.listColumns(tenantId, card.boardId!)
      .find((c) => c.id === refreshedCard.columnId) ?? column;
    const refreshedRole = (refreshedColumn.agentRole ?? fresh.currentAgentRole ?? role) as ColumnAgentRole;

    const toolCtx: ToolContext = {
      tenantId, channel, card: refreshedCard, column: refreshedColumn,
      state: fresh, customerPhone, role: refreshedRole,
    };

    for (const tc of toolCalls) {
      const result = await executeToolCall(tc, toolCtx);
      toolCallsThisFire.push({ name: tc.function.name, ok: result.ok });
      messages.push({
        role: 'tool', tool_call_id: tc.id, name: tc.function.name,
        content: JSON.stringify(result),
      });
    }
  }

  if (iter >= MAX_TOOL_ITERATIONS && !finalText) {
    recordAgentMetric({
      tenantId, columnId: column.id, cardId: card.id,
      event: 'tool_loop_max', reason: `inactivity_fire iter=${iter}`,
    });
    return { status: 'error', message: 'tool_loop_max_iterations' };
  }

  // Anti-meta-commentary (defesa em profundidade): se o LLM retornou
  // texto narrando suas proprias acoes em vez de mensagem pro cliente,
  // suprime — nao envia.
  if (finalText && looksLikeMetaCommentary(finalText)) {
    logger.warn(`[col-agent.runFromFire] meta_commentary bloqueou envio para ${customerPhone}: "${finalText.slice(0, 100)}"`);
    recordAgentMetric({
      tenantId, columnId: column.id, cardId: card.id,
      event: 'blocked', reason: 'meta_commentary_inactivity',
    });
    finalText = '';
  }

  // FIX 2026-05-08 — Classificador LLM 2a passada (defesa em camadas)
  if (finalText) {
    const addressee = await classifyAddressee(finalText, tenantId);
    if (addressee === 'about_client') {
      logger.warn(`[col-agent.runFromFire] meta_commentary_llm bloqueou envio para ${customerPhone}: "${finalText.slice(0, 100)}"`);
      recordAgentMetric({
        tenantId, columnId: column.id, cardId: card.id,
        event: 'blocked', reason: 'meta_commentary_llm_inactivity',
      });
      finalText = '';
    }
  }

  // FIX 2026-05-06 — barra "" / so pontuacao / single-emoji do inactivity fire
  if (finalText && isReplyEmptyish(finalText)) {
    logger.warn(`[col-agent.runFromFire] emptyish reply suprimido card=${card.id}: "${finalText.slice(0, 50)}"`);
    recordAgentMetric({
      tenantId, columnId: column.id, cardId: card.id,
      event: 'blocked', reason: 'emptyish_reply_inactivity',
    });
    finalText = '';
  }

  // KILL SWITCH: card movido pra coluna sem agente durante o tool loop.
  // Mesmo guard do runColumnAgent — cliente em Atendimento Humano = zero
  // msg automatica. Se card moveu, suprime o envio.
  if (finalText && !isCardStillOnAgentColumn(tenantId, card.id)) {
    logger.warn(`[col-agent.runFromFire] card=${card.id} movido pra coluna sem agente — abort send para ${customerPhone}`);
    recordAgentMetric({
      tenantId, columnId: column.id, cardId: card.id,
      event: 'blocked', reason: 'card_moved_to_human_column_inactivity',
    });
    finalText = '';
  }

  // Envia texto final (se houver). Se LLM so chamou tools (ex: marcar_morno
  // sem mensagem), nao mandamos nada — comportamento valido.
  if (finalText) {
    try {
      await sendReply(channel, customerPhone, finalText, contactId);
      recordAgentTurn(card.id, 'agent');
    } catch (err: any) {
      logger.error('[col-agent.runFromFire] send falhou:', err?.message);
      return { status: 'error', message: err?.message || 'send_failed' };
    }
  }

  recordAgentMetric({
    tenantId, columnId: column.id, cardId: card.id,
    event: 'executed', reason: `from_inactivity_fire fire_count=${fireCount} iter=${iter}`,
  });
  logger.info(
    `[col-agent.runFromFire] ✓ card=${card.id} role=${role} fire=${fireCount} ` +
      `elapsed=${elapsedMin}min iter=${iter} hadText=${!!finalText}`,
  );
  return { status: 'executed', reply: finalText };
}

const INACTIVITY_CONTEXT_BLURB = `

# CONTEXTO DE INATIVIDADE
Cliente nao respondeu apos sua ultima mensagem. O sistema disparou um timer
de inatividade. Use as tools disponiveis pra agir — voce pode:
- Mandar UMA mensagem de cobranca gentil (so primeira ou segunda vez)
- Chamar marcar_morno se cliente parece desinteressado
- Promover com tag='frio' (so pra cotador) pro proximo agente tentar
- Marcar perdido se ja tentou cobrar antes sem sucesso

NAO mande mais de 1 mensagem por disparo. NAO se reapresente.

# REGRA CRITICA — TEXTO VAI LITERALMENTE PRO CLIENTE
Qualquer texto que voce emitir FORA de tool_calls eh enviado palavra-por-palavra
pro cliente via WhatsApp. NUNCA escreva meta-comentario (relato do que voce fez,
do que vai fazer, ou do estado do cliente). NUNCA fale do cliente em 3a pessoa.
Frases PROIBIDAS: "Feito!", "Marquei como morno", "Agendei follow-up", "Vou
aguardar a resposta do cliente", "Acabei de mandar a primeira mensagem", "ainda
eh cedo", "o cliente parece", "o cliente continua". Esse texto eh pro operador
interno e NAO PODE chegar no cliente. Se voce so vai chamar tools e nao tem
mensagem real pra enviar, retorne string vazia ("").
`;

function buildInactivityInstruction(fireCount: number, elapsedMin: number, role: ColumnAgentRole): string {
  // fireCount === 0 e o entry_delay (card acabou de chegar na coluna).
  // NAO e "cliente sem responder" — e "execute sua missao default agora".
  // Sem esse branch, o LLM recebia "Cliente continua sem responder (0a
  // tentativa)" e marcava morno/perdido em vez de mandar a cotacao.
  if (fireCount === 0) {
    return `[SYSTEM:entry] O card acabou de chegar nesta coluna (role=${role}). ` +
      `Execute AGORA a missao default descrita no seu system prompt — nao espere mensagem do cliente, nao se reapresente. ` +
      `Le os dados ja coletados (ler_dados_card), executa a tool principal do role (ex: gerar_cotacao_sulamerica pra cotador), envia o texto pro cliente palavra-por-palavra, aplica a tag de marco e promove pra proxima coluna na MESMA virada. ` +
      `Se faltar dado obrigatorio, escala_humano(motivo: "dado faltante: <campo>"). NAO escreva meta-comentario.`;
  }
  const headline = fireCount === 1
    ? `Cliente nao respondeu ha ${elapsedMin} minutos.`
    : `Cliente continua sem responder (${fireCount}a tentativa, ${elapsedMin}min desde ultimo timer).`;
  const guidance = fireCount === 1
    ? `Avalie o contexto da conversa e decida: (a) cobrar gentilmente UMA vez, (b) marcar_morno + agendar D+2, (c) promover com tag 'frio' (so se voce eh cotador), ou (d) marcar_perdido se ja deu sinais claros de desinteresse antes.`
    : `Voce ja tentou ${fireCount - 1}x. Forte preferencia: marcar_morno, marcar_perdido, ou promover com tag='frio'. NOVA cobrança so se houver razao especifica no historico.`;
  return `[SYSTEM:inactivity_fire] ${headline} Role atual: ${role}. ${guidance}`;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/** Detecta texto que o LLM produziu como meta-comentario interno (falando
 *  SOBRE o cliente / SOBRE suas acoes em vez de falando COM o cliente). Esse
 *  texto NUNCA pode ser enviado pelo WhatsApp. Bug recorrente quando o LLM
 *  recebe instrucao [SYSTEM:inactivity_fire] e responde como observador.
 *  Heuristica conservadora: padroes fortes que praticamente nao aparecem em
 *  mensagem real pro cliente (referencia ao cliente em 3a pessoa, frases de log
 *  sobre tools, "ainda eh cedo", "vou aguardar", etc). */
export function looksLikeMetaCommentary(text: string): boolean {
  if (!text) return false;
  const t = text.toLowerCase();
  const patterns: RegExp[] = [
    // ─── Referencia ao cliente em 3a pessoa ─────────────────────────────
    /\bo cliente\b/,
    /\bo lead\b/,
    /\beste lead\b/,
    /\besse lead\b/,
    /\bcliente parece\b/,
    /\bcliente continua\b/,
    /\bsem responder (o )?cliente/,
    /\b(a |o )?cliente \(.*\) (pediu|perguntou|comentou|sinalizou|demonstrou)/,
    /\bela (n[aã]o respondeu|ainda n[aã]o respondeu|demonstrou interesse)/,
    /\bele (n[aã]o respondeu|ainda n[aã]o respondeu|demonstrou interesse)/,
    // ─── Aguardar / esperar resposta ────────────────────────────────────
    /\bvou aguardar (a |o |sua |uma )?(resposta|cliente|mensagem)/,
    /\bvou (esperar|aguardar) (ele|ela) responder/,
    /\baguardando (corretor|atendimento|humano|retorno do cliente)/,
    // ─── Relato de acoes proprias ──────────────────────────────────────
    /\bacabei de (mandar|enviar) (a |uma |minha )?(primeira )?(mensagem|msg)/,
    // FIX 2026-05-01: vazamento real visto em prod — agente mandou pro cliente
    // "Cliente não respondeu nada ainda — só a saudação inicial que eu mandei.
    // Vou fazer a 1ª cobrança gentil." Os patterns abaixo cobrem cada um dos
    // 3 elementos meta dessa frase: estado do cliente em 3a pessoa, narrativa
    // de mensagem propria ja enviada, e narrativa do que vai fazer agora.
    /\bcliente (ainda )?n[aã]o (respondeu|escreveu|retornou|falou|deu sinal|deu retorno|reagiu|interagiu)\b/,
    /\bque eu (mandei|enviei|disse|escrevi|j[aá] mandei|j[aá] enviei)\b/,
    /\bminha (última|ultima|primeira|primeir[oa]) (mensagem|msg|cobran[cç]a|tentativa|abordagem|saudac[aã]o|saudação)/,
    /\bsauda[cç][aã]o inicial\b/,
    /\bvou (fazer|tentar|aplicar|disparar|mandar|enviar|iniciar) (a |uma |minha |o |um |meu )?(\d+[aªo°]?\s*)?(cobran[cç]a|tentativa|abordagem|chase|reabertura|cutucada|saudac[aã]o|saudação|follow[\s\-]?up|reengajamento)/,
    /\b\d+[aªo°]\s*(cobran[cç]a|tentativa|abordagem|chase|saudac[aã]o|saudação|reengajamento)\b/,
    /\b(primeira|segunda|terceira|[uú]ltima)\s+(cobran[cç]a|tentativa|abordagem|chase|saudac[aã]o|saudação)\b/,
    // FIX 2026-04-30: bug ortografico — "marquei"/"classifiquei" usam
    // "marqu"/"classifiqu" (ortografia portuguesa), nao "marc"+"quei". Antes
    // o regex tinha (marc|...)(quei) que NUNCA casava com "marquei". Vazou
    // "Marquei como morno..." pro cliente. Aceita as duas raizes + "i" e
    // "amos" (defini, definimos), e tolera ate 30 chars entre verbo e label
    // (ex: "marquei como morno com follow-up").
    /\b(marc|marqu|anot|registr|classific|classifiqu|sinaliz|defin)(ar|ada|adas|ado|ados|amos|am|aram|ou|ei|emos|e|i|iu|imos|iram)\b.{0,30}\b(como )?(morno|perdid[oa]|fri[oa]|quent[ea]|qualificad[oa]|desqualificad[oa]|interessad[oa])\b/,
    /\b(j[áa] )?agendei (o |um |a |meu )?follow[\s\-]?up/,
    /\bagendei .{0,30}(retorno|contato|liga[cç][aã]o)/,
    /\bpromov(i|ido) (o |a |para|o card)/,
    /\b(j[áa] )?escalei (o |a )?(cliente|atendimento|caso|lead)/,
    /\bencaminh(ei|ado) (o |para o |pro )?(corretor|daniel|humano|atendimento)/,
    /\bpassei (o |para o |pro )?(corretor|daniel|humano|atendimento)/,
    /\bvou (mandar|enviar) (uma |um )?(cobran[cç]a|mensagem|msg) (gentil|leve|amig[aá]vel|firme|educada|simples)/,
    // ─── Status / lead-tagging ──────────────────────────────────────────
    /\blead (qualificado|desqualificado|frio|morno|quente|aleat[oó]rio)\b/,
    /\bstatus[:\s]+(morno|frio|quente|qualificado|aguardando|perdido)/,
    // FIX 2026-04-30: agente vazou identidade de role pro cliente (caso
    // Maria Cecilia Goncalves: "sou a qualificadora, da PV Corretora").
    // Cliente NUNCA pode ouvir o role tecnico do agente — qualificador,
    // cotador, vendedor, coletor, followupper, closer. Bloqueia tanto
    // formas masculinas quanto femininas + frases de auto-identificacao.
    /\b(sou|me chamo|aqui [eé]) (a |o )?(qualificador[ae]?|cotador[ae]?|vendedor[ae]?|coletor[ae]?|followupper|closer|educador[ae]?|finalizador[ae]?)\b/,
    /\b(sou|me chamo) (o |a |um |uma )?(bot|ia|assistente|agente|atendente virtual|inteligencia artificial|intelig[eê]ncia artificial)\b/,
    /\b(eu sou|sou) (o |a )?role[:\s]/,
    // ─── Meta de fluxo / sistema interno ────────────────────────────────
    /\bainda [eé] cedo (pra|para)/,
    /\bcomposi[cç][aã]o familiar (completa|coletada|registrada)/,
    /\b(necess[aá]rio|preciso) (montar|gerar|criar) (a |uma )?(proposta|cota[cç][aã]o) personalizada/,
    /\bcorretor (humano )?(precisa|deve|vai) (assumir|atender|ligar|continuar)/,
    /\bproposta personalizada\b/,
    /\bpr[oó]ximo passo[:\s]/,
    // FIX 2026-04-30: vazamentos novos vistos em prod (cliente Tania).
    // Agente narrava o pr[oó]prio raciocinio dentro de mensagem ao cliente.
    /\bdeixa eu (avaliar|analisar|pensar|revisar|checar|olhar|considerar)/,
    /\b(última|ultima|primeira|sua) (pergunta|mensagem|msg|d[uú]vida) (ficou|est[aá]|esta) no ar/,
    /\bficou no ar\b/,
    /\bvolt(o|arei|amos) a (atender|responder|falar)/,
    /\b(o )?sistema (dispara|envia|manda|aciona|aplica|vai disparar|vai enviar) (o |a |uma |um )?(follow[\s\-]?up|cobran[cç]a|alerta|mensagem|msg)/,
    /\bfollow[\s\-]?up autom[aá]tico\b/,
    /\bse (ela|ele|o cliente|a cliente) (responder|escrever|falar|retornar) at[eé]/,
    /\bcaso contr[aá]rio[,\s]+(o |a )?(sistema|bot|agente|automation|automa[cç][aã]o)/,
    /\bdemonstrou interesse real\b/,
    /\bn[aã]o perder o fio da meada\b/,
    /\bvou acionar (o |a )?(corretor|sistema|alerta|bot)/,
    /\bj[aá] vou acionar\b/,
    /\binativ[oa] \(\d+ (minutos?|min|horas?|h|dias?|d)\)/,
    /\b\(0 minutos?\)/,
    // ─── Bullet/checklist meta ──────────────────────────────────────────
    /^[\s]*[-•*]\s*(status|tag|lead|cliente)/im,
    /^[\s]*✅\s*(marcado|aplicado|feito|conclu[ií]do)/im,
    // FIX 2026-04-30: blocos de an[aá]lise estruturada com bullets — o LLM
    // as vezes responde com "- A cliente (Tania) pediu..." como se
    // estivesse num scratchpad. Cliente nunca v[ê] msg formatada assim.
    /^[\s]*-\s+[aA]\s+cliente\s+\(/im,
    /^[\s]*-\s+[eE]u\s+(perguntei|disse|mandei|enviei|escrevi|comentei)/im,
    /^[\s]*-\s+[aA]cabou\s+de\s+ficar\s+(inativ[oa]|sem)/im,
    // FIX 2026-05-05 — vazamento real card 0ef81eb48d37: bot mandou
    // "Dados salvos com sucesso! Como o card já está com o corretor Daniel,
    // meu trabalho aqui está feito. Vou só aguardar a resposta do cliente."
    // Esse texto eh narrativa interna pos-promocao, NUNCA pode chegar no cliente.
    /\bdados\s+(foram\s+)?(salvos|gravados|registrados)\s+(com\s+sucesso|corretamente|certinho|ok)/i,
    /\bsalvei\s+(os\s+)?(dados|seus\s+dados|tudo|as\s+informa[cç][oõ]es)/i,
    /\bmeu\s+trabalho\s+(aqui\s+)?(est[aá]\s+feito|est[aá]\s+conclu[ií]do|terminou|acabou|finalizou)/i,
    /\bminha\s+(tarefa|miss[aã]o|fun[cç][aã]o)\s+(aqui\s+)?(est[aá]\s+feita|est[aá]\s+conclu[ií]da|terminou|acabou)/i,
    /\bvou\s+(s[oó]\s+|apenas\s+|somente\s+|ficar\s+|aguardar\s+|estar\s+)?(aguard|esper)/i,
    /\b(como\s+|j[aá]\s+que\s+)?o\s+card\s+(j[aá]\s+)?(est[aá]|foi|virou|passou)/i,
    /\bcard\s+(foi\s+)?(movido|promovido|transferido|encaminhado)/i,
    /\b(j[aá]\s+)?est[aá]\s+com\s+(o\s+)?corretor\b/i,
    /\b(o\s+|a\s+)?corretor\s+(daniel\s+)?(j[aá]\s+)?(enviou|mandou|recebeu|assumiu|continua|vai\s+continuar)/i,
    /\bnaturalmente\s*\.?\s*[😊😀🙂]?\s*$/i, // termina com "naturalmente 😊" (sinal de fechamento meta)
    // FIX 2026-05-05 — vazamento real cliente Norma: bot mandou
    // "A cliente Norma já preencheu os dados no formulário de entrada.
    // Vou analisar: Nome:... Idade:... Composição familiar:..."
    // Bot estava narrando os dados em 3a pessoa pro cliente, com headers em
    // **bold** e bullets — formato scratchpad interno.
    /^\s*a\s+cliente\s+[\wÀ-ú]+\s+(j[aá]\s+)?(preencheu|mandou|enviou|forneceu|deu|disse|escreveu|passou|trouxe|completou)/im,
    /\bvou\s+(analisar|verificar|conferir|revisar|olhar|examinar|considerar|avaliar)[:\s]/i,
    /\bpreencheu\s+(os\s+)?dados\s+(no|do|de|na)\s+formul[aá]rio/i,
    // Headers de scratchpad ("**Nome:** Foo\n**Idade:** Bar\n**Composição:**")
    // Quando aparecem 2+ headers em bold seguidos de dados estruturados, e
    // texto de operador interno — cliente normal nao recebe formulario.
    /\*\*\s*(nome|idade|tipo|composi[cç][aã]o|titular|dependentes?|composi[cç][aã]o\s+familiar)\s*[:：]\s*\*\*/i,
    // FIX 2026-05-06 — vazamentos novos vendedor (Luiz Carlos, Val, Regiane, Rita, Norma).
    // 1) "Agora vou mandar/perguntar/te enviar..." — narrativa de acao seguinte
    /\bagora\s+vou\s+(mandar|enviar|te\s+mandar|te\s+enviar|fazer|perguntar|te\s+perguntar|chamar|coletar|gerar|montar|colocar|aplicar|disparar)/i,
    // 2) "O card tem/contem/trouxe/veio com/já tem..." — narrando estado interno
    /\bo\s+card\s+(tem|cont[eé]m|trouxe|veio\s+com|j[aá]\s+tem|acabou\s+de\s+chegar|chegou\s+com)/i,
    // 3) "Pelo nome <X>, deduzo/presumo/infiro/chuto" — externando raciocinio
    /\bpelo\s+nome\s+[\wÀ-ú]+\s*[,.]?\s*(deduzo|presumo|infiro|imagino|suponho|acredito\s+que|chuto|aposto)/i,
    /\b(deduzo|presumo|infiro|chuto)\s+que\s+(o\s+|a\s+|seja\s+)?(sexo|idade|nome|titular)/i,
    // 4) "Mas não tem o X salvo/registrado/coletado" — discutindo estado de campo
    /\b(mas\s+)?n[aã]o\s+(tem|consta|est[aá])\s+(o\s+|a\s+)?\*?\*?(sexo|idade|nome|cpf|rg|email|tipo|capital|forma\s+de\s+pagamento)\*?\*?\s+(do|da)?\s*(titular|cliente|lead)?\s*(salvo|registrado|preenchido|coletado|gravado|disponivel|dispon[ií]vel)/i,
    // 5) Confirmacoes parentéticas tipo "(confirmado)" / "(salvo)" / "(coletado)"
    /\([\wÀ-ú\s,]*\b(confirmado|salvo|coletado|registrado|gravado|preenchido)\b[\wÀ-ú\s,]*\)/i,
    // 6) "está/fica acima/fora da faixa de elegibilidade/aceitacao/contratacao"
    /\b(est[aá]|fica|encontra-se|encontra\s+se)\s+(acima|fora|abaixo)\s+da\s+faixa\s+(de\s+)?(elegibilidade|aceita[cç][aã]o|contrata[cç][aã]o|idade)/i,
    // 7) Tecniques: "max 74 para titular", "limite de X para Y" em texto
    /\b(max|m[aá]ximo|limite\s+(de\s+)?(\d+|m[aá]ximo))\s+(de\s+)?\d+\s+(para|pra|aceito\s+pra)\s+(titular|dependente|contrata[cç][aã]o|adesao|adesão)/i,
    // 8) Iniciar resposta com "Entendi." + tecnico (nao bloqueia "Entendi!" curto seguido de fala humana)
    /^\s*entendi\s*[.!]?\s+(o\s+(card|hist[oó]rico|sistema|cliente)|a\s+cliente\s+[\wÀ-ú]|do\s+que\s+(consta|est[aá])\s+aqui)/i,
    // 9) "vou agora montar/gerar a cotacao" / "vou aplicar a tag"
    /\bvou\s+(agora\s+)?(aplicar|colocar|registrar|salvar|setar|usar)\s+(a\s+|o\s+|uma\s+|um\s+)?(tag|status|valor|capital|cota[cç][aã]o)/i,
    // 10) Bullet com numero + "Sobre/A respeito de/Quanto a" no inicio (formato scratchpad enumerado)
    /^\s*\*\*\d+\)?\*\*\s+(sobre|a\s+respeito|quanto\s+a|com\s+rela[cç][aã]o)/im,
    // 11) "Beleza! Agora vou te perguntar..." — combinacao saudacao + meta
    /^\s*(beleza|perfeito|certo|ok|bacana|massa)\s*[!.]?\s+(agora\s+)?vou\s+(te\s+)?(perguntar|mandar|enviar|fazer|coletar)/i,
    // FIX 2026-05-06 (Daniel) — vazamentos novos pegos na auditoria:
    // 12) "Vou seguir o fluxo natural" / "proxima pergunta do fluxo" / "do roteiro"
    /\bvou\s+seguir\s+o\s+fluxo\b/i,
    /\bpr[oó]xim[ao]\s+pergunta\s+do\s+fluxo\b/i,
    /\bdo\s+roteiro\b/i,
    /\bpergunta\s+\d+\s+do\s+(roteiro|fluxo|script)\b/i,
    // 13) Bot mencionando API/sistema oficial pro cliente
    /\bAPI\s+(oficial|do\s+sistema|da\s+sulamerica|da\s+sul\s*am[eé]rica)\b/i,
    /\bvou\s+cotar\s+(aqui\s+)?com\s+a\s+api/i,
    /\bsistema\s+oficial\s+da\s+sulamerica/i,
    /\bcotador\s+oficial\b/i,
    // 14) Pergunta fechada "Topa?" no final (e variacoes simples)
    /[?!]\s*topa\??\s*$/im,
    /\btopa\??\s*$/im,
    /[?!]\s*aceita\??\s*$/im,
    // 15) Bot anuncia "Vou cotar aqui" — desnecessario, soa robotico
    /\bvou\s+cotar\s+aqui\b/i,
    // FIX 2026-05-06 (Daniel) — vazamentos pegos no monitoring continuo:
    // 16) "Deixa eu ver seus dados aqui" / "Deixa eu puxar"
    /\bdeixa\s+eu\s+(ver|puxar|consultar|olhar|conferir|carregar)\s+(seus?\s+)?(dados?|informa[cç][oõ]es?)/i,
    // 17) "Vou mandar pra [Nome]" / "Vou enviar pra [Nome]" — falando do cliente em 3a pessoa
    /^\s*Vou\s+(mandar|enviar)\s+pr[aá]?\s+[A-Z][\wÀ-ú]+(\s+[\wÀ-ú]+)*\s/im,
    // 18) "Vou montar aqui pra você:" seguido de lista bullet com bold (scratchpad)
    /\bvou\s+(montar|organizar|estruturar|preparar|listar)\s+(aqui\s+)?pra?\s+(voc[eê]|cliente)?:?\s*\n[\s•\-*]+\*\*/i,
    // 19) "Vou dar (mais )?uma chance" / "Vou tentar de novo" — narrativa interna
    /\bvou\s+(dar\s+(mais\s+)?(uma|outra)\s+chance|tentar\s+de\s+novo|tentar\s+novamente)/i,
    // 20) "Vou mandar um atalho" / "Vou mandar resumido" — narrativa estrategia
    /\bvou\s+mandar\s+(um\s+)?(atalho|resumido?|resumo|breve|rapidinho)/i,
    // 21) "A cliente pediu" / "ela pediu" / "ele pediu" — terceira pessoa apos verbo
    /\b(a\s+|o\s+)?cliente\s+(pediu|disse|mandou|escreveu|falou)\b/i,
    /\b(ela|ele)\s+(pediu|disse|mandou|escreveu|falou|comentou)\s+(que|pra|para|antes|depois)/i,
    // 22) "tô aguardando" / "to aguardando" — narrativa de espera
    /\bt[oô]\s+(aguardando|esperando)\s+(ela|ele|o\s+cliente|a\s+cliente|resposta|retorno)\b/i,
    // 23) "Já vi aqui" / "Vi aqui que" — narrativa de leitura interna
    /\bj[aá]\s+vi\s+aqui\b|^\s*Vi\s+aqui\s+que/im,
    // 24) Lista enumerada com bold de campos sao scratchpad ("- **Plano principal:** X")
    /^[\s•\-*]+\*\*(plano\s+principal|n[ií]vel\s+funeral|indeniza[cç][aã]o|sem\s+extras|extras|capital|composi[cç][aã]o)\s*:\*\*/im,
    // FIX 2026-05-06 — vazamentos pegos na auditoria de 63 cards "Atendimento Humano":
    // 25) "Vejo que eu acabei pulando..." / "Vejo que ele/ela..." — abertura observador
    /\bvejo\s+que\s+(eu|ele|ela|o\s+cliente|a\s+cliente|a\s+conversa|o\s+card)/i,
    // 26) "Pelo que entendi, a/o <Nome> é/está/foi..." — meta-resumo em 3a pessoa
    /\bpelo\s+que\s+(entendi|vi|li|consegui|j[aá]\s+vi)\s*[,.]?\s+(a|o)\s+[\wÀ-ú]+\s+(é|e|está|esta|foi|j[aá])/i,
    // 27) "Agora é aguardar/esperar (o retorno|a resposta) (dela|dele|do cliente)"
    /\bagora\s+[ée]\s+(aguardar|esperar)\s+(o\s+retorno|a\s+resposta|a\s+volta|ele|ela)/i,
    /\bretorno\s+(dela|dele|do\s+cliente|da\s+cliente)\b/i,
    // 28) "(Ela|Ele) tava (na dúvida|aguardando|querendo|...)"
    /\b(ela|ele)\s+tava\s+(na\s+d[uú]vida|aguardando|esperando|pensando|avaliando|querendo|com\s+d[uú]vida|sem\s+responder|inativa?)/i,
    // 29) "Vou retomar naturalmente o raciocínio" — narrativa de continuação interna
    /\bvou\s+retomar\s+(naturalmente\s+)?(o\s+raciocinio|o\s+raciocínio|a\s+conversa|de\s+onde|naturalmente)/i,
    /\bnaturalmente\s+o\s+racioc[ií]nio\b/i,
    // 30) "A cliente fechou/encerrou/indicou/continua/sumiu/parou/deixou/preferiu"
    /\b(a\s+|o\s+)?cliente\s+(fechou|encerrou|indicou|continua|sumiu|parou|deixou|preferiu|j[aá]\s+(fechou|encerrou|indicou|sumiu|parou))/i,
    // 31) "Vou só deixar quieto" / "Vou ficar quieto" / "Vou só observar"
    /\bvou\s+(s[oó]\s+|apenas\s+|somente\s+|ficar\s+)?(deixar\s+(quieto|de\s+lado|pra\s+l[aá])|ficar\s+(quieto|em\s+sil[eê]ncio|de\s+olho)|observar(\s+(em\s+sil[eê]ncio|de\s+longe))?)/i,
    // 32) "Sem mensagem." / "Sem cobrar." — fechando narrativa interna
    /\bsem\s+(mensagem|cobrar|cobran[cç]a|pressionar|press[aã]o|abordar)\s*\.?\s*$/im,
    // 33) "Já tem(os) uma cotação salva aqui" / "Já temos os dados salvos"
    /\bj[aá]\s+(tem|temos)\s+(uma\s+|os\s+|as\s+)?(cota[cç][aã]o|dados|informa[cç][oõ]es|valores)\s+(salva|salvos|salvas|aqui|prontas?|prontos?|guardad[oa]s?)/i,
    // 34) "Já agendei pra retomar" / "Marquei pra retomar daqui uns dias"
    /\b(j[aá]\s+)?(agendei|marquei|deixei\s+agendado|deixei\s+marcado)\s+.{0,50}(retomar|retornar|tentar\s+de\s+novo|cobrar\s+(de\s+)?novo)/i,
    // 35) "Aqui foi anotado" / "Aqui foi registrado" — narrativa de campo
    /\baqui\s+(foi|j[aá]\s+foi|est[aá])\s+(anotado|registrado|gravado|salvo|coletado|preenchido)/i,
    // 36) "Não precisa cobrar" / "Não precisa mandar mensagem" — instrução interna
    /\bn[aã]o\s+precisa\s+(cobrar|mandar\s+(mensagem|msg)|insistir|pressionar|abordar)/i,
    // 37) "Pronto! Agora é..." / "Pronto. Agora vou..." — início de relato pos-acao
    /^\s*pronto\s*[.!]\s+agora\s+(é|e|vou|posso|s[oó]\s+falta)/im,
    // 38) "[NOME] (j[aá])? (preencheu|forneceu|deu|indicou) os? (dados|filhos|familiares|valores)" no inicio
    //     (extensao do pattern que ja existe — agora aceita "indicou" e "j[aá]")
    /^\s*[\wÀ-ú]+\s+(j[aá]\s+)?(preencheu|forneceu|deu|indicou|trouxe|passou|completou)\s+(os\s+|as\s+|um\s+|uma\s+|o\s+|a\s+)?(dados|filhos|familiares|idades|valores|nomes|cpf|cep|endere[cç]o)/im,
    // FIX 2026-05-06 — vazamento real card JADEMAR (20:16, pos-deploy):
    // "Deixei registrado. Se o Jademar voltar a falar, eu retomo daqui mesmo 😊"
    // 39) "Deixei registrado/anotado/marcado" como abertura/sentenca solta (sem vocativo)
    /^\s*(j[aá]\s+)?deixei\s+(registrado|anotado|marcado|agendado|salvo|gravado)\s*[.!]?\s*(se|que|o|a|aqui|isso|tudo|para)\b/i,
    /^\s*(j[aá]\s+)?deixei\s+(registrado|anotado|marcado|agendado|salvo|gravado)\s*\.?\s*$/im,
    // 40) "Se o/a <Nome> voltar a falar/escrever/responder" — 3a pessoa pelo nome
    /\bse\s+(o|a)\s+[A-ZÀ-Ú][\wÀ-ú]+(\s+[\wÀ-ú]+)*\s+(voltar|retornar|aparecer|responder|escrever|falar|chamar|der\s+sinal)\b/i,
    // 41) "eu retomo/continuo daqui/aqui/de onde paramos" — narrativa interna pos-fechamento
    /\beu\s+(retomo|continuo|sigo|reabro|reativo|volto)\s+(daqui|aqui|de\s+onde|com\s+ele|com\s+ela|a\s+conversa|naturalmente)/i,
    // 42) "Quando ele/ela/<Nome> voltar/responder/aparecer" — espera em 3a pessoa
    /\bquando\s+(ele|ela|o\s+cliente|a\s+cliente|o\s+[A-Z][\wÀ-ú]+|a\s+[A-Z][\wÀ-ú]+)\s+(voltar|retornar|responder|aparecer|escrever|der\s+sinal)/i,
    // 43) "Se ela/ele responder depois/amanhã, eu X" — condicional + 3a pessoa
    /\bse\s+(ela|ele)\s+(responder|retornar|aparecer|voltar|escrever)\s+(depois|mais\s+tarde|amanh[aã]|em\s+breve|um\s+dia)/i,
    // FIX 2026-05-06 (incidente disparo Follow Up — Helga, Sil, Hércules):
    // 3 mensagens vazaram texto interno tipo "Tag já estava aplicada. Vou
    // seguir com a mensagem do step 1, adaptada ao histórico dela." LLM
    // narrava o handling de excecao + decisao de continuar pro cliente.
    // 44) "Tag já (estava|foi|existia|aplicada)" — narrativa sobre tag
    /\btag\s+j[aá]\s+(estava|foi|existia|tinha\s+sido|aplicada|estava\s+aplicada)/i,
    /\b(a\s+)?tag\s+j[aá]\s+existia\b/i,
    // 45) "Vou seguir com a mensagem" / "vou seguir o step" / "seguir com X mesmo assim"
    /\bvou\s+seguir\s+(com\s+|o\s+|para\s+)?(a\s+|o\s+)?(mensagem|msg|step|fluxo|passo|roteiro)/i,
    /\bseguir\s+com\s+(a\s+|o\s+)?(mensagem|msg|texto)\s+mesmo\s+assim/i,
    // 46) "step N" / "step 1" / "step do follow" — referencia tecnica de passo
    /\bstep\s+\d+\s+(do|de|da)?\s*(follow[\s\-]?up|fluxo|roteiro|cobran[cç]a)?/i,
    /\bmensagem\s+do\s+step\b/i,
    // 47) "adaptada ao histórico" — meta-reescrita
    /\badaptad[ao]\s+(ao\s+)?(hist[oó]rico|contexto|conversa|caso|cliente)\s+(dela|dele|do\s+cliente|da\s+cliente)?/i,
    // 48) "Hmm" no inicio — pensamento solto vazado
    /^\s*(hmm+|hum+|mmm+|n[oó]ssa+|opa+|epa+)\s*[,.!]?\s+(a\s+|o\s+|j[aá]\s+|essa|esse|isso|tag|status)/i,
    // 49) Combinacao "Tag X. Vou Y." (pattern de duas frases meta encadeadas)
    /\btag\s+[\wáéíóúâêôãõç\s]+\.\s+vou\s+(seguir|enviar|mandar|aplicar)/i,
    // FIX 2026-05-06 — vazamentos novos pegos no Follow Up (Daniel feedback):
    // 50) "Vou agora fazer/dar/pedir/montar/coletar as N perguntas/dados/coisas"
    //     (caso Maricleide "Vou agora fazer as 4 perguntas na ordem pra montar a cotação")
    /\bvou\s+(agora\s+)?(fazer|dar|pedir|montar|coletar|abrir|disparar)\s+(as\s+|os\s+|a\s+|o\s+)?\d+\s+(perguntas?|d[uú]vidas?|dados|coisas?|passos?|etapas?)/i,
    // 51) "Vou (dar|fazer) uma cobrada/cobrança" — meta-narração de cobrança
    //     (caso Maricleide "Vou dar uma leve cobrada")
    /\bvou\s+(dar|fazer|mandar)\s+(uma\s+|um\s+)?(leve\s+|gentil\s+|firme\s+|simples\s+)?(cobrada|cobran[cç]a|cutucada|sacudida|alfinetada|insist[eê]ncia)/i,
    // 52) "cotação automática" / "cotação automatica" — vazamento técnico
    //     (caso Adilson "não consigo fazer a cotação automática pra você")
    /\bcota[cç][aã]o\s+autom[aá]tica/i,
    /\bsimula[cç][aã]o\s+autom[aá]tica/i,
    // 53) "fluxo (do bot|da automacao|do sistema|do agente)" — termo técnico interno
    /\b(o\s+|a\s+)?fluxo\s+(do\s+(bot|sistema|agente|atendimento)|da\s+(automa[cç][aã]o|conversa|venda))/i,
    // 54) "Já tenho os dados" / "Vou agora seguir" / "Vou prosseguir" — narração pré-pergunta
    /\bj[aá]\s+tenho\s+(os\s+|todos\s+(os\s+)?)?dados/i,
    /\bvou\s+(agora\s+)?(prosseguir|continuar)\s+(com\s+|pra\s+|para\s+|na\s+|no\s+)/i,
    // FIX 2026-05-08 (Daniel) — vazamentos novos pegos em prod nas ultimas 48h
    // (Rosana, Creusa, Gilmar, Antonio, Renato, Maria, Nilza, Dilceu, Wilson,
    // Clodoaldo, Lucia, Carlos, Paulo Sergio, etc). Categorias novas:
    // 55) "Vou deixar [ele|ela|registrado|agendado|salvo|aqui|...]"
    //     Cobre: "Vou deixar ele/ela em follow-up", "Vou deixar registrado aqui",
    //     "Vou deixar agendado pra tentar amanhã", "Vou deixar tudo separado pra ele",
    //     "Vou deixar anotado". NAO bloqueia "vou deixar pra você" (vocativo direto).
    /\bvou\s+deixar\s+(ele|ela|esse|essa|este|esta|aquilo|registrado|anotado|agendado|salvo|gravado|marcado|tudo\s+(separado|registrado|anotado|salvo)|aqui\b)/i,
    // 56) "Já atendi a/o [Nome]" — relato pos-fechamento ("Já atendi a Rosana direitinho")
    /\bj[aá]\s+atendi\s+(a|o|ela|ele|esse|essa|este|esta)\s+[\wÀ-ú]+/i,
    // 57) "Atendimento foi concluído/finalizado/encerrado/completado" — status interno
    /\b(o\s+)?atendimento\s+(foi|est[aá]|j[aá]\s+(foi|est[aá]))\s+(conclu[ií]d[oa]|finalizad[oa]|encerrad[oa]|completad[oa]|completo|terminad[oa])/i,
    // 58) "Não precisa de cobrança/follow-up/insistir" — instrucao interna
    /\bn[aã]o\s+precisa\s+(de\s+)?(cobran[cç]a|cobrar|follow[\s\-]?up|insistir|abordar)\b/i,
    /\bn[aã]o\s+precisa\s+nem\s+(de\s+)?(cobran[cç]a|cobrar|follow[\s\-]?up|insistir|abordar)\b/i,
    // 59) "Follow-up agendado" sem vocativo — estado interno do sistema
    /\bfollow[\s\-]?up\s+agendad[oa]\b/i,
    // 60) "[Ela|Ele|Cliente] tá [no trabalho|sumiu|na duvida|ocupada|inativa|sem responder]"
    //     (extensao do pattern 28 que so cobria "tava" — agora cobre "tá", "está", "continua")
    /\b(ela|ele|a\s+cliente|o\s+cliente)\s+(t[aá]|tava|estava|continua|anda|t[aá]\s+sem)\s+(no\s+trabalho|sumi|na\s+d[uú]vida|em\s+casa|ocupad|inativ|sem\s+responder|ausente|fora|viajando|sem\s+sinal|ocupad)/i,
    // 61) "Cliente existente" / "Já é cliente" — status do cliente em narrativa
    /\bcliente\s+(existente|antig[oa]|fiel|j[aá]\s+contratante)\b/i,
    /\bj[aá]\s+[ée]\s+cliente\b/i,
    // 62) "Resolvi a dúvida/questão/problema/caso d(ela|ele|o cliente)"
    /\bresolvi\s+(a\s+|o\s+)?(d[uú]vida|quest[aã]o|pergunta|problema|caso|atendimento)\s+(d[ela]e?|do\s+cliente|do\s+atendimento)/i,
    // 63) "[Ela|Ele|Cliente] (agradeceu|aceitou|recusou|fechou|preferiu|sumiu|desistiu)"
    //     - verbo no passado em 3a pessoa, sem complemento que indique fala
    /\b(ela|ele|a\s+cliente|o\s+cliente)\s+(agradeceu|aceitou|recusou|negou|fechou|preferiu|sumiu|desistiu|n[aã]o\s+quis)\b/i,
    // 64) Texto comeca com "Vou deixar [Nome proprio]" - narrar dispatch em 3a pessoa
    /^\s*(j[aá]\s+)?vou\s+deixar\s+[A-ZÀ-Ú][\wÀ-ú]+\b/im,
    // 65) Texto inicia com "Já atendi" / "Já resolvi" / "Já passei" - relato de acao concluida
    /^\s*j[áa]\s+(atendi|resolvi|passei|encaminhei|finalizei|encerrei|conclu[ií]|fechei)\b/im,
    // 66) "Vou deixar agendado" - narra agendamento sem vocativo
    /\bvou\s+deixar\s+agendado\b/i,
    // 67) "Vai/vou tentar de novo amanhã/depois/em breve" sobre o cliente
    /\b(vai|vou)\s+tentar\s+(de\s+novo|novamente)\s+(amanh[aã]|depois|em\s+breve|mais\s+tarde|daqui\s+a)/i,
    // 68) "Cliente (não) respondeu/voltou/falou (mais|nada|nenhuma vez)" - status em 3a pessoa
    /\b(o\s+)?cliente\s+(n[aã]o\s+)?(respondeu|voltou|falou|escreveu|reagiu|deu\s+sinal)\s+(mais|nada|nenhuma\s+vez|ainda|sequer)/i,
  ];
  return patterns.some((p) => p.test(t));
}

/**
 * FIX 2026-05-08 (Daniel) — Classificador LLM como 2a passada (defesa em
 * camadas). Pergunta a um modelo curto: "esse texto e MENSAGEM PRA o
 * cliente, ou NOTA INTERNA SOBRE o cliente?". Bloqueia se 'about_client'.
 *
 * Estrategia complementar a `looksLikeMetaCommentary` (regex). Pega
 * variantes que regex nao cobre (ex: parafrases novas do LLM principal).
 *
 * Custo: 1 chamada DeepSeek curta por mensagem que passou no regex.
 * Latencia: +300-700ms por mensagem.
 *
 * Fail-open em caso de erro de rede/timeout — preferimos vazar uma msg
 * raramente a deixar bot mudo permanente. Erros sao logados pra observar.
 */
export async function classifyAddressee(
  text: string,
  tenantId: string,
): Promise<'to_client' | 'about_client'> {
  if (!text) return 'to_client';
  // Curto-circuito: textos curtissimos (saudacao, ack) nao precisam de LLM.
  // "Oi", "Tudo bem?", "Bom dia!" tem < 25 chars e nunca sao narrativa.
  if (text.trim().length < 25) return 'to_client';

  const sys = `Voce e um classificador binario.

Receba um texto em portugues e decida se e:
- "client": MENSAGEM ESCRITA PARA o cliente (vendedor falando com ele, em 2a pessoa, com vocativo, pergunta direta, saudacao, instrucao, agradecimento).
- "internal": NOTA INTERNA SOBRE o cliente (3a pessoa, narrar acoes proprias do sistema, descrever estado/decisao, relatar o que aconteceu).

Sinais de "internal": "vou deixar ele/ela", "ela tá", "o cliente nao respondeu", "atendimento concluido", "follow-up agendado", "ja atendi a [nome]", "resolvi a duvida dela", "vou deixar registrado", "ela agradeceu", "nao precisa de cobranca".

Sinais de "client": vocativo direto ("Bom dia, Joao!"), pergunta direta ("Voce prefere o plano X ou Y?"), instrucao ("Manda seu CPF"), agradecimento ("Obrigada por aguardar").

Casos ambiguos: se ha QUALQUER mistura de relato/narrativa com texto que poderia ser pro cliente, classifique como "internal" (cliente nao deveria receber narrativa de jeito nenhum).

Responda APENAS com 1 palavra: "client" ou "internal". Sem pontuacao, sem explicacao.`;

  try {
    const { callDeepSeek } = await import('../ai/agent.js');
    const r = await callDeepSeek(sys, [], text, 'deepseek-chat', tenantId);
    const norm = r.toLowerCase().trim().replace(/[.!?"'`\s]+/g, '');
    if (norm.startsWith('internal')) return 'about_client';
    return 'to_client';
  } catch (err: any) {
    logger.warn(`[col-agent.classifier] LLM falhou (fail-open): ${err?.message || 'unknown'}`);
    return 'to_client';
  }
}

// FIX 2026-05-06 — bug "" (2 chars) chegando no cliente:
// LLM as vezes gera literal `""` ou texto so com pontuacao/aspas/espaco.
// O check existente `if (!finalText)` ignora string vazia mas nao `""`.
// Strip + threshold de 2 chars uteis: passa "Oi" mas barra `""`, `😄` solto,
// `...`, `.`. Reuse em runColumnAgent + runFromInactivityFire.
export function isReplyEmptyish(text: string): boolean {
  if (!text) return true;
  // Remove aspas duplas/simples, espacos, pontuacao, quebras — sobra so palavra
  const stripped = text.replace(/["'`\s.,!?;:\-—–​-‍﻿]/g, '');
  // Strip emojis isolados (preserva texto com emoji)
  const noEmoji = stripped.replace(/\p{Extended_Pictographic}/gu, '');
  // Se sobrou < 2 caracteres uteis, considera vazio (barra "", "😄", ".")
  return noEmoji.length < 2;
}

/** Substitui {{key}} no template pelo valor do dict. Sem template engine. */
function renderPrompt(template: string, vars: Record<string, string>): string {
  let out = template;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replace(new RegExp(`\\{\\{\\s*${k}\\s*\\}\\}`, 'g'), v);
  }
  return out;
}

/** Hora atual no timezone do tenant (hardcoded BRT). */
export function getCurrentHourMinuteBRT(): { hour: number; minute: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: TENANT_TIMEZONE,
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(new Date());
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  // Intl as vezes retorna "24" pra meia-noite (00:xx) — normaliza.
  return { hour: hour === 24 ? 0 : hour, minute };
}

export function isWithinActiveHours(start: string, end: string, override?: { hour: number; minute: number }): boolean {
  const now = override ?? getCurrentHourMinuteBRT();
  const [sh, sm] = parseHHMM(start);
  const [eh, em] = parseHHMM(end);
  const nowMin = now.hour * 60 + now.minute;
  const startMin = sh * 60 + sm;
  const endMin = eh * 60 + em;
  // Nao tratamos janelas que cruzam meia-noite (start=22:00 end=02:00).
  // Caso de uso real seria estranho — operacao 24h normalmente desliga
  // o agente pra essa coluna. Se aparecer demanda, voltamos a tratar.
  return nowMin >= startMin && nowMin < endMin;
}

function parseHHMM(s: string): [number, number] {
  const [h, m] = s.split(':');
  return [Number(h) || 0, Number(m) || 0];
}

/**
 * Onda 63: gera audio TTS e envia como mediaType:'audio'. Em caso de
 * falha, faz fallback pra texto pra nao deixar cliente sem resposta.
 * Loga metric pra observabilidade.
 */
async function sendVoiceReply(
  channel: Channel2,
  customerPhone: string,
  finalText: string,
  contactId: string | null,
  voiceRaw: string,
  tenantId: string,
  cardId: string,
  columnId: string,
): Promise<void> {
  const voice: TtsVoice = isValidVoice(voiceRaw) ? voiceRaw : 'nova';
  const tts = await synthesizeSpeech(finalText, voice, tenantId);

  if (!tts.ok) {
    logger.warn(`[col-agent.runner] TTS falhou (${tts.error}) — fallback texto`);
    recordAgentMetric({
      tenantId, columnId, cardId,
      event: 'tts_failed', reason: tts.error,
    });
    // Fallback: manda texto pra nao deixar cliente sem resposta
    const { sendReply } = await import('../ai/agent.js');
    await sendReply(channel, customerPhone, finalText, contactId);
    return;
  }

  // Resolve cardId pra atividade vincular ao card certo (sendOutbound
  // usa contact lookup, mas explicito eh mais seguro).
  await sendOutbound(channel, {
    to: customerPhone,
    mediaUrl: tts.mediaUrl,
    mediaType: 'audio',
    contactId: contactId || undefined,
    cardId,
  });
  recordAgentMetric({
    tenantId, columnId, cardId,
    event: 'tts_sent', reason: `voice=${voice} bytes=${tts.bytes}`,
  });
}

function buildLockKey(input: RunColumnAgentInput): string {
  if (input.messageId) {
    return `crm:col-agent:msg:${input.messageId}`;
  }
  // Fallback: phone + 30s window (granularidade grossa, mas evita
  // qualquer chance de duplicar quando messageId esta ausente).
  const window = Math.floor(Date.now() / 30000);
  return `crm:col-agent:phone:${input.channel.tenantId}:${input.customerPhone}:${window}`;
}
