/**
 * Bug fix — o nome do contato era sobrescrito com o nome do operador do CRM.
 *
 * `pushName`, no webhook da Evolution, descreve quem ESCREVEU a mensagem.
 * Numa mensagem `fromMe` (o corretor respondendo pelo celular dele) esse campo
 * vem com o nome da própria conta — "Você" ou "Carlos Operador" — enquanto
 * `remoteJid` continua apontando para o cliente. O parser repassava os dois
 * juntos e o ingest renomeava o contato do cliente: a Marina Alves virava
 * "Carlos Operador" no card assim que ele respondesse pelo aparelho.
 *
 * Cobre os dois pontos de defesa (parser e ingest) e o caso que impede a
 * "correção" ingênua: um contato que de fato se chama Carlos Operador precisa
 * continuar se chamando Carlos Operador.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { randomBytes } from 'crypto';

const TEST_DB_PATH = '/tmp/clow-contact-name-' + randomBytes(6).toString('hex') + '.db';
process.env.CRM_DB_PATH = TEST_DB_PATH;
process.env.CLOW_PII_KEY = 'contact-name-test-key-min-16-chars-aaa';

const OPERADOR = 'Carlos Operador';

describe('nome do contato nunca vem do operador do CRM', () => {
  let evolution: any, inbox: any, store: any, schema: any;

  beforeAll(async () => {
    schema = await import('../../../src/crm/schema.js');
    evolution = await import('../../../src/crm/channels/evolution.js');
    inbox = await import('../../../src/crm/inbox.js');
    store = await import('../../../src/crm/store.js');
    schema.getCrmDb();
  });

  function tel() { return '5521' + randomBytes(4).toString('hex').replace(/\D/g, '').padEnd(9, '7').slice(0, 9); }

  function canal(tenantId: string) {
    return { id: 'ch_' + randomBytes(3).toString('hex'), tenantId, type: 'evolution', name: 'teste', autoCreateCards: true };
  }

  function webhook(remoteJid: string, fromMe: boolean, pushName: string, texto: string) {
    return {
      event: 'messages.upsert',
      data: {
        key: { id: 'wh_' + randomBytes(6).toString('hex'), remoteJid, fromMe },
        pushName,
        message: { conversation: texto },
        messageTimestamp: Math.floor(Date.now() / 1000),
      },
    };
  }

  // ── parser ──────────────────────────────────────────────────────────────
  it('descarta pushName em mensagem enviada pelo próprio corretor', () => {
    const r = evolution.parseWebhook(webhook('5521999888777@s.whatsapp.net', true, OPERADOR, 'oi'));
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0].fromMe).toBe(true);
    expect(r.messages[0].fromName).toBeUndefined();
  });

  it('mantém pushName em mensagem recebida do cliente', () => {
    const r = evolution.parseWebhook(webhook('5521999888777@s.whatsapp.net', false, 'Ricardo Nunes', 'oi'));
    expect(r.messages[0].fromName).toBe('Ricardo Nunes');
  });

  it('descarta o "Você" que a Evolution manda como pushName do próprio dono', () => {
    const r = evolution.parseWebhook(webhook('5521999888777@s.whatsapp.net', true, 'Você', 'oi'));
    expect(r.messages[0].fromName).toBeUndefined();
  });

  // ── caso 1: cliente identificado, corretor responde ─────────────────────
  it('caso 1 — Ricardo Nunes continua Ricardo Nunes depois da resposta do corretor', async () => {
    const t = 'tn-' + randomBytes(3).toString('hex');
    const ch = canal(t);
    const phone = tel();

    await inbox.ingestInbound(ch, {
      fromPhone: phone, fromName: 'Ricardo Nunes', messageId: 'm1-' + phone,
      type: 'text', text: 'quero cotar', timestamp: Date.now(), fromMe: false,
    });
    // o corretor responde pelo celular: pushName chega como o nome dele
    await inbox.ingestInbound(ch, {
      fromPhone: phone, fromName: OPERADOR, messageId: 'm2-' + phone,
      type: 'text', text: 'claro, já te passo', timestamp: Date.now(), fromMe: true,
    });

    const c = store.findContactByPhone(t, phone);
    expect(c.name).toBe('Ricardo Nunes');
    expect(c.name).not.toBe(OPERADOR);
  });

  // ── caso 2: mesmo cenário, outro contato ────────────────────────────────
  it('caso 2 — Marina Alves continua Marina Alves', async () => {
    const t = 'tn-' + randomBytes(3).toString('hex');
    const ch = canal(t);
    const phone = tel();

    await inbox.ingestInbound(ch, {
      fromPhone: phone, fromName: 'Marina Alves', messageId: 'c1-' + phone,
      type: 'text', text: 'bom dia', timestamp: Date.now(), fromMe: false,
    });
    await inbox.ingestInbound(ch, {
      fromPhone: phone, fromName: OPERADOR, messageId: 'c2-' + phone,
      type: 'text', text: 'bom dia!', timestamp: Date.now(), fromMe: true,
    });

    expect(store.findContactByPhone(t, phone).name).toBe('Marina Alves');
  });

  // ── caso 3: o contato REALMENTE se chama Carlos Operador ────────────────
  it('caso 3 — contato que de fato se chama Carlos Operador mantém o nome', async () => {
    const t = 'tn-' + randomBytes(3).toString('hex');
    const ch = canal(t);
    const phone = tel();

    await inbox.ingestInbound(ch, {
      fromPhone: phone, fromName: OPERADOR, messageId: 'd1-' + phone,
      type: 'text', text: 'oi, sou eu', timestamp: Date.now(), fromMe: false,
    });

    // veio numa mensagem RECEBIDA, logo é o nome legítimo do contato
    expect(store.findContactByPhone(t, phone).name).toBe(OPERADOR);
  });

  // ── caso 4: contato sem nome, só telefone ───────────────────────────────
  it('caso 4 — contato sem nome cai no telefone, nunca no operador', async () => {
    const t = 'tn-' + randomBytes(3).toString('hex');
    const ch = canal(t);
    const phone = tel();

    // o corretor inicia a conversa: não há nome de cliente nenhum disponível
    await inbox.ingestInbound(ch, {
      fromPhone: phone, fromName: OPERADOR, messageId: 'e1-' + phone,
      type: 'text', text: 'olá, tudo bem?', timestamp: Date.now(), fromMe: true,
    });

    const c = store.findContactByPhone(t, phone);
    expect(c.name).toBe(phone);
    expect(c.name).not.toBe(OPERADOR);
  });

  // ── o card também não pode nascer com o nome do operador ────────────────
  it('card criado pelo corretor não é batizado com o nome do corretor', async () => {
    const t = 'tn-' + randomBytes(3).toString('hex');
    const ch = canal(t);
    const phone = tel();

    await inbox.ingestInbound(ch, {
      fromPhone: phone, fromName: OPERADOR, messageId: 'f1-' + phone,
      type: 'text', text: 'primeira mensagem', timestamp: Date.now(), fromMe: true,
    });

    const c = store.findContactByPhone(t, phone);
    const cards = store.listCardsByContact(t, c.id);
    expect(cards.length).toBeGreaterThan(0);
    expect(cards[0].title).not.toBe(OPERADOR);
    expect(cards[0].title).toBe(phone);
  });

  // ── o card sempre aponta para o contato certo ───────────────────────────
  it('card fica vinculado ao contato do cliente, não a outro registro', async () => {
    const t = 'tn-' + randomBytes(3).toString('hex');
    const ch = canal(t);
    const phone = tel();

    await inbox.ingestInbound(ch, {
      fromPhone: phone, fromName: 'Paulo Freitas', messageId: 'g1-' + phone,
      type: 'text', text: 'oi', timestamp: Date.now(), fromMe: false,
    });
    await inbox.ingestInbound(ch, {
      fromPhone: phone, fromName: OPERADOR, messageId: 'g2-' + phone,
      type: 'text', text: 'respondendo', timestamp: Date.now(), fromMe: true,
    });

    const c = store.findContactByPhone(t, phone);
    const card = store.listCardsByContact(t, c.id)[0];
    expect(card.contactId).toBe(c.id);
    expect(store.getContact(t, card.contactId).name).toBe('Paulo Freitas');
  });
});
