/**
 * escalar_humano deve mover o card pra coluna "Atendimento Humano" quando
 * essa coluna existe no board (urgencia 'alta' ou 'normal' — sempre move).
 *
 * Daniel 2026-04-30: "agente manda msg no meu whatsapp e envia o cliente
 * pra mim e move direto para a tabela/coluna Atendimento Humano".
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { randomBytes } from 'crypto';

const TEST_DB_PATH = '/tmp/clow-escm-' + randomBytes(6).toString('hex') + '.db';
process.env.CRM_DB_PATH = TEST_DB_PATH;
process.env.CLOW_PII_KEY = 'escalar-test-key-with-min-16-chars-aaa';

const TENANT = 'esc-test';
const BOARD = 'crm_board_escm';
const LEAD = 'crm_col_escm_lead';
const HUMANO = 'crm_col_escm_humano';
const CARD = 'crm_card_escm';

describe('escalar_humano — move card pra Atendimento Humano', () => {
  let schema: any, common: any, db: any;

  beforeAll(async () => {
    schema = await import('../../../src/crm/schema.js');
    db = schema.getCrmDb();
    common = await import('../../../src/crm/agents/tools/common.js');

    const now = Date.now();
    db.prepare('INSERT INTO crm_boards (id, tenant_id, name, type, created_at, updated_at) VALUES (?,?,?,?,?,?)')
      .run(BOARD, TENANT, 'Pipeline', 'sales', now, now);
    db.prepare('INSERT INTO crm_columns (id, board_id, name, position, agent_enabled, created_at) VALUES (?,?,?,?,?,?)')
      .run(LEAD, BOARD, 'Lead novo', 0, 1, now);
    db.prepare('INSERT INTO crm_columns (id, board_id, name, position, agent_enabled, created_at) VALUES (?,?,?,?,?,?)')
      .run(HUMANO, BOARD, 'Atendimento Humano', 2, 0, now);
    db.prepare('INSERT INTO crm_cards (id, tenant_id, board_id, column_id, title, position, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(CARD, TENANT, BOARD, LEAD, 'Test Card', 0, now, now);
  });

  function getEscalarTool() {
    // a tool e exportada via COMMON_TOOLS — pega ela pelo nome
    const t = common.COMMON_TOOLS.find((x: any) => x.name === 'escalar_humano');
    if (!t) throw new Error('escalar_humano not found in COMMON_TOOLS');
    return t;
  }

  function makeCtx() {
    return {
      tenantId: TENANT, role: 'qualificador',
      column: { id: LEAD, name: 'Lead novo', boardId: BOARD, agentRole: 'qualificador' },
      card: { id: CARD, tenantId: TENANT, boardId: BOARD, columnId: LEAD, title: 'Test Card', contactId: null },
      channel: { id: 'ch1', tenantId: TENANT, name: 'Test', type: 'zapi', status: 'active' },
      customerPhone: '5521999999999',
      state: { turnsCount: 1, status: 'active' },
    };
  }

  it('move card pra Atendimento Humano quando urgencia=alta', async () => {
    db.prepare('UPDATE crm_cards SET column_id=? WHERE id=?').run(LEAD, CARD);
    const tool = getEscalarTool();

    const result = await tool.execute(
      { motivo: 'cliente quer plano completo', urgencia: 'alta' },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    expect(result.result.escalated).toBe(true);
    expect(result.result.movedTo).not.toBeNull();
    expect(result.result.movedTo.name).toBe('Atendimento Humano');

    const card = db.prepare('SELECT column_id FROM crm_cards WHERE id=?').get(CARD);
    expect(card.column_id).toBe(HUMANO);
  });

  it('move card mesmo com urgencia=normal', async () => {
    db.prepare('UPDATE crm_cards SET column_id=? WHERE id=?').run(LEAD, CARD);
    const tool = getEscalarTool();

    const result = await tool.execute({ motivo: 'cliente xingou', urgencia: 'normal' }, makeCtx());

    expect(result.result.movedTo).not.toBeNull();
    const card = db.prepare('SELECT column_id FROM crm_cards WHERE id=?').get(CARD);
    expect(card.column_id).toBe(HUMANO);
  });

  it('NAO falha se coluna Atendimento Humano nao existir', async () => {
    db.prepare('UPDATE crm_cards SET column_id=? WHERE id=?').run(LEAD, CARD);
    db.prepare('UPDATE crm_columns SET name=? WHERE id=?').run('Outra Coisa', HUMANO);
    const tool = getEscalarTool();

    const result = await tool.execute({ motivo: 'teste', urgencia: 'alta' }, makeCtx());

    expect(result.ok).toBe(true);
    expect(result.result.escalated).toBe(true);
    expect(result.result.movedTo).toBeNull();
    // Card fica na coluna original
    const card = db.prepare('SELECT column_id FROM crm_cards WHERE id=?').get(CARD);
    expect(card.column_id).toBe(LEAD);

    // Restaura pra outros testes
    db.prepare('UPDATE crm_columns SET name=? WHERE id=?').run('Atendimento Humano', HUMANO);
  });

  it('match tolerante a acentos (Atendimento humano)', async () => {
    db.prepare('UPDATE crm_cards SET column_id=? WHERE id=?').run(LEAD, CARD);
    db.prepare('UPDATE crm_columns SET name=? WHERE id=?').run('atendimento humano', HUMANO);
    const tool = getEscalarTool();

    const result = await tool.execute({ motivo: 'teste', urgencia: 'alta' }, makeCtx());
    expect(result.result.movedTo).not.toBeNull();
    db.prepare('UPDATE crm_columns SET name=? WHERE id=?').run('Atendimento Humano', HUMANO);
  });

  it('idempotente — se card ja esta em Atendimento Humano, nao move', async () => {
    db.prepare('UPDATE crm_cards SET column_id=? WHERE id=?').run(HUMANO, CARD);
    const tool = getEscalarTool();
    const ctx = makeCtx();
    ctx.card.columnId = HUMANO;
    ctx.column = { id: HUMANO, name: 'Atendimento Humano', boardId: BOARD, agentRole: 'custom' };

    const result = await tool.execute({ motivo: 'teste', urgencia: 'alta' }, ctx);
    expect(result.result.movedTo).toBeNull();  // ja estava la
  });
});
