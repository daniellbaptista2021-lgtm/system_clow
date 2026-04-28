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
  callDeepSeek,
  transcribeAudio,
  loadRecentHistory,
  sendReply,
  type ChatMessage,
} from '../ai/agent.js';
import {
  getCardAgentState,
  upsertCardAgentState,
  recordAgentTurn,
  setCardAgentStatus,
  recordAgentMetric,
} from '../store/cardAgentStateStore.js';
import * as store from '../store.js';
import type { Channel2, Card, BoardColumn, ColumnAgentRole } from '../types.js';

// ─── Defaults ────────────────────────────────────────────────────────────

const DEFAULT_PERSONA_NAME = 'Safira';
const DEFAULT_MAX_HISTORY = 20;
const DEFAULT_MAX_TURNS = 30;
const DEFAULT_HOURS_START = '08:00';
const DEFAULT_HOURS_END = '21:00';
const LOCK_TTL_SECONDS = 60;
const TENANT_TIMEZONE = 'America/Sao_Paulo'; // hardcoded — decisao 4 do PR 2

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
  | { status: 'blocked'; reason: 'out_of_hours' | 'max_turns' | 'anti_loop' | 'no_text' | 'audio_disabled' | 'transcribe_failed' }
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

  // Reforco anti-regressao (mesmo do channel agent — vide ai/agent.ts:296).
  const contextRules = `

# REGRAS DE CONTEXTO (CRITICAS — NAO IGNORAR)
- Voce ESTA no meio de uma conversa em andamento. Leia atentamente as ultimas mensagens trocadas antes de responder.
- NUNCA se reapresente se ja fez sua apresentacao nesta conversa (basta olhar o historico acima).
- NUNCA pergunte algo que o cliente JA respondeu nas mensagens anteriores. Use a informacao que ele ja deu.
- Continue de ONDE PAROU.

# PROMOCAO ENTRE COLUNAS
Voce esta na coluna "${column.name}" (role: ${role}). Esta versao do sistema (PR 2)
NAO tem ainda as tools de promocao habilitadas — entao APENAS responda o cliente.
NAO chame promover_qualificado / promover_vendedor / etc nesta versao. Esses
serao habilitados num upgrade futuro.

# CRITERIOS DE PROMOCAO (referencia, nao chame tools ainda)
${column.agentPromotionCriteria || '(nao definidos)'}
`;
  const finalSystemPrompt = systemPrompt + contextRules;

  // 7) History
  const { contactId, messages: history } = loadRecentHistory(
    tenantId, customerPhone, DEFAULT_MAX_HISTORY,
  );

  // Marca turno do cliente ANTES de chamar LLM (turns_count++).
  // Se o LLM falhar, ja contamos esse turno — evita loop infinito de
  // retry pra mesma msg (que aumentaria turns_count infinitamente
  // e bloquearia eventualmente, mas a custa de varias chamadas de LLM
  // perdidas).
  recordAgentTurn(card.id, 'client');
  state = getCardAgentState(card.id) ?? state;

  // 8) Chama DeepSeek
  let reply: string;
  try {
    reply = await callDeepSeek(finalSystemPrompt, history, userMessage, 'deepseek-chat');
  } catch (err: any) {
    logger.error('[col-agent.runner] DeepSeek falhou:', err?.message);
    recordAgentMetric({
      tenantId, columnId: column.id, cardId: card.id,
      event: 'blocked', reason: 'llm_error',
    });
    return { status: 'error', message: err?.message || 'llm_error' };
  }

  // 9) Anti-loop (mesma logica do channel agent)
  const recentOut = history.filter((m: ChatMessage) => m.role === 'assistant').slice(-1)[0];
  if (recentOut?.content) {
    const norm = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 100).toLowerCase();
    if (norm(recentOut.content) === norm(reply)) {
      logger.warn(`[col-agent.runner] anti-loop bloqueou resposta para ${customerPhone}`);
      recordAgentMetric({
        tenantId, columnId: column.id, cardId: card.id,
        event: 'blocked', reason: 'anti_loop',
      });
      return { status: 'blocked', reason: 'anti_loop' };
    }
  }

  // 10) Envia (sendOutbound loga message_out + bumpa card pro topo)
  try {
    await sendReply(channel, customerPhone, reply, contactId);
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
      `column="${column.name}" turns=${finalState.turnsCount}`,
  );
  return { status: 'executed', reply };
}

// ─── Helpers ─────────────────────────────────────────────────────────────

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
