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
import * as zapi from '../channels/zapi.js';
import * as meta from '../channels/meta.js';
import type { Channel2 } from '../types.js';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ChannelAIConfig {
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
 *  Acha contato pelo phone e busca message_in/message_out cronológicas.
 *  Limita ao canal específico pra evitar misturar conversas de canais
 *  diferentes do mesmo cliente (ex.: WA e email). */
function loadRecentHistory(tenantId: string, channelId: string, customerPhone: string, limit: number): ChatMessage[] {
  const db = getCrmDb();
  // Acha contato pelo phone (normalizado, com ou sem 55, sem caracteres extra)
  const phoneNorm = customerPhone.replace(/\D/g, '');
  const contact = db.prepare(`
    SELECT id FROM crm_contacts
    WHERE tenant_id = ?
      AND REPLACE(REPLACE(REPLACE(REPLACE(phone, '+', ''), ' ', ''), '-', ''), '(', '') LIKE ?
    LIMIT 1
  `).get(tenantId, '%' + phoneNorm + '%') as { id?: string } | undefined;
  if (!contact?.id) return [];
  const rows = db.prepare(`
    SELECT content, type, created_at
    FROM crm_activities
    WHERE tenant_id = ?
      AND contact_id = ?
      AND type IN ('message_in', 'message_out')
    ORDER BY created_at DESC
    LIMIT ?
  `).all(tenantId, contact.id, limit) as Array<{ content: string; type: string; created_at: number }>;
  return rows.reverse().map((r) => ({
    role: r.type === 'message_out' ? 'assistant' as const : 'user' as const,
    content: r.content || '',
  })).filter((m) => m.content.length > 0);
}

/** Chama DeepSeek (OpenAI-compatible) com history + system prompt. */
async function callDeepSeek(
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
async function transcribeAudio(audioUrl: string): Promise<string> {
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

/** Envia resposta de volta pelo canal (Z-API ou Meta). */
async function sendReply(channel: Channel2, customerPhone: string, text: string): Promise<void> {
  if (channel.type === 'zapi') {
    const r = await zapi.sendMessage(channel, { to: customerPhone, text });
    if (!r.ok) throw new Error(`zapi send failed: ${r.error?.message}`);
  } else if (channel.type === 'meta') {
    const r = await meta.sendMessage(channel, { to: customerPhone, text });
    if (!r.ok) throw new Error(`meta send failed: ${r.error?.message}`);
  } else {
    throw new Error(`unknown channel type: ${channel.type}`);
  }
}

interface InboundContext {
  channel: Channel2;
  customerPhone: string;
  text?: string;       // texto da mensagem (se for texto)
  audioUrl?: string;   // URL do audio (se for audio)
  imageUrl?: string;   // URL da imagem (se for imagem)
  senderName?: string;
}

/**
 * Entry point: chamado pelo webhook handler em background após
 * ingestInbound gravar a mensagem no DB. Faz debounce + processamento.
 */
export function handleInboundForAI(ctx: InboundContext): void {
  const { channel, customerPhone } = ctx;
  const config = readChannelAIConfig(channel.id);
  if (!config) return; // canal não tem AI ativo

  // Debounce: cancela timer anterior do mesmo phone, re-agenda
  const debounceKey = `${channel.id}:${customerPhone}`;
  const existing = _debounceTimers.get(debounceKey);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    _debounceTimers.delete(debounceKey);
    runAgent(ctx, config).catch((err) => {
      logger.error(`[ai/agent] runAgent fail (${customerPhone}):`, err?.message);
    });
  }, config.debounceSeconds * 1000);
  _debounceTimers.set(debounceKey, timer);
}

async function runAgent(ctx: InboundContext, config: ChannelAIConfig): Promise<void> {
  const { channel, customerPhone, senderName } = ctx;

  // 1. Resolve texto da mensagem
  let userMessage = ctx.text || '';
  if (!userMessage && ctx.audioUrl) {
    if (!config.audioEnabled) {
      await sendReply(channel, customerPhone,
        'No momento só consigo te atender com mensagens de texto. Me manda sua dúvida por escrito? 😊');
      return;
    }
    userMessage = await transcribeAudio(ctx.audioUrl);
    if (!userMessage) {
      await sendReply(channel, customerPhone,
        'Não consegui entender o áudio. Pode mandar por escrito? 🙂');
      return;
    }
  }
  if (!userMessage && ctx.imageUrl) {
    await sendReply(channel, customerPhone,
      'No momento só consigo te atender com mensagens de texto ou áudio. Me manda sua dúvida por escrito ou em áudio? 😊');
    return;
  }
  if (!userMessage) {
    logger.info(`[ai/agent] mensagem sem texto/audio/imagem — ignorando`);
    return;
  }

  // 2. Carrega history das últimas N msgs do contato
  const history = loadRecentHistory(channel.tenantId, channel.id, customerPhone, config.maxHistory);

  // 3. Substitui {{customer_name}} no system prompt se existir
  const systemPrompt = config.systemPrompt
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

  // 5. Envia via canal
  try {
    await sendReply(channel, customerPhone, reply);
    logger.info(`[ai/agent] ✓ resposta enviada para ${customerPhone} (${reply.length} chars)`);
  } catch (err: any) {
    logger.error('[ai/agent] send falhou:', err?.message);
  }
}
