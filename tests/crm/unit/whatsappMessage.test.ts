/**
 * Balões vazios no painel de conversas.
 *
 * O parser conhecia sete formatos de `message` e mandava todo o resto para
 * `text` com texto vazio. Como mídia sem legenda também grava conteúdo vazio
 * — contando com o player para aparecer —, uma conversa inteira de áudios
 * cujo binário não pôde ser baixado virava uma coluna de horários com balões
 * em branco.
 *
 * Os payloads abaixo são recortes sanitizados dos 30.076 registros reais da
 * instância em produção: os tipos e a posição dos campos vêm de
 * `SELECT message FROM "Message"`, sem telefones nem conteúdo de terceiros.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizarMensagemWhatsApp,
  desembrulhar,
  chavesDeConteudo,
} from '../../../src/crm/channels/whatsappMessage.js';

describe('normalizarMensagemWhatsApp', () => {
  describe('texto', () => {
    it('texto simples recebido', () => {
      const r = normalizarMensagemWhatsApp({ conversation: 'Olá, gostaria de informações.' });
      expect(r.tipo).toBe('text');
      expect(r.texto).toBe('Olá, gostaria de informações.');
      expect(r.desconhecido).toBe(false);
    });

    it('texto simples enviado (mesma forma — o formato não muda com fromMe)', () => {
      const r = normalizarMensagemWhatsApp({ conversation: 'Claro, posso ajudar.' });
      expect(r.texto).toBe('Claro, posso ajudar.');
    });

    it('extendedTextMessage', () => {
      const r = normalizarMensagemWhatsApp({
        extendedTextMessage: { text: 'Segue o link: exemplo.com', contextInfo: {} },
      });
      expect(r.tipo).toBe('text');
      expect(r.texto).toBe('Segue o link: exemplo.com');
    });

    it('texto em branco não conta como texto', () => {
      const r = normalizarMensagemWhatsApp({ conversation: '   ' });
      expect(r.texto).toBeUndefined();
    });
  });

  describe('mídia', () => {
    it('imagem com legenda devolve a legenda', () => {
      const r = normalizarMensagemWhatsApp({
        imageMessage: { caption: 'segue a proposta', mimetype: 'image/jpeg', url: 'https://mmg.whatsapp.net/x' },
      });
      expect(r.tipo).toBe('image');
      expect(r.texto).toBe('segue a proposta');
      expect(r.bloco?.mimetype).toBe('image/jpeg');
    });

    it('imagem sem legenda tem rótulo — nunca balão vazio', () => {
      const r = normalizarMensagemWhatsApp({ imageMessage: { mimetype: 'image/jpeg' } });
      expect(r.tipo).toBe('image');
      expect(r.texto).toBeUndefined();
      expect(r.rotulo).toBe('[imagem]');
    });

    it('áudio é reconhecido como áudio', () => {
      const r = normalizarMensagemWhatsApp({
        audioMessage: { mimetype: 'audio/ogg; codecs=opus', seconds: 12, ptt: true },
      });
      expect(r.tipo).toBe('audio');
      expect(r.rotulo).toBe('🎤 Áudio');
    });

    it('pttMessage também é áudio', () => {
      expect(normalizarMensagemWhatsApp({ pttMessage: { seconds: 3 } }).tipo).toBe('audio');
    });

    it('documento leva o nome do arquivo no rótulo', () => {
      const r = normalizarMensagemWhatsApp({
        documentMessage: { fileName: 'apolice-2026.pdf', mimetype: 'application/pdf' },
      });
      expect(r.tipo).toBe('document');
      expect(r.rotulo).toBe('📄 apolice-2026.pdf');
    });

    it('vídeo com legenda', () => {
      const r = normalizarMensagemWhatsApp({ videoMessage: { caption: 'olha isso', mimetype: 'video/mp4' } });
      expect(r.tipo).toBe('video');
      expect(r.texto).toBe('olha isso');
    });
  });

  describe('formatos que produziam balão vazio em produção', () => {
    it('ptvMessage (vídeo redondo) vira vídeo, não texto vazio', () => {
      const r = normalizarMensagemWhatsApp({ ptvMessage: { mimetype: 'video/mp4', seconds: 8 } });
      expect(r.tipo).toBe('video');
      expect(r.rotulo).toBe('🎥 Vídeo');
      expect(r.desconhecido).toBe(false);
    });

    it('lottieStickerMessage vira figurinha', () => {
      const r = normalizarMensagemWhatsApp({ lottieStickerMessage: { mimetype: 'application/was' } });
      expect(r.tipo).toBe('image');
      expect(r.rotulo).toBe('[sticker]');
    });

    it('secretEncryptedMessage tem rótulo próprio', () => {
      const r = normalizarMensagemWhatsApp({ secretEncryptedMessage: { encPayload: 'x' } });
      expect(r.rotulo).toBe('[mensagem protegida]');
      expect(r.desconhecido).toBe(false);
    });

    it('stickerMessage', () => {
      expect(normalizarMensagemWhatsApp({ stickerMessage: { mimetype: 'image/webp' } }).rotulo).toBe('[sticker]');
    });

    it('contactMessage mostra o nome do contato compartilhado', () => {
      const r = normalizarMensagemWhatsApp({
        contactMessage: { displayName: 'Maria Silva', vcard: 'BEGIN:VCARD...' },
      });
      expect(r.rotulo).toBe('👤 Maria Silva');
    });

    it('locationMessage', () => {
      const r = normalizarMensagemWhatsApp({ locationMessage: { degreesLatitude: -22.9, degreesLongitude: -43.1 } });
      expect(r.tipo).toBe('location');
      expect(r.rotulo).toBe('📍 Localização');
    });

    it('reactionMessage traz o emoji', () => {
      const r = normalizarMensagemWhatsApp({ reactionMessage: { text: '👍', key: { id: 'ABC' } } });
      expect(r.rotulo).toBe('Reagiu com 👍');
    });

    it('pollCreationMessageV3', () => {
      const r = normalizarMensagemWhatsApp({ pollCreationMessageV3: { name: 'Qual horário?' } });
      expect(r.texto).toBe('Qual horário?');
    });

    it('listResponseMessage devolve o título escolhido', () => {
      const r = normalizarMensagemWhatsApp({ listResponseMessage: { title: 'Plano Prata' } });
      expect(r.texto).toBe('Plano Prata');
    });

    it('buttonsResponseMessage', () => {
      const r = normalizarMensagemWhatsApp({ buttonsResponseMessage: { selectedDisplayText: 'Quero contratar' } });
      expect(r.texto).toBe('Quero contratar');
    });
  });

  describe('envelopes', () => {
    it('ephemeralMessage — desembrulha e lê o texto de dentro', () => {
      const r = normalizarMensagemWhatsApp({
        ephemeralMessage: { message: { extendedTextMessage: { text: 'some em 24h' } } },
      });
      expect(r.tipo).toBe('text');
      expect(r.texto).toBe('some em 24h');
    });

    it('viewOnceMessage — imagem de ver-uma-vez não vira balão vazio', () => {
      const r = normalizarMensagemWhatsApp({
        viewOnceMessage: { message: { imageMessage: { mimetype: 'image/jpeg', viewOnce: true } } },
      });
      expect(r.tipo).toBe('image');
      expect(r.rotulo).toBe('[imagem]');
    });

    it('viewOnceMessageV2 com áudio', () => {
      const r = normalizarMensagemWhatsApp({
        viewOnceMessageV2: { message: { audioMessage: { seconds: 5 } } },
      });
      expect(r.tipo).toBe('audio');
    });

    it('documentWithCaptionMessage', () => {
      const r = normalizarMensagemWhatsApp({
        documentWithCaptionMessage: {
          message: { documentMessage: { fileName: 'contrato.pdf', caption: 'assina aqui' } },
        },
      });
      expect(r.tipo).toBe('document');
      expect(r.texto).toBe('assina aqui');
    });

    it('envelope aninhado em dois níveis', () => {
      const r = normalizarMensagemWhatsApp({
        ephemeralMessage: { message: { viewOnceMessageV2: { message: { conversation: 'oi' } } } },
      });
      expect(r.texto).toBe('oi');
    });

    it('auto-referência não trava o parser', () => {
      const laco: any = { ephemeralMessage: {} };
      laco.ephemeralMessage.message = laco;
      expect(() => normalizarMensagemWhatsApp(laco)).not.toThrow();
    });
  });

  describe('ruído e casos-limite', () => {
    it('messageContextInfo sozinho não define o tipo', () => {
      const r = normalizarMensagemWhatsApp({
        messageContextInfo: { deviceListMetadata: {} },
        conversation: 'texto de verdade',
      });
      expect(r.texto).toBe('texto de verdade');
      expect(r.tipo).toBe('text');
    });

    it('mensagem sem nada recuperável é marcada como desconhecida', () => {
      const r = normalizarMensagemWhatsApp({ algumFormatoNovoDoWhatsApp: { x: 1 } });
      expect(r.desconhecido).toBe(true);
      expect(r.rotulo).toBe('[mensagem não suportada]');
    });

    it('payload nulo não quebra', () => {
      expect(() => normalizarMensagemWhatsApp(null)).not.toThrow();
      expect(normalizarMensagemWhatsApp(null).desconhecido).toBe(true);
    });

    it('rótulo nunca vem vazio', () => {
      for (const p of [{}, null, { audioMessage: {} }, { xyz: 1 }, { stickerMessage: {} }]) {
        expect(normalizarMensagemWhatsApp(p).rotulo.length).toBeGreaterThan(0);
      }
    });
  });

  describe('data URI de mídia', () => {
    // O mime de áudio do WhatsApp vem sempre com parâmetro. Um grupo que pare
    // no primeiro `;` não casa, e `fetchMedia` devolvia "data_uri_malformado"
    // para todo áudio — o player nunca aparecia mesmo com o base64 íntegro.
    const REGEX = /^data:(.*?);base64,(.*)$/s;

    it('aceita mime com parâmetro (audio/ogg; codecs=opus)', () => {
      const m = 'data:audio/ogg; codecs=opus;base64,AAAA'.match(REGEX);
      expect(m).not.toBeNull();
      expect(m![1]).toBe('audio/ogg; codecs=opus');
      expect(m![2]).toBe('AAAA');
    });

    it('continua aceitando mime simples', () => {
      const m = 'data:image/jpeg;base64,BBBB'.match(REGEX);
      expect(m![1]).toBe('image/jpeg');
      expect(m![2]).toBe('BBBB');
    });

    it('aceita base64 com quebras de linha', () => {
      const m = 'data:audio/ogg;base64,AAAA\nBBBB'.match(REGEX);
      expect(m).not.toBeNull();
      expect(m![2]).toContain('BBBB');
    });
  });

  describe('diagnóstico', () => {
    it('chavesDeConteudo lista os formatos sem vazar o binário', () => {
      const k = chavesDeConteudo({
        imageMessage: { mimetype: 'image/jpeg' },
        base64: 'AAAA_conteudo_binario_gigante',
        messageContextInfo: {},
      });
      expect(k).toContain('imageMessage');
      expect(k).not.toContain('base64');
      expect(k).not.toContain('messageContextInfo');
    });

    it('desembrulhar é seguro com entrada estranha', () => {
      expect(desembrulhar(undefined)).toBeUndefined();
      expect(desembrulhar('texto')).toBe('texto');
    });
  });
});
