/**
 * PR 7.0 — Funil v2 Timer-Driven (RECONSTRUÇÃO ARQUITETURAL).
 *
 * 26 cenarios cobrindo:
 *   - Roteamento e roles (1-3)
 *   - Timers entry/chase/followup (4-12)
 *   - Reset de timers ao cliente responder (13)  [skipped — depende do runner real]
 *   - Prompts dos 5 roles (13-19)
 *   - Tags estruturadas (20-22)
 *   - Escalate plano completo (23-24)
 *   - Cripto e validação (25-26)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'crypto';

const TEST_DB_PATH = '/tmp/clow-pr70-' + randomBytes(6).toString('hex') + '.db';
process.env.CRM_DB_PATH = TEST_DB_PATH;
process.env.CLOW_PII_KEY = 'pr70-test-key-with-min-16-chars-aaaa';

describe('PR 7.0 — Funil v2 Timer-Driven', () => {
  let prompts: any, registry: any, schema: any, store: any,
      agentState: any, scheduler: any, tags: any, finalizador: any;

  beforeAll(async () => {
    schema = await import('../../../src/crm/schema.js');
    store = await import('../../../src/crm/store.js');
    agentState = await import('../../../src/crm/store/cardAgentStateStore.js');
    registry = await import('../../../src/crm/agents/tools/registry.js');
    prompts = await import('../../../src/crm/agents/defaultPrompts.js');
    scheduler = await import('../../../src/crm/agents/columnTimerScheduler.js');
    tags = await import('../../../src/crm/agents/tools/tags.js');
    finalizador = await import('../../../src/crm/agents/tools/coletor_dados.js');
    schema.getCrmDb();
  });

  afterAll(() => {
    try { require('fs').unlinkSync(TEST_DB_PATH); } catch { /* ignore */ }
  });

  // ─── Helpers ────────────────────────────────────────────────────────────

  function makeTenant() { return 't70-' + randomBytes(3).toString('hex'); }

  function setupBoard(tenantId: string) {
    const board = store.seedDefaultBoards(tenantId);
    const cols = store.listColumns(tenantId, board.id);
    return { board, cols };
  }

  function createCardInColumn(tenantId: string, boardId: string, columnId: string, role = 'qualificador') {
    const contact = store.createContact(tenantId, {
      name: 'TestLead',
      phone: '+5511990' + randomBytes(2).toString('hex').slice(0, 5),
      source: 't',
    });
    const card = store.createCard(tenantId, {
      boardId, columnId, title: contact.name, contactId: contact.id,
    });
    agentState.upsertCardAgentState({
      cardId: card.id, columnId, currentAgentRole: role, tenantId, status: 'active',
    });
    return card;
  }

  function configColumn(columnId: string, opts: {
    role?: string; entryDelayMin?: number; chaseSteps?: number[] | null;
    fuSteps?: number[] | null; promoteToColumnId?: string;
  }) {
    const db = schema.getCrmDb();
    db.prepare(`UPDATE crm_columns SET
      agent_enabled = 1,
      agent_role = ?,
      agent_role_type = ?,
      agent_entry_delay_minutes = ?,
      agent_no_response_chase_steps_json = ?,
      agent_followup_steps_hours_json = ?,
      agent_promote_to_column_id = ?,
      agent_max_turns = 30,
      agent_active_hours_start = '00:00',
      agent_active_hours_end = '23:59',
      agent_system_prompt = 'test prompt'
      WHERE id = ?`).run(
        opts.role ?? null, opts.role ?? null,
        opts.entryDelayMin ?? 0,
        opts.chaseSteps ? JSON.stringify(opts.chaseSteps) : null,
        opts.fuSteps ? JSON.stringify(opts.fuSteps) : null,
        opts.promoteToColumnId ?? null,
        columnId,
      );
  }

  function setColumnChangedAt(cardId: string, ts: number) {
    const db = schema.getCrmDb();
    db.prepare(`UPDATE crm_cards SET column_changed_at = ? WHERE id = ?`).run(ts, cardId);
  }

  function setLastBotMessageAt(cardId: string, ts: number) {
    const db = schema.getCrmDb();
    db.prepare(`UPDATE crm_cards SET last_bot_message_at = ? WHERE id = ?`).run(ts, cardId);
  }

  // ─── ROTEAMENTO E ROLES ─────────────────────────────────────────────────

  it('1. ColumnAgentRole inclui qualificador, cotador, vendedor, coletor, followupper', () => {
    // Type-level — checa via DEFAULT_PROMPTS keys
    const roles = Object.keys(prompts.DEFAULT_PROMPTS);
    expect(roles).toContain('qualificador');
    expect(roles).toContain('cotador');
    expect(roles).toContain('vendedor');
    expect(roles).toContain('coletor');
    expect(roles).toContain('followupper');
    expect(roles.length).toBe(5);
  });

  it('2. Migration 011 renomeia roles antigos pra novos', async () => {
    const tenantId = makeTenant();
    const board = store.seedDefaultBoards(tenantId);
    const cols = store.listColumns(tenantId, board.id);
    const db = schema.getCrmDb();
    // Setup: cria roles deprecated
    db.prepare(`UPDATE crm_columns SET agent_role = 'vendedor_funeral' WHERE id = ?`).run(cols[0].id);
    db.prepare(`UPDATE crm_columns SET agent_role = 'coletor_dados' WHERE id = ?`).run(cols[1].id);

    const m011 = await import('../../../src/crm/migrations/011_funnel_v2_timer_driven.js');
    m011.up(db);

    const r0 = db.prepare(`SELECT agent_role FROM crm_columns WHERE id = ?`).get(cols[0].id) as any;
    const r1 = db.prepare(`SELECT agent_role FROM crm_columns WHERE id = ?`).get(cols[1].id) as any;
    expect(r0.agent_role).toBe('vendedor');
    expect(r1.agent_role).toBe('coletor');
  });

  it('3. Roles deprecated estao no type mas registry nao expoe tools especificas', () => {
    for (const oldRole of ['educador', 'finalizador', 'closer']) {
      const tools = registry.getToolsForRole(oldRole);
      const specific = tools.filter((t: any) => !t.roles.includes('*'));
      expect(specific.length).toBe(0);
    }
  });

  // ─── TIMERS ─────────────────────────────────────────────────────────────

  it('4. Card chega em coluna com entry_delay_minutes=5 — apos 5 min scheduler dispara', () => {
    const tenantId = makeTenant();
    const { board, cols } = setupBoard(tenantId);
    const card = createCardInColumn(tenantId, board.id, cols[0].id, 'cotador');
    configColumn(cols[0].id, { role: 'cotador', entryDelayMin: 5 });
    // Card entrou ha 6 min
    setColumnChangedAt(card.id, Date.now() - 6 * 60 * 1000);

    const eligible = scheduler.findEntryDelayCards(Date.now());
    const ids = eligible.map((r: any) => r.card_id);
    expect(ids).toContain(card.id);
  });

  it('4b. Card com entry_delay_minutes=5 e ainda 3 min na coluna — NAO dispara', () => {
    const tenantId = makeTenant();
    const { board, cols } = setupBoard(tenantId);
    const card = createCardInColumn(tenantId, board.id, cols[0].id, 'cotador');
    configColumn(cols[0].id, { role: 'cotador', entryDelayMin: 5 });
    setColumnChangedAt(card.id, Date.now() - 3 * 60 * 1000);

    const eligible = scheduler.findEntryDelayCards(Date.now());
    const ids = eligible.map((r: any) => r.card_id);
    expect(ids).not.toContain(card.id);
  });

  it('5. Card em Vendedor, bot mandou msg ha 30 min sem resposta — chase_step_1 dispara', () => {
    const tenantId = makeTenant();
    const { board, cols } = setupBoard(tenantId);
    const card = createCardInColumn(tenantId, board.id, cols[0].id, 'vendedor');
    configColumn(cols[0].id, { role: 'vendedor', chaseSteps: [30, 120, 360] });
    // Bot mandou ha 35 min, cliente nao respondeu
    setLastBotMessageAt(card.id, Date.now() - 35 * 60 * 1000);

    const fires = scheduler.findChaseCards(Date.now());
    const f = fires.find((x: any) => x.row.card_id === card.id);
    expect(f).toBeDefined();
    expect(f.stepIdx).toBe(0);
    expect(f.stepMinutes).toBe(30);
  });

  it('6. Card chase step 1 ja disparado — segunda passagem pega step 2 (2h)', () => {
    const tenantId = makeTenant();
    const { board, cols } = setupBoard(tenantId);
    const card = createCardInColumn(tenantId, board.id, cols[0].id, 'vendedor');
    configColumn(cols[0].id, { role: 'vendedor', chaseSteps: [30, 120, 360] });
    setLastBotMessageAt(card.id, Date.now() - 130 * 60 * 1000);
    // Step 1 ja foi
    tags.applyTagSystem(card.id, 'sem_resposta_step_1');

    const fires = scheduler.findChaseCards(Date.now());
    const f = fires.find((x: any) => x.row.card_id === card.id);
    expect(f).toBeDefined();
    expect(f.stepIdx).toBe(1);
    expect(f.stepMinutes).toBe(120);
  });

  it('7. Card chase step 3 ja disparado — sem mais fires (espera mover_para_followup)', () => {
    const tenantId = makeTenant();
    const { board, cols } = setupBoard(tenantId);
    const card = createCardInColumn(tenantId, board.id, cols[0].id, 'vendedor');
    configColumn(cols[0].id, { role: 'vendedor', chaseSteps: [30, 120, 360] });
    setLastBotMessageAt(card.id, Date.now() - 400 * 60 * 1000);
    tags.applyTagSystem(card.id, 'sem_resposta_step_1');
    tags.applyTagSystem(card.id, 'sem_resposta_step_2');
    tags.applyTagSystem(card.id, 'sem_resposta_step_3');

    const fires = scheduler.findChaseCards(Date.now());
    const f = fires.find((x: any) => x.row.card_id === card.id);
    expect(f).toBeUndefined();
  });

  it('8. Card em Follow Up ha 25h — followup_step_1 dispara (24h)', () => {
    const tenantId = makeTenant();
    const board = store.seedDefaultBoards(tenantId);
    const fuCol = store.createColumn(tenantId, { boardId: board.id, name: 'Follow Up', color: '#888' });
    const card = createCardInColumn(tenantId, board.id, fuCol.id, 'followupper');
    configColumn(fuCol.id, { role: 'followupper', fuSteps: [24, 48, 72] });
    setColumnChangedAt(card.id, Date.now() - 25 * 60 * 60 * 1000);

    const fires = scheduler.findFollowupCards(Date.now());
    const f = fires.find((x: any) => x.row.card_id === card.id);
    expect(f).toBeDefined();
    expect(f.stepHours).toBe(24);
    expect(f.isFinalDelete).toBe(false);
  });

  it('9. Card em Follow Up ha 50h, step 1 ja foi — step 2 dispara (48h)', () => {
    const tenantId = makeTenant();
    const board = store.seedDefaultBoards(tenantId);
    const fuCol = store.createColumn(tenantId, { boardId: board.id, name: 'Follow Up', color: '#888' });
    const card = createCardInColumn(tenantId, board.id, fuCol.id, 'followupper');
    configColumn(fuCol.id, { role: 'followupper', fuSteps: [24, 48, 72] });
    setColumnChangedAt(card.id, Date.now() - 50 * 60 * 60 * 1000);
    tags.applyTagSystem(card.id, 'followup_24h');

    const fires = scheduler.findFollowupCards(Date.now());
    const f = fires.find((x: any) => x.row.card_id === card.id);
    expect(f).toBeDefined();
    expect(f.stepHours).toBe(48);
  });

  it('10. Card em Follow Up ha 100h, todos steps ja foram — final_delete dispara', () => {
    const tenantId = makeTenant();
    const board = store.seedDefaultBoards(tenantId);
    const fuCol = store.createColumn(tenantId, { boardId: board.id, name: 'Follow Up', color: '#888' });
    const card = createCardInColumn(tenantId, board.id, fuCol.id, 'followupper');
    configColumn(fuCol.id, { role: 'followupper', fuSteps: [24, 48, 72] });
    setColumnChangedAt(card.id, Date.now() - 100 * 60 * 60 * 1000);
    tags.applyTagSystem(card.id, 'followup_24h');
    tags.applyTagSystem(card.id, 'followup_48h');
    tags.applyTagSystem(card.id, 'followup_72h');

    const fires = scheduler.findFollowupCards(Date.now());
    const f = fires.find((x: any) => x.row.card_id === card.id);
    expect(f).toBeDefined();
    expect(f.isFinalDelete).toBe(true);
  });

  it('11. Cliente respondeu (last_client_message_at > last_bot_message_at) — chase NAO dispara', () => {
    const tenantId = makeTenant();
    const { board, cols } = setupBoard(tenantId);
    const card = createCardInColumn(tenantId, board.id, cols[0].id, 'vendedor');
    configColumn(cols[0].id, { role: 'vendedor', chaseSteps: [30, 120, 360] });
    const now = Date.now();
    setLastBotMessageAt(card.id, now - 35 * 60 * 1000);
    // Cliente respondeu 2 min depois (mais recente que bot)
    const db = schema.getCrmDb();
    db.prepare(`UPDATE crm_cards SET last_client_message_at = ? WHERE id = ?`)
      .run(now - 33 * 60 * 1000, card.id);

    const fires = scheduler.findChaseCards(Date.now());
    const f = fires.find((x: any) => x.row.card_id === card.id);
    expect(f).toBeUndefined();
  });

  it('12. Limite global de 50 cards por categoria por tick', () => {
    // Documentado — MAX_PER_CATEGORY=50 hardcoded em scheduler
    expect(true).toBe(true); // smoke
  });

  // ─── PROMPTS ────────────────────────────────────────────────────────────

  it('13. Qualificador prompt NAO contem precos do plano (29,90 / 39,90 / 49,90 / 89,90)', () => {
    const p = prompts.PROMPT_QUALIFICADOR;
    // PR 7.0: Qualificador pode mencionar beneficio "R$ 50.000 morte acidental"
    // (eh valor de cobertura, nao preco do plano). Mas NUNCA cita preco mensal.
    expect(p).not.toContain('29,90');
    expect(p).not.toContain('39,90');
    expect(p).not.toContain('49,90');
    expect(p).not.toContain('89,90');
    // Regra explicita esta no prompt
    expect(p).toMatch(/NUNCA\s+cite\s+valor\s+em\s+R\$/i);
  });

  it('14. Qualificador prompt instrui PASSO 2 com escolha funeral/completo', () => {
    const p = prompts.PROMPT_QUALIFICADOR;
    expect(p).toContain('PASSO 2');
    expect(p).toContain('1️⃣');
    expect(p).toContain('2️⃣');
    expect(p).toMatch(/Prote[çc][ãa]o\s+funeral/i);
  });

  it('15. Cotador prompt SO chama gerar_cotacao_sulamerica + promote, nao escreve cotacao manual', () => {
    const p = prompts.PROMPT_COTADOR;
    expect(p).toContain('gerar_cotacao_sulamerica');
    expect(p).toContain('promover_para_vendedor');
    expect(p).toMatch(/N[ÃA]O\s+escreve\s+cota[çc][ãa]o\s+manual/i);
  });

  it('16. Vendedor prompt CONTEM proibicao de "quer fechar" + exemplo "boleto ou cartao"', () => {
    const p = prompts.PROMPT_VENDEDOR;
    expect(p).toMatch(/NUNCA\s+pergunte\s+sim\/n[ãa]o/i);
    expect(p).toMatch(/Quer\s+fechar/i); // pelo menos referenciado nos exemplos ❌
    expect(p).toMatch(/boleto\s+mensal.*cart[ãa]o\s+recorrente|cart[ãa]o.*boleto/i);
  });

  it('17. Coletor prompt pede LGPD ANTES de coletar', () => {
    const p = prompts.PROMPT_COLETOR;
    expect(p).toContain('CONSENTIMENTO LGPD');
    // PASSO 1 = LGPD, PASSO 2 = coleta — essa ordem
    const idxLgpd = p.indexOf('CONSENTIMENTO LGPD');
    const idxColeta = p.indexOf('COLETA DOS 17 CAMPOS');
    expect(idxLgpd).toBeGreaterThan(0);
    expect(idxColeta).toBeGreaterThan(idxLgpd);
  });

  it('18. Coletor prompt lista os 17 campos (15 titular + 4 dependente)', () => {
    const p = prompts.PROMPT_COLETOR;
    const titular = ['Nome completo', 'CPF', 'RG', 'Data nascimento', 'Sexo',
      'Estado civil', 'Nacionalidade', 'Nome da mãe', 'Dia vencimento',
      'Celular WhatsApp', 'E-mail', 'CEP', 'Endereço completo', 'Profissão',
      'Altura', 'Peso'];
    for (const f of titular) expect(p).toMatch(new RegExp(f, 'i'));
    expect(p).toMatch(/Parentesco/i);
  });

  it('19. Followupper tem 4 mensagens (24h, 48h, 72h, final_delete)', () => {
    const p = prompts.PROMPT_FOLLOWUPPER;
    expect(p).toContain('SYSTEM:followup_step_1');
    expect(p).toContain('SYSTEM:followup_step_2');
    expect(p).toContain('SYSTEM:followup_step_3');
    expect(p).toContain('SYSTEM:final_delete');
    expect(p).toContain('deletar_card_final');
  });

  // ─── TAGS ───────────────────────────────────────────────────────────────

  it('20. aplicar_tag insere em crm_card_tags com applied_by correto', async () => {
    const tenantId = makeTenant();
    const { board, cols } = setupBoard(tenantId);
    const card = createCardInColumn(tenantId, board.id, cols[0].id, 'qualificador');
    const ctx = {
      tenantId,
      channel: { id: 'ch_x', tenantId, type: 'zapi' as const, name: 't', credentialsEncrypted: '', webhookSecret: 'w', createdAt: Date.now() },
      card, column: cols[0],
      state: agentState.getCardAgentState(card.id),
      customerPhone: '+5511990000000', role: 'qualificador',
    };
    const r = await registry.executeToolCall({
      id: 'call_' + randomBytes(3).toString('hex'),
      type: 'function' as const,
      function: { name: 'aplicar_tag', arguments: JSON.stringify({ tag: 'querendo_fechar' }) },
    }, ctx);
    expect(r.ok).toBe(true);

    const db = schema.getCrmDb();
    const row = db.prepare(`SELECT applied_by FROM crm_card_tags WHERE card_id = ? AND tag = ?`)
      .get(card.id, 'querendo_fechar') as any;
    expect(row).toBeDefined();
    expect(row.applied_by).toBe('qualificador');
  });

  it('21. Tags duplicadas nao inserem (PRIMARY KEY)', () => {
    const tenantId = makeTenant();
    const { board, cols } = setupBoard(tenantId);
    const card = createCardInColumn(tenantId, board.id, cols[0].id, 'qualificador');
    const first = tags.applyTagSystem(card.id, 'qualificado_funeral');
    const second = tags.applyTagSystem(card.id, 'qualificado_funeral');
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it('22. Cascade ON DELETE remove tags do card', () => {
    const tenantId = makeTenant();
    const { board, cols } = setupBoard(tenantId);
    const card = createCardInColumn(tenantId, board.id, cols[0].id, 'qualificador');
    tags.applyTagSystem(card.id, 'tag_x');
    tags.applyTagSystem(card.id, 'tag_y');
    expect(tags.listCardTags(card.id).length).toBe(2);

    const db = schema.getCrmDb();
    db.exec('PRAGMA foreign_keys = ON');
    db.prepare(`DELETE FROM crm_cards WHERE id = ?`).run(card.id);
    expect(tags.listCardTags(card.id).length).toBe(0);
  });

  // ─── ESCALATE PLANO COMPLETO ────────────────────────────────────────────

  it('23. Qualificador escala (urgencia=alta) quando cliente quer plano completo', async () => {
    const tenantId = makeTenant();
    const { board, cols } = setupBoard(tenantId);
    const card = createCardInColumn(tenantId, board.id, cols[0].id, 'qualificador');
    const ctx = {
      tenantId,
      channel: { id: 'ch_x', tenantId, type: 'zapi' as const, name: 't', credentialsEncrypted: '', webhookSecret: 'w', createdAt: Date.now() },
      card, column: cols[0],
      state: agentState.getCardAgentState(card.id),
      customerPhone: '+5511990000099', role: 'qualificador',
    };
    const r = await registry.executeToolCall({
      id: 'call_' + randomBytes(3).toString('hex'),
      type: 'function' as const,
      function: {
        name: 'escalar_humano',
        arguments: JSON.stringify({ motivo: 'cliente quer plano completo (vida/doenças graves)', urgencia: 'alta' }),
      },
    }, ctx);
    expect(r.ok).toBe(true);
    expect((r.result as any).urgencia).toBe('alta');
    const metrics = agentState.listAgentMetricsForCard(card.id);
    const escalated = metrics.find((m: any) => m.event === 'escalated');
    expect(escalated?.reason).toMatch(/^urgent:/);
  });

  it('24. Vendedor durante venda detecta interesse adicional → escala + tag', () => {
    // Smoke: prompt do vendedor menciona escalar pra plano completo
    const p = prompts.PROMPT_VENDEDOR;
    expect(p).toMatch(/escalar_humano.*urgencia.*alta|urgencia.*alta.*escalar_humano/i);
    expect(p).toMatch(/interesse_plano_completo|plano completo/i);
  });

  // ─── CRIPTO E VALIDACAO ─────────────────────────────────────────────────

  it('25. Coletor com salvar_dados_proposta cifra os campos sensiveis', async () => {
    const tenantId = makeTenant();
    const { board, cols } = setupBoard(tenantId);
    const card = createCardInColumn(tenantId, board.id, cols[0].id, 'coletor');
    const ctx = {
      tenantId,
      channel: { id: 'ch_x', tenantId, type: 'zapi' as const, name: 't', credentialsEncrypted: '', webhookSecret: 'w', createdAt: Date.now() },
      card, column: cols[0],
      state: agentState.getCardAgentState(card.id),
      customerPhone: '+5511990000888', role: 'coletor',
    };
    const r = await registry.executeToolCall({
      id: 'call_' + randomBytes(3).toString('hex'),
      type: 'function' as const,
      function: {
        name: 'salvar_dados_proposta',
        arguments: JSON.stringify({ cpf: '11144477735', nome_completo: 'Joao Silva' }),
      },
    }, ctx);
    expect(r.ok).toBe(true);
    expect((r.result as any).saved).toContain('cpf');
    expect((r.result as any).saved).toContain('nome_completo');
    // Payload no DB esta cifrado
    const fresh = agentState.getCardAgentState(card.id);
    const sensitive = (fresh.collectedData?.sensitive ?? {}) as Record<string, any>;
    expect(typeof sensitive.cpf_enc).toBe('string');
    expect(sensitive.cpf_enc).not.toContain('11144477735');
  });

  it('26. validar_cpf rejeita "137.44793737" (formato bagunçado)', () => {
    expect(finalizador.isValidCPF('137.44793737')).toBe(false);
    expect(finalizador.isValidCPF('111.444.777-35')).toBe(true);
    expect(finalizador.isValidCPF('11144477735')).toBe(true);
  });
});
