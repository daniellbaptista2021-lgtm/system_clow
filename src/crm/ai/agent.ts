/**
 * agent.ts — AI agent que atende WhatsApp inbound automaticamente.
 *
 * Replica em código nativo o que o user fazia em n8n separado:
 *   webhook inbound → debounce 8s → transcreve áudio (se houver) →
 *   monta history das últimas N mensagens do contato → DeepSeek com
 *   system prompt do canal → envia resposta via Z-API/Meta.
 *
 * Memória: usa crm_chat_messages (já gravado pelo ingestInbound) como
 * fonte. Não duplica storage. Janela de N msgs (default 20) ordenada
 * por created_at.
 *
 * Disparado em background pelo webhook handler — não bloqueia o
 * 200 OK que volta pra Z-API.
 */
import { logger } from '../../utils/logger.js';
import { getCrmDb } from '../schema.js';
import * as store from '../store.js';
import { sendOutbound } from '../inbox.js';
import type { Channel2 } from '../types.js';
import { pickAgent, type AgentPick } from '../agents/columnAgentSelector.js';
import { runColumnAgent, looksLikeMetaCommentary } from '../agents/columnAgentRunner.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChannelAIConfig {
  enabled: boolean;
  systemPrompt: string;
  model: string;
  audioEnabled: boolean;
  maxHistory: number;
  debounceSeconds: number;
}

// In-memory debounce: phone → timer id. Quando msg nova chega no mesmo
// phone antes do timer expirar, cancela e re-agenda. Garante que o
// agent só processa DEPOIS do cliente parar de digitar (evita responder
// fragmento por fragmento). 8s é o sweet spot pra WhatsApp BR.
const _debounceTimers = new Map<string, NodeJS.Timeout>();

export function readChannelAIConfig(channelId: string): ChannelAIConfig | null {
  const db = getCrmDb();
  const r = db.prepare(`
    SELECT ai_enabled, ai_system_prompt, ai_model, ai_audio_enabled,
           ai_max_history, ai_debounce_seconds
    FROM crm_channels WHERE id = ?
  `).get(channelId) as any;
  if (!r) return null;
  if (!r.ai_enabled) return null;
  if (!r.ai_system_prompt) return null;
  return {
    enabled: true,
    systemPrompt: String(r.ai_system_prompt),
    // Modelo FIXO em deepseek-chat — regra absoluta. Coluna ai_model
    // do schema fica vestigial pra retrocompat, mas e ignorada.
    model: 'deepseek-chat',
    audioEnabled: r.ai_audio_enabled !== 0,
    maxHistory: Number(r.ai_max_history || 20),
    debounceSeconds: Number(r.ai_debounce_seconds || 8),
  };
}

/** Pega últimas N mensagens da timeline do contato (crm_activities).
 *  Usa findContactByPhone (matching 3-niveis: exact, cleaned, ultimos 10
 *  digitos) — phone do Z-API vem com 55, contato no DB pode estar sem.
 *  Antes a gente fazia LIKE '%phone%' que falhava quando o phone do
 *  webhook (5521...) era MAIOR que o do contato (21...) — bot achava
 *  toda interacao primeira e mandava saudacao infinita.
 *
 *  Floor minimo: garantimos pelo menos 10 mensagens de contexto, mesmo
 *  que o config diga menos. Sem contexto suficiente o bot regride e
 *  reapresenta a Safira / repete perguntas. */
export function loadRecentHistory(tenantId: string, customerPhone: string, limit: number): { contactId: string | null; messages: ChatMessage[] } {
  const contact = store.findContactByPhone(tenantId, customerPhone);
  if (!contact) return { contactId: null, messages: [] };
  const effectiveLimit = Math.max(10, limit || 10);
  // listActivitiesByContact ja retorna ASC; pegamos os ultimos N invertendo o slice
  const all = store.listActivitiesByContact(tenantId, contact.id, 1000);
  const msgs = all.filter((a) => a.type === 'message_in' || a.type === 'message_out');
  const recent = msgs.slice(-effectiveLimit);
  return {
    contactId: contact.id,
    messages: recent.map((a) => ({
      role: a.type === 'message_out' ? 'assistant' as const : 'user' as const,
      content: a.content || '',
    })).filter((m) => m.content.length > 0),
  };
}

/** Checa se o contato esta numa coluna onde o bot NAO deve responder
 *  (em tratativa com humano). Padrao: qualquer coluna cujo nome contem
 *  "qualificado" — eh onde o corretor humano assume a conversa.
 *
 *  Tambem aceita colunas com sinalizadores explicitos no nome:
 *  "[no-bot]", "[humano]", "[manual]" (case-insensitive) — pra dar
 *  flexibilidade sem precisar de schema change. */
