/**
 * Tests do healthMetrics — snapshot de saúde da pipeline.
 *
 * Daniel 2026-05-07 (Fase 3.1): garante que o snapshot retorna shape
 * esperado mesmo com DB vazio, computa contagens corretas com fixtures,
 * e dispara alertas pros casos críticos.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'crypto';

const TEST_DB_PATH = '/tmp/clow-health-' + randomBytes(6).toString('hex') + '.db';
process.env.CRM_DB_PATH = TEST_DB_PATH;
process.env.CLOW_PII_KEY = 'health-test-key-with-min-16-chars';

describe('healthMetrics — snapshot de saúde', () => {
  let schema: any, store: any, healthMetrics: any;

  beforeAll(async () => {
    schema = await import('../../../src/crm/schema.js');
    store = await import('../../../src/crm/store.js');
    healthMetrics = await import('../../../src/crm/observability/healthMetrics.js');
    schema.getCrmDb();
  });

  afterAll(() => {
    try { require('fs').unlinkSync(TEST_DB_PATH); } catch { /* ignore */ }
  });

  it('retorna shape válido com DB vazio (tenant inexistente)', () => {
    const tid = 't-' + randomBytes(4).toString('hex');
    const snap = healthMetrics.collectClowHealthSnapshot(tid);

    expect(snap.tenant_id).toBe(tid);
    expect(typeof snap.collected_at).toBe('string');
    expect(snap.cards_waiting_client_reply.total).toBe(0);
    expect(snap.cards_waiting_client_reply.over_30min).toBe(0);
    expect(snap.cards_waiting_client_reply.over_2h).toBe(0);
    expect(snap.cards_waiting_client_reply.sample_titles_over_30min).toEqual([]);
    expect(snap.validator_blocks_24h).toEqual({});
    expect(snap.tool_failures_24h).toEqual({});
    expect(snap.meta_commentary_blocked_24h).toBe(0);
    expect(snap.bursts_outbound_60s_24h.total_messages).toBe(0);
    expect(snap.pipeline_summary.new_cards_24h).toBe(0);
    expect(snap.alerts).toEqual([]);
  });

  it('detecta cards aguardando bot (cliente respondeu por último)', () => {
    const tid = 't-' + randomBytes(4).toString('hex');
    const board = store.seedDefaultBoards(tid);
    const cols = store.listColumns(tid, board.id);
    const db = schema.getCrmDb();

    // Liga agente na primeira coluna (pra entrar no filtro)
    db.prepare(`UPDATE crm_columns SET agent_enabled=1, agent_role='vendedor' WHERE id=?`).run(cols[0].id);

    const now = Date.now();
    const _40min_ago = now - 40 * 60_000;
    const _3h_ago = now - 3 * 60 * 60_000;

    const c1 = store.createContact(tid, { name: 'Cliente40min', phone: '+5511999000001', source: 'test' });
    const card1 = store.createCard(tid, { boardId: board.id, columnId: cols[0].id, title: c1.name, contactId: c1.id });

    const c2 = store.createContact(tid, { name: 'Cliente3h', phone: '+5511999000002', source: 'test' });
    const card2 = store.createCard(tid, { boardId: board.id, columnId: cols[0].id, title: c2.name, contactId: c2.id });

    // Simula: cliente mandou mensagem (last_inbound_at) e bot não respondeu
    db.prepare(`UPDATE crm_cards SET last_inbound_at=?, last_bot_message_at=? WHERE id=?`)
      .run(_40min_ago, _40min_ago - 1000, card1.id);
    db.prepare(`UPDATE crm_cards SET last_inbound_at=?, last_bot_message_at=? WHERE id=?`)
      .run(_3h_ago, _3h_ago - 1000, card2.id);

    const snap = healthMetrics.collectClowHealthSnapshot(tid);
    expect(snap.cards_waiting_client_reply.total).toBe(2);
    expect(snap.cards_waiting_client_reply.over_30min).toBe(2);
    expect(snap.cards_waiting_client_reply.over_2h).toBe(1);
    expect(snap.cards_waiting_client_reply.over_24h).toBe(0);
    expect(snap.cards_waiting_client_reply.sample_titles_over_30min).toContain('Cliente40min');
  });

  it('contabiliza bloqueios do validator nas últimas 24h por reason', () => {
    const tid = 't-' + randomBytes(4).toString('hex');
    const board = store.seedDefaultBoards(tid);
    const cols = store.listColumns(tid, board.id);
    const db = schema.getCrmDb();
    const now = Date.now();

    const insertMetric = (event: string, reason: string, ageMs = 1000) => {
      db.prepare(`INSERT INTO crm_agent_metrics (id, tenant_id, column_id, card_id, event, reason, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run('m_' + randomBytes(4).toString('hex'), tid, cols[0].id, 'fake_card', event, reason, now - ageMs);
    };

    insertMetric('blocked', 'output_validator_price_off_table');
    insertMetric('blocked', 'output_validator_price_off_table');
    insertMetric('blocked', 'output_validator_forbidden_term');
    insertMetric('blocked', 'output_validator_unbacked_currency_inactivity');
    // Antigo (>24h não conta)
    insertMetric('blocked', 'output_validator_price_below_floor', 25 * 60 * 60_000);
    // Não-validator (não conta)
    insertMetric('blocked', 'meta_commentary');
    insertMetric('blocked', 'meta_commentary_inactivity');

    const snap = healthMetrics.collectClowHealthSnapshot(tid);
    expect(snap.validator_blocks_24h).toEqual({
      price_off_table: 2,
      forbidden_term: 1,
      unbacked_currency: 1,
    });
    expect(snap.meta_commentary_blocked_24h).toBe(2);
  });

  it('agrega tool failures por nome', () => {
    const tid = 't-' + randomBytes(4).toString('hex');
    const board = store.seedDefaultBoards(tid);
    const cols = store.listColumns(tid, board.id);
    const db = schema.getCrmDb();
    const now = Date.now();

    const insertFail = (reason: string) => {
      db.prepare(`INSERT INTO crm_agent_metrics (id, tenant_id, column_id, card_id, event, reason, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run('m_' + randomBytes(4).toString('hex'), tid, cols[0].id, 'fake', 'tool_failed', reason, now - 1000);
    };

    insertFail('tool=cotar_sulamerica_api args_keys=[idade] ok=false');
    insertFail('tool=cotar_sulamerica_api args_keys=[idade] ok=false');
    insertFail('tool=salvar_dados_proposta args_keys=[cpf] ok=false');

    const snap = healthMetrics.collectClowHealthSnapshot(tid);
    expect(snap.tool_failures_24h.cotar_sulamerica_api).toBe(2);
    expect(snap.tool_failures_24h.salvar_dados_proposta).toBe(1);
  });

  it('dispara alerta quando >2h cliente esperando', () => {
    const tid = 't-' + randomBytes(4).toString('hex');
    const board = store.seedDefaultBoards(tid);
    const cols = store.listColumns(tid, board.id);
    const db = schema.getCrmDb();
    db.prepare(`UPDATE crm_columns SET agent_enabled=1, agent_role='vendedor' WHERE id=?`).run(cols[0].id);

    const _3h_ago = Date.now() - 3 * 60 * 60_000;
    const c = store.createContact(tid, { name: 'Esperando3h', phone: '+5511999111111', source: 'test' });
    const card = store.createCard(tid, { boardId: board.id, columnId: cols[0].id, title: c.name, contactId: c.id });
    db.prepare(`UPDATE crm_cards SET last_inbound_at=?, last_bot_message_at=? WHERE id=?`)
      .run(_3h_ago, _3h_ago - 1000, card.id);

    const snap = healthMetrics.collectClowHealthSnapshot(tid);
    expect(snap.alerts.some((a: string) => /2h/.test(a))).toBe(true);
  });

  it('dispara alerta quando >20 bloqueios validator em 24h', () => {
    const tid = 't-' + randomBytes(4).toString('hex');
    const board = store.seedDefaultBoards(tid);
    const cols = store.listColumns(tid, board.id);
    const db = schema.getCrmDb();
    const now = Date.now();
    for (let i = 0; i < 25; i++) {
      db.prepare(`INSERT INTO crm_agent_metrics (id, tenant_id, column_id, card_id, event, reason, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run('m_' + i + '_' + randomBytes(2).toString('hex'), tid, cols[0].id, 'fake', 'blocked', 'output_validator_price_off_table', now - 1000);
    }

    const snap = healthMetrics.collectClowHealthSnapshot(tid);
    expect(snap.alerts.some((a: string) => /bloqueios.*validator/i.test(a))).toBe(true);
  });

  it('logHealthSnapshot não throws (log-only)', () => {
    expect(() => healthMetrics.logHealthSnapshot()).not.toThrow();
  });
});
