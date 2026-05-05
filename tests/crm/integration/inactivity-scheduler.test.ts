/**
 * Inactivity scheduler integration tests (Onda 62, PR 4).
 *
 * Cobre:
 *  1. Timer dispara apos X min de inatividade
 *  2. Cliente respondendo antes RESETA timer (e zera fire_count)
 *  3. Card status='paused' nao dispara
 *  4. Disparo fora de horario posterga pra proximo dia
 *  5. 2 ticks simultaneos: so 1 processa o disparo (cluster lock)
 *  6. fire_count >= 3 forca marcar_morno SEM chamar LLM
 *  7. Reset atomico: nova msg do cliente nao perde turno se timer dispara
 *     na mesma janela
 *  8. Card sem agente ativo na coluna NAO eh elegivel
 *
 * Mock do LLM via vi.mock pro tool runner — runFromInactivityFire so eh
 * coberto end-to-end nos tests 1, 2, 5; os outros usam SQL/state direto.
 */
import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import { randomBytes } from 'crypto';

const TEST_DB_PATH = '/tmp/clow-pr4-' + randomBytes(6).toString('hex') + '.db';
process.env.CRM_DB_PATH = TEST_DB_PATH;

// Mocks pra LLM e sendReply (runFromInactivityFire chama callDeepSeekWithTools)
const mockLLM = vi.fn();
const mockSendReply = vi.fn();
vi.mock('../../../src/crm/ai/agent.js', async () => {
  const actual = await vi.importActual<any>('../../../src/crm/ai/agent.js');
  return {
    ...actual,
    callDeepSeekWithTools: mockLLM,
    sendReply: mockSendReply,
  };
});

