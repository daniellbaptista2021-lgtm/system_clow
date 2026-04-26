/**
 * openaiMedia.ts — Pipeline OpenAI para mídia inbound:
 *   - Audio (voz/ogg/webm/mp3/m4a) → Whisper → texto
 *   - Imagens (jpg/png/webp) → GPT-4o-mini vision → descrição
 *   - PDF → pdftotext (poppler) → texto; se vier vazio, Vision página por página (OCR)
 *   - Text files (csv/txt/json/md) → utf-8 direto
 *
 * Requer OPENAI_API_KEY no .env.
 * Opcional: OPENAI_WHISPER_MODEL (default: whisper-1)
 *           OPENAI_VISION_MODEL (default: gpt-4o-mini)
 *
 * Falha graciosamente: cada função retorna string com '[Erro: ...]' em vez
 * de lançar, pra não travar o fluxo de mensagens quando a OpenAI está down.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';

const execFileP = promisify(execFile);

function apiKey(): string | null {
  return process.env.OPENAI_API_KEY || null;
}

function whisperModel(): string {
  return process.env.OPENAI_WHISPER_MODEL || 'whisper-1';
}

function visionModel(): string {
  return process.env.OPENAI_VISION_MODEL || 'gpt-4o-mini';
}

// ──────────────────────────────────────────────────────────────────────
// AUDIO → texto (Whisper)
// ──────────────────────────────────────────────────────────────────────

/**
 * Transcreve áudio via OpenAI Whisper.
 * @param audio Buffer do arquivo de áudio (ogg, webm, mp3, m4a, wav, mpga, flac)
 * @param filename Nome (com extensão) que a OpenAI usa pra detectar o formato
 * @param language Código ISO (pt, en, es) — opcional, melhora precisão
 */
export async function transcribeAudio(
  audio: Buffer,
  filename: string,
  language: string = 'pt',
): Promise<string> {
  const key = apiKey();
  if (!key) return '[Áudio recebido — OPENAI_API_KEY não configurada]';

  try {
    const blob = new Blob([new Uint8Array(audio)]);
    const form = new FormData();
    form.append('file', blob, filename);
    form.append('model', whisperModel());
    if (language) form.append('language', language);
    form.append('response_format', 'text');

    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key },
      body: form,
    });

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      console.error('[openai-whisper] http', res.status, err.slice(0, 300));
      return `[Erro transcrevendo áudio: HTTP ${res.status}]`;
    }
    const text = (await res.text()).trim();
    return text || '[Áudio sem fala detectada]';
  } catch (err: any) {
    console.error('[openai-whisper] error', err?.message);
    return `[Erro transcrevendo áudio: ${err?.message || 'desconhecido'}]`;
  }
}

// ──────────────────────────────────────────────────────────────────────
// IMAGEM → descrição (Vision)
// ──────────────────────────────────────────────────────────────────────

/**
 * Descreve imagem via GPT-4o-mini vision.
 * Aceita Buffer (converte pra base64) OU URL pública.
 */
export async function describeImage(
  input: Buffer | string,
  mime: string = 'image/jpeg',
  contextPrompt?: string,
): Promise<string> {
  const key = apiKey();
  if (!key) return '[Imagem recebida — OPENAI_API_KEY não configurada]';

  const imageUrl = typeof input === 'string'
    ? input
    : `data:${mime};base64,${input.toString('base64')}`;

  const userMsg = contextPrompt
    ? `${contextPrompt}\n\nDescreva esta imagem detalhadamente em português, destacando texto visível, pessoas, objetos e contexto.`
    : 'Descreva esta imagem detalhadamente em português. Extraia qualquer texto visível (OCR). Inclua o contexto: pessoas, objetos, cenário, emoções aparentes.';

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: visionModel(),
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: userMsg },
            { type: 'image_url', image_url: { url: imageUrl, detail: 'auto' } },
          ],
        }],
        max_tokens: 800,
      }),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      console.error('[openai-vision] http', res.status, err.slice(0, 300));
      return `[Erro descrevendo imagem: HTTP ${res.status}]`;
    }
    const data: any = await res.json();
    const txt = data?.choices?.[0]?.message?.content?.trim();
    return txt || '[Imagem sem descrição extraída]';
  } catch (err: any) {
    console.error('[openai-vision] error', err?.message);
    return `[Erro descrevendo imagem: ${err?.message || 'desconhecido'}]`;
  }
}

