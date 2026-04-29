/**
 * CRM config tools — testa as 9 ferramentas que System Clow usa pra montar
 * funnels customizados pra clientes (qualquer nicho).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { randomBytes } from 'crypto';

const TEST_DB_PATH = '/tmp/clow-cfg-tools-' + randomBytes(6).toString('hex') + '.db';
process.env.CRM_DB_PATH = TEST_DB_PATH;
process.env.CLOW_PII_KEY = 'cfg-tools-test-key-with-min-16-chars-aaa';

describe('CRM config tools — System Clow setup coach', () => {
  let schema: any, store: any, tools: any;

  beforeAll(async () => {
    schema = await import('../../../src/crm/schema.js');
    store = await import('../../../src/crm/store.js');
    tools = await import('../../../src/tools/CrmTool/CrmTool.js');
    schema.getCrmDb();
  });

  function makeTenant() { return 'tcfg-' + randomBytes(3).toString('hex'); }
  function ctx(tenantId: string) { return { tenantId } as any; }

  function readCol(colId: string) {
    return schema.getCrmDb().prepare('SELECT * FROM crm_columns WHERE id = ?').get(colId) as any;
  }

  // ─── 1. crm_create_column ────────────────────────────────────────────
  it('1. crm_create_column insere coluna e respeita position automática', async () => {
    const tenantId = makeTenant();
    const board = store.seedDefaultBoards(tenantId);
    const before = store.listColumns(tenantId, board.id);
    const r = await tools.CrmCreateColumnTool.call(
      { boardId: board.id, name: 'Meu Estágio Custom' },
      ctx(tenantId),
    );
    expect(r.output.column).toBeTruthy();
    expect(r.output.column.name).toBe('Meu Estágio Custom');
    expect(r.output.column.position).toBeGreaterThanOrEqual(before.length);
  });

  // ─── 2. crm_update_column ────────────────────────────────────────────
  it('2. crm_update_column renomeia + reordena + setta stage_type', async () => {
    const tenantId = makeTenant();
    const board = store.seedDefaultBoards(tenantId);
    const cols = store.listColumns(tenantId, board.id);
    const target = cols[0];

    await tools.CrmUpdateColumnTool.call(
      { columnId: target.id, name: 'Renomeada', position: 99, stageType: 'won' },
      ctx(tenantId),
    );
    const row = readCol(target.id);
    expect(row.name).toBe('Renomeada');
    expect(row.position).toBe(99);
    expect(row.stage_type).toBe('won');
  });

  // ─── 3. crm_configure_column_agent ───────────────────────────────────
  it('3. crm_configure_column_agent é PATCH — preserva campos não-passados', async () => {
    const tenantId = makeTenant();
    const board = store.seedDefaultBoards(tenantId);
    const cols = store.listColumns(tenantId, board.id);
    const colId = cols[0].id;

    // 1ª chamada: setta tudo
    await tools.CrmConfigureColumnAgentTool.call({
      columnId: colId,
      agentEnabled: true,
      agentName: 'Sofia',
      agentRole: 'qualificador',
      agentSystemPrompt: 'Você é Sofia, qualificadora da empresa X.',
      agentEntryDelayMinutes: 5,
      agentNoResponseChaseSteps: [30, 120, 360],
      agentFollowupStepsHours: [24, 48],
      agentMaxTurns: 25,
    }, ctx(tenantId));
    let row = readCol(colId);
    expect(row.agent_enabled).toBe(1);
    expect(row.agent_name).toBe('Sofia');
    expect(row.agent_role).toBe('qualificador');
    expect(row.agent_role_type).toBe('qualificador'); // espelhou role
    expect(row.agent_entry_delay_minutes).toBe(5);
    expect(row.agent_no_response_chase_steps_json).toBe('[30,120,360]');
    expect(row.agent_followup_steps_hours_json).toBe('[24,48]');
    expect(row.agent_max_turns).toBe(25);

    // 2ª chamada: PATCH só do entry_delay — resto preservado
    await tools.CrmConfigureColumnAgentTool.call({
      columnId: colId,
      agentEntryDelayMinutes: 2,
    }, ctx(tenantId));
    row = readCol(colId);
    expect(row.agent_entry_delay_minutes).toBe(2);
    expect(row.agent_name).toBe('Sofia'); // preservado
    expect(row.agent_system_prompt).toBe('Você é Sofia, qualificadora da empresa X.'); // preservado
    expect(row.agent_max_turns).toBe(25); // preservado
  });

  // ─── 4. crm_configure_column_agent — set promote_to_column_id ────────
  it('4. crm_configure_column_agent grava agentPromoteToColumnId (2ª passada)', async () => {
    const tenantId = makeTenant();
    const board = store.seedDefaultBoards(tenantId);
    const cols = store.listColumns(tenantId, board.id);
    expect(cols.length).toBeGreaterThanOrEqual(2);

    await tools.CrmConfigureColumnAgentTool.call({
      columnId: cols[0].id,
      agentPromoteToColumnId: cols[1].id,
    }, ctx(tenantId));
    const row = readCol(cols[0].id);
    expect(row.agent_promote_to_column_id).toBe(cols[1].id);
  });

  // ─── 5. crm_disable_column_agent ─────────────────────────────────────
  it('5. crm_disable_column_agent zera flag mas preserva config', async () => {
    const tenantId = makeTenant();
    const board = store.seedDefaultBoards(tenantId);
    const cols = store.listColumns(tenantId, board.id);
    const colId = cols[0].id;

    await tools.CrmConfigureColumnAgentTool.call({
      columnId: colId, agentEnabled: true, agentRole: 'cotador',
      agentSystemPrompt: 'prompt importante',
    }, ctx(tenantId));
    await tools.CrmDisableColumnAgentTool.call({ columnId: colId }, ctx(tenantId));

    const row = readCol(colId);
    expect(row.agent_enabled).toBe(0);
    expect(row.agent_role).toBe('cotador'); // preservado
    expect(row.agent_system_prompt).toBe('prompt importante'); // preservado
  });

  // ─── 6. crm_delete_column ────────────────────────────────────────────
  it('6. crm_delete_column falha se tem cards (sem force) e funciona com force', async () => {
    const tenantId = makeTenant();
    const board = store.seedDefaultBoards(tenantId);
    const cols = store.listColumns(tenantId, board.id);
    const colId = cols[0].id;

    // Cria card
    const contact = store.createContact(tenantId, { name: 'X', source: 't' });
    store.createCard(tenantId, { boardId: board.id, columnId: colId, title: 'card', contactId: contact.id });

    const r1 = await tools.CrmDeleteColumnTool.call({ columnId: colId }, ctx(tenantId));
    expect(r1.isError).toBe(true);
    expect(r1.output.error).toBe('has_cards');
    expect(r1.output.cardCount).toBe(1);

    const r2 = await tools.CrmDeleteColumnTool.call({ columnId: colId, force: true }, ctx(tenantId));
    expect(r2.output.deleted).toBe(true);
  });

  // ─── 7. crm_update_card ──────────────────────────────────────────────
  it('7. crm_update_card renomeia + muda value', async () => {
    const tenantId = makeTenant();
    const board = store.seedDefaultBoards(tenantId);
    const cols = store.listColumns(tenantId, board.id);
    const contact = store.createContact(tenantId, { name: 'Y', source: 't' });
    const card = store.createCard(tenantId, { boardId: board.id, columnId: cols[0].id, title: 'antigo', contactId: contact.id });

    const r = await tools.CrmUpdateCardTool.call({
      cardId: card.id, title: 'NovoTitulo', valueCents: 49900, probability: 75,
    }, ctx(tenantId));
    expect(r.output.card.title).toBe('NovoTitulo');
    expect(r.output.card.valueCents).toBe(49900);
    expect(r.output.card.probability).toBe(75);
  });

  // ─── 8. crm_list_columns retorna config completa ─────────────────────
  it('8. crm_list_columns retorna toda config de agente das colunas', async () => {
    const tenantId = makeTenant();
    const board = store.seedDefaultBoards(tenantId);
    const cols = store.listColumns(tenantId, board.id);
    await tools.CrmConfigureColumnAgentTool.call({
      columnId: cols[0].id,
      agentEnabled: true,
      agentRole: 'vendedor',
      agentEntryDelayMinutes: 4,
      agentNoResponseChaseSteps: [30, 120],
    }, ctx(tenantId));

    const r = await tools.CrmListColumnsTool.call({ boardId: board.id }, ctx(tenantId));
    expect(r.output.columns).toBeDefined();
    expect(r.output.columns.length).toBe(cols.length);
    const c0 = r.output.columns.find((c: any) => c.id === cols[0].id);
    expect(c0.agentEnabled).toBe(true);
    expect(c0.agentRole).toBe('vendedor');
    expect(c0.agentEntryDelayMinutes).toBe(4);
    expect(r.outputText).toContain('vendedor');
  });

  // ─── 9. crm_list_boards e crm_create_board ───────────────────────────
  it('9. crm_create_board cria + crm_list_boards retorna ambos', async () => {
    const tenantId = makeTenant();
    store.seedDefaultBoards(tenantId);
    const before = (await tools.CrmListBoardsTool.call({}, ctx(tenantId))).output.boards;
    await tools.CrmCreateBoardTool.call({ name: 'Plano Saúde', type: 'sales' }, ctx(tenantId));
    const after = (await tools.CrmListBoardsTool.call({}, ctx(tenantId))).output.boards;
    expect(after.length).toBe(before.length + 1);
    expect(after.some((b: any) => b.name === 'Plano Saúde')).toBe(true);
  });
});
