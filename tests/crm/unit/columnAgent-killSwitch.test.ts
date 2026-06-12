/**
 * Kill switch — agent_enabled=0 DEVE impedir o bot de executar em qualquer
 * caminho (mensagem do cliente OU timer de inatividade). Daniel 2026-04-30:
 * "se ta desligado na chave nao deve funcionar nem mandar msg pro cliente
 * de maneira nenhuma".
 *
 * O fix: runColumnAgent + runFromInactivityFire abortam ANTES de qualquer
 * acao, lendo crm_columns.agent_enabled diretamente do DB. Mesmo que o
 * scheduler ou outro caller passe um `column` stale com agentEnabled=true
 * em memoria, o DB e a fonte de verdade.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { randomBytes } from 'crypto';

const TEST_DB_PATH = '/tmp/clow-killsw-' + randomBytes(6).toString('hex') + '.db';
process.env.CRM_DB_PATH = TEST_DB_PATH;
process.env.CLOW_PII_KEY = 'kill-switch-test-key-with-min-16-chars-aaa';

const TENANT = 'kill-switch-test';
const COL_ID = 'crm_col_killswitch_test';
const CARD_ID = 'crm_card_killswitch_test';
const BOARD_ID = 'crm_board_killswitch_test';
const CHANNEL_ID = 'crm_chan_killswitch_test';

describe('Kill switch — agent_enabled=0 deve abortar runners', () => {
  let schema: any, runner: any, db: any;

  beforeAll(async () => {
    schema = await import('../../../src/crm/schema.js');
    runner = await import('../../../src/crm/agents/columnAgentRunner.js');
    db = schema.getCrmDb();

    // Seed: board, column (com agent_enabled=0), card.
    const now = Date.now();
    db.prepare(`INSERT INTO crm_boards (id, tenant_id, name, type, created_at, updated_at) VALUES (?,?,?,?,?,?)`)
      .run(BOARD_ID, TENANT, 'Test Board', 'sales', now, now);
    db.prepare(`INSERT INTO crm_columns (id, board_id, name, position, is_terminal, agent_enabled, agent_role, agent_system_prompt, agent_max_turns, agent_active_hours_start, agent_active_hours_end, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(COL_ID, BOARD_ID, 'Test Col', 0, 0, /*agent_enabled=*/0, 'qualificador', 'oi', 30, '00:00', '23:59', now);
    db.prepare(`INSERT INTO crm_cards (id, tenant_id, board_id, column_id, title, position, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(CARD_ID, TENANT, BOARD_ID, COL_ID, 'Test Card', 0, Date.now(), Date.now());
  });

  // helper — column com agentEnabled=true em memoria (stale) vs DB=0
  const staleColumn = {
    id: COL_ID, tenantId: TENANT, boardId: BOARD_ID, name: 'Test',
    position: 0, isTerminal: 0,
    agentEnabled: true, // <-- stale: param diz on, DB diz off
    agentRole: 'qualificador', agentSystemPrompt: 'oi',
    agentMaxTurns: 30,
    agentActiveHoursStart: '00:00', agentActiveHoursEnd: '23:59',
  };
  const fakeChannel = {
    id: CHANNEL_ID, tenantId: TENANT, name: 'Test', type: 'zapi',
    status: 'active', createdAt: Date.now(),
  };
  const fakeCard = {
    id: CARD_ID, tenantId: TENANT, boardId: BOARD_ID, columnId: COL_ID,
    title: 'Test Card', position: 0, createdAt: Date.now(), updatedAt: Date.now(),
  };

  it('runColumnAgent aborta com reason=agent_disabled quando DB tem agent_enabled=0', async () => {
    db.prepare('UPDATE crm_columns SET agent_enabled=0 WHERE id=?').run(COL_ID);

    const result = await runner.runColumnAgent({
      channel: fakeChannel, card: fakeCard, column: staleColumn,
      customerPhone: '5521999999999', text: 'teste',
      messageId: 'msg_kill_1',
    });

    expect(result.status).toBe('blocked');
    expect(result.reason).toBe('agent_disabled');
  });

  it('runColumnAgent grava metric blocked/agent_disabled', async () => {
    db.prepare('UPDATE crm_columns SET agent_enabled=0 WHERE id=?').run(COL_ID);
    db.prepare('DELETE FROM crm_agent_metrics WHERE card_id=?').run(CARD_ID);

    await runner.runColumnAgent({
      channel: fakeChannel, card: fakeCard, column: staleColumn,
      customerPhone: '5521999999999', text: 'teste', messageId: 'msg_kill_2',
    });

    const m = db.prepare('SELECT event, reason FROM crm_agent_metrics WHERE card_id=? ORDER BY occurred_at DESC LIMIT 1').get(CARD_ID);
    expect(m?.event).toBe('blocked');
    expect(m?.reason).toBe('agent_disabled');
  });

  it('runFromInactivityFire aborta com reason=agent_disabled', async () => {
    db.prepare('UPDATE crm_columns SET agent_enabled=0 WHERE id=?').run(COL_ID);

    const result = await runner.runFromInactivityFire({
      channel: fakeChannel, card: fakeCard, column: staleColumn,
      fireCount: 1, elapsedMin: 60,
    });

    expect(result.status).toBe('blocked');
    expect(result.reason).toBe('agent_disabled');
  });

  it('runFromInactivityFire grava metric blocked/agent_disabled_inactivity', async () => {
    db.prepare('UPDATE crm_columns SET agent_enabled=0 WHERE id=?').run(COL_ID);
    db.prepare('DELETE FROM crm_agent_metrics WHERE card_id=?').run(CARD_ID);

    await runner.runFromInactivityFire({
      channel: fakeChannel, card: fakeCard, column: staleColumn,
      fireCount: 1, elapsedMin: 60,
    });

    const m = db.prepare('SELECT event, reason FROM crm_agent_metrics WHERE card_id=? ORDER BY occurred_at DESC LIMIT 1').get(CARD_ID);
    expect(m?.event).toBe('blocked');
    expect(m?.reason).toBe('agent_disabled_inactivity');
  });

  it('fail-closed: columnId inexistente -> aborta', async () => {
    const result = await runner.runColumnAgent({
      channel: fakeChannel,
      card: { ...fakeCard, columnId: 'nao-existe-coluna' },
      column: { ...staleColumn, id: 'nao-existe-coluna' },
      customerPhone: '5521999999999', text: 'teste',
      messageId: 'msg_kill_3',
    });
    expect(result.status).toBe('blocked');
    expect(result.reason).toBe('agent_disabled');
  });
});