// ──────────────────────────────────────────────────────────────────────
// PDF → texto (pdftotext; fallback OCR via vision se texto vazio)
// ──────────────────────────────────────────────────────────────────────

/**
 * Extrai texto de PDF usando pdftotext (poppler-utils).
 * Se texto vier vazio (PDF scaneado = só imagens), retorna aviso.
 */
export async function extractPdfText(pdf: Buffer): Promise<string> {
  const tmpDir = os.tmpdir();
  const pdfPath = path.join(tmpDir, `clow-pdf-${randomUUID()}.pdf`);
  try {
    fs.writeFileSync(pdfPath, pdf);
    const { stdout } = await execFileP('pdftotext', ['-layout', pdfPath, '-'], {
      maxBuffer: 20 * 1024 * 1024,
    });
    const text = String(stdout || '').trim();
    if (!text) {
      return '[PDF recebido parece ser scaneado (sem texto extraível). Conteúdo só em imagens.]';
    }
    // Trunca pra não estourar context (50k chars ~ 12k tokens)
    if (text.length > 50000) {
      return text.slice(0, 50000) + '\n\n[...PDF truncado em 50k caracteres...]';
    }
    return text;
  } catch (err: any) {
    console.error('[pdf-extract] error', err?.message);
    return `[Erro extraindo texto do PDF: ${err?.message || 'desconhecido'}]`;
  } finally {
    try { fs.unlinkSync(pdfPath); } catch {}
  }
}

// ──────────────────────────────────────────────────────────────────────
// Text files (csv, txt, json, md, html) → utf-8
// ──────────────────────────────────────────────────────────────────────

export function readTextFile(buf: Buffer, mime: string = 'text/plain', maxBytes: number = 50000): string {
  try {
    const text = buf.toString('utf-8');
    if (text.length > maxBytes) {
      return text.slice(0, maxBytes) + `\n\n[...arquivo truncado em ${maxBytes} chars...]`;
    }
    return text;
  } catch (err: any) {
    return `[Erro lendo arquivo: ${err?.message || 'desconhecido'}]`;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Router principal: dispatch baseado em mime
// ──────────────────────────────────────────────────────────────────────

const TEXT_MIMES = new Set([
  'text/plain', 'text/csv', 'application/json', 'text/markdown',
  'text/html', 'application/xml', 'text/xml', 'application/javascript',
  'text/javascript', 'application/x-yaml', 'text/yaml',
]);

/**
 * Processa qualquer arquivo e retorna texto legível pra o LLM.
 * Roteamento por mime type. Fallback: tenta ler como texto.
 */
export async function processMedia(
  buf: Buffer,
  mime: string,
  filename: string = 'file',
): Promise<{ kind: 'audio' | 'image' | 'pdf' | 'text' | 'unknown'; content: string }> {
  const m = (mime || '').toLowerCase();

  if (m.startsWith('audio/')) {
    const text = await transcribeAudio(buf, filename);
    return { kind: 'audio', content: text };
  }

  if (m.startsWith('image/')) {
    const text = await describeImage(buf, m);
    return { kind: 'image', content: text };
  }

  if (m === 'application/pdf' || filename.toLowerCase().endsWith('.pdf')) {
    const text = await extractPdfText(buf);
    return { kind: 'pdf', content: text };
  }

  if (TEXT_MIMES.has(m) || m.startsWith('text/')) {
    return { kind: 'text', content: readTextFile(buf, m) };
  }

  // Último recurso: tenta texto
  const tentative = readTextFile(buf, m);
  if (tentative && !/[\x00-\x08\x0E-\x1F]/.test(tentative.slice(0, 200))) {
    return { kind: 'text', content: tentative };
  }

  return {
    kind: 'unknown',
    content: `[Arquivo binário recebido: ${filename} (${mime}, ${buf.length} bytes). Formato não suportado para extração automática.]`,
  };
}