function isContactInHumanHandoffColumn(tenantId: string, contactId: string): { paused: boolean; columnName?: string } {
  const cards = store.listCardsByContact(tenantId, contactId);
  if (cards.length === 0) return { paused: false };
  const card = cards[0]; // listCardsByContact retorna ORDER BY updated_at DESC
  if (!card.boardId || !card.columnId) return { paused: false };
  const columns = store.listColumns(tenantId, card.boardId);
  const col = columns.find((c) => c.id === card.columnId);
  if (!col) return { paused: false };
  const name = (col.name || '').toLowerCase();
  // Triggers: nome contem palavra-chave de tratativa humana
  const humanKeywords = ['qualificado', '[no-bot]', '[humano]', '[manual]'];
  for (const kw of humanKeywords) {
    if (name.includes(kw)) return { paused: true, columnName: col.name };
  }
  return { paused: false };
}

/**
 * Variante com function calling (PR 3 da Onda 62). Recebe lista
 * crua de mensagens (incluindo role:'tool' + tool_call_id) e tools
 * no formato OpenAI/DeepSeek.
 *
 * Diferente de callDeepSeek (texto only), retorna o `message` cru pra o
 * caller decidir se eh texto final ou tem tool_calls.
 */
export interface DeepSeekToolMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

export async function callDeepSeekWithTools(
  messages: DeepSeekToolMessage[],
  tools: unknown[],
  model = 'deepseek-chat',
): Promise<DeepSeekToolMessage> {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error('DEEPSEEK_API_KEY not configured');
  const r = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model || 'deepseek-chat',
      messages,
      tools,
      tool_choice: 'auto',
      temperature: 0.6,
      max_tokens: 1500,
    }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`deepseek http_${r.status}: ${body.slice(0, 200)}`);
  }
  const d: any = await r.json();
  const msg = d?.choices?.[0]?.message;
  if (!msg) throw new Error('deepseek: empty message in response');
  return msg as DeepSeekToolMessage;
}

/** Chama DeepSeek (OpenAI-compatible) com history + system prompt. */
export async function callDeepSeek(
  systemPrompt: string,
  history: ChatMessage[],
  userMessage: string,
  model: string,
): Promise<string> {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error('DEEPSEEK_API_KEY not configured');
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: userMessage },
  ];
  const r = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model || 'deepseek-chat',
      messages,
      temperature: 0.6,
      max_tokens: 1200,
    }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`deepseek http_${r.status}: ${body.slice(0, 200)}`);
  }
  const d: any = await r.json();
  const content = d?.choices?.[0]?.message?.content;
  if (!content) throw new Error('deepseek: empty content in response');
  return String(content).trim();
}

