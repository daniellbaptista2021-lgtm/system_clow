/**
 * Garante que nenhuma mensagem chegue à conversa sem nada para mostrar.
 *
 * O balão vazio nasce da combinação de duas coisas: mídia sem legenda grava
 * conteúdo vazio de propósito (o player é que aparece), e a Evolution só
 * entrega o binário quando está com S3 ligado. Sem S3, `downloadAndSave`
 * devolve `null`, e sobra um balão com o horário e nada dentro.
 *
 * Estes testes percorrem o caminho real — `parseWebhook` -> `ingestInbound`
 * -> banco — e conferem a linha que o painel de conversas vai renderizar.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { randomBytes } from 'crypto';

const TEST_DB_PATH = '/tmp/clow-balao-' + randomBytes(6).toString('hex') + '.db';
process.env.CRM_DB_PATH = TEST_DB_PATH;
process.env.CLOW_PII_KEY = 'balao-vazio-test-key-min-16-chars-aaa';

describe('conversa nunca recebe balão vazio', () => {
  let evolution: any, inbox: any, store: any, schema: any;

  beforeAll(async () => {
    schema = await import('../../../src/crm/schema.js');
    evolution = await import('../../../src/crm/channels/evolution.js');
    inbox = await import('../../../src/crm/inbox.js');
    store = await import('../../../src/crm/store.js');
    schema.getCrmDb();
  });

  function tel() { return '5521' + String(Math.floor(Math.random() * 1e9)).padStart(9, '0'); }
  function canal(tenantId: string) {
    return { id: 'ch_' + randomBytes(3).toString('hex'), tenantId, type: 'evolution', name: 't', autoCreateCards: true };
  }

  /** Percorre webhook -> ingest e devolve a linha gravada. */
  async function ingerir(message: any, fromMe = false) {
    const t = 'tn-' + randomBytes(3).toString('hex');
    const ch = canal(t);
    const phone = tel();
    const parsed = evolution.parseWebhook({
      event: 'messages.upsert',
      data: {
        key: { id: 'wh_' + randomBytes(8).toString('hex'), remoteJid: `${phone}@s.whatsapp.net`, fromMe },
        pushName: fromMe ? 'Operador' : 'Cliente',
        message,
        messageTimestamp: Math.floor(Date.now() / 1000),
      },
    });
    if (!parsed.messages.length) return { descartada: true, atividade: null, tenant: t };
    await inbox.ingestInbound(ch, parsed.messages[0]);
    const contato = store.findContactByPhone(t, phone);
    const acts = store.listActivitiesByContact(t, contato.id);
    const msgs = acts.filter((a: any) => a.type === 'message_in' || a.type === 'message_out');
    return { descartada: false, atividade: msgs[0], tenant: t };
  }

  it('áudio sem mídia baixada mostra "🎤 Áudio" em vez de nada', async () => {
    const { atividade } = await ingerir({ audioMessage: { mimetype: 'audio/ogg', seconds: 9 } });
    expect(atividade).toBeTruthy();
    expect(atividade.mediaType).toBe('audio');
    expect(atividade.content).toBe('🎤 Áudio');
  });

  it('áudio enviado pelo corretor também tem conteúdo', async () => {
    const { atividade } = await ingerir({ audioMessage: { mimetype: 'audio/ogg' } }, true);
    expect(atividade.type).toBe('message_out');
    expect(atividade.content).toBe('🎤 Áudio');
  });

  it('texto continua indo puro, sem rótulo grudado', async () => {
    const { atividade } = await ingerir({ conversation: 'Olá, gostaria de saber mais.' });
    expect(atividade.content).toBe('Olá, gostaria de saber mais.');
  });

  it('imagem com legenda mostra a legenda, não o rótulo', async () => {
    const { atividade } = await ingerir({ imageMessage: { caption: 'segue a proposta', mimetype: 'image/jpeg' } });
    expect(atividade.content).toBe('segue a proposta');
  });

  it('imagem sem legenda mostra "[imagem]"', async () => {
    const { atividade } = await ingerir({ imageMessage: { mimetype: 'image/jpeg' } });
    expect(atividade.content).toBe('[imagem]');
  });

  it('documento mostra o nome do arquivo', async () => {
    const { atividade } = await ingerir({ documentMessage: { fileName: 'apolice.pdf', mimetype: 'application/pdf' } });
    expect(atividade.content).toBe('📄 apolice.pdf');
  });

  it('ptvMessage — o formato que ninguém tratava — vira vídeo com rótulo', async () => {
    const { atividade } = await ingerir({ ptvMessage: { mimetype: 'video/mp4', seconds: 6 } });
    expect(atividade.mediaType).toBe('video');
    expect(atividade.content).toBe('🎥 Vídeo');
  });

  it('figurinha animada não some da conversa', async () => {
    const { atividade } = await ingerir({ lottieStickerMessage: { mimetype: 'application/was' } });
    expect(atividade.content).toBe('[sticker]');
  });

  it('mensagem temporária tem o texto de dentro do envelope', async () => {
    const { atividade } = await ingerir({
      ephemeralMessage: { message: { extendedTextMessage: { text: 'combinado então' } } },
    });
    expect(atividade.content).toBe('combinado então');
  });

  it('nenhum formato conhecido gera conteúdo vazio', async () => {
    const formatos = [
      { audioMessage: {} }, { imageMessage: {} }, { videoMessage: {} },
      { documentMessage: {} }, { stickerMessage: {} }, { ptvMessage: {} },
      { locationMessage: { degreesLatitude: -22.9 } },
      { contactMessage: { displayName: 'Fulano' } },
      { reactionMessage: { text: '❤️' } },
      { secretEncryptedMessage: {} },
      { viewOnceMessageV2: { message: { imageMessage: {} } } },
    ];
    for (const f of formatos) {
      const { atividade, descartada } = await ingerir(f);
      expect(descartada, `formato ${Object.keys(f)[0]} foi descartado`).toBe(false);
      expect(atividade.content?.length, `formato ${Object.keys(f)[0]} ficou vazio`).toBeGreaterThan(0);
    }
  });

  it('a mesma mensagem entregue duas vezes não duplica', async () => {
    const t = 'tn-' + randomBytes(3).toString('hex');
    const ch = canal(t);
    const phone = tel();
    const evento = {
      event: 'messages.upsert',
      data: {
        key: { id: 'dup_' + randomBytes(6).toString('hex'), remoteJid: `${phone}@s.whatsapp.net`, fromMe: false },
        pushName: 'Cliente',
        message: { conversation: 'mensagem única' },
        messageTimestamp: Math.floor(Date.now() / 1000),
      },
    };
    const p = evolution.parseWebhook(evento);
    await inbox.ingestInbound(ch, p.messages[0]);
    await inbox.ingestInbound(ch, evolution.parseWebhook(evento).messages[0]);

    const contato = store.findContactByPhone(t, phone);
    const msgs = store.listActivitiesByContact(t, contato.id)
      .filter((a: any) => a.type === 'message_in');
    expect(msgs).toHaveLength(1);
  });
});
