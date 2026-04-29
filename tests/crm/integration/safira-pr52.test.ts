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

  it('1. Qualificador prompt contem mensagem de acolhimento + pergunta critica', () => {
    const p = prompts.PROMPT_QUALIFICADOR;
    expect(p).toContain('Oi! Sou a {{persona_name}}, da *PV Corretora*');
    expect(p).toContain('Você viu nosso anúncio do *Plano Funeral SulAmérica*');
  });

  // ─── 2. Qualificador oferece ESCOLHA (funeral vs plano completo) ───

  it('2. Qualificador prompt oferece escolha funeral simples vs plano completo', () => {
    const p = prompts.PROMPT_QUALIFICADOR;
    expect(p).toContain('1️⃣');
    expect(p).toContain('proteção funeral');
    expect(p).toContain('2️⃣');
    expect(p).toMatch(/seguro de vida.*doen[çc]as graves|doen[çc]as graves.*cirurgia/);
    expect(p).toContain('Qual dos dois faz mais sentido');
  });

  // ─── 3. Qualificador NAO cita valor em R$ (PR 6.1: regra mais rigida) ───

  it('3. Qualificador prompt instrui NUNCA citar valor em R$', () => {
    const p = prompts.PROMPT_QUALIFICADOR;
    // PR 6.1: Qualificador NAO sabe valor — regra mais rigida que PR 5.2
    expect(p).toMatch(/NUNCA\s+cite\s+valor\s+em\s+R\$/i);
  });

  // ─── 4. Qualificador NAO pede CPF/RG ───────────────────────────────

  it('4. Qualificador prompt instrui NAO pedir CPF/RG/dados sensiveis', () => {
    const p = prompts.PROMPT_QUALIFICADOR;
    expect(p).toMatch(/(N[ÃA]O|NUNCA)\s+fale\s+CPF\/RG/i);
  });

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

  it('7. Vendedor Funeral prompt instrui usar gerar_cotacao_sulamerica e fechar venda', () => {
    const p = prompts.PROMPT_VENDEDOR_FUNERAL;
    expect(p).toContain('gerar_cotacao_sulamerica');
    expect(p).toMatch(/COTA|VENDEDOR|fecha/i);
    // Vendedor Funeral nao inventa desconto
    expect(p).toMatch(/(N[ÃA]O|NUNCA)\s+invente\s+desconto/i);
  });

  // ─── 8. Vendedor Funeral NAO oferece desconto ──────────────────────

  it('8. Vendedor Funeral prompt proibe oferecer desconto', () => {
    const p = prompts.PROMPT_VENDEDOR_FUNERAL;
    expect(p).toMatch(/(N[ÃA]O|NUNCA)\s+invente\s+desconto/i);
  });

  // ─── 9. Vendedor Funeral trata objecao "tá caro" (PR 6.1: alternativa positiva) ───

  it('9. Vendedor Funeral prompt tem template pra objecao "tá caro"', () => {
    const p = prompts.PROMPT_VENDEDOR_FUNERAL;
    expect(p).toMatch(/T[áa] caro/);
    // PR 6.1: divisao por dia agora R$ 1,67 (49,90/30) — alternativa "Familiar ou Casal"
    expect(p).toMatch(/menos de R\$\s*1[,.]67\s+por\s+dia/i);
  });

  // ─── 10. Coletor de Dados menciona Daniel especificamente ──────────

  it('10. Coletor de Dados prompt menciona Daniel como pessoa especifica', () => {
    const p = prompts.PROMPT_COLETOR_DADOS;
    expect(p).toMatch(/\*Daniel\*/);
    expect(p).toMatch(/corretor/i);
  });

  // ─── 11. Finalizador pede consentimento LGPD ───────────────────────

  it('11. Coletor de Dados prompt tem mensagem de consentimento LGPD', () => {
    const p = prompts.PROMPT_COLETOR_DADOS;
    expect(p).toContain('CONSENTIMENTO LGPD');
    expect(p).toContain('Antes de pegar seus dados');
    expect(p).toMatch(/Tudo bem\?/);
  });

  // ─── 12. Finalizador valida CPF "137.44793737" como invalido ──────

  it('12. validar_cpf rejeita "137.44793737" (formato bagunçado)', () => {
    expect(finalizador.isValidCPF('137.44793737')).toBe(false);
    expect(finalizador.isValidCPF('111.444.777-35')).toBe(true);
    expect(finalizador.isValidCPF('11144477735')).toBe(true);
  });

  // ─── 13. Finalizador coleta 17 campos ──────────────────────────────

  it('13. Coletor de Dados prompt lista os 15 campos titular + 4 dependente', () => {
    const p = prompts.PROMPT_COLETOR_DADOS;
    const titularFields = [
      'Nome completo', 'CPF', 'RG', 'Data nascimento', 'Sexo',
      'Estado civil', 'Nacionalidade', 'Nome da mãe',
      'Dia vencimento', 'Celular WhatsApp', 'E-mail',
      'CEP', 'Endereço completo', 'Profissão', 'Altura', 'Peso',
    ];
    for (const f of titularFields) {
      expect(p).toMatch(new RegExp(f, 'i'));
    }
    // Dependentes
    expect(p).toMatch(/Parentesco/i);
    expect(p).toMatch(/CPF/);
    expect(p).toMatch(/Data\s+nascimento/i);
  });

  // ─── 14. Roles deprecated (cotador / closer / educador / finalizador) ──

  it('14. Sistema NAO expoe tools pra roles deprecated', () => {
    // PR 6.0: cotador, closer, educador, finalizador todos deprecated
    for (const oldRole of ['cotador', 'closer', 'educador', 'finalizador']) {
      const tools = registry.getToolsForRole(oldRole);
      const specific = tools.filter((t: any) => !t.roles.includes('*'));
      expect(specific.length).toBe(0);
    }
    // PR 6.0: gerar_cotacao_sulamerica VOLTOU (Vendedor Funeral usa).
    // consultar_margem_desconto + promover_vendedor + promover_fechamento removidas.
    const allNames = registry.listAllToolNames();
    expect(allNames).toContain('gerar_cotacao_sulamerica');
    expect(allNames).toContain('promover_para_coletor_dados');
    expect(allNames).toContain('promover_para_vendedor_funeral');
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
      tenantId, channel: { id: 'ch_x', tenantId, type: 'zapi', name: 't', credentialsEncrypted: '', webhookSecret: 'w', createdAt: Date.now() },
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

  it('PR 6.0: Vendedor Funeral prompt instrui escalar quando cliente pede plano completo', () => {
    const p = prompts.PROMPT_VENDEDOR_FUNERAL;
    expect(p).toMatch(/PRODUTO ADICIONAL/i);
    expect(p).toMatch(/escalar_humano.*urgencia.*alta/);
  });

  // ─── PR 6.0 — Qualificador prompt tem PASSO 3B (escala plano completo) ───

  it('PR 6.0: Qualificador prompt tem PASSO 3B com escalar_humano urgencia alta', () => {
    const p = prompts.PROMPT_QUALIFICADOR;
    expect(p).toContain('PASSO 3B');
    expect(p).toMatch(/escalar_humano.*urgencia.*alta/);
  });

  // ─── PR 6.1 — bug do 3o teste: Qualificador cotou sozinho, pulou Vendedor Funeral ───

  it('PR 6.1 (1): Qualificador prompt NAO contem valor em R$ (R$ seguido de digito)', () => {
    const p = prompts.PROMPT_QUALIFICADOR;
    // Causa raiz do bug: ter tabela de precos no prompt fez o LLM cotar sozinho
    // sem promover. Qualificador NAO sabe valor — quem sabe eh o Vendedor Funeral.
    expect(p).not.toMatch(/\bR\$\s*\d/);
  });

  it('PR 6.1 (2): Qualificador prompt NAO contem precos especificos da tabela', () => {
    const p = prompts.PROMPT_QUALIFICADOR;
    // 4 modalidades originais nunca podem aparecer no prompt do Qualificador
    expect(p).not.toContain('29,90');
    expect(p).not.toContain('39,90');
    expect(p).not.toContain('49,90');
    expect(p).not.toContain('89,90');
  });

  it('PR 6.1 (3): Vendedor Funeral prompt PROIBE pergunta "quer fechar?" / "posso prosseguir?"', () => {
    const p = prompts.PROMPT_VENDEDOR_FUNERAL;
    // Tecnica Sandler/SPIN: nunca pergunta SE fecha, sempre COMO fecha.
    // Cliente brasileiro recusa fechamento se vendedor pergunta sim/nao.
    expect(p).toMatch(/NUNCA\s+pergunte\s+["']?quer\s+fechar/i);
    expect(p).toMatch(/NUNCA\s+PERGUNTAS\s+SIM\/N[ÃA]O/i);
    // Lista de perguntas RUINS proibidas
    expect(p).toMatch(/Quer\s+seguir\s+com\s+a\s+contrata[çc][ãa]o\?/i);
    expect(p).toMatch(/Posso\s+prosseguir\?/i);
  });

  it('PR 6.1 (4): Vendedor Funeral prompt tem exemplo de alternativa positiva (boleto OU cartao)', () => {
    const p = prompts.PROMPT_VENDEDOR_FUNERAL;
    // Exemplo canonico de alternativa: boleto mensal vs cartao (recorrente)
    expect(p).toMatch(/boleto\s+mensal.*cart[ãa]o\s+recorrente|cart[ãa]o\s+recorrente.*boleto\s+mensal/i);
    // E principio explicito: NUNCA SE fecha, sempre COMO fecha
    expect(p).toMatch(/NUNCA\s+pergunta\s+SE\s+fecha.*COMO\s+fecha/i);
  });

  it('PR 6.1 (5): gerar_cotacao_sulamerica retorna CTA com 4 opcoes de pagamento', () => {
    // Importa engine direto pra testar a mensagem renderizada (sem precisar de tool ctx).
    // Seed minimo: tenant com plano Individual.
    const tenantId = 'pr61-cta-' + randomBytes(3).toString('hex');
    const board = store.seedDefaultBoards(tenantId);
    void board;
    // Plans: usa o seed default do schema migration ou criamos manualmente?
    // Como esse arquivo de test nao tem helper de seed, usamos os planos do tenant default.
    // Workaround: cria plano via store de planos.
    // Nota: nao usa await import pra evitar TLA — modulos ja importados em beforeAll.
    return import('../../../src/crm/store/tenantPlansStore.js').then(async (plansStore: any) => {
      plansStore.createPlan({
        tenantId, name: 'SulAmérica AP Flex Individual',
        productType: 'acidentes_pessoais', basePriceCents: 2990,
        coverageSummary: 'Funeral nacional.', minAge: 1, maxAge: 74,
        surchargeOutsideRioCents: 0, priority: 10,
      });
      const engine = await import('../../../src/crm/agents/quotation/quotationEngine.js');
      const r = engine.buildQuotation({
        tenantId, qualification: { idadeTitular: 35 }, customerName: 'Lucas',
      });
      expect(r.ok).toBe(true);
      const msg = r.message as string;
      // CTA forte com alternativa positiva — 4 formas de pagamento
      expect(msg).toMatch(/forma\s+de\s+pagamento\s+prefere/i);
      expect(msg).toMatch(/Cart[ãa]o\s+de\s+cr[eé]dito/);
      expect(msg).toMatch(/Boleto\s+mensal/);
      expect(msg).toMatch(/PIX\s+mensal/);
      expect(msg).toMatch(/D[eé]bito\s+autom[áa]tico/);
      // Substituiu o CTA fraco "Me diz o que achou da cobertura"
      expect(msg).not.toMatch(/Me\s+diz\s+o\s+que\s+achou\s+da\s+cobertura/i);
      expect(msg).not.toMatch(/Estou\s+aguardando\s+seu\s+retorno/i);
      // Saudacao com nome
      expect(msg).toMatch(/Lucas/);
    });
  });

  it('PR 6.1 (6): Qualificador prompt instrui chamar AMBAS tools (salvar + promover) e NAO escrever cotacao', () => {
    const p = prompts.PROMPT_QUALIFICADOR;
    // PASSO 5: as 2 tools tem que ser chamadas em sequencia
    expect(p).toContain('salvar_dados_qualificacao');
    expect(p).toContain('promover_para_vendedor_funeral');
    // PROIBE LLM de tomar atalho e cotar sozinho
    expect(p).toMatch(/N[ÃA]O\s+escreva\s+mensagem\s+pr[óo]pria\s+com\s+cota[çc][ãa]o/i);
    expect(p).toMatch(/N[ÃA]O\s+mostre\s+valor/i);
    expect(p).toMatch(/N[ÃA]O\s+pe[çc]a\s+fechamento/i);
  });
});
