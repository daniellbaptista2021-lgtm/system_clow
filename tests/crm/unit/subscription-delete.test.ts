/**
 * Apagar mensalidade — soft delete.
 *
 * "Apagar" é diferente de "Cancelar": cancelar encerra a cobrança e mantém o
 * registro visível entre as canceladas; apagar tira a mensalidade de todas as
 * listas, contadores e buscas. Estes testes fixam essa distinção, o
 * isolamento por tenant e o que NÃO pode ser afetado junto.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { randomBytes } from 'crypto';

const TEST_DB_PATH = '/tmp/clow-sub-del-' + randomBytes(6).toString('hex') + '.db';
process.env.CRM_DB_PATH = TEST_DB_PATH;
process.env.CLOW_PII_KEY = 'sub-delete-test-key-min-16-chars-aaaa';

describe('apagar mensalidade', () => {
  let store: any, schema: any;

  beforeAll(async () => {
    schema = await import('../../../src/crm/schema.js');
    store = await import('../../../src/crm/store.js');
    schema.getCrmDb();
  });

  const tn = () => 'tn-' + randomBytes(4).toString('hex');

  function criarMensalidade(tenantId: string, nome = 'Azos', valor = 32500) {
    const contato = store.createContact(tenantId, {
      name: 'Cliente ' + randomBytes(2).toString('hex'),
      phone: '5521' + String(Math.floor(Math.random() * 1e9)).padStart(9, '0'),
      source: 'teste',
    });
    const sub = store.createSubscription(tenantId, {
      contactId: contato.id,
      planName: nome,
      amountCents: valor,
      cycle: 'monthly',
      nextChargeAt: Date.now() + 86400000,
    });
    return { contato, sub };
  }

  // ── caso 3: confirmar exclusão ──────────────────────────────────────────
  it('caso 3 — apagada some da listagem', () => {
    const t = tn();
    const { sub } = criarMensalidade(t);
    expect(store.listSubscriptions(t)).toHaveLength(1);

    expect(store.softDeleteSubscription(t, sub.id)).toBe(true);
    expect(store.listSubscriptions(t)).toHaveLength(0);
  });

  // ── caso 4: persiste depois do reload ───────────────────────────────────
  it('caso 4 — continua sumida numa leitura nova (persistiu no banco)', () => {
    const t = tn();
    const { sub } = criarMensalidade(t);
    store.softDeleteSubscription(t, sub.id);

    // Releitura direta do banco: é o que um F5 faz.
    expect(store.listSubscriptions(t)).toHaveLength(0);
    expect(store.listSubscriptions(t).some((x: any) => x.id === sub.id)).toBe(false);
  });

  // ── caso 5: filtros ─────────────────────────────────────────────────────
  it('caso 5 — não reaparece em nenhum filtro de status', () => {
    const t = tn();
    const { sub } = criarMensalidade(t);
    store.softDeleteSubscription(t, sub.id);

    for (const status of ['active', 'past_due', 'cancelled']) {
      expect(store.listSubscriptions(t, status), `filtro ${status}`).toHaveLength(0);
    }
    expect(store.listSubscriptions(t)).toHaveLength(0);
  });

  it('não aparece nos contadores do painel', () => {
    const t = tn();
    const { sub } = criarMensalidade(t, 'Plano X', 50000);
    const antes = store.computeMrr(t);
    expect(antes.activeSubs).toBeGreaterThan(0);

    store.softDeleteSubscription(t, sub.id);
    const depois = store.computeMrr(t);
    expect(depois.activeSubs).toBe(0);
    expect(depois.totalMrrCents).toBe(0);
  });

  it('não volta na cobrança automática', () => {
    const t = tn();
    const contato = store.createContact(t, { name: 'Vencida', phone: '5521' + Date.now().toString().slice(-9), source: 't' });
    const sub = store.createSubscription(t, {
      contactId: contato.id, planName: 'Vencido', amountCents: 1000,
      cycle: 'monthly', nextChargeAt: Date.now() - 86400000, // já venceu
    });
    expect(store.listSubscriptionsDue().some((s: any) => s.id === sub.id)).toBe(true);

    store.softDeleteSubscription(t, sub.id);
    expect(store.listSubscriptionsDue().some((s: any) => s.id === sub.id)).toBe(false);
  });

  // ── caso 6: não afeta as outras ─────────────────────────────────────────
  it('caso 6 — apagar A não mexe em B', () => {
    const t = tn();
    const a = criarMensalidade(t, 'Plano A', 10000);
    const b = criarMensalidade(t, 'Plano B', 20000);

    store.softDeleteSubscription(t, a.sub.id);

    const restantes = store.listSubscriptions(t);
    expect(restantes).toHaveLength(1);
    expect(restantes[0].id).toBe(b.sub.id);
    expect(restantes[0].planName).toBe('Plano B');
    expect(restantes[0].amountCents).toBe(20000);
  });

  // ── caso 7: isolamento entre tenants ────────────────────────────────────
  it('caso 7 — tenant B não consegue apagar mensalidade do tenant A', () => {
    const tA = tn();
    const tB = tn();
    const { sub } = criarMensalidade(tA);

    // Mesmo com o id correto em mãos, o tenant errado não apaga nada.
    expect(store.softDeleteSubscription(tB, sub.id)).toBe(false);
    expect(store.listSubscriptions(tA)).toHaveLength(1);
    expect(store.listSubscriptions(tA)[0].id).toBe(sub.id);
  });

  it('id inexistente devolve false, sem estourar', () => {
    const t = tn();
    expect(store.softDeleteSubscription(t, 'crm_sub_naoexiste')).toBe(false);
  });

  it('apagar duas vezes é idempotente — a segunda diz que não havia o que apagar', () => {
    const t = tn();
    const { sub } = criarMensalidade(t);
    expect(store.softDeleteSubscription(t, sub.id)).toBe(true);
    expect(store.softDeleteSubscription(t, sub.id)).toBe(false);
  });

  // ── apagar ≠ cancelar ───────────────────────────────────────────────────
  it('cancelar mantém visível; apagar remove — são ações distintas', () => {
    const t = tn();
    const { sub } = criarMensalidade(t);

    store.cancelSubscription(t, sub.id, 'cliente pediu');
    const canceladas = store.listSubscriptions(t, 'cancelled');
    expect(canceladas, 'cancelada continua na lista').toHaveLength(1);
    expect(canceladas[0].status).toBe('cancelled');

    store.softDeleteSubscription(t, sub.id);
    expect(store.listSubscriptions(t, 'cancelled'), 'apagada sai da lista').toHaveLength(0);
  });

  // ── o que NÃO pode ser afetado ──────────────────────────────────────────
  it('apagar a mensalidade não apaga o contato', () => {
    const t = tn();
    const { contato, sub } = criarMensalidade(t);

    store.softDeleteSubscription(t, sub.id);

    const aindaLa = store.getContact(t, contato.id);
    expect(aindaLa).not.toBeNull();
    expect(aindaLa.name).toBe(contato.name);
  });

  it('apagar a mensalidade não apaga o histórico de atividades do contato', () => {
    const t = tn();
    const { contato, sub } = criarMensalidade(t);
    store.logActivity(t, {
      contactId: contato.id, type: 'message_in', channel: 'whatsapp_evolution',
      direction: 'in', content: 'oi, sobre o plano',
    });

    store.softDeleteSubscription(t, sub.id);

    const historico = store.listActivitiesByContact(t, contato.id);
    expect(historico.length).toBeGreaterThan(0);
    expect(historico.some((a: any) => a.content === 'oi, sobre o plano')).toBe(true);
  });

  it('a linha continua no banco — soft delete, não DELETE', () => {
    const t = tn();
    const { sub } = criarMensalidade(t);
    store.softDeleteSubscription(t, sub.id);

    const db = schema.getCrmDb();
    const row: any = db.prepare('SELECT id, deleted_at, plan_name FROM crm_subscriptions WHERE id = ?').get(sub.id);
    expect(row, 'a linha não pode ter sumido: o gateway e o histórico apontam para ela').toBeTruthy();
    expect(row.deleted_at).toBeGreaterThan(0);
    expect(row.plan_name).toBe('Azos');
  });
});
