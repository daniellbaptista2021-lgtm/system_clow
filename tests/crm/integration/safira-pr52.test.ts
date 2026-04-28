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
    finalizador = await import('../../../src/crm/agents/tools/finalizador.js');
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
      tenantId, channel: { id: 'ch_x', tenantId, type: 'zapi', name: 't', credentialsEncrypted: '', webhookSecret: 'w', createdAt: Date.now() },
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

  it('1. Qualificador prompt contem mensagem de acolhimento', () => {
    const p = prompts.PROMPT_QUALIFICADOR;
    expect(p).toContain('Oi! Sou a {{persona_name}}, da *PV Corretora*');
    expect(p).toContain('Que bom que você chegou até aqui!');
  });

  // ─── 2. Qualificador planta semente consultiva ─────────────────────

  it('2. Qualificador prompt tem 4 sementes consultivas', () => {
    const p = prompts.PROMPT_QUALIFICADOR;
    expect(p).toContain('Sabia que o seguro de vida hoje tem benefícios');
    expect(p).toContain('seguro de vida cobre *doenças graves');
    expect(p).toContain('coberturas pra usar *agora*');
    expect(p).toContain('70% dos acionamentos');
  });

  // ─── 3. Qualificador NAO fala valor em R$ ──────────────────────────

  it('3. Qualificador prompt instrui NAO passar valor em R$', () => {
    const p = prompts.PROMPT_QUALIFICADOR;
    expect(p).toMatch(/N[ÃA]O passe valor em R\$/i);
  });

  // ─── 4. Qualificador NAO pede CPF ──────────────────────────────────

  it('4. Qualificador prompt instrui NAO pedir CPF/RG/dados sensiveis', () => {
    const p = prompts.PROMPT_QUALIFICADOR;
    expect(p).toMatch(/N[ÃA]O\s+pe[çc]a\s+CPF/);
    expect(p).toMatch(/N[ÃA]O\s+pe[çc]a.*RG/);
  });

  // ─── 5. Qualificador NAO menciona "corretora oficial SulAmerica" ──

  it('5. Qualificador NAO descreve PV Corretora como "corretora oficial SulAmerica"', () => {
    const p = prompts.PROMPT_QUALIFICADOR;
    expect(p).not.toMatch(/corretora\s+oficial\s+SulAm[eé]rica/i);
  });

  // ─── 6. Educador NAO tem gerar_cotacao_sulamerica ──────────────────

  it('6. Educador role NAO tem acesso a gerar_cotacao_sulamerica', () => {
    const tools = registry.getToolsForRole('educador');
    const names = tools.map((t: any) => t.name);
    expect(names).not.toContain('gerar_cotacao_sulamerica');
    expect(names).not.toContain('consultar_margem_desconto');
    expect(names).not.toContain('promover_vendedor');
    // Tools que ELE pode chamar
    expect(names).toContain('promover_fechamento');
    expect(names).toContain('escalar_humano');
    expect(names).toContain('marcar_perdido');
  });

  // ─── 7. Educador NAO fala valor em R$ ──────────────────────────────

  it('7. Educador prompt instrui NUNCA falar valor em R$', () => {
    const p = prompts.PROMPT_EDUCADOR;
    expect(p).toMatch(/NUNCA[\s\S]{0,100}valor\s+em\s+R\$/i);
    expect(p).toMatch(/Diga\s+um\s+valor\s+em\s+R\$/i); // listado entre as proibicoes
  });

  // ─── 8. Educador NAO oferece desconto ──────────────────────────────

  it('8. Educador prompt instrui NAO oferecer desconto', () => {
    const p = prompts.PROMPT_EDUCADOR;
    expect(p).toMatch(/Ofere[çc]a\s+desconto/i);
    expect(p).toMatch(/NUNCA invente desconto/i);
  });

  // ─── 9. Educador resposta a "tem desconto?" ────────────────────────

  it('9. Educador prompt tem resposta padrao pra "tem desconto?"', () => {
    const p = prompts.PROMPT_EDUCADOR;
    expect(p).toMatch(/já é (o )?promocional/);
    expect(p).toContain('quer que eu te explique como funciona a {benefício_relevante}');
  });

  // ─── 10. Finalizador menciona Daniel especificamente ───────────────

  it('10. Finalizador prompt menciona Daniel como pessoa especifica', () => {
    const p = prompts.PROMPT_FINALIZADOR;
    expect(p).toMatch(/\*Daniel\*/);
    expect(p).toContain('corretor da PV Corretora');
    expect(p).not.toMatch(/corretor\s+oficial\s+SulAm[eé]rica/i);
  });

  // ─── 11. Finalizador pede consentimento LGPD ───────────────────────

  it('11. Finalizador prompt tem mensagem de consentimento LGPD', () => {
    const p = prompts.PROMPT_FINALIZADOR;
    expect(p).toContain('CONSENTIMENTO LGPD');
    expect(p).toContain('Antes de eu te pedir os dados');
    expect(p).toMatch(/Tudo bem se eu coletar\?/);
  });

  // ─── 12. Finalizador valida CPF "137.44793737" como invalido ──────

  it('12. validar_cpf rejeita "137.44793737" (formato bagunçado)', () => {
    expect(finalizador.isValidCPF('137.44793737')).toBe(false);
    expect(finalizador.isValidCPF('111.444.777-35')).toBe(true);
    expect(finalizador.isValidCPF('11144477735')).toBe(true);
  });

  // ─── 13. Finalizador coleta 17 campos ──────────────────────────────

  it('13. Finalizador prompt lista os 15 campos titular + 4 dependente', () => {
    const p = prompts.PROMPT_FINALIZADOR;
    const titularFields = [
      'Nome completo', 'CPF', 'RG', 'Data de nascimento', 'Sexo',
      'Estado civil', 'Nacionalidade', 'Nome da mãe',
      'Dia de vencimento', 'Celular WhatsApp', 'E-mail',
      'CEP', 'Endereço completo', 'Profissão', 'Altura', 'Peso',
    ];
    for (const f of titularFields) {
      expect(p).toMatch(new RegExp(f, 'i'));
    }
    // Dependentes
    expect(p).toContain('Nome completo');
    expect(p).toContain('Grau de parentesco');
    expect(p).toContain('CPF');
    expect(p).toMatch(/Data\s+de\s+nascimento/);
  });

  // ─── 14. Roles 'cotador' e 'closer' nao tem tools ativas ──────────

  it('14. Sistema NAO expoe tools pra roles deprecated cotador/closer', () => {
    // Tools de role cotador (deprecated PR 5.2): so as comuns vem
    const toolsCotador = registry.getToolsForRole('cotador');
    const cotadorSpecific = toolsCotador.filter((t: any) =>
      !t.roles.includes('*') // remove tools comuns que aceitam *
    );
    expect(cotadorSpecific.length).toBe(0);

    const toolsCloser = registry.getToolsForRole('closer');
    const closerSpecific = toolsCloser.filter((t: any) => !t.roles.includes('*'));
    expect(closerSpecific.length).toBe(0);

    // Confirma que essas tools antigas nao existem mais no registry
    const allNames = registry.listAllToolNames();
    expect(allNames).not.toContain('gerar_cotacao_sulamerica');
    expect(allNames).not.toContain('consultar_margem_desconto');
    expect(allNames).not.toContain('promover_vendedor');
  });

  // ─── 15. Migration 008: cotador/closer → educador idempotente ────

  it('15. Migration 008 converte cotador/closer em educador (idempotente)', async () => {
    const tenantId = 'mig8-' + randomBytes(3).toString('hex');
    const board = store.seedDefaultBoards(tenantId);
    const cols = store.listColumns(tenantId, board.id);
    const db = schema.getCrmDb();

    // Setup: 2 colunas com roles deprecated
    const lancarVenda = store.createColumn(tenantId, { boardId: board.id, name: 'Lançar venda', color: '#fff' });
    db.prepare(`UPDATE crm_columns SET agent_role = 'cotador' WHERE id = ?`).run(cols[1].id);
    db.prepare(`UPDATE crm_columns SET agent_role = 'closer' WHERE id = ?`).run(cols[2].id);

    // Aplica migration 008
    const m008 = await import('../../../src/crm/migrations/008_role_consolidation.js');
    m008.up(db);

    // Verifica que ambas viraram educador
    const r1 = db.prepare(`SELECT agent_role, agent_promote_to_column_id FROM crm_columns WHERE id = ?`).get(cols[1].id) as any;
    const r2 = db.prepare(`SELECT agent_role, agent_promote_to_column_id FROM crm_columns WHERE id = ?`).get(cols[2].id) as any;
    expect(r1.agent_role).toBe('educador');
    expect(r2.agent_role).toBe('educador');
    expect(r1.agent_promote_to_column_id).toBe(lancarVenda.id);
    expect(r2.agent_promote_to_column_id).toBe(lancarVenda.id);

    // Idempotencia: roda de novo, nao quebra
    expect(() => m008.up(db)).not.toThrow();
    const r1Again = db.prepare(`SELECT agent_role FROM crm_columns WHERE id = ?`).get(cols[1].id) as any;
    expect(r1Again.agent_role).toBe('educador');
  });
});
