/**
 * Tests da tool cotar_sulamerica_api OFFLINE (HARDENING 6).
 *
 * Daniel 2026-05-06: tool deixou de chamar API e virou cálculo via
 * tabela hardcoded. Cobre todos os 8 valores principais + adicionais
 * + edge cases (idade fora, composição inválida) + verificação de
 * que userVisible NÃO contém termos proibidos.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'crypto';

const TEST_DB_PATH = '/tmp/clow-cot-' + randomBytes(6).toString('hex') + '.db';
process.env.CRM_DB_PATH = TEST_DB_PATH;
process.env.CLOW_PII_KEY = 'cot-test-key-with-min-16-chars-aaaa';

describe('cotar_sulamerica_api — tabela offline', () => {
  let schema: any, store: any, agentState: any, registry: any;

  beforeAll(async () => {
    schema = await import('../../../src/crm/schema.js');
    store = await import('../../../src/crm/store.js');
    agentState = await import('../../../src/crm/store/cardAgentStateStore.js');
    registry = await import('../../../src/crm/agents/tools/registry.js');
    schema.getCrmDb();
  });

  afterAll(() => {
    try { require('fs').unlinkSync(TEST_DB_PATH); } catch { /* ignore */ }
  });

  // ── helpers ──────────────────────────────────────────────────────────
  function makeTenant() { return 'tCot-' + randomBytes(4).toString('hex'); }

  function setupCard(tenantId: string, idade?: number) {
    const board = store.seedDefaultBoards(tenantId);
    const cols = store.listColumns(tenantId, board.id);
    const db = schema.getCrmDb();
    db.prepare(`
      UPDATE crm_columns SET agent_enabled=1, agent_role='vendedor',
        agent_system_prompt='voce e safira',
        agent_active_hours_start='00:00', agent_active_hours_end='23:59'
      WHERE id=?
    `).run(cols[0].id);
    const contact = store.createContact(tenantId, {
      name: 'Cliente Teste', phone: '+5511999999999', source: 'test',
    });
    const card = store.createCard(tenantId, {
      boardId: board.id, columnId: cols[0].id, title: contact.name, contactId: contact.id,
    });
    const state = agentState.upsertCardAgentState({
      cardId: card.id, columnId: cols[0].id, currentAgentRole: 'vendedor',
      tenantId, status: 'active',
      collectedData: idade ? { qualification: { idade, nome: 'Cliente Teste' } } : undefined,
    });
    return {
      tenantId,
      ctx: {
        tenantId,
        channel: { id: 'ch_x', tenantId, type: 'zapi', name: 'T', credentialsEncrypted: '', webhookSecret: '', createdAt: Date.now() },
        card, column: cols[0], state,
        customerPhone: '+5511999999999', role: 'vendedor' as const,
      },
    };
  }

  function callTool(args: any) {
    return {
      id: 'call_' + randomBytes(3).toString('hex'),
      type: 'function' as const,
      function: { name: 'cotar_sulamerica_api', arguments: JSON.stringify(args) },
    };
  }

  // ── tabela principal ─────────────────────────────────────────────────

  describe('Tabela de preços oficial (Daniel 2026-05-06)', () => {
    it('Individual 30 anos → R$ 29,90', async () => {
      const { ctx } = setupCard(makeTenant(), 30);
      const r = await registry.executeToolCall(
        callTool({ idade: 30, composicao: 'individual' }), ctx);
      expect(r.ok).toBe(true);
      expect((r as any).result.total_cents).toBe(2990);
      expect(r.userVisible).toContain('R$ 29,90');
    });

    it('Individual 45 anos (limite jovem) → R$ 29,90', async () => {
      const { ctx } = setupCard(makeTenant(), 45);
      const r = await registry.executeToolCall(
        callTool({ composicao: 'individual' }), ctx);
      expect((r as any).result.total_cents).toBe(2990);
    });

    it('Individual 46 anos (limite velho) → R$ 39,90', async () => {
      const { ctx } = setupCard(makeTenant(), 46);
      const r = await registry.executeToolCall(
        callTool({ composicao: 'individual' }), ctx);
      expect((r as any).result.total_cents).toBe(3990);
    });

    it('Individual 70 anos → R$ 39,90', async () => {
      const { ctx } = setupCard(makeTenant(), 70);
      const r = await registry.executeToolCall(
        callTool({ composicao: 'individual' }), ctx);
      expect((r as any).result.total_cents).toBe(3990);
    });

    it('Casal 35 → R$ 39,90', async () => {
      const { ctx } = setupCard(makeTenant(), 35);
      const r = await registry.executeToolCall(
        callTool({ composicao: 'casal' }), ctx);
      expect((r as any).result.total_cents).toBe(3990);
    });

    it('Casal 60 → R$ 49,90', async () => {
      const { ctx } = setupCard(makeTenant(), 60);
      const r = await registry.executeToolCall(
        callTool({ composicao: 'casal' }), ctx);
      expect((r as any).result.total_cents).toBe(4990);
    });

    it('Casal + filhos 35 → R$ 49,90', async () => {
      const { ctx } = setupCard(makeTenant(), 35);
      const r = await registry.executeToolCall(
        callTool({ composicao: 'casal_filhos' }), ctx);
      expect((r as any).result.total_cents).toBe(4990);
    });

    it('Casal + filhos 50 → R$ 59,90', async () => {
      const { ctx } = setupCard(makeTenant(), 50);
      const r = await registry.executeToolCall(
        callTool({ composicao: 'casal_filhos' }), ctx);
      expect((r as any).result.total_cents).toBe(5990);
    });

    it('Completo 30 → R$ 89,90', async () => {
      const { ctx } = setupCard(makeTenant(), 30);
      const r = await registry.executeToolCall(
        callTool({ composicao: 'completo' }), ctx);
      expect((r as any).result.total_cents).toBe(8990);
    });

    it('Completo 65 → R$ 109,90', async () => {
      const { ctx } = setupCard(makeTenant(), 65);
      const r = await registry.executeToolCall(
        callTool({ composicao: 'completo' }), ctx);
      expect((r as any).result.total_cents).toBe(10990);
      expect(r.userVisible).toContain('R$ 109,90');
    });
  });

  // ── adicionais ───────────────────────────────────────────────────────

  describe('Adicionais (planos separados)', () => {
    it('Casal+filhos 30 + 1 filho>21 → 49,90 principal + 12,00 separado = 61,90 total', async () => {
      const { ctx } = setupCard(makeTenant(), 30);
      const r = await registry.executeToolCall(
        callTool({ composicao: 'casal_filhos', filhos_maior_21: 1 }), ctx);
      expect((r as any).result.total_cents).toBe(4990); // só principal
      expect((r as any).result.total_incluindo_separados_cents).toBe(6190);
    });

    it('Individual 30 + 2 outros dependentes → 29,90 + 28,00 = 57,90', async () => {
      const { ctx } = setupCard(makeTenant(), 30);
      const r = await registry.executeToolCall(
        callTool({ composicao: 'individual', outros_dependentes: 2 }), ctx);
      expect((r as any).result.total_cents).toBe(2990);
      expect((r as any).result.total_incluindo_separados_cents).toBe(2990 + 2 * 1400);
    });

    it('Individual 30 + Médico na Tela → 29,90 + 14,00 = 43,90 no principal', async () => {
      const { ctx } = setupCard(makeTenant(), 30);
      const r = await registry.executeToolCall(
        callTool({ composicao: 'individual', incluir_medico_tela: true }), ctx);
      expect((r as any).result.total_cents).toBe(4390);
      expect(r.userVisible).toContain('R$ 43,90');
      expect(r.userVisible).toContain('Médico na Tela');
    });

    it('Combinação completa: Completo 50 + Médico Tela + 1 filho>21 + 2 outros',
      async () => {
        const { ctx } = setupCard(makeTenant(), 50);
        const r = await registry.executeToolCall(
          callTool({
            composicao: 'completo',
            incluir_medico_tela: true,
            filhos_maior_21: 1,
            outros_dependentes: 2,
          }), ctx);
        // principal: 109,90 + 14 (médico) = 123,90
        expect((r as any).result.total_cents).toBe(12390);
        // total: 123,90 + 12 (filho) + 28 (2 outros) = 163,90
        expect((r as any).result.total_incluindo_separados_cents).toBe(16390);
      });
  });

  // ── edge cases ───────────────────────────────────────────────────────

  describe('Validações', () => {
    it('idade < 18 → erro', async () => {
      const { ctx } = setupCard(makeTenant(), 17);
      const r = await registry.executeToolCall(
        callTool({ composicao: 'individual' }), ctx);
      expect(r.ok).toBe(false);
      expect((r as any).error).toMatch(/idade_invalida/);
    });

    it('idade > 74 → erro com sugestão de escalar humano', async () => {
      const { ctx } = setupCard(makeTenant(), 75);
      const r = await registry.executeToolCall(
        callTool({ composicao: 'individual' }), ctx);
      expect(r.ok).toBe(false);
      expect((r as any).error).toMatch(/74/);
    });

    it('composicao inválida → erro', async () => {
      const { ctx } = setupCard(makeTenant(), 30);
      const r = await registry.executeToolCall(
        callTool({ composicao: 'familiar_ampliado' as any }), ctx);
      expect(r.ok).toBe(false);
      expect((r as any).error).toMatch(/composicao_invalida/);
    });

    it('lê idade da qualification se não passar nos args', async () => {
      const { ctx } = setupCard(makeTenant(), 50);
      const r = await registry.executeToolCall(
        callTool({ composicao: 'casal' }), ctx);
      expect(r.ok).toBe(true);
      expect((r as any).result.total_cents).toBe(4990); // 50 anos = older
    });
  });

  // ── side effects ─────────────────────────────────────────────────────

  describe('Side effects', () => {
    it('grava snapshot em collected_data.last_quotation', async () => {
      const { ctx } = setupCard(makeTenant(), 35);
      await registry.executeToolCall(
        callTool({ composicao: 'casal_filhos' }), ctx);
      const fresh = agentState.getCardAgentState(ctx.card.id);
      expect(fresh.collectedData.last_quotation).toBeDefined();
      expect(fresh.collectedData.last_quotation.total_cents).toBe(4990);
      expect(fresh.collectedData.last_quotation.composicao).toBe('casal_filhos');
    });

    it('userVisible NÃO contém termos proibidos pelo outputValidator', async () => {
      const { ctx } = setupCard(makeTenant(), 35);
      const r = await registry.executeToolCall(
        callTool({ composicao: 'completo', incluir_medico_tela: true }), ctx);
      expect(r.userVisible).toBeDefined();
      // Sem API/sistema/cotador/oficial — pega caso Neide/Claudio
      expect(r.userVisible).not.toMatch(/\bAPI\b/i);
      expect(r.userVisible).not.toMatch(/cotador/i);
      expect(r.userVisible).not.toMatch(/sistema\s+oficial/i);
      expect(r.userVisible).not.toMatch(/cota[çc][aã]o\s+oficial/i);
      expect(r.userVisible).not.toMatch(/vou\s+consultar\s+o\s+sistema/i);
    });

    it('userVisible inclui FAQ-friendly: cobertura nacional + indenizações + carências', async () => {
      const { ctx } = setupCard(makeTenant(), 35);
      const r = await registry.executeToolCall(
        callTool({ composicao: 'casal' }), ctx);
      expect(r.userVisible).toContain('R$ 50 mil');
      expect(r.userVisible).toContain('R$ 500');
      expect(r.userVisible).toContain('todo Brasil');
      expect(r.userVisible).toMatch(/Carências/);
      expect(r.userVisible).toContain('120 dias'); // familiar
    });

    it('Individual usa carência de 90 dias (não 120)', async () => {
      const { ctx } = setupCard(makeTenant(), 35);
      const r = await registry.executeToolCall(
        callTool({ composicao: 'individual' }), ctx);
      expect(r.userVisible).toContain('90 dias');
      expect(r.userVisible).not.toContain('120 dias');
    });
  });
});
