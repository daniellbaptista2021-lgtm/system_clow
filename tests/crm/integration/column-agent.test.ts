/**
 * Column-agent integration tests (Onda 62, PR 2).
 *
 * Cobre os 5 cenarios:
 *  1. card em coluna sem agente → cai no fallback de canal
 *  2. card em coluna com agente → executa column agent
 *  3. card em coluna com agente mas fora de horario → manda msg padrao
 *  4. turns_count >= max → marca stuck, sem LLM
 *  5. 2 workers simultaneos processando mesma msg → so 1 executa (lock)
 *
 * Mock do LLM e do envio via vi.mock no modulo ai/agent.js — preserva
 * o resto das funcoes (loadRecentHistory, etc) e overrida so callDeepSeek
 * e sendReply.
 */
import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import { randomBytes } from 'crypto';

const TEST_DB_PATH = '/tmp/clow-col-agent-test-' + randomBytes(6).toString('hex') + '.db';
process.env.CRM_DB_PATH = TEST_DB_PATH;

// Mocks: callDeepSeekWithTools (PR 3) e sendReply. Substitui ANTES de qualquer import.
// PR 3 trocou callDeepSeek -> callDeepSeekWithTools (function calling) — esses mocks
// retornam um DeepSeekToolMessage (sem tool_calls = resposta texto final).
const mockCallDeepSeek = vi.fn();
const mockSendReply = vi.fn();

vi.mock('../../../src/crm/ai/agent.js', async () => {
  const actual = await vi.importActual<any>('../../../src/crm/ai/agent.js');
  return {
    ...actual,
    callDeepSeekWithTools: mockCallDeepSeek,
    sendReply: mockSendReply,
  };
});

// Helper: monta uma resposta DeepSeek "texto final, sem tool_calls"
function llmTextReply(text: string) {
  return { role: 'assistant' as const, content: text };
}

