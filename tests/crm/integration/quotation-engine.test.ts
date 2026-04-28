/**
 * Quotation engine + gerar_cotacao tool integration tests (Onda 62, PR 5).
 *
 * Cobre:
 *  1. Plano Individual cotado pra cliente 35 anos → R$29,90 retornado
 *  2. Plano Familiar com dependentes → preço base + adicional correto
 *  3. Cliente "fora do Rio" → mostra 2 totais (com e sem surcharge)
 *  4. Cliente 95 anos → todos planos rejeitam por max_age → tool retorna
 *     erro + escalate
 *  5. Tenant sem planos → erro + escalate
 *  6. Mensagem formatada NÃO contém "Popular", NÃO menciona "Rio de
 *     Janeiro" no header, NÃO contém telefone
 *  7. Snapshot salvo em collected_data.last_quotation
 *  8. ler_dados_card retorna last_quotation pra closer/finalizador
 *  9. defesa contra cadastro errado: plano com "Popular" no nome eh
 *     scrubbed pra "Essencial" no output
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'crypto';

const TEST_DB_PATH = '/tmp/clow-pr5-' + randomBytes(6).toString('hex') + '.db';
process.env.CRM_DB_PATH = TEST_DB_PATH;
process.env.CLOW_PII_KEY = 'pr5-test-key-with-min-16-chars';

describe('Quotation Engine — integration', () => {
  let schema: any, store: any, agentState: any, plansStore: any, engine: any, registry: any, rules: any;

  beforeAll(async () => {
    schema = await import('../../../src/crm/schema.js');
    store = await import('../../../src/crm/store.js');
    agentState = await import('../../../src/crm/store/cardAgentStateStore.js');
    plansStore = await import('../../../src/crm/store/tenantPlansStore.js');
    engine = await import('../../../src/crm/agents/quotation/quotationEngine.js');
    registry = await import('../../../src/crm/agents/tools/registry.js');
    rules = await import('../../../src/crm/agents/quotation/realPaxRules.js');
    schema.getCrmDb();
  });

  afterAll(() => {
    try { require('fs').unlinkSync(TEST_DB_PATH); } catch { /* ignore */ }
  });

  // ── helpers ──────────────────────────────────────────────────────────

  function makeTenant() { return 'tT5-' + randomBytes(4).toString('hex'); }

  function seedFuneralPlans(tenantId: string) {
    plansStore.createPlan({
      tenantId, name: 'Real Pax Essencial Individual',
      productType: 'funeral', basePriceCents: 2990,
      coverageSummary: 'Assistência funeral até R$ 5.000.',
      minAge: 0, maxAge: 75, allowsDependents: false,
      surchargeOutsideRioCents: 800, priority: 10,
    });
    plansStore.createPlan({
      tenantId, name: 'Real Pax Essencial Familiar',
      productType: 'funeral', basePriceCents: 5990,
      coverageSummary: 'Cobertura familiar até 4 pessoas.',
      minAge: 0, maxAge: 75, allowsDependents: true,
      additionalPerDependentCents: 700,
      surchargeOutsideRioCents: 800, priority: 30,
    });
  }

  function setupCardCtx(tenantId: string, role = 'cotador') {
    const board = store.seedDefaultBoards(tenantId);
    const cols = store.listColumns(tenantId, board.id);
    const contact = store.createContact(tenantId, { name: 'Joao Teste', phone: '+5511990000501', source: 'test' });
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

  // ── 1) Individual 35 anos → R$29,90 ──────────────────────────────────

  it('1. Individual 35 anos → preço R$29,90', () => {
    const tenantId = makeTenant();
    seedFuneralPlans(tenantId);
    const r = engine.buildQuotation({
      tenantId, productType: 'funeral',
      qualification: { idade: 35, regiao: 'rio' },
    });
    expect(r.ok).toBe(true);
    const ind = r.plans.find((p: any) => /Individual/.test(p.plan.name));
    expect(ind).toBeTruthy();
    expect(ind.basePriceCents).toBe(2990);
    expect(ind.eligible).toBe(true);
    expect(r.message).toContain('R$ 29,90');
  });

  // ── 2) Familiar com 3 dependentes → base + adicional ────────────────

  it('2. Familiar com 3 dependentes → 5990 + 3*700 = 8090 cents', () => {
    const tenantId = makeTenant();
    seedFuneralPlans(tenantId);
    const r = engine.buildQuotation({
      tenantId, productType: 'funeral',
      qualification: { idade: 40, numeroDependentes: 3, regiao: 'rio' },
    });
    expect(r.ok).toBe(true);
    const fam = r.plans.find((p: any) => /Familiar/.test(p.plan.name));
    expect(fam).toBeTruthy();
    expect(fam.basePriceCents).toBe(5990 + 3 * 700);
  });

  // ── 3) Fora do Rio → 2 totais (com + sem surcharge) ─────────────────

  it('3. Fora do Rio → priceLine mostra 2 valores', () => {
    const tenantId = makeTenant();
    seedFuneralPlans(tenantId);
    const r = engine.buildQuotation({
      tenantId, productType: 'funeral',
      qualification: { idade: 35, regiao: 'fora_do_rio' },
      customerName: 'Joao',
    });
    expect(r.ok).toBe(true);
    expect(r.message).toContain('R$ 29,90');         // Rio
    expect(r.message).toContain('R$ 37,90');         // 29.90 + 8.00 surcharge
    expect(r.message).toContain('Total fora do Rio');
    expect(r.message).toContain('(já incluso adicional)');
    // NAO escreve explicacao do "+R$8" nem mencionar surcharge explicit
    expect(r.message).not.toContain('+R$8');
    expect(r.message).not.toContain('surcharge');
    expect(r.message).not.toMatch(/adicional de R\$/i);
  });

  // ── 4) Cliente 95 anos → todos rejeitam por max_age ──────────────────

  it('4. Cliente 95 anos → todos rejeitam → tool retorna erro + escalate', async () => {
    const tenantId = makeTenant();
    seedFuneralPlans(tenantId);
    const ctx = setupCardCtx(tenantId, 'cotador');
    const r = await registry.executeToolCall(
      callTool('gerar_cotacao', { idade: 95, regiao: 'rio' }),
      ctx,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBe('sem_plano_compativel_idade');
    // Metric event=escalated
    const metrics = agentState.listAgentMetricsForCard(ctx.card.id);
    expect(metrics.some((m: any) => m.event === 'escalated' && /sem_plano_compativel_idade/.test(m.reason))).toBe(true);
  });

  // ── 5) Tenant sem planos → erro + escalate ──────────────────────────

  it('5. Tenant sem planos cadastrados → erro + escalate', async () => {
    const tenantId = makeTenant(); // SEM seed de planos
    const ctx = setupCardCtx(tenantId, 'cotador');
    const r = await registry.executeToolCall(
      callTool('gerar_cotacao', { idade: 30, regiao: 'rio' }),
      ctx,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBe('tenant_sem_planos_cadastrados');
    const metrics = agentState.listAgentMetricsForCard(ctx.card.id);
    expect(metrics.some((m: any) => m.event === 'escalated' && /tenant_sem_planos/.test(m.reason))).toBe(true);
  });

  // ── 6) Mensagem respeita regras de marca ─────────────────────────────

  it('6. mensagem NAO contém Popular, Rio de Janeiro no header, telefone', () => {
    const tenantId = makeTenant();
    seedFuneralPlans(tenantId);
    const r = engine.buildQuotation({
      tenantId, productType: 'funeral',
      qualification: { idade: 35, regiao: 'rio' },
      customerName: 'Maria',
    });
    expect(r.ok).toBe(true);
    const msg = r.message;
    expect(msg).not.toContain('Popular');
    // Header e a primeira linha — NAO pode citar "Rio de Janeiro"
    const header = msg.split('\n')[0];
    expect(header).not.toContain('Rio de Janeiro');
    expect(header).toMatch(/^Oi Maria/);
    // Sem telefone (nem com +55, nem (XX) XXXXX-XXXX, nem 9XXXXXXXX longo)
    expect(msg).not.toMatch(/\+55\s*\d{2}/);
    expect(msg).not.toMatch(/\(\d{2}\)\s*\d/);
  });

  // ── 7) Snapshot salvo em collected_data.last_quotation ──────────────

  it('7. tool gerar_cotacao salva snapshot em collected_data.last_quotation', async () => {
    const tenantId = makeTenant();
    seedFuneralPlans(tenantId);
    const ctx = setupCardCtx(tenantId, 'cotador');
    const r = await registry.executeToolCall(
      callTool('gerar_cotacao', { idade: 35, regiao: 'rio' }),
      ctx,
    );
    expect(r.ok).toBe(true);
    const stateAfter = agentState.getCardAgentState(ctx.card.id);
    const lq = (stateAfter.collectedData as any).last_quotation;
    expect(lq).toBeTruthy();
    expect(lq.productType).toBe('funeral');
    expect(lq.region).toBe('rio');
    expect(Array.isArray(lq.plans)).toBe(true);
    expect(lq.plans.length).toBeGreaterThan(0);
    expect(lq.plans[0].basePriceCents).toBe(2990);
  });

  // ── 8) ler_dados_card retorna last_quotation ────────────────────────

  it('8. closer le ler_dados_card → recebe last_quotation', async () => {
    const tenantId = makeTenant();
    seedFuneralPlans(tenantId);
    const ctxCotador = setupCardCtx(tenantId, 'cotador');
    await registry.executeToolCall(
      callTool('gerar_cotacao', { idade: 35, regiao: 'rio' }),
      ctxCotador,
    );
    // Simula closer no MESMO card
    const ctxCloser = { ...ctxCotador, role: 'closer' as const };
    const r = await registry.executeToolCall(
      callTool('ler_dados_card', {}),
      ctxCloser,
    );
    expect(r.ok).toBe(true);
    expect(r.result.last_quotation).toBeTruthy();
    expect(r.result.last_quotation.plans[0].basePriceCents).toBe(2990);
  });

  // ── 9) scrub "Popular" → "Essencial" ────────────────────────────────

  it('9. plano com "Popular" no nome (cadastro errado) eh scrubbed pra "Essencial"', () => {
    const tenantId = makeTenant();
    plansStore.createPlan({
      tenantId, name: 'Real Pax Popular Individual',
      productType: 'funeral', basePriceCents: 2990,
      coverageSummary: 'Cobertura basica.',
      minAge: 0, maxAge: 75, surchargeOutsideRioCents: 800, priority: 10,
    });
    const r = engine.buildQuotation({
      tenantId, productType: 'funeral',
      qualification: { idade: 35, regiao: 'rio' },
    });
    expect(r.ok).toBe(true);
    expect(r.message).not.toContain('Popular');
    expect(r.message).toContain('Essencial');
    // Snapshot tambem scrubbed
    expect(r.snapshot.plans[0].name).toBe('Real Pax Essencial Individual');
    // E o util scrubPlanName diretamente
    expect(rules.scrubPlanName('Real Pax Popular Individual')).toBe('Real Pax Essencial Individual');
  });
});
