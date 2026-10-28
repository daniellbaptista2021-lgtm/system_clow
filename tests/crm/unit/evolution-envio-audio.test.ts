/**
 * Áudio gravado no CRM tem de sair pela rota de mensagem de voz da Evolution.
 *
 * O navegador grava em webm, e o sendMedia repassava o arquivo cru: o CRM
 * mostrava "enviado" e o áudio nunca chegava ao telefone do contato. O
 * sendWhatsAppAudio converte para ogg/opus e manda como nota de voz.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';

process.env.CLOW_CRM_SECRET = 'evolution-audio-test-key-min-16-chars';

describe('envio de áudio pela Evolution', () => {
  let evolution: any, channel: any;

  beforeAll(async () => {
    const crypto = await import('../../../src/crm/crypto.js');
    evolution = await import('../../../src/crm/channels/evolution.js');
    channel = {
      credentialsEncrypted: crypto.encryptJson({
        baseUrl: 'http://evo.local', apiKey: 'k', instance: 'inst 1',
      }),
    };
  });

  afterEach(() => vi.unstubAllGlobals());

  function capturar() {
    const chamadas: { url: string; corpo: any }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: any) => {
      chamadas.push({ url, corpo: JSON.parse(init.body) });
      return new Response(JSON.stringify({ key: { id: 'MSG1' } }), { status: 201 });
    });
    return chamadas;
  }

  it('áudio vai para sendWhatsAppAudio, com conversão ligada', async () => {
    const chamadas = capturar();
    const r = await evolution.sendMessage(channel, {
      to: '+55 21 99999-8888', mediaUrl: 'https://cdn.exemplo/audio.webm', mediaType: 'audio',
    });
    expect(r).toEqual({ ok: true, messageId: 'MSG1' });
    expect(chamadas[0].url).toBe('http://evo.local/message/sendWhatsAppAudio/inst%201');
    expect(chamadas[0].corpo).toMatchObject({
      number: '5521999998888', audio: 'https://cdn.exemplo/audio.webm', encoding: true,
    });
    expect(chamadas[0].corpo.mediatype).toBeUndefined();
  });

  it('imagem continua no sendMedia', async () => {
    const chamadas = capturar();
    await evolution.sendMessage(channel, {
      to: '5521999998888', mediaUrl: 'https://cdn.exemplo/foto.jpg', mediaType: 'image', caption: 'oi',
    });
    expect(chamadas[0].url).toBe('http://evo.local/message/sendMedia/inst%201');
    expect(chamadas[0].corpo).toMatchObject({ mediatype: 'image', caption: 'oi' });
  });
});