describe('Inactivity Scheduler — integration', () => {
  let schema: any, store: any, agentState: any, sched: any;

  beforeAll(async () => {
    schema = await import('../../../src/crm/schema.js');
    store = await import('../../../src/crm/store.js');
    agentState = await import('../../../src/crm/store/cardAgentStateStore.js');
    sched = await import('../../../src/crm/agents/inactivityScheduler.js');
    schema.getCrmDb();
  });

  afterAll(() => {
    try { require('fs').unlinkSync(TEST_DB_PATH); } catch { /* ignore */ }
  });

  beforeEach(() => {
    mockLLM.mockReset();
    mockSendReply.mockReset();
    // Isolation: zera timers/states de outros tests, senao findEligibleCards
    // captura cards "leftover" e quebra os asserts (especialmente o test 5
    // de cluster lock).
    const db = schema.getCrmDb();
    db.exec('DELETE FROM crm_card_agent_state');
    db.exec(`DELETE FROM crm_agent_metrics`);
  });

  // ── helpers ──────────────────────────────────────────────────────────

  function makeTenant() { return 'tT4-' + randomBytes(4).toString('hex'); }

  function setupBoardWithAgent(tenantId: string, opts?: { hoursStart?: string; hoursEnd?: string; timeoutMin?: number }) {
    const board = store.seedDefaultBoards(tenantId);
    const cols = store.listColumns(tenantId, board.id);
    const target = cols[0];
    const db = schema.getCrmDb();
    db.prepare(`
      UPDATE crm_columns SET
        agent_enabled = 1,
        agent_system_prompt = 'voce e {{persona_name}}',
        agent_role = 'qualificador',
        agent_promote_to_column_id = ?,
        agent_active_hours_start = ?,
        agent_active_hours_end = ?,
        agent_inactivity_timeout_minutes = ?
      WHERE id = ?
    `).run(
      cols[1].id,
      opts?.hoursStart ?? '00:00',
      opts?.hoursEnd ?? '23:59',
      opts?.timeoutMin ?? 20,
      target.id,
    );
    return { board, column: store.listColumns(tenantId, board.id).find((c: any) => c.id === target.id) };
  }

  function setupCardWithChannel(tenantId: string, board: any, columnId: string, phone: string) {
    const contact = store.createContact(tenantId, { name: 'C', phone, source: 'test' });
    const card = store.createCard(tenantId, {
      boardId: board.id, columnId, title: 'C', contactId: contact.id,
    });
    // Cria um channel "active" pro inactivityScheduler.pickChannelForCard achar.
    // credentialsEncrypted='' eh aceito (NOT NULL satisfeito) — sendReply esta
    // mockado no top do arquivo, nada eh decifrado nesses tests.
    const ch = store.createChannel(tenantId, {
      type: 'zapi', name: 'TestCh',
      credentialsEncrypted: '',
      status: 'active',
    });
    return { contact, card, channel: ch };
  }

  // ── 1) timer vencido → tick processa (LLM mockado) ───────────────────

  it('1. timer vencido → tickInactivity processa o card e chama LLM', async () => {
    const tenantId = makeTenant();
    const { column, board } = setupBoardWithAgent(tenantId);
    const { card } = setupCardWithChannel(tenantId, board, column.id, '+5511990000401');
    // Arma timer no PASSADO (vencido)
    agentState.upsertCardAgentState({
      cardId: card.id, columnId: column.id, currentAgentRole: 'qualificador',
      tenantId, status: 'active',
      inactivityTimerAt: Date.now() - 60_000,
    });
    mockLLM.mockResolvedValue({ role: 'assistant', content: 'Oi! Tá tudo bem?' });
    mockSendReply.mockResolvedValue(undefined);

    const r = await sched.tickInactivity();
    expect(r.processed).toBe(1);
    expect(mockLLM).toHaveBeenCalledTimes(1);
    expect(mockSendReply).toHaveBeenCalledTimes(1);

    // fire_count incrementou
    const stateAfter = agentState.getCardAgentState(card.id);
    expect(stateAfter.inactivityFireCount).toBe(1);

    // Metric inactive_timeout gravado
    const metrics = agentState.listAgentMetricsForCard(card.id);
    expect(metrics.some((m: any) => m.event === 'inactive_timeout')).toBe(true);
  });

  // ── 2) reset atomico em recordAgentTurn('client') ───────────────────

  it('2. recordAgentTurn(client) reseta inactivityTimerAt + zera fireCount', () => {
    const tenantId = makeTenant();
    const { column, board } = setupBoardWithAgent(tenantId, { timeoutMin: 5 });
    const { card } = setupCardWithChannel(tenantId, board, column.id, '+5511990000402');
    agentState.upsertCardAgentState({
      cardId: card.id, columnId: column.id, currentAgentRole: 'qualificador',
      tenantId, status: 'active',
      inactivityTimerAt: Date.now() - 60_000, // vencido
      inactivityFireCount: 2,
    });
    const beforeMs = Date.now();
    agentState.recordAgentTurn(card.id, 'client');
    const afterState = agentState.getCardAgentState(card.id);
    // Timer re-armado: aprox now + 5min
    expect(afterState.inactivityTimerAt).toBeGreaterThan(beforeMs + 4 * 60_000);
    expect(afterState.inactivityTimerAt).toBeLessThan(beforeMs + 6 * 60_000);
    // FireCount zerado
    expect(afterState.inactivityFireCount).toBe(0);
  });

  // ── 3) status=paused NAO eh elegivel ─────────────────────────────────

  it('3. card status=paused nao aparece em findEligibleCards', () => {
    const tenantId = makeTenant();
    const { column, board } = setupBoardWithAgent(tenantId);
    const { card } = setupCardWithChannel(tenantId, board, column.id, '+5511990000403');
    agentState.upsertCardAgentState({
      cardId: card.id, columnId: column.id, currentAgentRole: 'qualificador',
      tenantId, status: 'paused',
      inactivityTimerAt: Date.now() - 60_000, // vencido
    });
    const eligible = sched.findEligibleCards();
    expect(eligible.some((e: any) => e.card_id === card.id)).toBe(false);
  });

  // ── 4) fora de horario → posterga pra amanha ─────────────────────────

  it('4. fora de horario → tick posterga timer pra proximo dia (sem chamar LLM)', async () => {
    const tenantId = makeTenant();
    const now = await import('../../../src/crm/agents/columnAgentRunner.js')
      .then((m) => m.getCurrentHourMinuteBRT());
    // Janela DEPOIS do "agora" (sempre fora)
    const pad = (n: number) => String(n).padStart(2, '0');
    const startH = (now.hour + 4) % 24;
    const endH = (startH + 1) % 24;
    let s = `${pad(startH)}:00`;
    let e = `${pad(endH)}:00`;
    // Se cruzar meia-noite, pega janela antes do agora
    if (startH > endH) {
      s = `${pad((now.hour + 22) % 24)}:00`;
      e = `${pad((now.hour + 23) % 24)}:00`;
    }
    const { column, board } = setupBoardWithAgent(tenantId, { hoursStart: s, hoursEnd: e });
    const { card } = setupCardWithChannel(tenantId, board, column.id, '+5511990000404');
    agentState.upsertCardAgentState({
      cardId: card.id, columnId: column.id, currentAgentRole: 'qualificador',
      tenantId, status: 'active',
      inactivityTimerAt: Date.now() - 60_000,
    });

    const r = await sched.tickInactivity();
    expect(r.processed).toBe(1);
    // LLM NAO foi chamado
    expect(mockLLM).not.toHaveBeenCalled();
    // Timer postpondo pro futuro
    const stateAfter = agentState.getCardAgentState(card.id);
    expect(stateAfter.inactivityTimerAt).toBeGreaterThan(Date.now());
    // fireCount NAO incrementou (o postpone nao conta como disparo)
    expect(stateAfter.inactivityFireCount).toBe(0);
  });

  // ── 5) cluster lock: 2 ticks paralelos → so 1 processa ──────────────

  it('5. 2 chamadas paralelas a tickInactivity → so 1 processa o card', async () => {
    const tenantId = makeTenant();
    const { column, board } = setupBoardWithAgent(tenantId);
    const { card } = setupCardWithChannel(tenantId, board, column.id, '+5511990000405');
    agentState.upsertCardAgentState({
      cardId: card.id, columnId: column.id, currentAgentRole: 'qualificador',
      tenantId, status: 'active',
      inactivityTimerAt: Date.now() - 60_000,
    });
    mockLLM.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 80)); // simula latencia
      return { role: 'assistant', content: 'oi' };
    });
    mockSendReply.mockResolvedValue(undefined);

    const [r1, r2] = await Promise.all([sched.tickInactivity(), sched.tickInactivity()]);
    const totalProcessed = r1.processed + r2.processed;
    const totalSkipped = r1.skipped + r2.skipped;
    expect(totalProcessed).toBe(1);
    expect(totalSkipped).toBe(1);
    expect(mockLLM).toHaveBeenCalledTimes(1);
  });

  // ── 6) fire_count >=3 → forced morno SEM LLM ─────────────────────────

  it('6. inactivityFireCount=2 + dispara → forca morno (3o), sem chamar LLM', async () => {
    const tenantId = makeTenant();
    const { column, board } = setupBoardWithAgent(tenantId);
    const { card, contact } = setupCardWithChannel(tenantId, board, column.id, '+5511990000406');
    agentState.upsertCardAgentState({
      cardId: card.id, columnId: column.id, currentAgentRole: 'qualificador',
      tenantId, status: 'active',
      inactivityTimerAt: Date.now() - 60_000,
      inactivityFireCount: 2, // proximo disparo eh o 3o
    });

    const r = await sched.tickInactivity();
    expect(r.processed).toBe(1);
    expect(mockLLM).not.toHaveBeenCalled(); // forced morno SEM LLM

    // status virou 'paused', tag morno no contato
    const stateAfter = agentState.getCardAgentState(card.id);
    expect(stateAfter.status).toBe('paused');
    expect(stateAfter.inactivityFireCount).toBe(0); // resetado pra D+2
    const contactAfter = store.getContact(tenantId, contact.id);
    expect(contactAfter.tags).toContain('morno');

    // Metric forced_morno
    const metrics = agentState.listAgentMetricsForCard(card.id);
    expect(metrics.some((m: any) => m.event === 'inactive_timeout' && /forced_morno/.test(m.reason))).toBe(true);
  });

  // ── 7) reset atomico inclui timer arming ─────────────────────────────

  it('7. reset atomico em recordAgentTurn(client) — timer + turns_count + fireCount na mesma UPDATE', () => {
    const tenantId = makeTenant();
    const { column, board } = setupBoardWithAgent(tenantId, { timeoutMin: 7 });
    const { card } = setupCardWithChannel(tenantId, board, column.id, '+5511990000407');
    agentState.upsertCardAgentState({
      cardId: card.id, columnId: column.id, currentAgentRole: 'qualificador',
      tenantId, status: 'active',
      inactivityTimerAt: Date.now() - 60_000,
      inactivityFireCount: 1,
      turnsCount: 5,
    });

    const beforeTs = Date.now();
    agentState.recordAgentTurn(card.id, 'client');
    const after = agentState.getCardAgentState(card.id);
    expect(after.turnsCount).toBe(6); // incrementou
    expect(after.inactivityFireCount).toBe(0);
    expect(after.inactivityTimerAt).toBeGreaterThanOrEqual(beforeTs + 6 * 60_000);
    expect(after.inactivityTimerAt).toBeLessThanOrEqual(beforeTs + 8 * 60_000);
    expect(after.lastClientMessageAt).toBeGreaterThanOrEqual(beforeTs);
  });

  // ── 8) coluna sem agent_enabled NAO eh elegivel ─────────────────────

  it('8. card em coluna com agent_enabled=0 nao aparece em findEligibleCards', () => {
    const tenantId = makeTenant();
    const board = store.seedDefaultBoards(tenantId);
    const cols = store.listColumns(tenantId, board.id);
    // Coluna SEM agente ativo
    const target = cols[0];
    const { card } = setupCardWithChannel(tenantId, board, target.id, '+5511990000408');
    agentState.upsertCardAgentState({
      cardId: card.id, columnId: target.id, currentAgentRole: 'qualificador',
      tenantId, status: 'active',
      inactivityTimerAt: Date.now() - 60_000,
    });
    // Coluna NAO tem agent_enabled=1 → nao deve aparecer
    const eligible = sched.findEligibleCards();
    expect(eligible.some((e: any) => e.card_id === card.id)).toBe(false);
  });
});
