/**
 * Column-agent TOOLS integration tests (Onda 62, PR 3).
 *
 * Cobre os 8 cenarios:
 *  1. Qualificador chama salvar_dados_qualificacao + promover_qualificado
 *     → card move pra coluna correta, collected_data persiste, role muda
 *  2. Cotador chama gerar_cotacao (mock) + promover_vendedor com tag 'frio'
 *  3. Closer chama promover_fechamento sem destino configurado → erro
 *  4. Finalizador chama validar_cpf invalido (digito errado) → false
 *  5. Finalizador chama promover_pendente_daniel → outbound webhook
 *     'card.ready_for_human' eh disparado
 *  6. Permissao: qualificador tentando chamar gerar_cotacao → erro
 *  7. Idempotencia: 2 calls de promover_qualificado → 2a eh no-op
 *  8. Sensibilidade: salvar_dados_proposta cifra; query bruta no banco
 *     mostra cifra, nao texto claro
 *  9. Tool ler_dados_card retorna mascarado por default; unmask=true so
 *     pra finalizador
 *
 * Testa as tools DIRETAMENTE (executeToolCall) sem precisar passar pelo
 * LLM real. Validacoes de payload + side effects em DB + outbound webhooks.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomBytes } from 'crypto';

const TEST_DB_PATH = '/tmp/clow-pr3-' + randomBytes(6).toString('hex') + '.db';
process.env.CRM_DB_PATH = TEST_DB_PATH;
// Necessario pro encryptPII
process.env.CLOW_PII_KEY = 'pr3-test-key-with-min-16-chars-aaaa';

describe('Column Agent Tools — integration', () => {
  let schema: any, store: any, agentState: any, registry: any, outbound: any;

  beforeAll(async () => {
    schema = await import('../../../src/crm/schema.js');
    store = await import('../../../src/crm/store.js');
    agentState = await import('../../../src/crm/store/cardAgentStateStore.js');
    registry = await import('../../../src/crm/agents/tools/registry.js');
    outbound = await import('../../../src/crm/outboundWebhooks.js');
    schema.getCrmDb();
  });

  afterAll(() => {
    try { require('fs').unlinkSync(TEST_DB_PATH); } catch { /* ignore */ }
  });

  // ── helpers ──────────────────────────────────────────────────────────

  function makeTenant() { return 'tT-' + randomBytes(4).toString('hex'); }

  function makeFakeChannel(tenantId: string) {
    return {
      id: 'ch_' + randomBytes(4).toString('hex'),
      tenantId, type: 'zapi' as const, name: 'Test',
      credentialsEncrypted: '', webhookSecret: 'wh',
      createdAt: Date.now(),
    };
  }

  function setupBoardFunnel(tenantId: string) {
    // Cria board com 4 colunas conectadas A → B → C → D
    const board = store.seedDefaultBoards(tenantId);
    const cols = store.listColumns(tenantId, board.id);
    const db = schema.getCrmDb();

    // Configura agentes em cada coluna em sequencia (col 0..3)
    const promotePairs = [
      [cols[0].id, cols[1].id, 'qualificador'],
      [cols[1].id, cols[2].id, 'cotador'],
      [cols[2].id, cols[3].id, 'closer'],
      [cols[3].id, null, 'finalizador'], // ultima nao tem destino (default)
    ] as const;
    for (const [sourceId, destId, role] of promotePairs) {
      db.prepare(`
        UPDATE crm_columns SET
          agent_enabled = 1,
          agent_system_prompt = 'voce e {{persona_name}}',
          agent_role = ?,
          agent_promote_to_column_id = ?,
          agent_active_hours_start = '00:00',
          agent_active_hours_end = '23:59'
        WHERE id = ?
      `).run(role, destId, sourceId);
    }
    return { board, cols: store.listColumns(tenantId, board.id) };
  }

  function setupCard(tenantId: string, board: any, columnId: string, phone: string) {
    const contact = store.createContact(tenantId, {
      name: 'Cliente Teste', phone, source: 'test',
    });
    const card = store.createCard(tenantId, {
      boardId: board.id, columnId, title: contact.name, contactId: contact.id,
    });
    return { contact, card };
  }

  function buildCtx(tenantId: string, channel: any, card: any, column: any, role: any) {
    const state = agentState.upsertCardAgentState({
      cardId: card.id, columnId: column.id, currentAgentRole: role,
      tenantId, status: 'active',
    });
    return {
      tenantId, channel, card, column, state,
      customerPhone: '+5511990000000', role,
    };
  }

  function callTool(name: string, args: any) {
    return {
      id: 'call_' + randomBytes(3).toString('hex'),
      type: 'function' as const,
      function: { name, arguments: JSON.stringify(args) },
    };
  }

  // ── 1) qualificador full flow ────────────────────────────────────────

  it('1. qualificador salva dados + promove → card move + role atualizado', async () => {
    const tenantId = makeTenant();
    const { board, cols } = setupBoardFunnel(tenantId);
    const { card } = setupCard(tenantId, board, cols[0].id, '+5511990000001');
    const ctx = buildCtx(tenantId, makeFakeChannel(tenantId), card, cols[0], 'qualificador');

    // 1.a) salvar_dados_qualificacao
    const r1 = await registry.executeToolCall(
      callTool('salvar_dados_qualificacao', {
        nome: 'Joao', idade: 45, tipo_plano: 'funeral',
        composicao_familiar: 'casal + 2 filhos',
      }),
      ctx,
    );
    expect(r1.ok).toBe(true);
    const stateAfterSave = agentState.getCardAgentState(card.id);
    expect((stateAfterSave.collectedData as any).qualification.nome).toBe('Joao');
    expect((stateAfterSave.collectedData as any).qualification.tipo_plano).toBe('funeral');

    // 1.b) promover_qualificado
    const r2 = await registry.executeToolCall(
      callTool('promover_qualificado', { motivo: 'checklist completo' }),
      ctx,
    );
    expect(r2.ok).toBe(true);
    expect((r2.result as any).moved_to.id).toBe(cols[1].id);

    // Card moveu
    const cardAfter = store.getCard(tenantId, card.id);
    expect(cardAfter.columnId).toBe(cols[1].id);

    // State atualizado: role=cotador, columnId=cols[1].id, turnsCount=0
    const stateAfter = agentState.getCardAgentState(card.id);
    expect(stateAfter.columnId).toBe(cols[1].id);
    expect(stateAfter.currentAgentRole).toBe('cotador');
    expect(stateAfter.turnsCount).toBe(0);
    expect(stateAfter.promotionLog?.length).toBe(1);
    expect(stateAfter.promotionLog?.[0].toRole).toBe('cotador');

    // Metric promoted gravado
    const metrics = agentState.listAgentMetricsForCard(card.id);
    expect(metrics.some((m: any) => m.event === 'promoted')).toBe(true);
  });

  // ── 2) cotador full flow (gerar_cotacao real do PR 5 + promover) ────

  it('2. cotador chama gerar_cotacao (real, PR 5) + promover_vendedor com tag frio', async () => {
    const tenantId = makeTenant();
    const { board, cols } = setupBoardFunnel(tenantId);
    // PR 5: gerar_cotacao agora consulta tenant_plans real — precisa cadastrar
    const plansStore = await import('../../../src/crm/store/tenantPlansStore.js');
    plansStore.createPlan({
      tenantId, name: 'Real Pax Essencial Individual',
      productType: 'funeral', basePriceCents: 2990,
      coverageSummary: 'Funeral basico',
      minAge: 0, maxAge: 75, surchargeOutsideRioCents: 800, priority: 10,
    });
    const { card } = setupCard(tenantId, board, cols[1].id, '+5511990000002');
    const ctx = buildCtx(tenantId, makeFakeChannel(tenantId), card, cols[1], 'cotador');

    const cot = await registry.executeToolCall(
      callTool('gerar_cotacao', { product_type: 'funeral', idade: 40, regiao: 'rio' }),
      ctx,
    );
    expect(cot.ok).toBe(true);
    // Shape novo: result.message (texto pronto) + result.plans (lista)
    expect(typeof (cot.result as any).message).toBe('string');
    expect(Array.isArray((cot.result as any).plans)).toBe(true);
    expect((cot.result as any).plans.length).toBeGreaterThan(0);

    const promo = await registry.executeToolCall(
      callTool('promover_vendedor', { motivo: 'cotacao enviada', tag: 'frio' }),
      ctx,
    );
    expect(promo.ok).toBe(true);
    expect((promo.result as any).tag).toBe('frio');

    const stateAfter = agentState.getCardAgentState(card.id);
    expect(stateAfter.currentAgentRole).toBe('closer');

    const metrics = agentState.listAgentMetricsForCard(card.id);
    const promoted = metrics.find((m: any) => m.event === 'promoted');
    expect(promoted?.reason).toContain('tag=frio');
  });

  // ── 3) destino invalido / coluna deletada ────────────────────────────

  it('3. promote_* com coluna destino DELETADA → escala humano automatico', async () => {
    const tenantId = makeTenant();
    const { board, cols } = setupBoardFunnel(tenantId);
    const { card } = setupCard(tenantId, board, cols[0].id, '+5511990000003');

    // Apaga a coluna destino DEPOIS de configurar
    const targetId = cols[1].id;
    const db = schema.getCrmDb();
    db.prepare('DELETE FROM crm_columns WHERE id = ?').run(targetId);

    const ctx = buildCtx(tenantId, makeFakeChannel(tenantId), card, cols[0], 'qualificador');
    const r = await registry.executeToolCall(
      callTool('promover_qualificado', { motivo: 'teste' }),
      ctx,
    );
    expect(r.ok).toBe(false);
    expect((r.error || '')).toContain('target_column_not_found');

    // Card NAO foi movido
    const cardAfter = store.getCard(tenantId, card.id);
    expect(cardAfter.columnId).toBe(cols[0].id);
  });

  // ── 4) validar_cpf ───────────────────────────────────────────────────

  it('4. finalizador valida CPF invalido → tool retorna valid=false', async () => {
    const tenantId = makeTenant();
    const { board, cols } = setupBoardFunnel(tenantId);
    const { card } = setupCard(tenantId, board, cols[3].id, '+5511990000004');
    const ctx = buildCtx(tenantId, makeFakeChannel(tenantId), card, cols[3], 'finalizador');

    const bad = await registry.executeToolCall(
      callTool('validar_cpf', { cpf: '12345678900' }), // digitos invalidos
      ctx,
    );
    expect(bad.ok).toBe(true);
    expect((bad.result as any).valid).toBe(false);

    const good = await registry.executeToolCall(
      callTool('validar_cpf', { cpf: '111.444.777-35' }), // CPF valido conhecido
      ctx,
    );
    expect(good.ok).toBe(true);
    expect((good.result as any).valid).toBe(true);
  });

  // ── 5) promover_pendente_daniel → webhook card.ready_for_human ──────

  it('5. finalizador.promover_pendente_daniel → outbound emit card.ready_for_human', async () => {
    const tenantId = makeTenant();
    const { board, cols } = setupBoardFunnel(tenantId);
    // Configura promote target da coluna finalizador → cria coluna "Pendente Daniel"
    const danielCol = store.createColumn(tenantId, {
      boardId: board.id, name: 'Pendente Daniel', color: '#9B59FC',
    });
    const db = schema.getCrmDb();
    db.prepare('UPDATE crm_columns SET agent_promote_to_column_id = ? WHERE id = ?')
      .run(danielCol.id, cols[3].id);
    // Cria webhook receptor
    outbound.createOutboundWebhook(tenantId, {
      name: 'Test wh', url: 'http://localhost:99999/sink',
      events: ['card.ready_for_human'], enabled: true,
    });
    // Spy no emit pra capturar — sem precisar acertar HTTP
    const spy = vi.spyOn(outbound, 'emit');

    const { card } = setupCard(tenantId, board, cols[3].id, '+5511990000005');
    const refreshedCol = store.listColumns(tenantId, board.id).find((c: any) => c.id === cols[3].id);
    const ctx = buildCtx(tenantId, makeFakeChannel(tenantId), card, refreshedCol, 'finalizador');

    const r = await registry.executeToolCall(
      callTool('promover_pendente_daniel', { motivo: 'dados ok' }),
      ctx,
    );
    expect(r.ok).toBe(true);

    // Confere que emit foi chamado com event correto
    const emitCalls = spy.mock.calls.filter((c) => c[1] === 'card.ready_for_human');
    expect(emitCalls.length).toBeGreaterThan(0);
    const payload = emitCalls[0][2] as any;
    expect(payload.cardId).toBe(card.id);
    expect(payload.movedToColumn?.id).toBe(danielCol.id);
    spy.mockRestore();
  });

  // ── 6) permissao: qualificador tentando gerar_cotacao ────────────────

  it('6. qualificador chamando gerar_cotacao → permission denied', async () => {
    const tenantId = makeTenant();
    const { board, cols } = setupBoardFunnel(tenantId);
    const { card } = setupCard(tenantId, board, cols[0].id, '+5511990000006');
    const ctx = buildCtx(tenantId, makeFakeChannel(tenantId), card, cols[0], 'qualificador');

    const r = await registry.executeToolCall(
      callTool('gerar_cotacao', { idade: 30 }),
      ctx,
    );
    expect(r.ok).toBe(false);
    expect((r.error || '')).toContain('not_allowed_for_role');

    const metrics = agentState.listAgentMetricsForCard(card.id);
    const failed = metrics.find((m: any) => m.event === 'tool_failed');
    expect(failed?.reason).toContain('permission_denied');
  });

  // ── 7) idempotencia ──────────────────────────────────────────────────

  it('7. promover_qualificado 2x → 2a eh no-op (already_promoted)', async () => {
    const tenantId = makeTenant();
    const { board, cols } = setupBoardFunnel(tenantId);
    const { card } = setupCard(tenantId, board, cols[0].id, '+5511990000007');
    const ctx = buildCtx(tenantId, makeFakeChannel(tenantId), card, cols[0], 'qualificador');

    const r1 = await registry.executeToolCall(
      callTool('promover_qualificado', { motivo: 'primeira' }),
      ctx,
    );
    expect(r1.ok).toBe(true);
    expect((r1.result as any).moved_to.id).toBe(cols[1].id);

    // 2a chamada usando MESMO ctx (que ainda aponta pra cols[0])
    const r2 = await registry.executeToolCall(
      callTool('promover_qualificado', { motivo: 'segunda' }),
      ctx,
    );
    expect(r2.ok).toBe(true);
    expect(r2.result).toBe('already_promoted');

    // Card so foi movido 1x
    const stateAfter = agentState.getCardAgentState(card.id);
    expect(stateAfter.promotionLog?.length).toBe(1);
  });

  // ── 8) cripto: dados em salvar_dados_proposta sao cifrados ──────────

  it('8. salvar_dados_proposta cifra; query bruta mostra cifra, nao texto', async () => {
    const tenantId = makeTenant();
    const { board, cols } = setupBoardFunnel(tenantId);
    const { card } = setupCard(tenantId, board, cols[3].id, '+5511990000008');
    const ctx = buildCtx(tenantId, makeFakeChannel(tenantId), card, cols[3], 'finalizador');

    const cpfClaro = '11144477735';
    const r = await registry.executeToolCall(
      callTool('salvar_dados_proposta', {
        cpf: cpfClaro, rg: '12.345.678-9',
        endereco: { cep: '01310100', cidade: 'Sao Paulo', uf: 'SP' },
      }),
      ctx,
    );
    expect(r.ok).toBe(true);

    // Query bruta no banco — collected_data eh JSON string
    const db = schema.getCrmDb();
    const row = db.prepare(`
      SELECT collected_data FROM crm_card_agent_state WHERE card_id = ?
    `).get(card.id) as any;
    const raw = row.collected_data as string;
    expect(raw).toBeTruthy();
    expect(raw).not.toContain(cpfClaro);
    expect(raw).not.toContain('Sao Paulo');
    // Tem o shape sensitive cifrado
    expect(raw).toContain('cpf_enc');
    expect(raw).toContain('endereco_enc');

    // Decrypt funciona pra finalizador via ler_dados_card unmask
    const unmasked = await registry.executeToolCall(
      callTool('ler_dados_card', { unmask: true }),
      ctx,
    );
    expect(unmasked.ok).toBe(true);
    expect((unmasked.result as any).sensitive.cpf).toBe(cpfClaro);
  });

  // ── 9) ler_dados_card mascarado por default ─────────────────────────

  it('9. ler_dados_card mascarado por default; unmask=true so pra finalizador', async () => {
    const tenantId = makeTenant();
    const { board, cols } = setupBoardFunnel(tenantId);
    const { card } = setupCard(tenantId, board, cols[2].id, '+5511990000009');
    // Forca cripto via finalizador primeiro
    const finalCtx = buildCtx(tenantId, makeFakeChannel(tenantId), card, cols[2], 'finalizador');
    await registry.executeToolCall(
      callTool('salvar_dados_proposta', { cpf: '11144477735' }),
      finalCtx,
    );

    // Closer le com unmask=true → DEVE FALHAR
    const closerCtx = buildCtx(tenantId, makeFakeChannel(tenantId), card, cols[2], 'closer');
    const closerUnmask = await registry.executeToolCall(
      callTool('ler_dados_card', { unmask: true }),
      closerCtx,
    );
    expect(closerUnmask.ok).toBe(false);
    expect(closerUnmask.error).toContain('unmask_only_for_finalizador');

    // Closer sem unmask → ok, vem mascarado
    const closerMask = await registry.executeToolCall(
      callTool('ler_dados_card', {}),
      closerCtx,
    );
    expect(closerMask.ok).toBe(true);
    expect((closerMask.result as any).sensitive.cpf).toMatch(/\*\*\*\.\d{3}\.\d{3}-\*\*/);
    expect((closerMask.result as any).sensitive_fields_filled).toContain('cpf_enc');
  });
});
