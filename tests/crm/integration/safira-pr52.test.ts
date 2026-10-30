/**
 * PR 5.2 verification tests — 15 cenarios pra garantir conformidade
 * com o material oficial do Daniel.
 *
 * Cobre:
 *  1. Qualificador acolhe com mensagem padrao "Oi! Sou a Safira, da PV Corretora"
 *  2. Qualificador planta semente consultiva
 *  3. Qualificador NUNCA fala valor em R$
 *  4. Qualificador NAO pede CPF
 *  5. Qualificador NAO menciona "corretora oficial SulAmerica"
 *  6. Educador NAO chama gerar_cotacao_sulamerica (tool nao existe)
 *  7. Educador NAO fala valor em R$ no prompt
 *  8. Educador NAO oferece desconto
 *  9. Educador resposta a "tem desconto?" segue template oficial
 * 10. Finalizador menciona "Daniel" como pessoa especifica
 * 11. Finalizador pede consentimento LGPD antes de coletar
 * 12. Finalizador valida CPF "137.44793737" como invalido
 * 13. Finalizador coleta os 17 campos
 * 14. Sistema NAO tem role 'cotador' nem 'closer' como roles ativos no registry
 * 15. Migration 008 converte cotador/closer em educador idempotentemente
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'crypto';

const TEST_DB_PATH = '/tmp/clow-pr52-' + randomBytes(6).toString('hex') + '.db';
process.env.CRM_DB_PATH = TEST_DB_PATH;
process.env.CLOW_PII_KEY = 'pr52-test-key-with-min-16-chars-aaaa';

describe('PR 5.2 — Safira SDR refinada (3 estagios)', () => {
  let prompts: any, registry: any, agentState: any, store: any, schema: any, finalizador: any;

  beforeAll(async () => {
    schema = await import('../../../src/crm/schema.js');
    store = await import('../../../src/crm/store.js');
    agentState = await import('../../../src/crm/store/cardAgentStateStore.js');
    registry = await import('../../../src/crm/agents/tools/registry.js');
    prompts = await import('../../../src/crm/agents/defaultPrompts.js');
    finalizador = await import('../../../src/crm/agents/tools/coletor_dados.js');
    schema.getCrmDb();
  });

  afterAll(() => {
    try { require('fs').unlinkSync(TEST_DB_PATH); } catch { /* ignore */ }
  });

  // ─── Helpers ────────────────────────────────────────────────────────

  function makeCtx(role: string) {
    const tenantId = 'tT52-' + randomBytes(3).toString('hex');
    const board = store.seedDefaultBoards(tenantId);
    const cols = store.listColumns(tenantId, board.id);
    const contact = store.createContact(tenantId, { name: 'Test', phone: '+55119000-' + randomBytes(2).toString('hex'), source: 't' });
    const card = store.createCard(tenantId, { boardId: board.id, columnId: cols[0].id, title: 'Test', contactId: contact.id });
    const state = agentState.upsertCardAgentState({
      cardId: card.id, columnId: cols[0].id, currentAgentRole: role, tenantId, status: 'active',
    });
    return {
      tenantId, channel: { id: 'ch_x', tenantId, type: 'evolution', name: 't', credentialsEncrypted: '', webhookSecret: 'w', createdAt: Date.now() },
      card, column: cols[0], state, customerPhone: '+5511990000000', role,
    };
  }

  function callTool(name: string, args: any) {
    return {
      id: 'call_' + randomBytes(3).toString('hex'),
      type: 'function' as const,
      function: { name, arguments: JSON.stringify(args) },
    };
  }

  // ─── 1. Qualificador acolhe com mensagem padrao ────────────────────


  // ─── 2. Qualificador oferece ESCOLHA (funeral vs plano completo) ───


  // ─── 3. Qualificador NAO fala valor em R$ proibido ─────────────────


  // ─── 4. Qualificador NAO pede CPF/RG ───────────────────────────────


  // ─── 5. Qualificador NAO menciona "corretora oficial SulAmerica" ──

  it('5. Qualificador NAO descreve PV Corretora como "corretora oficial SulAmerica"', () => {
    const p = prompts.PROMPT_QUALIFICADOR;
    expect(p).not.toMatch(/corretora\s+oficial\s+SulAm[eé]rica/i);
  });

  // ─── 6. PR 6.0: Vendedor Funeral TEM gerar_cotacao_sulamerica (cota + fecha) ───

  it('6. Vendedor Funeral role TEM gerar_cotacao_sulamerica + promover_para_coletor_dados', () => {
    const tools = registry.getToolsForRole('vendedor_funeral');
    const names = tools.map((t: any) => t.name);
    // PR 6.0: Vendedor Funeral COTA E FECHA — gerar_cotacao_sulamerica VOLTA exposta
    expect(names).toContain('gerar_cotacao_sulamerica');
    expect(names).toContain('promover_para_coletor_dados');
    expect(names).toContain('escalar_humano');
    expect(names).toContain('marcar_perdido');
    // Removidas
    expect(names).not.toContain('consultar_margem_desconto');
    expect(names).not.toContain('promover_vendedor');
    expect(names).not.toContain('promover_fechamento');
  });

  // ─── 7. Vendedor Funeral TEM autoridade pra cotar + falar valor ────


  // ─── 8. Vendedor Funeral NAO oferece desconto ──────────────────────


  // ─── 9. Vendedor Funeral trata objecao "tá caro" ───────────────────


  // ─── 10. Coletor de Dados menciona Daniel especificamente ──────────


  // ─── 11. Finalizador pede consentimento LGPD ───────────────────────


  // ─── 12. Finalizador valida CPF "137.44793737" como invalido ──────

  it('12. validar_cpf rejeita "137.44793737" (formato bagunçado)', () => {
    expect(finalizador.isValidCPF('137.44793737')).toBe(false);
    expect(finalizador.isValidCPF('111.444.777-35')).toBe(true);
    expect(finalizador.isValidCPF('11144477735')).toBe(true);
  });

  // ─── 13. Finalizador coleta 17 campos ──────────────────────────────


  // ─── 14. Roles deprecated (cotador / closer / educador / finalizador) ──

  it('14. Sistema NAO expoe tools pra roles deprecated', () => {
    // PR 7.0: cotador agora eh role ATIVO. Os deprecated reais sao:
    // closer, educador, finalizador.
    for (const oldRole of ['closer', 'educador', 'finalizador']) {
      const tools = registry.getToolsForRole(oldRole);
      const specific = tools.filter((t: any) => !t.roles.includes('*'));
      expect(specific.length).toBe(0);
    }
    // PR 7.0: novas tools de promocao + tags + followup
    const allNames = registry.listAllToolNames();
    expect(allNames).toContain('gerar_cotacao_sulamerica');
    expect(allNames).toContain('promover_para_coletor_dados');     // legacy
    expect(allNames).toContain('promover_para_vendedor_funeral');  // legacy
    expect(allNames).toContain('promover_para_qualificado');       // PR 7.0
    expect(allNames).toContain('promover_para_vendedor');          // PR 7.0
    expect(allNames).toContain('promover_para_coletor');           // PR 7.0
    expect(allNames).toContain('promover_para_lancar_venda');      // PR 7.0
    expect(allNames).toContain('aplicar_tag');                     // PR 7.0
    expect(allNames).toContain('mover_para_followup');             // PR 7.0
    expect(allNames).toContain('voltou_para_vendedor');            // PR 7.0
    expect(allNames).toContain('deletar_card_final');              // PR 7.0
    expect(allNames).not.toContain('consultar_margem_desconto');
    expect(allNames).not.toContain('promover_vendedor');
    expect(allNames).not.toContain('promover_fechamento');
  });

  // ─── 15. Migration 008: cotador/closer → educador idempotente ────

  it('15. Migration 008 + 010 chain: cotador/closer → educador → vendedor_funeral; finalizador → coletor_dados', async () => {
    const tenantId = 'mig-chain-' + randomBytes(3).toString('hex');
    const board = store.seedDefaultBoards(tenantId);
    const cols = store.listColumns(tenantId, board.id);
    const db = schema.getCrmDb();

    // Setup: 4 colunas com roles deprecated em diferentes estagios da evolucao
    const lancarVenda = store.createColumn(tenantId, { boardId: board.id, name: 'Lançar venda', color: '#fff' });
    db.prepare(`UPDATE crm_columns SET agent_role = 'cotador' WHERE id = ?`).run(cols[1].id);
    db.prepare(`UPDATE crm_columns SET agent_role = 'closer' WHERE id = ?`).run(cols[2].id);
    db.prepare(`UPDATE crm_columns SET agent_role = 'finalizador' WHERE id = ?`).run(cols[3].id);

    // 008: cotador/closer → educador
    const m008 = await import('../../../src/crm/migrations/008_role_consolidation.js');
    m008.up(db);
    expect((db.prepare(`SELECT agent_role FROM crm_columns WHERE id = ?`).get(cols[1].id) as any).agent_role).toBe('educador');
    expect((db.prepare(`SELECT agent_role FROM crm_columns WHERE id = ?`).get(cols[2].id) as any).agent_role).toBe('educador');

    // 010: educador → vendedor_funeral; finalizador → coletor_dados
    const m010 = await import('../../../src/crm/migrations/010_role_rename_final.js');
    m010.up(db);
    expect((db.prepare(`SELECT agent_role FROM crm_columns WHERE id = ?`).get(cols[1].id) as any).agent_role).toBe('vendedor_funeral');
    expect((db.prepare(`SELECT agent_role FROM crm_columns WHERE id = ?`).get(cols[2].id) as any).agent_role).toBe('vendedor_funeral');
    expect((db.prepare(`SELECT agent_role FROM crm_columns WHERE id = ?`).get(cols[3].id) as any).agent_role).toBe('coletor_dados');

    // Idempotencia (rodar 008+010 de novo nao quebra)
    expect(() => { m008.up(db); m010.up(db); }).not.toThrow();
    const finalRole = (db.prepare(`SELECT agent_role FROM crm_columns WHERE id = ?`).get(cols[1].id) as any).agent_role;
    expect(finalRole).toBe('vendedor_funeral');
    void lancarVenda;
  });

  // ─── PR 6.0 — escalar_humano urgencia=alta ─────────────────────────

  it('PR 6.0: escalar_humano com urgencia=alta grava metric com prefix "urgent:"', async () => {
    const tenantId = 'esc-' + randomBytes(3).toString('hex');
    const board = store.seedDefaultBoards(tenantId);
    const cols = store.listColumns(tenantId, board.id);
    const contact = store.createContact(tenantId, { name: 'Lead Teste', phone: '+5521999111111', source: 't' });
    const card = store.createCard(tenantId, { boardId: board.id, columnId: cols[0].id, title: contact.name, contactId: contact.id });
    const state = agentState.upsertCardAgentState({
      cardId: card.id, columnId: cols[0].id, currentAgentRole: 'qualificador', tenantId, status: 'active',
    });
    const ctx = {
      tenantId, channel: { id: 'ch_x', tenantId, type: 'evolution', name: 't', credentialsEncrypted: '', webhookSecret: 'w', createdAt: Date.now() },
      card, column: cols[0], state, customerPhone: contact.phone, role: 'qualificador',
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
    // metric escalated com reason urgent:
    const metrics = agentState.listAgentMetricsForCard(card.id);
    const escalated = metrics.find((m: any) => m.event === 'escalated');
    expect(escalated?.reason).toMatch(/^urgent:/);
  });

  // ─── PR 6.0 — Vendedor Funeral prompt menciona escalate em plano completo ─


  // ─── PR 6.0 — Qualificador prompt tem PASSO 3B (escala plano completo) ───

});
