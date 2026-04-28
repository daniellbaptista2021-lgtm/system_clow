/**
 * Quotation engine + tools SulAmerica AP Flex (Onda 62, PR 5.1).
 *
 * Cobre os 12 cenarios principais + edge cases:
 *  1. Cliente curioso "tô só vendo" → Qualificador NAO promove (testado em column-agent-tools)
 *  2. Individual 35 anos → R$29,90
 *  3. Casal 35+33 sem filhos → R$39,90
 *  4. Familiar 35+33+filhos 5,8 → R$49,90
 *  5. Familiar Ampliado (com pais) → R$89,90
 *  6. 1 filho 25 anos → +R$8 no plano
 *  7. Cliente 76 anos → recusa, oferece como dependente (erro titular_acima_idade_maxima)
 *  8. Cliente pede desconto → consultar_margem_desconto retorna 0%
 *  9. CPF "137.44793737" → invalido (formato bagunçado)
 * 10. Mensagem NAO contem "Real Pax" em lugar nenhum
 * 11. Mensagem NAO menciona "10% desconto"
 * 12. Mensagem NAO promete que ela mesma fecha venda (fluxo da contratacao 4 passos)
 *
 * Edge cases:
 * - Tenant sem planos → erro + escalate
 * - Cliente "Popular" → scrub pra "Essencial"
 * - Snapshot persiste em collected_data.last_quotation
 * - Closer le ler_dados_card → recebe last_quotation
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'crypto';

const TEST_DB_PATH = '/tmp/clow-pr51-' + randomBytes(6).toString('hex') + '.db';
process.env.CRM_DB_PATH = TEST_DB_PATH;
process.env.CLOW_PII_KEY = 'pr51-test-key-with-min-16-chars';

describe('Quotation Engine SulAmerica AP Flex (PR 5.1)', () => {
  let schema: any, store: any, agentState: any, plansStore: any, engine: any, registry: any, rules: any;

  beforeAll(async () => {
    schema = await import('../../../src/crm/schema.js');
    store = await import('../../../src/crm/store.js');
    agentState = await import('../../../src/crm/store/cardAgentStateStore.js');
    plansStore = await import('../../../src/crm/store/tenantPlansStore.js');
    engine = await import('../../../src/crm/agents/quotation/quotationEngine.js');
    registry = await import('../../../src/crm/agents/tools/registry.js');
    rules = await import('../../../src/crm/agents/quotation/sulamericaRules.js');
    schema.getCrmDb();
  });

  afterAll(() => {
    try { require('fs').unlinkSync(TEST_DB_PATH); } catch { /* ignore */ }
  });

  // ── helpers ──────────────────────────────────────────────────────────

  function makeTenant() { return 'tT51-' + randomBytes(4).toString('hex'); }

  /** Seed os 4 planos SulAmerica pro tenant. */
  function seedSulamericaPlans(tenantId: string) {
    plansStore.createPlan({
      tenantId, name: 'SulAmérica AP Flex Individual',
      productType: 'acidentes_pessoais', basePriceCents: 2990,
      coverageSummary: 'Assistência funeral nacional + R$50k morte acidental.',
      minAge: 1, maxAge: 74, surchargeOutsideRioCents: 0, priority: 10,
    });
    plansStore.createPlan({
      tenantId, name: 'SulAmérica AP Flex Casal',
      productType: 'acidentes_pessoais', basePriceCents: 3990,
      coverageSummary: 'Cobertura titular + cônjuge.',
      minAge: 1, maxAge: 74, surchargeOutsideRioCents: 0, priority: 20,
    });
    plansStore.createPlan({
      tenantId, name: 'SulAmérica AP Flex Familiar',
      productType: 'acidentes_pessoais', basePriceCents: 4990,
      coverageSummary: 'Titular + cônjuge + filhos até 21.',
      minAge: 1, maxAge: 74, allowsDependents: true,
      surchargeOutsideRioCents: 0, priority: 30,
    });
    plansStore.createPlan({
      tenantId, name: 'SulAmérica AP Flex Familiar Ampliado',
      productType: 'acidentes_pessoais', basePriceCents: 8990,
      coverageSummary: 'Cobertura ampliada.',
      minAge: 1, maxAge: 74, allowsDependents: true,
      surchargeOutsideRioCents: 0, priority: 40,
    });
  }

  function setupCardCtx(tenantId: string, role = 'educador') {
    const board = store.seedDefaultBoards(tenantId);
    const cols = store.listColumns(tenantId, board.id);
    const contact = store.createContact(tenantId, { name: 'Joao Teste', phone: '+55119000-' + randomBytes(2).toString('hex'), source: 'test' });
    const card = store.createCard(tenantId, {
      boardId: board.id, columnId: cols[1].id, title: contact.name, contactId: contact.id,
    });
    const state = agentState.upsertCardAgentState({
      cardId: card.id, columnId: cols[1].id, currentAgentRole: role,
      tenantId, status: 'active',
    });
    const channel = {
      id: 'ch_' + randomBytes(3).toString('hex'),
      tenantId, type: 'zapi' as const, name: 't', credentialsEncrypted: '',
      webhookSecret: 'w', createdAt: Date.now(),
    };
    return {
      tenantId, channel, card, column: cols[1], state,
      customerPhone: '+5511990000501', role,
    };
  }

  function callTool(name: string, args: any) {
    return {
      id: 'call_' + randomBytes(3).toString('hex'),
      type: 'function' as const,
      function: { name, arguments: JSON.stringify(args) },
    };
  }

  // ─── Scenarios 2-7: Calculo de modalidade + preço ───────────────────

  it('2. Individual 35 anos → modalidade=individual, preço R$ 29,90', () => {
    const tenantId = makeTenant();
    seedSulamericaPlans(tenantId);
    const r = engine.buildQuotation({
      tenantId,
      qualification: { idadeTitular: 35 },
    });
    expect(r.ok).toBe(true);
    expect(r.modalidade).toBe('individual');
    expect(r.totalCents).toBe(2990);
    expect(r.message).toContain('R$ 29,90');
  });

  it('3. Casal 35+33 sem filhos → modalidade=casal, preço R$ 39,90', () => {
    const tenantId = makeTenant();
    seedSulamericaPlans(tenantId);
    const r = engine.buildQuotation({
      tenantId,
      qualification: { idadeTitular: 35, conjuge: { idade: 33 } },
    });
    expect(r.ok).toBe(true);
    expect(r.modalidade).toBe('casal');
    expect(r.totalCents).toBe(3990);
    expect(r.message).toContain('R$ 39,90');
  });

  it('4. Familiar 35+33+filhos 5,8 → modalidade=familiar, preço R$ 49,90', () => {
    const tenantId = makeTenant();
    seedSulamericaPlans(tenantId);
    const r = engine.buildQuotation({
      tenantId,
      qualification: {
        idadeTitular: 35,
        conjuge: { idade: 33 },
        filhosMenores21: [{ idade: 5 }, { idade: 8 }],
      },
    });
    expect(r.ok).toBe(true);
    expect(r.modalidade).toBe('familiar');
    expect(r.totalCents).toBe(4990);
    expect(r.message).toContain('R$ 49,90');
  });

  it('5. Familiar Ampliado (com pais) → modalidade=familiar_ampliado, R$ 89,90', () => {
    const tenantId = makeTenant();
    seedSulamericaPlans(tenantId);
    const r = engine.buildQuotation({
      tenantId,
      qualification: {
        idadeTitular: 40,
        conjuge: { idade: 38 },
        filhosMenores21: [{ idade: 10 }],
        pais: true,
      },
    });
    expect(r.ok).toBe(true);
    expect(r.modalidade).toBe('familiar_ampliado');
    expect(r.totalCents).toBe(8990);
    expect(r.message).toContain('R$ 89,90');
  });

  it('5b. Familiar Ampliado (com sogros, sem pais) → R$ 89,90', () => {
    const tenantId = makeTenant();
    seedSulamericaPlans(tenantId);
    const r = engine.buildQuotation({
      tenantId,
      qualification: { idadeTitular: 40, conjuge: { idade: 38 }, sogros: true },
    });
    expect(r.ok).toBe(true);
    expect(r.modalidade).toBe('familiar_ampliado');
    expect(r.totalCents).toBe(8990);
  });

  it('6. 1 filho >21 → modalidade=individual + R$ 8 = R$ 37,90', () => {
    const tenantId = makeTenant();
    seedSulamericaPlans(tenantId);
    const r = engine.buildQuotation({
      tenantId,
      qualification: {
        idadeTitular: 60,
        filhosMaiores21: [{ idade: 25 }],
      },
    });
    expect(r.ok).toBe(true);
    expect(r.modalidade).toBe('individual'); // filhos>21 nao puxam pra Familiar
    expect(r.totalCents).toBe(2990 + 800); // 29,90 + 8 = 37,90
    expect(r.message).toContain('R$ 37,90');
    expect(r.message).toContain('1 filho(s) maior(es) de 21');
  });

  it('6b. Familiar com 2 filhos <21 + 1 filho >21 → R$ 49,90 + R$ 8 = R$ 57,90', () => {
    const tenantId = makeTenant();
    seedSulamericaPlans(tenantId);
    const r = engine.buildQuotation({
      tenantId,
      qualification: {
        idadeTitular: 45, conjuge: { idade: 42 },
        filhosMenores21: [{ idade: 12 }, { idade: 15 }],
        filhosMaiores21: [{ idade: 23 }],
      },
    });
    expect(r.ok).toBe(true);
    expect(r.modalidade).toBe('familiar');
    expect(r.totalCents).toBe(4990 + 800);
    expect(r.message).toContain('R$ 57,90');
  });

  it('7. Titular 76 anos → recusa, erro=titular_acima_idade_maxima', () => {
    const tenantId = makeTenant();
    seedSulamericaPlans(tenantId);
    const r = engine.buildQuotation({
      tenantId,
      qualification: { idadeTitular: 76 },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('titular_acima_idade_maxima');
  });

  it('7b. Titular 74 anos → ainda elegivel (idade limite)', () => {
    const tenantId = makeTenant();
    seedSulamericaPlans(tenantId);
    const r = engine.buildQuotation({
      tenantId,
      qualification: { idadeTitular: 74 },
    });
    expect(r.ok).toBe(true);
    expect(r.totalCents).toBe(2990);
  });

  // ─── Scenario 8 (PR 5.2): Educador NAO tem tool de desconto ─────────

  it('8. consultar_margem_desconto NAO existe mais (Educador nao consulta margem)', async () => {
    const tenantId = makeTenant();
    const ctx = setupCardCtx(tenantId, 'educador');
    const r = await registry.executeToolCall(
      callTool('consultar_margem_desconto', { plano: 'SulAmérica AP Flex Familiar' }),
      ctx,
    );
    // Tool foi removida no PR 5.2 — registry retorna 'tool_unknown'
    expect(r.ok).toBe(false);
    expect(r.error).toContain('tool_unknown');
  });

  // ─── Scenario 9: validar_cpf rigoroso (formato + digito) ────────────

  it('9. validar_cpf rejeita formatos bagunçados (PR 5.1 fix)', async () => {
    const tenantId = makeTenant();
    const ctx = setupCardCtx(tenantId, 'finalizador');

    // Bagunçado — formato quebrado mesmo com 11 digitos somando OK
    const bad1 = await registry.executeToolCall(callTool('validar_cpf', { cpf: '137.44793737' }), ctx);
    expect((bad1.result as any).valid).toBe(false);

    // Sem nada (vazio)
    const bad2 = await registry.executeToolCall(callTool('validar_cpf', { cpf: '' }), ctx);
    expect((bad2.result as any).valid).toBe(false);

    // Letras
    const bad3 = await registry.executeToolCall(callTool('validar_cpf', { cpf: 'abc.def.ghi-jk' }), ctx);
    expect((bad3.result as any).valid).toBe(false);

    // Sequência repetida
    const bad4 = await registry.executeToolCall(callTool('validar_cpf', { cpf: '00000000000' }), ctx);
    expect((bad4.result as any).valid).toBe(false);

    // Dígito errado (formato OK, mas matemática falha)
    const bad5 = await registry.executeToolCall(callTool('validar_cpf', { cpf: '123.456.789-00' }), ctx);
    expect((bad5.result as any).valid).toBe(false);

    // Válidos
    const good1 = await registry.executeToolCall(callTool('validar_cpf', { cpf: '111.444.777-35' }), ctx);
    expect((good1.result as any).valid).toBe(true);

    const good2 = await registry.executeToolCall(callTool('validar_cpf', { cpf: '11144477735' }), ctx);
    expect((good2.result as any).valid).toBe(true);
  });

  // ─── Scenario 10/11/12: Mensagem livre de "Real Pax" / "Popular" / "10% desconto" ──

  it('10/11/12. Mensagem da cotação respeita memórias do Daniel', () => {
    const tenantId = makeTenant();
    seedSulamericaPlans(tenantId);
    const r = engine.buildQuotation({
      tenantId,
      qualification: {
        idadeTitular: 40, conjuge: { idade: 38 },
        filhosMenores21: [{ idade: 8 }],
      },
      customerName: 'Maria',
    });
    expect(r.ok).toBe(true);
    const msg = r.message;

    // 10. Sem "Real Pax"
    expect(msg).not.toMatch(/Real\s*Pax/i);
    // Sem "Popular" (defesa scrubPlanName)
    expect(msg).not.toMatch(/\bPopular\b/i);

    // 11. Sem ofertas de desconto comercial (mas "Desconto em farmácias" eh benefício legítimo)
    expect(msg).not.toMatch(/\d+\s*%\s*(de\s+)?desconto/i);            // "10% desconto"
    expect(msg).not.toMatch(/desconto\s+(no|do)\s+(plano|valor)/i);    // "desconto no plano"
    expect(msg).not.toMatch(/consegui[a-zà-ú\s]*desconto/i);           // "consegui desconto"
    expect(msg).not.toMatch(/abatimento|reduçã[oõ]\s+de\s+valor/i);    // sinonimos
    // 10% literal SO se fora de contexto de "%off" — checa que NAO tem "10%"
    expect(msg).not.toContain('10%');

    // 12. NAO promete que o bot finaliza venda
    expect(msg).not.toMatch(/eu\s+vou\s+(finalizar|fechar)/i);
    expect(msg).not.toMatch(/eu\s+(finalizo|fecho)/i);

    // FLUXO CORRETO: 4 passos da contratacao
    expect(msg).toContain('1️⃣ Enviamos toda a documentação');
    expect(msg).toContain('2️⃣');
    expect(msg).toContain('3️⃣');
    expect(msg).toContain('4️⃣');
    expect(msg).toContain('Total transparência');
    expect(msg).toContain('antes');

    // Branding (template usa "Assistência Funeral SulAmérica" no header)
    expect(msg).toMatch(/SulAm[ée]rica/);
    expect(msg).toContain('Cotação');
  });

  // ─── Edge: Tenant sem planos ─────────────────────────────────────────

  it('Tenant sem planos cadastrados → buildQuotation retorna erro', () => {
    const tenantId = makeTenant(); // sem seed
    const r = engine.buildQuotation({
      tenantId,
      qualification: { idadeTitular: 30 },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('tenant_sem_planos_cadastrados');
  });

  // ─── Edge: buildQuotation direto (engine, sem tool LLM) ──────────────

  it('buildQuotation usa qualification estruturada e calcula modalidade', () => {
    const tenantId = makeTenant();
    seedSulamericaPlans(tenantId);
    const r = engine.buildQuotation({
      tenantId,
      qualification: {
        nomeTitular: 'José',
        idadeTitular: 50,
        conjuge: { idade: 48 },
        filhosMenores21: [{ idade: 16 }],
      },
      customerName: 'José',
    });
    expect(r.ok).toBe(true);
    expect(r.modalidade).toBe('familiar');
    expect(r.totalCents).toBe(4990);
    expect(r.message).toMatch(/José/);
  });

  // ─── Edge: scrub Real Pax → SulAmerica ──────────────────────────────

  it('Plano cadastrado errado com "Real Pax" eh scrubbed pra "SulAmerica AP Flex"', () => {
    const tenantId = makeTenant();
    plansStore.createPlan({
      tenantId, name: 'Real Pax Essencial Individual', // typo histórico
      productType: 'acidentes_pessoais', basePriceCents: 2990,
      coverageSummary: 'Cobertura básica.',
      minAge: 1, maxAge: 74, surchargeOutsideRioCents: 0, priority: 10,
    });
    const r = engine.buildQuotation({
      tenantId,
      qualification: { idadeTitular: 35 },
    });
    expect(r.ok).toBe(true);
    expect(r.snapshot.plans[0].name).toBe('SulAmérica AP Flex Essencial Individual');
    expect(rules.scrubPlanName('Real Pax Essencial')).toBe('SulAmérica AP Flex Essencial');
  });

  // ─── Snapshot persistido ─────────────────────────────────────────────

  it('PR 5.2: snapshot persiste em collected_data.last_quotation via promover_pendente_daniel', async () => {
    const tenantId = makeTenant();
    seedSulamericaPlans(tenantId);
    const ctxFinal = setupCardCtx(tenantId, 'finalizador');
    // Pre-popula qualification (Qualificador faria isso)
    agentState.upsertCardAgentState({
      cardId: ctxFinal.card.id, columnId: ctxFinal.column.id, currentAgentRole: 'finalizador',
      tenantId,
      collectedData: {
        qualification: {
          nomeTitular: 'José',
          idadeTitular: 40,
          conjuge: { idade: 38 },
        },
      },
    });
    // Configura coluna destino (Pendente Daniel) na coluna do Finalizador
    const db = schema.getCrmDb();
    const targetCol = await import('../../../src/crm/store.js').then((s) =>
      s.createColumn(tenantId, { boardId: ctxFinal.card.boardId, name: 'Pendente Daniel', color: '#ccc' })
    );
    db.prepare(`UPDATE crm_columns SET agent_promote_to_column_id = ? WHERE id = ?`)
      .run(targetCol.id, ctxFinal.column.id);
    const updatedColumn = (await import('../../../src/crm/store.js')).listColumns(tenantId, ctxFinal.card.boardId)
      .find((c: any) => c.id === ctxFinal.column.id);
    const ctxFinal2 = { ...ctxFinal, column: updatedColumn };

    // Chama promover_pendente_daniel — internamente calcula e salva snapshot
    const r = await registry.executeToolCall(
      callTool('promover_pendente_daniel', { motivo: 'dados completos' }),
      ctxFinal2,
    );
    expect(r.ok).toBe(true);
    const stateAfter = agentState.getCardAgentState(ctxFinal.card.id);
    const lq = (stateAfter.collectedData as any).last_quotation;
    expect(lq).toBeTruthy();
    expect(lq.qualification.modalidade).toBe('casal');
  });

  // ─── ler_dados_card retorna last_quotation pra educador ──────────────

  it('Educador chama ler_dados_card → recebe last_quotation salvo', async () => {
    const tenantId = makeTenant();
    seedSulamericaPlans(tenantId);
    const ctxEducador = setupCardCtx(tenantId, 'educador');
    // Simula snapshot salvo (em prod, eh setado via promover_pendente_daniel)
    agentState.upsertCardAgentState({
      cardId: ctxEducador.card.id, columnId: ctxEducador.column.id, currentAgentRole: 'educador',
      tenantId,
      collectedData: {
        qualification: { nomeTitular: 'João', idadeTitular: 35 },
        last_quotation: {
          productType: 'acidentes_pessoais',
          modalidade: 'individual',
          qualification: { nomeTitular: 'João', idadeTitular: 35, modalidade: 'individual' },
          plans: [{ name: 'SulAmérica AP Flex Individual', basePriceCents: 2990, coverageSummary: 'x' }],
          calculatedAt: Date.now(),
        },
      },
    });
    const r = await registry.executeToolCall(callTool('ler_dados_card', {}), ctxEducador);
    expect(r.ok).toBe(true);
    expect(r.result.last_quotation).toBeTruthy();
    expect(r.result.last_quotation.qualification.modalidade).toBe('individual');
  });

  // ─── Salvar dados proposta com 17 campos cifrados ──────────────────

  it('salvar_dados_proposta cifra 16 campos titular + dependentes (PR 5.1 17 fields)', async () => {
    const tenantId = makeTenant();
    const ctx = setupCardCtx(tenantId, 'finalizador');
    const r = await registry.executeToolCall(callTool('salvar_dados_proposta', {
      nome_completo: 'José Pereira da Silva',
      cpf: '11144477735',
      rg: '12.345.678-9',
      data_nascimento: '1985-06-15',
      sexo: 'M',
      estado_civil: 'casado',
      nacionalidade: 'brasileira',
      nome_mae: 'Maria Pereira',
      dia_vencimento: 10,
      celular: '+5511990000000',
      email: 'jose@example.com',
      cep: '01310100',
      endereco_completo: { rua: 'Av Paulista', numero: '1000', bairro: 'Bela Vista', cidade: 'São Paulo', uf: 'SP' },
      profissao: 'Engenheiro',
      altura: '1.78m',
      peso: '82kg',
      dependentes: [
        { nome_completo: 'Maria Silva', parentesco: 'cônjuge', cpf: '11144477735', data_nascimento: '1990-03-22' },
      ],
    }), ctx);
    expect(r.ok).toBe(true);
    const filled: string[] = (r.result as any).sensitive_fields_filled;
    // 16 campos titular + 1 array dependentes
    expect(filled.length).toBe(17);
    expect(filled).toContain('cpf_enc');
    expect(filled).toContain('nome_completo_enc');
    expect(filled).toContain('endereco_completo_enc');
    expect(filled).toContain('dependentes_enc');

    // Query bruta no DB confirma cifragem
    const db = schema.getCrmDb();
    const row = db.prepare(`SELECT collected_data FROM crm_card_agent_state WHERE card_id = ?`).get(ctx.card.id) as any;
    const raw = row.collected_data as string;
    expect(raw).not.toContain('11144477735'); // CPF claro nao aparece
    expect(raw).not.toContain('Av Paulista'); // endereco claro nao aparece
    expect(raw).toContain('cpf_enc');
    expect(raw).toContain('endereco_completo_enc');
  });
});
