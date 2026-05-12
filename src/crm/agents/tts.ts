/**
 * tts.ts — Text-to-Speech via OpenAI Audio Speech API.
 *
 * Usado pelo columnAgentRunner quando a coluna tem agent_voice_enabled=1
 * e o cliente mandou audio (mirror mode). Sintetiza a resposta em OGG/Opus
 * e salva via saveMedia, retornando o publicUrl pro sendOutbound enviar
 * como mediaType='audio'.
 *
 * Modelo: tts-1 (latencia baixa ~1-2s, $15/1M chars).
 * Formato: opus em container ogg — formato nativo de audio do WhatsApp,
 *   evita transcoding ffmpeg no adapter Z-API/Meta.
 *
 * API key: prefere OPENAI_TTS_KEY, fallback OPENAI_API_KEY. Permite
 * rotacionar a key de TTS sem afetar Whisper/Vision.
 *
 * Vozes validas (OpenAI): alloy, echo, fable, onyx, nova, shimmer.
 * Default 'nova' (feminina, jovem).
 */
import { logger } from '../../utils/logger.js';
import { saveMedia } from '../media.js';

const VALID_VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'] as const;
export type TtsVoice = (typeof VALID_VOICES)[number];

/** Limite duro pra evitar custos absurdos. tts-1 cobra $15/1M chars; uma
 *  resposta tipica de bot tem ~200 chars. Acima de 4000, trunca. */
const MAX_TTS_CHARS = 4000;

export function isValidVoice(v: unknown): v is TtsVoice {
  return typeof v === 'string' && (VALID_VOICES as readonly string[]).includes(v);
}

export interface TtsOk {
  ok: true;
  mediaUrl: string; // /v1/crm/media/{tenantId}/{date}/{filename}
  mime: string;
  bytes: number;
}
export interface TtsErr {
  ok: false;
  error: string;
}
export type TtsResult = TtsOk | TtsErr;

function ttsKey(): string | null {
  return process.env.OPENAI_TTS_KEY || process.env.OPENAI_API_KEY || null;
}

/**
 * Sintetiza voz a partir de texto. Retorna mediaUrl pronto pra sendOutbound.
 *
 * @param text Texto a sintetizar (recomendado < 500 chars pra latencia OK).
 * @param voice Voz OpenAI (default 'nova').
 * @param tenantId Tenant pra salvar via saveMedia (escopo de armazenamento).
 */
export async function synthesizeSpeech(
  text: string,
  voice: TtsVoice,
  tenantId: string,
): Promise<TtsResult> {
  const key = ttsKey();
  if (!key) {
    return { ok: false, error: 'tts_key_missing (set OPENAI_TTS_KEY or OPENAI_API_KEY)' };
  }
  const cleaned = (text || '').trim();
  if (!cleaned) return { ok: false, error: 'empty_text' };
  // Trunca pra evitar custo descontrolado se LLM gerar resposta gigante.
  const input = cleaned.length > MAX_TTS_CHARS ? cleaned.slice(0, MAX_TTS_CHARS) : cleaned;

  const safeVoice: TtsVoice = isValidVoice(voice) ? voice : 'nova';

  const t0 = Date.now();
  let r: Response;
  try {
    r = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'tts-1',
        voice: safeVoice,
        input,
        // 'opus' em container OGG — formato nativo do WhatsApp PTT.
        response_format: 'opus',
      }),
    });
  } catch (err: any) {
    logger.error('[tts] fetch falhou:', err?.message);
    return { ok: false, error: `fetch_failed: ${err?.message || 'unknown'}` };
  }

  if (!r.ok) {
    const body = await r.text().catch(() => '');
    logger.error(`[tts] http ${r.status}: ${body.slice(0, 200)}`);
    return { ok: false, error: `http_${r.status}` };
  }

  const buf = Buffer.from(await r.arrayBuffer());
  const elapsed = Date.now() - t0;

  try {
    const saved = saveMedia(tenantId, buf, {
      mime: 'audio/ogg',
      mediaType: 'audio',
      suggestedFilename: `tts-${Date.now()}.ogg`,
    });
    logger.info(
      `[tts] ok tenant=${tenantId.slice(0, 8)} voice=${safeVoice} chars=${input.length} ` +
      `bytes=${buf.length} ms=${elapsed} url=${saved.publicUrl}`,
    );
    return {
      ok: true,
      mediaUrl: saved.publicUrl,
      mime: 'audio/ogg',
      bytes: buf.length,
    };
  } catch (err: any) {
    logger.error('[tts] saveMedia falhou:', err?.message);
    return { ok: false, error: `save_failed: ${err?.message || 'unknown'}` };
  }
}
