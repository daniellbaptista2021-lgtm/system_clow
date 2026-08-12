/**
 * motorOpenAI.ts — caminho de modelo no protocolo OpenAI (/chat/completions).
 *
 * Por que este arquivo existe: o agente principal foi escrito sobre o SDK da
 * Anthropic, que so fala o protocolo da Anthropic. Na VPS antiga havia um
 * LiteLLM local traduzindo tudo pra OpenRouter — o que funcionava porque havia
 * UMA chave, do dono, no servidor.
 *
 * Com BYOK (cada cliente traz a propria chave), o LiteLLM deixa de servir:
 * ele teria de receber a chave de um cliente diferente a cada requisicao, e
 * ainda seria uma peca a mais pra manter de pe no servidor. Falar o protocolo
 * direto elimina o intermediario.
 *
 * `/chat/completions` e o padrao de fato: OpenAI, OpenRouter, DeepSeek, Groq,
 * Together e praticamente qualquer servico novo o expoem. Quem conectar a
 * Anthropic continua indo pelo SDK nativo dela (ver api/anthropic.ts).
 *
 * A saida daqui e a MESMA `StreamChunk` do caminho Anthropic — o QueryEngine
 * nao sabe, e nao deve saber, qual provedor esta do outro lado.
 */
import { withRetry } from '../utils/retry/retry.js';
import { logger } from '../utils/logger.js';
import { zodParaJsonSchema } from './anthropic.js';
import type { ClovMessage, StreamChunk } from './anthropic.js';
import type { Tool } from '../tools/Tool.js';

/** Para onde a chamada vai: a credencial do cliente, ja resolvida. */
export interface DestinoOpenAI {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxOutputTokens?: number;
}

/**
 * ClovMessage → mensagens OpenAI.
 *
 * A diferenca estrutural entre os dois protocolos: na Anthropic o resultado de
 * ferramenta e um bloco dentro de uma mensagem de `user`; no OpenAI e uma
 * mensagem propria de role `tool` amarrada pelo `tool_call_id`. A conversao
 * mora aqui pra que o resto do sistema siga falando um formato so.
 */
function paraMensagensOpenAI(messages: ClovMessage[], systemPrompt?: string): any[] {
  const saida: any[] = [];
  if (systemPrompt) saida.push({ role: 'system', content: systemPrompt });
  for (const msg of messages) {
    if (msg.role === 'system') continue;
    if (msg.role === 'tool') {
      saida.push({
        role: 'tool',
        content: msg.content ?? '',
        tool_call_id: msg.tool_call_id || '',
      });
      continue;
    }
    if (msg.role === 'user') {
      saida.push({ role: 'user', content: msg.content });
      continue;
    }
    // assistant — pode ter texto, chamadas de ferramenta, ou os dois.
    const chamadas = (msg.tool_calls || []).map((tc) => ({
      id: tc.id,
      type: 'function',
      function: { name: tc.function.name, arguments: tc.function.arguments },
    }));
    saida.push({
      role: 'assistant',
      // `content: null` e o que o protocolo espera quando so ha tool_calls;
      // string vazia faz alguns provedores recusarem a mensagem.
      content: msg.content || (chamadas.length > 0 ? null : ''),
      ...(chamadas.length > 0 ? { tool_calls: chamadas } : {}),
    });
  }
  return saida;
}

function ferramentasParaOpenAI(tools: Tool[]): any[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: zodParaJsonSchema((t as any).inputSchema),
    },
  }));
}

// ─── Leitura do fluxo SSE ─────────────────────────────────────────────────

/**
 * Le o corpo da resposta como eventos SSE, linha a linha.
 *
 * Feito na mao de proposito: e o unico pedaco de protocolo que precisamos, e
 * puxar um SDK inteiro (com a propria politica de retry e de erro) so pra isso
 * seria mais peca pra manter. O cuidado que importa e o buffer — um chunk da
 * rede pode cortar um evento no meio, entao so processamos linha completa.
 */
async function* lerEventosSSE(corpo: ReadableStream<Uint8Array>): AsyncGenerator<any> {
  const leitor = corpo.getReader();
  const decodificador = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await leitor.read();
      if (done) break;
      buffer += decodificador.decode(value, { stream: true });
      let quebra: number;
      while ((quebra = buffer.indexOf('\n')) !== -1) {
        const linha = buffer.slice(0, quebra).trim();
        buffer = buffer.slice(quebra + 1);
        if (!linha.startsWith('data:')) continue;
        const dados = linha.slice(5).trim();
        if (!dados || dados === '[DONE]') continue;
        try {
          yield JSON.parse(dados);
        } catch {
          // Evento partido ou keep-alive do provedor — ignorar e seguir e o
          // comportamento certo: derrubar a resposta inteira por um frame
          // ilegivel seria pior que perder um delta.
        }
      }
    }
  } finally {
    leitor.releaseLock();
  }
}

function normalizarMotivo(motivo?: string): string {
  if (!motivo) return 'stop';
  // 'length' e o que o QueryEngine espera pra acionar a recuperacao por
  // continuacao — mesmo contrato do caminho Anthropic.
  if (motivo === 'length') return 'length';
  if (motivo === 'tool_calls') return 'tool_calls';
  return motivo === 'stop' ? 'stop' : motivo;
}

async function erroDeResposta(r: Response): Promise<Error> {
  const corpo = await r.text().catch(() => '');
  if (r.status === 401 || r.status === 403) {
    return new Error('ia_credencial_recusada: o provedor recusou a chave. Ela pode ter sido ' +
      'revogada ou copiada pela metade. Reconecte em Configurações → Inteligência Artificial.');
  }
  if (r.status === 402) {
    return new Error('ia_sem_saldo: a conta do provedor está sem créditos. Recarregue na conta que você conectou.');
  }
  if (r.status === 429) {
    return new Error('ia_limite: o provedor está limitando as chamadas. Tente de novo em instantes.');
  }
  return new Error(`ia http_${r.status}: ${corpo.slice(0, 300)}`);
}

