/** Mensagem apagada no WhatsApp: o CRM reconhece o aviso e não o trata como mensagem nova. */
import { describe, it, expect } from 'vitest';
import { parseApagadas, parseWebhook } from '../../src/crm/channels/evolution.js';

const revoke = {
  event: 'messages.upsert',
  data: {
    key: { remoteJid: '5511999990000@s.whatsapp.net', fromMe: false, id: 'NOVA1' },
    message: { protocolMessage: { key: { id: 'ORIGINAL1', remoteJid: '5511999990000@s.whatsapp.net' }, type: 'REVOKE' } },
    messageTimestamp: 1761840000,
  },
};

describe('mensagem apagada no WhatsApp', () => {
  it('REVOKE aponta para a mensagem original', () => {
    expect(parseApagadas(revoke)).toEqual(['ORIGINAL1']);
    expect(parseApagadas({ ...revoke, data: { ...revoke.data, message: { protocolMessage: { key: { id: 'X' }, type: 0 } } } })).toEqual(['X']);
  });

  it('evento messages.delete também conta', () => {
    expect(parseApagadas({ event: 'messages.delete', data: { key: { id: 'ORIG2' } } })).toEqual(['ORIG2']);
  });

  it('o aviso não vira mensagem nova na conversa', () => {
    expect(parseWebhook(revoke).messages).toHaveLength(0);
  });

  it('mensagem comum não é apagada', () => {
    const comum = { event: 'messages.upsert', data: { key: { remoteJid: '5511999990000@s.whatsapp.net', id: 'A' }, message: { conversation: 'oi' } } };
    expect(parseApagadas(comum)).toEqual([]);
  });
});