/** Transcreve audio via Whisper (OpenAI). Retorna string vazia em falha. */
export async function transcribeAudio(audioUrl: string): Promise<string> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    logger.warn('[ai/agent] OPENAI_API_KEY not configured — pulando transcribe');
    return '';
  }
  try {
    // 1. Baixa o áudio
    const audioResp = await fetch(audioUrl);
    if (!audioResp.ok) throw new Error(`audio download http_${audioResp.status}`);
    const audioBuf = Buffer.from(await audioResp.arrayBuffer());
    // 2. Whisper transcribe (multipart/form-data)
    const FormData = (globalThis as any).FormData;
    const Blob = (globalThis as any).Blob;
    const fd = new FormData();
    fd.append('file', new Blob([audioBuf], { type: 'audio/ogg' }), 'audio.ogg');
    fd.append('model', 'whisper-1');
    fd.append('language', 'pt');
    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}` },
      body: fd as any,
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw new Error(`whisper http_${r.status}: ${body.slice(0, 200)}`);
    }
    const d: any = await r.json();
    return String(d?.text || '').trim();
  } catch (err: any) {
    logger.warn('[ai/agent] transcribe falhou:', err?.message);
    return '';
  }
}

/** Envia resposta de volta pelo canal E grava como message_out no CRM.
 *  Sem isso, agent ficava em looping: nao via proprias respostas no
 *  history, achava sempre que era primeira interacao, mandava saudacao
 *  de novo. Reusa sendOutbound de inbox.ts (envia + log activity +
 *  trigger automations).
 *
 *  IMPORTANTE: passamos contactId+cardId pro sendOutbound. Se nao
 *  passar cardId, a activity grava com card_id=NULL e fica invisivel
 *  no painel do card (que filtra por card_id). Resolvemos o card mais
 *  recente do contato (ingestInbound ja criou um pra essa conversa). */
export async function sendReply(
  channel: Channel2,
  customerPhone: string,
  text: string,
  contactId: string | null,
): Promise<void> {
  let cardId: string | undefined;
  if (contactId) {
    const cards = store.listCardsByContact(channel.tenantId, contactId);
    // listCardsByContact retorna ORDER BY updated_at DESC -> primeiro = mais recente
    if (cards.length > 0) cardId = cards[0].id;
  }
  const r = await sendOutbound(channel, {
    to: customerPhone,
    text,
    contactId: contactId || undefined,
    cardId,
  });
  if (!r.ok) throw new Error(`send failed: ${r.error}`);
}

export interface InboundContext {
  channel: Channel2;
  customerPhone: string;
  text?: string;       // texto da mensagem (se for texto)
  audioUrl?: string;   // URL do audio (se for audio)
  imageUrl?: string;   // URL da imagem (se for imagem)
  senderName?: string;
  // Onda 62 (PR 2): provider message id pro cluster lock
  // (crm:col-agent:msg:{messageId} via setNxEx). Opcional pra
  // backward compat — se faltar, usamos fallback baseado em phone+timestamp.
  messageId?: string;
}

/**
 * Entry point: chamado pelo webhook handler em background após
 * ingestInbound gravar a mensagem no DB. Faz debounce + processamento.
 *
 * Onda 62 (PR 2): antes do debounce, decide via pickAgent se vai rodar
 * o agente de coluna (novo) ou o de canal (legado, comportamento atual).
 * Backward compat: se nao tiver agente de coluna ativo, cai no fluxo
 * antigo sem regressao alguma.
 */
const COLUMN_AGENT_DEBOUNCE_SECONDS = 8;

export function handleInboundForAI(ctx: InboundContext): void {
  const { channel, customerPhone } = ctx;

  // Decide (pre-debounce) qual caminho. Se for "none", ja short-circuita
  // sem agendar timer — economiza memoria.
  // O picker eh chamado de novo no fire do timer (mais abaixo) pra
  // capturar mudanças que aconteceram durante o debounce (ex: corretor
  // ativou agente de coluna entre msgs).
  let initialPick: AgentPick;
  try {
    initialPick = pickAgent({ channel, customerPhone });
  } catch (err: any) {
    logger.warn('[ai/agent] pickAgent falhou (assume channel fallback):', err?.message);
    const cfg = readChannelAIConfig(channel.id);
    initialPick = cfg ? { type: 'channel', channel } : { type: 'none', reason: 'no_agent_configured' };
  }
  if (initialPick.type === 'none') return;

  // Debounce key + duracao. Pra channel agent reusa config existente
  // (que pode ter sido tunada por canal). Pra column agent usa default
  // (8s — mesmo sweet spot WhatsApp BR).
  const channelConfig = initialPick.type === 'channel' ? readChannelAIConfig(channel.id) : null;
  const debounceSeconds = channelConfig?.debounceSeconds ?? COLUMN_AGENT_DEBOUNCE_SECONDS;

  const debounceKey = `${channel.id}:${customerPhone}`;
  const existing = _debounceTimers.get(debounceKey);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    _debounceTimers.delete(debounceKey);
    void dispatchAfterDebounce(ctx).catch((err) => {
      logger.error(`[ai/agent] dispatch fail (${customerPhone}):`, err?.message);
    });
  }, debounceSeconds * 1000);
  _debounceTimers.set(debounceKey, timer);
}

/** Re-pickAgent no fire do timer (pode ter mudado durante o debounce) e
 *  roda o runner correspondente. Tudo async, sem retorno — o caller
 *  (timer callback) ja eh fire-and-forget. */
async function dispatchAfterDebounce(ctx: InboundContext): Promise<void> {
  const { channel, customerPhone } = ctx;
  const pick = pickAgent({ channel, customerPhone });
  if (pick.type === 'none') {
    logger.info(`[ai/agent] dispatch=none reason=${pick.reason}`);
    return;
  }
  if (pick.type === 'column') {
    await runColumnAgent({
      channel: pick.channel,
      card: pick.card,
      column: pick.column,
      customerPhone,
      text: ctx.text,
      audioUrl: ctx.audioUrl,
      imageUrl: ctx.imageUrl,
      senderName: ctx.senderName,
      messageId: ctx.messageId,
    });
    return;
  }
  // type === 'channel' — fluxo legado (ZERO regressao)
  const config = readChannelAIConfig(channel.id);
  if (!config) return; // race: removido durante o debounce
  await runAgent(ctx, config);
}

async function runAgent(ctx: InboundContext, config: ChannelAIConfig): Promise<void> {
  const { channel, customerPhone, senderName } = ctx;

  // 1. Resolve contato + history numa unica chamada (reusa contactId
  //    pro anti-loop e pro sendReply, evita 3 lookups redundantes).
  const { contactId, messages: history } = loadRecentHistory(channel.tenantId, customerPhone, config.maxHistory);

  // 1.5. REGRA IMPRESCINDIVEL: se o contato esta na coluna "Qualificado"
  //      (ou outra marcada com [no-bot]/[humano]/[manual]), nao responder.
  //      Cliente esta em tratativa com humano — bot atrapalha. Esse check
  //      vem ANTES de qualquer transcricao/LLM call pra economizar custo.
  if (contactId) {
    const handoff = isContactInHumanHandoffColumn(channel.tenantId, contactId);
    if (handoff.paused) {
      logger.info(`[ai/agent] contato ${customerPhone} esta na coluna "${handoff.columnName}" — bot pausado (tratativa humana)`);
      return;
    }
  }

  // 2. Resolve texto da mensagem
  let userMessage = ctx.text || '';
  if (!userMessage && ctx.audioUrl) {
    if (!config.audioEnabled) {
      await sendReply(channel, customerPhone,
        'No momento só consigo te atender com mensagens de texto. Me manda sua dúvida por escrito? 😊', contactId);
      return;
    }
    userMessage = await transcribeAudio(ctx.audioUrl);
    if (!userMessage) {
      await sendReply(channel, customerPhone,
        'Não consegui entender o áudio. Pode mandar por escrito? 🙂', contactId);
      return;
    }
  }
  if (!userMessage && ctx.imageUrl) {
    await sendReply(channel, customerPhone,
      'No momento só consigo te atender com mensagens de texto ou áudio. Me manda sua dúvida por escrito ou em áudio? 😊', contactId);
    return;
  }
  if (!userMessage) {
    logger.info(`[ai/agent] mensagem sem texto/audio/imagem — ignorando`);
    return;
  }

  // 3. Monta system prompt: substitui placeholders + injeta reforco de
  //    contexto. O prompt do user e bom mas LLMs as vezes ignoram o
  //    historico e regridem pra "Oi sou a Safira" mesmo apos varias
  //    rodadas. Esse anexo no fim e mais resistente a essa regressao.
  const contextRules = `

