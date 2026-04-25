/**
 * whatsapp.ts — Z-API WhatsApp Adapter
 *
 * Receives webhooks from Z-API, routes to Clow QueryEngine, sends responses
 * back to WhatsApp. Each phone number gets a persistent session.
 *
 * Flow: Z-API webhook → extract message → resolve session → process async → reply
 *
 * Key decisions:
 *   - Responds 200 immediately (Z-API has ~10s webhook timeout)
 *   - Processes in background, sends reply when done
 *   - Splits long messages (WhatsApp ~4000 char limit)
 *   - Shows typing indicator while working
 *   - Sends ⚙️ notifications for tool usage
 */

import { Hono } from 'hono';
import type { SessionPool } from '../server/sessionPool.js';
import * as path from 'path';
import * as fs from 'fs';

// ─── Z-API Config ───────────────────────────────────────────────────────────

function getZApiConfig() {
  const instanceId = process.env.ZAPI_INSTANCE_ID;
  const token = process.env.ZAPI_TOKEN;
  const clientToken = process.env.ZAPI_CLIENT_TOKEN || '';
  if (!instanceId || !token) return null;
  return {
    instanceId,
    token,
    clientToken,
    baseUrl: `https://api.z-api.io/instances/${instanceId}/token/${token}`,
  };
}

// ─── Z-API Client ───────────────────────────────────────────────────────────

async function sendWhatsAppMessage(phone: string, message: string): Promise<void> {
  const config = getZApiConfig();
  if (!config) {
    console.error('[zapi] No Z-API config — cannot send message');
    return;
  }

  // Split long messages (WhatsApp limit ~4000 chars)
  const chunks = splitForWhatsApp(message);

  for (const chunk of chunks) {
    try {
      await fetch(`${config.baseUrl}/send-text`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Client-Token': config.clientToken,
        },
        body: JSON.stringify({ phone, message: chunk }),
      });
      // Small delay between chunks to preserve order
      if (chunks.length > 1) {
        await sleep(500);
      }
    } catch (err: any) {
      console.error(`[zapi] Send failed to ${phone}: ${err.message}`);
    }
  }
}

async function sendTypingIndicator(phone: string): Promise<void> {
  const config = getZApiConfig();
  if (!config) return;

  try {
    await fetch(`${config.baseUrl}/send-chat-state`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Client-Token': config.clientToken,
      },
      body: JSON.stringify({ phone, chatState: 'composing' }),
    });
  } catch {
    // Non-critical — ignore
  }
}

// ─── Audio Transcription ────────────────────────────────────────────────────

async function transcribeAudio(audioUrl: string): Promise<string> {
  const whisperUrl = process.env.WHISPER_URL;

  if (!whisperUrl) {
    return '[Audio message received — transcription unavailable. Please send text instead.]';
  }

  try {
    const audioResponse = await fetch(audioUrl);
    const audioBuffer = await audioResponse.arrayBuffer();

    const formData = new FormData();
    formData.append('file', new Blob([audioBuffer]), 'audio.ogg');
    formData.append('model', 'whisper-1');

    const response = await fetch(`${whisperUrl}/v1/audio/transcriptions`, {
      method: 'POST',
      body: formData,
    });

    const result = await response.json() as { text: string };
    return result.text || '[Audio could not be transcribed]';
  } catch (err: any) {
    console.error(`[whisper] Transcription failed: ${err.message}`);
    return '[Audio transcription failed. Please send text instead.]';
  }
}

// ─── Image Processing ───────────────────────────────────────────────────────

