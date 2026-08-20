/**
 * DELETE /subscriptions/:id — a rota HTTP.
 *
 * Os testes de `subscription-delete.test.ts` cobrem a função do store; estes
 * exercitam a rota de verdade, com o tenant vindo do contexto da requisição
 * como acontece em produção. O que importa provar aqui é que o id da URL não
 * decide nada sozinho: quem manda é o tenant da sessão.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { Hono } from 'hono';
import { randomBytes } from 'crypto';

const TEST_DB_PATH = '/tmp/clow-sub-http-' + randomBytes(6).toString('hex') + '.db';
process.env.CRM_DB_PATH = TEST_DB_PATH;
process.env.CLOW_PII_KEY = 'sub-http-test-key-with-min-16-chars-a';

describe('DELETE /subscriptions/:id', () => {
  let app: Hono;
  let store: any;
  let tenantAtual = '';

  beforeAll(async () => {
    const schema = await import('../../../src/crm/schema.js');
    store = await import('../../../src/crm/store.js');
    const { registerSubscriptionsRoutes } = await import('../../../src/crm/routes/subscriptions.js');
    schema.getCrmDb();

    app = new Hono();
    // Faz o papel do middleware de autenticação: em produção o tenant sai da
    // chave de API validada, nunca do corpo ou da URL. `tenantAtual` é o
    // equivalente a "quem está logado agora".
    app.use('*', async (c, next) => { c.set('tenantId' as never, tenantAtual as never); await next(); });
    registerSubscriptionsRoutes(app);
  });

  function criar(tenantId: string, plano = 'Azos') {
    const contato = store.createContact(tenantId, {
      name: 'Cliente ' + randomBytes(2).toString('hex'),
      phone: '5521' + String(Math.floor(Math.random() * 1e9)).padStart(9, '0'),
      source: 'teste',
    });
    return store.createSubscription(tenantId, {
      contactId: contato.id, planName: plano, amountCents: 32500,
      cycle: 'monthly', nextChargeAt: Date.now() + 86400000,
    });
  }

  it('apaga e some da listagem da rota', async () => {
    tenantAtual = 'tn-' + randomBytes(4).toString('hex');
    const sub = criar(tenantAtual);

    const antes = await (await app.request('/subscriptions')).json() as any;
    expect(antes.subscriptions).toHaveLength(1);

    const r = await app.request(`/subscriptions/${sub.id}`, { method: 'DELETE' });
    expect(r.status).toBe(200);

    const depois = await (await app.request('/subscriptions')).json() as any;
    expect(depois.subscriptions).toHaveLength(0);
  });

  it('id de outro tenant devolve 404 e não apaga nada', async () => {
    const dono = 'tn-' + randomBytes(4).toString('hex');
    const sub = criar(dono, 'Plano do Dono');

    // Outro cliente logado, com o id correto em mãos.
    tenantAtual = 'tn-' + randomBytes(4).toString('hex');
    const r = await app.request(`/subscriptions/${sub.id}`, { method: 'DELETE' });
    expect(r.status).toBe(404);

    // A mensalidade do dono continua intacta.
    tenantAtual = dono;
    const lista = await (await app.request('/subscriptions')).json() as any;
    expect(lista.subscriptions).toHaveLength(1);
    expect(lista.subscriptions[0].planName).toBe('Plano do Dono');
  });

  it('id inexistente devolve 404', async () => {
    tenantAtual = 'tn-' + randomBytes(4).toString('hex');
    const r = await app.request('/subscriptions/crm_sub_naoexiste', { method: 'DELETE' });
    expect(r.status).toBe(404);
  });

  it('apagar duas vezes: 200 e depois 404', async () => {
    tenantAtual = 'tn-' + randomBytes(4).toString('hex');
    const sub = criar(tenantAtual);
    expect((await app.request(`/subscriptions/${sub.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await app.request(`/subscriptions/${sub.id}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('apagar não mexe na mensalidade vizinha', async () => {
    tenantAtual = 'tn-' + randomBytes(4).toString('hex');
    const a = criar(tenantAtual, 'Plano A');
    const b = criar(tenantAtual, 'Plano B');

    await app.request(`/subscriptions/${a.id}`, { method: 'DELETE' });

    const lista = await (await app.request('/subscriptions')).json() as any;
    expect(lista.subscriptions).toHaveLength(1);
    expect(lista.subscriptions[0].id).toBe(b.id);
  });
});