// ─── Chamada com streaming ────────────────────────────────────────────────

export async function* chamarModeloOpenAI(
  destino: DestinoOpenAI,
  messages: ClovMessage[],
  tools: Tool[],
  systemPrompt: string,
  signal?: AbortSignal,
): AsyncGenerator<StreamChunk> {
  const corpo = {
    model: destino.model,
    messages: paraMensagensOpenAI(messages, systemPrompt),
    ...(tools.length > 0 ? { tools: ferramentasParaOpenAI(tools), tool_choice: 'auto' } : {}),
    max_tokens: destino.maxOutputTokens || 16384,
    temperature: 0,
    stream: true,
    // Sem isto varios provedores nao mandam `usage` nenhum no modo streaming,
    // e o painel de custo do cliente ficaria zerado pra sempre.
    stream_options: { include_usage: true },
  };
  const r = await withRetry(() => fetch(`${destino.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${destino.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(corpo),
    signal,
  }), { signal });
  if (!r.ok || !r.body) {
    if (!r.ok) throw await erroDeResposta(r);
    throw new Error('ia: resposta sem corpo');
  }
  // Chamadas de ferramenta chegam fatiadas por `index`, e o nome so vem no
  // primeiro pedaco — por isso acumulamos por indice em vez de emitir direto.
  const emMontagem = new Map<number, { id: string; name: string; args: string; abriu: boolean }>();
  let motivo = 'stop';
  let usage: any = { prompt_tokens: 0, completion_tokens: 0 };
  try {
    for await (const evento of lerEventosSSE(r.body)) {
      if (evento.usage) {
        usage = {
          prompt_tokens: evento.usage.prompt_tokens ?? usage.prompt_tokens,
          completion_tokens: evento.usage.completion_tokens ?? usage.completion_tokens,
          prompt_cache_hit_tokens: evento.usage.prompt_tokens_details?.cached_tokens ?? 0,
          prompt_cache_miss_tokens: Math.max((evento.usage.prompt_tokens ?? 0) - (evento.usage.prompt_tokens_details?.cached_tokens ?? 0), 0),
        };
      }
      const escolha = evento.choices?.[0];
      if (!escolha) continue;
      if (escolha.finish_reason) motivo = normalizarMotivo(escolha.finish_reason);
      const delta = escolha.delta;
      if (!delta) continue;
      if (delta.content) {
        yield { type: 'text', content: delta.content };
      }
      for (const tc of delta.tool_calls || []) {
        const idx = tc.index ?? 0;
        let atual = emMontagem.get(idx);
        if (!atual) {
          atual = { id: tc.id || `call_${idx}`, name: tc.function?.name || '', args: '', abriu: false };
          emMontagem.set(idx, atual);
        }
        if (tc.id) atual.id = tc.id;
        if (tc.function?.name) atual.name = tc.function.name;
        if (!atual.abriu && atual.name) {
          atual.abriu = true;
          yield { type: 'tool_call_start', toolCallId: atual.id, toolName: atual.name };
        }
        const pedaco = tc.function?.arguments;
        if (pedaco) {
          atual.args += pedaco;
          yield { type: 'tool_call_delta', toolCallId: atual.id, toolArgs: pedaco };
        }
      }
    }
    // Fecha as chamadas montadas. O protocolo OpenAI nao tem um evento de
    // "acabou esta ferramenta" — o fim do fluxo e o fim de todas elas.
    for (const [, tc] of emMontagem) {
      if (!tc.abriu) {
        yield { type: 'tool_call_start', toolCallId: tc.id, toolName: tc.name };
      }
      yield {
        type: 'tool_call_end',
        toolCallId: tc.id,
        toolName: tc.name,
        toolArgs: tc.args || '{}',
      };
    }
    yield {
      type: 'done',
      finishReason: emMontagem.size > 0 && motivo === 'stop' ? 'tool_calls' : motivo,
      usage: {
        inputTokens: usage.prompt_tokens,
        outputTokens: usage.completion_tokens,
        cachedTokens: usage.prompt_cache_hit_tokens,
        uncachedTokens: usage.prompt_cache_miss_tokens,
      },
    };
  } catch (erro: any) {
    if (erro?.name === 'AbortError') {
      yield { type: 'done', finishReason: 'abort' };
      return;
    }
    logger.error(`[motor-openai] falha no fluxo: ${erro?.message}`);
    throw erro;
  }
}

// ─── Chamada sem streaming ────────────────────────────────────────────────

export async function chamarModeloOpenAISync(
  destino: DestinoOpenAI,
  messages: ClovMessage[],
  systemPrompt: string,
  maxTokens?: number,
): Promise<{ content: string; usage: { inputTokens: number; outputTokens: number } }> {
  const r = await withRetry(() => fetch(`${destino.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${destino.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: destino.model,
      messages: paraMensagensOpenAI(messages, systemPrompt),
      max_tokens: maxTokens || 4096,
      temperature: 0,
    }),
  }));
  if (!r.ok) throw await erroDeResposta(r);
  const d = await r.json() as any;
  return {
    content: String(d?.choices?.[0]?.message?.content ?? ''),
    usage: {
      inputTokens: d?.usage?.prompt_tokens ?? 0,
      outputTokens: d?.usage?.completion_tokens ?? 0,
    },
  };
}