# REGRAS DE CONTEXTO (CRITICAS — NAO IGNORAR)
- Voce ESTA no meio de uma conversa em andamento. Leia atentamente as ultimas mensagens trocadas antes de responder.
- NUNCA se reapresente se ja fez sua apresentacao nesta conversa (basta olhar o historico acima).
- NUNCA pergunte algo que o cliente JA respondeu nas mensagens anteriores. Use a informacao que ele ja deu.
- Se a ultima coisa que voce disse foi uma pergunta, agora e hora de processar a resposta dele e seguir com o fluxo, NAO repetir a pergunta.
- Continue de ONDE PAROU: olhe sua ultima resposta no historico e veja qual era o proximo passo.
`;
  const systemPrompt = (config.systemPrompt + contextRules)
    .replace(/\{\{customer_name\}\}/g, senderName || 'cliente')
    .replace(/\{\{customer_phone\}\}/g, customerPhone);

  // 4. Chama DeepSeek
  let reply: string;
  try {
    reply = await callDeepSeek(systemPrompt, history, userMessage, config.model);
  } catch (err: any) {
    logger.error('[ai/agent] DeepSeek call falhou:', err?.message);
    return;
  }

  // 5. Anti-loop: se a ultima resposta do bot (no history que ja
  //    carregamos) e quase identica a nova, bloqueia. Isso evita
  //    saudacao 3x seguidas quando o user manda multiplas msgs
  //    rapidas que cabem todas no debounce, ou quando o LLM regride
  //    pra "Oi sou a Safira..." mesmo ja tendo se apresentado.
  if (contactId) {
    try {
      const recentOut = history.filter((m) => m.role === 'assistant').slice(-1)[0];
      if (recentOut?.content) {
        const norm = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 100).toLowerCase();
        if (norm(recentOut.content) === norm(reply)) {
          logger.warn(`[ai/agent] anti-loop: resposta duplicada bloqueada para ${customerPhone}`);
          return;
        }
      }
    } catch { /* nao bloqueia se anti-loop falhar */ }
  }

  // 5.5 Anti-meta-commentary: se o LLM gerou texto que parece relato
  //     interno em vez de mensagem pro cliente, NAO envia. Mesma defesa
  //     que columnAgentRunner — agente de canal estava sem ela e podia
  //     vazar "marquei como morno" / "sou a qualificadora" etc.
  if (looksLikeMetaCommentary(reply)) {
    logger.warn(`[ai/agent] meta_commentary bloqueou envio para ${customerPhone}: "${reply.slice(0, 100)}"`);
    return;
  }

  // 6. Envia via canal (E grava message_out + card_id via sendOutbound)
  try {
    await sendReply(channel, customerPhone, reply, contactId);
    logger.info(`[ai/agent] ✓ resposta enviada para ${customerPhone} (${reply.length} chars, contactId=${contactId || 'novo'})`);
  } catch (err: any) {
    logger.error('[ai/agent] send falhou:', err?.message);
  }
}