describe('Column Agent — integration', () => {
  let schema: any, store: any, runner: any, selector: any, agentState: any;

  beforeAll(async () => {
    schema = await import('../../../src/crm/schema.js');
    store = await import('../../../src/crm/store.js');
    runner = await import('../../../src/crm/agents/columnAgentRunner.js');
    selector = await import('../../../src/crm/agents/columnAgentSelector.js');
    agentState = await import('../../../src/crm/store/cardAgentStateStore.js');
    schema.getCrmDb();
  });

  afterAll(() => {
    try { require('fs').unlinkSync(TEST_DB_PATH); } catch { /* ignore */ }
  });

  beforeEach(() => {
    mockCallDeepSeek.mockReset();
    mockSendReply.mockReset();
  });

  // ── helpers ─────────────────────────────────────────────────────────

  function makeTenant() {
    return 'test-' + randomBytes(4).toString('hex');
  }

  function makeFakeChannel(tenantId: string) {
    // Channel2-like com campos minimos pro runner. credentialsEncrypted
    // fica vazio — sendReply esta mockado, nada eh usado de fato.
    return {
      id: 'ch_' + randomBytes(4).toString('hex'),
      tenantId,
      type: 'zapi' as const,
      name: 'Test Channel',
      credentialsEncrypted: '',
      webhookSecret: 'wh_test',
      createdAt: Date.now(),
    };
  }

  function setupBoardWithAgentColumn(tenantId: string, opts?: {
    agentEnabled?: boolean;
    hoursStart?: string;
    hoursEnd?: string;
    maxTurns?: number;
  }) {
    const board = store.seedDefaultBoards(tenantId);
    const columns = store.listColumns(tenantId, board.id);
    const target = columns[0]; // "Lead novo"
    const db = schema.getCrmDb();
    // Patch direto via SQL — store nao tem updateColumn pros campos novos ainda (PR 6).
    db.prepare(`
      UPDATE crm_columns SET
        agent_enabled = ?,
        agent_system_prompt = ?,
        agent_role = ?,
        agent_active_hours_start = ?,
        agent_active_hours_end = ?,
        agent_max_turns = ?
      WHERE id = ?
    `).run(
      opts?.agentEnabled === false ? 0 : 1,
      'Voce e {{persona_name}} da {{tenant_name}}. Responda concisamente.',
      'qualificador',
      opts?.hoursStart ?? '00:00',
      opts?.hoursEnd ?? '23:59',
      opts?.maxTurns ?? 30,
      target.id,
    );
    return { board, column: store.listColumns(tenantId, board.id).find((c: any) => c.id === target.id) };
  }

  function setupContactAndCard(tenantId: string, boardId: string, columnId: string, phone: string) {
    const contact = store.createContact(tenantId, {
      name: 'Cliente Teste', phone, source: 'test',
    });
    const card = store.createCard(tenantId, {
      boardId, columnId, title: contact.name, contactId: contact.id,
    });
    return { contact, card };
  }

  // ── 1) coluna sem agente → fallback canal ───────────────────────────

  it('1. card em coluna SEM agente ativo → pickAgent cai no fallback de canal (ou none)', () => {
    const tenantId = makeTenant();
    const { column } = setupBoardWithAgentColumn(tenantId, { agentEnabled: false });
    const { card } = setupContactAndCard(tenantId, column.boardId, column.id, '+5511990000001');
    const channel = makeFakeChannel(tenantId);

    const pick = selector.pickAgent({ channel, customerPhone: '+5511990000001' });
    // Sem channel agent ativo (channel não tem ai_enabled), retorna 'none'.
    // Importante: NAO retorna 'column' — coluna sem agente nao captura.
    expect(pick.type).toBe('none');
    expect(pick.reason).toBe('no_agent_configured');

    void card;
  });

  // ── 2) coluna com agente → executa ─────────────────────────────────

  it('2. card em coluna COM agente ativo → pickAgent retorna column + runColumnAgent executa', async () => {
    const tenantId = makeTenant();
    const { column } = setupBoardWithAgentColumn(tenantId);
    const { card } = setupContactAndCard(tenantId, column.boardId, column.id, '+5511990000002');
    const channel = makeFakeChannel(tenantId);

    const pick = selector.pickAgent({ channel, customerPhone: '+5511990000002' });
    expect(pick.type).toBe('column');
    if (pick.type !== 'column') return;
    expect(pick.column.id).toBe(column.id);
    expect(pick.card.id).toBe(card.id);

    mockCallDeepSeek.mockResolvedValue(llmTextReply('Olá! Sou a Safira, posso te ajudar?'));
    mockSendReply.mockResolvedValue(undefined);

    const result = await runner.runColumnAgent({
      channel, card: pick.card, column: pick.column,
      customerPhone: '+5511990000002',
      text: 'olá, quero plano funeral',
      messageId: 'msg-test-2-' + randomBytes(3).toString('hex'),
    });

    expect(result.status).toBe('executed');
    expect(mockCallDeepSeek).toHaveBeenCalledTimes(1);
    expect(mockSendReply).toHaveBeenCalledTimes(1);

    // System prompt foi renderizado com placeholders substituidos.
    // PR 3 muda assinatura: callDeepSeekWithTools(messages, tools, model)
    // — system prompt eh messages[0].content
    const [messages] = mockCallDeepSeek.mock.calls[0];
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('Safira');
    expect(messages[0].content).not.toContain('{{persona_name}}');

    // Estado persistido
    const state = agentState.getCardAgentState(card.id);
    expect(state).toBeTruthy();
    expect(state.status).toBe('active');
    expect(state.turnsCount).toBe(1);
    expect(state.currentAgentRole).toBe('qualificador');

    // Metric "executed" gravado
    const metrics = agentState.listAgentMetricsForCard(card.id);
    expect(metrics.some((m: any) => m.event === 'executed')).toBe(true);
  });

  // ── 3) fora de horario → mensagem padrao, sem LLM ──────────────────

  it('3. fora de horario → manda mensagem padrao SEM chamar LLM', async () => {
    const tenantId = makeTenant();
    // Janela de 1h DOIS dias no futuro (sempre fora de horario)
    // — usamos hora distante de "agora" pra ter certeza
    const now = runner.getCurrentHourMinuteBRT();
    // Janela 4h adiante (sempre fora do "agora"), evita cruzamento de meia-noite
    const startH = (now.hour + 4) % 24;
    const endH = (startH + 1) % 24;
    const pad = (n: number) => String(n).padStart(2, '0');
    const hoursStart = `${pad(startH)}:00`;
    const hoursEnd = `${pad(endH)}:00`;

    // Se a janela cruzar meia-noite (start > end no mesmo dia), ajusta pra
    // 4h ANTES (que tambem esta fora). Mantem teste deterministico.
    const finalStart = startH > endH ? `${pad((now.hour + 22) % 24)}:00` : hoursStart;
    const finalEnd = startH > endH ? `${pad((now.hour + 23) % 24)}:00` : hoursEnd;

    const { column } = setupBoardWithAgentColumn(tenantId, {
      hoursStart: finalStart, hoursEnd: finalEnd,
    });
    const { card } = setupContactAndCard(tenantId, column.boardId, column.id, '+5511990000003');
    const channel = makeFakeChannel(tenantId);

    mockSendReply.mockResolvedValue(undefined);

    const result = await runner.runColumnAgent({
      channel, card, column,
      customerPhone: '+5511990000003',
      text: 'oi',
      messageId: 'msg-test-3-' + randomBytes(3).toString('hex'),
    });

    expect(result.status).toBe('blocked');
    if (result.status === 'blocked') {
      expect(result.reason).toBe('out_of_hours');
    }
    expect(mockCallDeepSeek).not.toHaveBeenCalled();
    expect(mockSendReply).toHaveBeenCalledTimes(1);
    // Mensagem padrao com horario de inicio
    const [, , text] = mockSendReply.mock.calls[0];
    expect(text).toContain(finalStart);
    expect(text).toContain('Recebi sua mensagem');

    // Metric blocked/out_of_hours gravado
    const metrics = agentState.listAgentMetricsForCard(card.id);
    const blocked = metrics.find((m: any) => m.event === 'blocked');
    expect(blocked?.reason).toBe('out_of_hours');
  });

  // ── 4) max_turns atingido → stuck, sem LLM ─────────────────────────

  it('4. turns_count >= max_turns → status=stuck, sem chamar LLM', async () => {
    const tenantId = makeTenant();
    const { column } = setupBoardWithAgentColumn(tenantId, { maxTurns: 3 });
    const { card } = setupContactAndCard(tenantId, column.boardId, column.id, '+5511990000004');
    const channel = makeFakeChannel(tenantId);

    // Pre-popula state com turnsCount = 3 (igual ao limite)
    agentState.upsertCardAgentState({
      cardId: card.id, columnId: column.id, currentAgentRole: 'qualificador',
      tenantId, turnsCount: 3,
    });

    const result = await runner.runColumnAgent({
      channel, card, column,
      customerPhone: '+5511990000004',
      text: 'oi',
      messageId: 'msg-test-4-' + randomBytes(3).toString('hex'),
    });

    expect(result.status).toBe('blocked');
    if (result.status === 'blocked') {
      expect(result.reason).toBe('max_turns');
    }
    expect(mockCallDeepSeek).not.toHaveBeenCalled();

    // status virou 'stuck'
    const state = agentState.getCardAgentState(card.id);
    expect(state?.status).toBe('stuck');

    // Metric blocked/max_turns gravado
    const metrics = agentState.listAgentMetricsForCard(card.id);
    const blocked = metrics.find((m: any) => m.event === 'blocked');
    expect(blocked?.reason).toBe('max_turns');
  });

  // ── 5) cluster lock → 2 chamadas paralelas, so 1 executa ──────────

  it('5. cluster lock impede 2 workers de processar mesma msg em paralelo', async () => {
    const tenantId = makeTenant();
    const { column } = setupBoardWithAgentColumn(tenantId);
    const { card } = setupContactAndCard(tenantId, column.boardId, column.id, '+5511990000005');
    const channel = makeFakeChannel(tenantId);

    // LLM atrasa 60ms pra dar tempo do segundo runner tentar adquirir lock
    mockCallDeepSeek.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 60));
      return llmTextReply('resposta concorrente');
    });
    mockSendReply.mockResolvedValue(undefined);

    const messageId = 'msg-test-5-shared-' + randomBytes(3).toString('hex');
    const inputs = {
      channel, card, column,
      customerPhone: '+5511990000005',
      text: 'oi',
      messageId,
    };

    const [r1, r2] = await Promise.all([
      runner.runColumnAgent(inputs),
      runner.runColumnAgent(inputs),
    ]);

    // Um executou, o outro foi locked_out
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual(['executed', 'locked_out']);

    // LLM so foi chamado 1x
    expect(mockCallDeepSeek).toHaveBeenCalledTimes(1);
    expect(mockSendReply).toHaveBeenCalledTimes(1);

    // Metric locked_out gravado
    const metrics = agentState.listAgentMetricsForCard(card.id);
    expect(metrics.some((m: any) => m.event === 'locked_out')).toBe(true);
    expect(metrics.some((m: any) => m.event === 'executed')).toBe(true);
  });

  // ── extra: anti-loop ────────────────────────────────────────────────

  it('extra. anti-loop: resposta identica a anterior eh bloqueada', async () => {
    const tenantId = makeTenant();
    const { column } = setupBoardWithAgentColumn(tenantId);
    const { contact, card } = setupContactAndCard(tenantId, column.boardId, column.id, '+5511990000006');
    const channel = makeFakeChannel(tenantId);

    // Pre-grava 1 message_in + 1 message_out (assistant) com texto X
    const X = 'Olá! Eu sou a Safira, posso te ajudar?';
    store.logActivity(tenantId, {
      cardId: card.id, contactId: contact.id, type: 'message_in',
      channel: 'whatsapp_zapi', direction: 'in', content: 'oi',
      providerMessageId: 'in-1',
    });
    store.logActivity(tenantId, {
      cardId: card.id, contactId: contact.id, type: 'message_out',
      channel: 'whatsapp_zapi', direction: 'out', content: X,
      providerMessageId: 'out-1',
    });

    // LLM tenta responder a mesma coisa de novo
    mockCallDeepSeek.mockResolvedValue(llmTextReply(X));
    mockSendReply.mockResolvedValue(undefined);

    const result = await runner.runColumnAgent({
      channel, card, column,
      customerPhone: '+5511990000006',
      text: 'tudo bem?',
      messageId: 'msg-test-extra-' + randomBytes(3).toString('hex'),
    });

    expect(result.status).toBe('blocked');
    if (result.status === 'blocked') {
      expect(result.reason).toBe('anti_loop');
    }
    // sendReply NAO foi chamado pra a resposta duplicada
    expect(mockSendReply).not.toHaveBeenCalled();
  });
});
