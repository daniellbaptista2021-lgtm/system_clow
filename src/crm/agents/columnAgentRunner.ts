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
import type { ToolContext } from './tools/types.js';
import * as store from '../store.js';
import type { Channel2, Card, BoardColumn, ColumnAgentRole } from '../types.js';

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
  imageUrl?: string;
  senderName?: string;
  /** Provider message id — usado pro cluster lock. Se faltar, lock degrada
   *  pra phone+timestamp (menos preciso, mas funcional). */
  messageId?: string;
}

export type RunResult =
  | { status: 'executed'; reply: string }
  | { status: 'blocked'; reason: 'out_of_hours' | 'max_turns' | 'anti_loop' | 'no_text' | 'audio_disabled' | 'transcribe_failed' | 'meta_commentary' }
  | { status: 'locked_out' }
  | { status: 'error'; message: string };

// ─── Public API ──────────────────────────────────────────────────────────

export async function runColumnAgent(input: RunColumnAgentInput): Promise<RunResult> {
  const { channel, card, column, customerPhone } = input;
  const tenantId = channel.tenantId;
  const role = (column.agentRole ?? 'custom') as ColumnAgentRole;

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

  while (iteration < MAX_TOOL_ITERATIONS) {
    iteration++;
    let llmMsg: DeepSeekToolMessage;
    try {
      llmMsg = await callDeepSeekWithTools(messages, llmTools, 'deepseek-chat');
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
      // Sem tool_calls — texto final
      finalText = String(llmMsg.content || '').trim();
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

  if (!finalText) {
    // LLM nao mandou texto (so chamou tools sem responder cliente).
    // Loga e nao envia nada — alguns flows sao validos (ex: marcar_perdido
    // sem despedida; promote sem mensagem).
    logger.info(`[col-agent.runner] no final text card=${card.id} (so tools)`);
    recordAgentMetric({
      tenantId, columnId: column.id, cardId: card.id,
      event: 'executed', reason: 'tools_only_no_reply',
    });
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

  // 10) Envia (sendOutbound loga message_out + bumpa card pro topo)
  try {
    await sendReply(channel, customerPhone, finalText, contactId);
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
}

export async function runFromInactivityFire(input: InactivityFireInput): Promise<RunResult> {
  const { channel, card, column, fireCount, elapsedMin } = input;
  const tenantId = channel.tenantId;
  const role = (column.agentRole ?? 'custom') as ColumnAgentRole;
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
    { role: 'system', content: systemPrompt + INACTIVITY_CONTEXT_BLURB },
    ...history.map((m: ChatMessage) => ({ role: m.role, content: m.content })),
    { role: 'user', content: instruction },
  ];

  let finalText = '';
  let iter = 0;
  while (iter < MAX_TOOL_ITERATIONS) {
    iter++;
    let llmMsg: DeepSeekToolMessage;
    try {
      llmMsg = await callDeepSeekWithTools(messages, llmTools, 'deepseek-chat');
    } catch (err: any) {
      logger.error('[col-agent.runFromFire] DeepSeek falhou:', err?.message);
      return { status: 'error', message: err?.message || 'llm_error' };
    }
    const toolCalls = llmMsg.tool_calls ?? [];
    if (toolCalls.length === 0) {
      finalText = String(llmMsg.content || '').trim();
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
    /\bo cliente\b/,
    /\bcliente parece\b/,
    /\bcliente continua\b/,
    /\bvou aguardar (a |o |sua |uma )?(resposta|cliente|mensagem)/,
    /\bacabei de (mandar|enviar) (a |uma |minha )?(primeira )?(mensagem|msg)/,
    /\bmarc(ar|ado|amos|quei) (como |o cliente como )?(morno|perdido|frio|quente)/,
    /\b(j[áa] )?agendei (o |um |a |meu )?follow[\s\-]?up/,
    /\bainda [eé] cedo (pra|para)/,
    /\bpromov(i|ido) (o |a |para)/,
    /\b(j[áa] )?escalei (o |a )?(cliente|atendimento|caso)/,
    /\bsem responder (o )?cliente/,
    /\bvou (esperar|aguardar) (ele|ela) responder/,
  ];
  return patterns.some((p) => p.test(t));
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

function buildLockKey(input: RunColumnAgentInput): string {
  if (input.messageId) {
    return `crm:col-agent:msg:${input.messageId}`;
  }
  // Fallback: phone + 30s window (granularidade grossa, mas evita
  // qualquer chance de duplicar quando messageId esta ausente).
  const window = Math.floor(Date.now() / 30000);
  return `crm:col-agent:phone:${input.channel.tenantId}:${input.customerPhone}:${window}`;
}