async function processImage(imageUrl: string, caption?: string): Promise<string> {
  const visionUrl = process.env.VISION_URL;

  if (!visionUrl) {
    const text = caption ? `[Image with caption: "${caption}"]` : '[Image received — vision unavailable]';
    return text;
  }

  try {
    const response = await fetch(`${visionUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'default',
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: imageUrl },
            },
            {
              type: 'text',
              text: caption || 'Describe this image in detail. If it contains text, transcribe all text.',
            },
          ],
        }],
        max_tokens: 1024,
      }),
    });

    const result = await response.json() as any;
    const description = result.choices?.[0]?.message?.content || 'Image could not be processed';
    return `[Image received]\n${caption ? `Caption: ${caption}\n` : ''}Content: ${description}`;
  } catch (err: any) {
    console.error(`[vision] Processing failed: ${err.message}`);
    return caption ? `[Image with caption: "${caption}"]` : '[Image received — processing failed]';
  }
}

// ─── Tool Description for UX ────────────────────────────────────────────────

function describeTool(toolName: string): string {
  const descriptions: Record<string, string> = {
    Bash: 'Running command...',
    Read: 'Reading file...',
    Edit: 'Editing file...',
    Write: 'Writing file...',
    Glob: 'Searching files...',
    Grep: 'Searching code...',
    WebFetch: 'Fetching URL...',
    WebSearch: 'Searching the web...',
    Agent: 'Spawning sub-agent...',
  };
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.split('__');
    return `Using ${parts[1]}/${parts[2]}...`;
  }
  return descriptions[toolName] || `Using ${toolName}...`;
}

// ─── Message Splitting ──────────────────────────────────────────────────────

function splitForWhatsApp(text: string, maxLen = 3500): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  const paragraphs = text.split('\n\n');
  let current = '';

  for (const p of paragraphs) {
    if ((current + '\n\n' + p).length > maxLen) {
      if (current) chunks.push(current.trim());
      // If single paragraph exceeds limit, force split
      if (p.length > maxLen) {
        for (let i = 0; i < p.length; i += maxLen) {
          chunks.push(p.slice(i, i + maxLen));
        }
        current = '';
      } else {
        current = p;
      }
    } else {
      current = current ? `${current}\n\n${p}` : p;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

// ─── Background Processing ──────────────────────────────────────────────────

async function processInBackground(
  pool: SessionPool,
  sessionId: string,
  phone: string,
  userMessage: string,
): Promise<void> {
  try {
    const engine = await pool.getOrCreate(sessionId, {
      cwd: path.join(process.env.CLOW_WORKSPACES || '/tmp/clow-workspaces', phone),
    });

    // Ensure workspace dir exists
    const wsDir = path.join(process.env.CLOW_WORKSPACES || '/tmp/clow-workspaces', phone);
    try { fs.mkdirSync(wsDir, { recursive: true }); } catch {}

    let buffer = '';
    let lastSentTime = Date.now();
    let lastToolNotified = '';

    for await (const event of engine.submitMessage(userMessage)) {
      if (event.type === 'assistant' && event.content) {
        buffer += event.content;

        // Send in chunks: every 200 chars OR 3s, whichever first
        if (buffer.length > 200 || Date.now() - lastSentTime > 3000) {
          await sendWhatsAppMessage(phone, buffer);
          buffer = '';
          lastSentTime = Date.now();
        }
      }

      if (event.type === 'progress' && event.toolName) {
        // Notify tool usage (max 1 per unique tool per turn)
        const toolKey = event.toolName;
        if (toolKey !== lastToolNotified) {
          lastToolNotified = toolKey;
          await sendWhatsAppMessage(phone, `_⚙️ ${describeTool(event.toolName)}_`);
        }
      }

      if (event.type === 'result') {
        if (event.subtype?.startsWith('error')) {
          // Flush any remaining buffer
          if (buffer) {
            await sendWhatsAppMessage(phone, buffer);
            buffer = '';
          }
          // Send error
          const errorMsg = event.content || 'An error occurred while processing your request.';
          await sendWhatsAppMessage(phone, `⚠️ ${errorMsg.slice(0, 500)}`);
        }
      }
    }

    // Flush remaining buffer
    if (buffer.trim()) {
      await sendWhatsAppMessage(phone, buffer);
    }

    pool.trackMessage(sessionId);

  } catch (err: any) {
    console.error(`[wpp] Error processing message for ${phone}: ${err.message}`);
    await sendWhatsAppMessage(phone, `⚠️ Sorry, an error occurred: ${err.message.slice(0, 200)}`);
  }
}

// ─── Build Routes ───────────────────────────────────────────────────────────

export function buildWhatsAppRoutes(pool: SessionPool): Hono {
  const app = new Hono();

  // Z-API webhook receiver
  app.post('/webhooks/zapi', async (c) => {
    const config = getZApiConfig();
    if (!config) {
      // Onda 53i: silenciado — CRM usa /webhooks/crm/zapi/:secret. Este endpoint legacy fica idle.
      return c.json({ ok: true });
    }

    let payload: any;
    try {
      payload = await c.req.json();
    } catch {
      return c.json({ ok: true });
    }

    // Z-API sends different event types
    const phone: string | undefined = payload.phone;
    const isFromMe: boolean = payload.fromMe || false;

    // Ignore our own messages and messages without phone
    if (!phone || isFromMe) {
      return c.json({ ok: true });
    }

    // Extract message content based on type
    let userMessage: string | null = null;

    if (payload.text?.message) {
      userMessage = payload.text.message;
    } else if (payload.audio?.audioUrl) {
      userMessage = await transcribeAudio(payload.audio.audioUrl);
    } else if (payload.image?.imageUrl) {
      userMessage = await processImage(payload.image.imageUrl, payload.image.caption);
    } else if (payload.document?.documentUrl) {
      userMessage = `[Document received: ${payload.document.fileName || 'unknown'}]`;
    } else if (payload.sticker) {
      return c.json({ ok: true }); // Ignore stickers
    } else {
      // Unknown type — try to extract any text
      const anyText = payload.body || payload.message?.body;
      if (anyText) {
        userMessage = anyText;
      }
    }

    if (!userMessage) {
      return c.json({ ok: true }); // Nothing to process
    }

    console.log(`[wpp] ${phone}: ${userMessage.slice(0, 80)}${userMessage.length > 80 ? '...' : ''}`);

    // Session ID: 1 phone = 1 persistent session
    const sessionId = `wpp_${phone.replace(/\D/g, '')}`;

    // Send typing immediately for UX
    void sendTypingIndicator(phone);

    // Process in background (don't block webhook response)
    void processInBackground(pool, sessionId, phone, userMessage);

    // Respond 200 immediately (Z-API timeout is ~10s)
    return c.json({ ok: true });
  });

  // Status callback (Z-API sends delivery reports here)
  app.post('/webhooks/zapi/status', async (c) => {
    // Ignore delivery reports for now
    return c.json({ ok: true });
  });

  return app;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
