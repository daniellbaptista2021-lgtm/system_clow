/**
 * Bug fix — column_changed_at, last_bot_message_at, last_client_message_at
 * eram nunca gravados em crm_cards por createCard/moveCard/reorderCard/logActivity.
 * Quebrava entry_delay/chase/followup do columnTimerScheduler.
 *
 * 9 cenarios — cobrem unitario (writes) + integracao (queries do scheduler).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { randomBytes } from 'crypto';

const TEST_DB_PATH = '/tmp/clow-cards-ts-' + randomBytes(6).toString('hex') + '.db';
process.env.CRM_DB_PATH = TEST_DB_PATH;
process.env.CLOW_PII_KEY = 'cards-ts-test-key-with-min-16-chars-aaa';

describe('cardsStore — column_changed_at / last_bot_message_at / last_client_message_at', () => {
  let schema: any, store: any, scheduler: any;

  beforeAll(async () => {
    schema = await import('../../../src/crm/schema.js');
    store = await import('../../../src/crm/store.js');
    scheduler = await import('../../../src/crm/agents/columnTimerScheduler.js');
    schema.getCrmDb();
  });

  function makeTenant() { return 'tts-' + randomBytes(3).toString('hex'); }

  function setup(tenantId: string) {
    const board = store.seedDefaultBoards(tenantId);
    const cols = store.listColumns(tenantId, board.id);
    return { board, cols };
  }

  function newCard(tenantId: string, boardId: string, columnId: string) {
    const contact = store.createContact(tenantId, {
      name: 'TS', phone: '+55119' + randomBytes(3).toString('hex').slice(0, 7), source: 't',
    });
    return store.createCard(tenantId, { boardId, columnId, title: contact.name, contactId: contact.id });
  }

  function readCard(cardId: string) {
    return schema.getCrmDb().prepare('SELECT * FROM crm_cards WHERE id = ?').get(cardId) as any;
  }

  function configColumn(columnId: string, opts: {
    role?: string; entryDelayMin?: number; chaseSteps?: number[] | null;
  }) {
    const db = schema.getCrmDb();
    db.prepare(`UPDATE crm_columns SET
      agent_enabled = 1,
      agent_role = ?,
      agent_role_type = ?,
      agent_entry_delay_minutes = ?,
      agent_no_response_chase_steps_json = ?
      WHERE id = ?`).run(
        opts.role ?? null, opts.role ?? null,
        opts.entryDelayMin ?? 0,
        opts.chaseSteps ? JSON.stringify(opts.chaseSteps) : null,
        columnId,
      );
  }

  // ─── Cenarios 1-4: column_changed_at ─────────────────────────────────

  it('1. moveCard atualiza column_changed_at quando muda de coluna', () => {
    const tenantId = makeTenant();
    const { board, cols } = setup(tenantId);
    const card = newCard(tenantId, board.id, cols[0].id);
    const before = readCard(card.id).column_changed_at;
    expect(before).toBeTruthy(); // setado pelo createCard

    // Move pra outra coluna
    const t0 = Date.now();
    store.moveCard(tenantId, card.id, cols[1].id);
    const after = readCard(card.id).column_changed_at;

    expect(after).toBeGreaterThanOrEqual(t0);
    expect(after).toBeGreaterThan(before);
  });

  it('2. moveCard NAO atualiza column_changed_at se for mesma coluna', () => {
    const tenantId = makeTenant();
    const { board, cols } = setup(tenantId);
    const card = newCard(tenantId, board.id, cols[0].id);
    const before = readCard(card.id).column_changed_at;

    // Pequeno sleep pra garantir diff temporal se houvesse write
    const t0 = Date.now();
    while (Date.now() - t0 < 5) { /* spin */ }

    store.moveCard(tenantId, card.id, cols[0].id);
    const after = readCard(card.id).column_changed_at;

    expect(after).toBe(before);
  });

  it('3. reorderCard atualiza column_changed_at apenas se mudou coluna', () => {
    const tenantId = makeTenant();
    const { board, cols } = setup(tenantId);
    const cardA = newCard(tenantId, board.id, cols[0].id);
    const cardB = newCard(tenantId, board.id, cols[0].id);

    // Reorder dentro da mesma coluna
    const beforeSame = readCard(cardA.id).column_changed_at;
    store.reorderCard(tenantId, cardA.id, cols[0].id, { beforeCardId: cardB.id });
    const afterSame = readCard(cardA.id).column_changed_at;
    expect(afterSame).toBe(beforeSame);

    // Reorder pra outra coluna
    const beforeMove = readCard(cardA.id).column_changed_at;
    const t0 = Date.now();
    store.reorderCard(tenantId, cardA.id, cols[1].id, { atIndex: 0 });
    const afterMove = readCard(cardA.id).column_changed_at;
    expect(afterMove).toBeGreaterThanOrEqual(t0);
    expect(afterMove).toBeGreaterThan(beforeMove);
  });

  it('4. createCard inicial setta column_changed_at = createdAt', () => {
    const tenantId = makeTenant();
    const { board, cols } = setup(tenantId);
    const card = newCard(tenantId, board.id, cols[0].id);
    const row = readCard(card.id);
    expect(row.column_changed_at).toBeTruthy();
    expect(row.column_changed_at).toBe(row.created_at);
  });

  // ─── Cenarios 5-6: logActivity → last_bot/client_message_at ──────────

  it('5. logActivity message_out atualiza last_bot_message_at', () => {
    const tenantId = makeTenant();
    const { board, cols } = setup(tenantId);
    const card = newCard(tenantId, board.id, cols[0].id);
    expect(readCard(card.id).last_bot_message_at).toBeFalsy();

    const t0 = Date.now();
    store.logActivity(tenantId, {
      cardId: card.id, contactId: card.contactId,
      type: 'message_out', channel: 'whatsapp_zapi', direction: 'out', content: 'oi',
    });
    const row = readCard(card.id);
    expect(row.last_bot_message_at).toBeGreaterThanOrEqual(t0);
    expect(row.unread_count).toBe(0);
  });

  it('6. logActivity message_in atualiza last_client_message_at + unread_count', () => {
    const tenantId = makeTenant();
    const { board, cols } = setup(tenantId);
    const card = newCard(tenantId, board.id, cols[0].id);
    expect(readCard(card.id).last_client_message_at).toBeFalsy();

    const t0 = Date.now();
    store.logActivity(tenantId, {
      cardId: card.id, contactId: card.contactId,
      type: 'message_in', channel: 'whatsapp_zapi', direction: 'in', content: 'oi do cliente',
    });
    const row = readCard(card.id);
    expect(row.last_client_message_at).toBeGreaterThanOrEqual(t0);
    expect(row.last_inbound_at).toBeGreaterThanOrEqual(t0);
    expect(row.unread_count).toBeGreaterThan(0);
  });

  // ─── Cenarios 7-9: integracao com queries do scheduler ───────────────

  it('7. Card move → 5 min depois → findEntryDelayCards encontra', () => {
    const tenantId = makeTenant();
    const { board, cols } = setup(tenantId);
    configColumn(cols[1].id, { role: 'cotador', entryDelayMin: 5 });
    const card = newCard(tenantId, board.id, cols[0].id);
    store.moveCard(tenantId, card.id, cols[1].id);

    // Faz parecer que moveu ha 6 min
    schema.getCrmDb().prepare('UPDATE crm_cards SET column_changed_at = ? WHERE id = ?')
      .run(Date.now() - 6 * 60_000, card.id);

    const found = scheduler.findEntryDelayCards();
    expect(found.some((r: any) => r.card_id === card.id)).toBe(true);
  });

  it('8. Bot envia message_out → 30 min depois → findChaseCards encontra', () => {
    const tenantId = makeTenant();
    const { board, cols } = setup(tenantId);
    configColumn(cols[0].id, { role: 'qualificador', chaseSteps: [30, 120] });
    const card = newCard(tenantId, board.id, cols[0].id);

    store.logActivity(tenantId, {
      cardId: card.id, contactId: card.contactId,
      type: 'message_out', channel: 'whatsapp_zapi', direction: 'out', content: 'oi',
    });
    // Faz parecer que bot mandou ha 31 min
    schema.getCrmDb().prepare('UPDATE crm_cards SET last_bot_message_at = ? WHERE id = ?')
      .run(Date.now() - 31 * 60_000, card.id);

    const fires = scheduler.findChaseCards();
    expect(fires.some((f: any) => f.row.card_id === card.id)).toBe(true);
  });

  it('9. Cliente responde apos bot → findChaseCards NAO encontra mais', () => {
    const tenantId = makeTenant();
    const { board, cols } = setup(tenantId);
    configColumn(cols[0].id, { role: 'qualificador', chaseSteps: [30, 120] });
    const card = newCard(tenantId, board.id, cols[0].id);

    // Bot mandou ha 31 min
    store.logActivity(tenantId, {
      cardId: card.id, contactId: card.contactId,
      type: 'message_out', channel: 'whatsapp_zapi', direction: 'out', content: 'oi',
    });
    schema.getCrmDb().prepare('UPDATE crm_cards SET last_bot_message_at = ? WHERE id = ?')
      .run(Date.now() - 31 * 60_000, card.id);

    // Confirma que SEM resposta do cliente o chase pegaria
    let fires = scheduler.findChaseCards();
    expect(fires.some((f: any) => f.row.card_id === card.id)).toBe(true);

    // Cliente responde agora
    store.logActivity(tenantId, {
      cardId: card.id, contactId: card.contactId,
      type: 'message_in', channel: 'whatsapp_zapi', direction: 'in', content: 'opa',
    });

    // Agora chase NAO deve mais pegar
    fires = scheduler.findChaseCards();
    expect(fires.some((f: any) => f.row.card_id === card.id)).toBe(false);
  });
});
