/**
 * Asaas webhook auth — fail-closed.
 *
 * Regressao de seguranca: antes, ASAAS_WEBHOOK_TOKEN vazio fazia o endpoint
 * aceitar qualquer POST sem validacao (eventos de cobranca forjados podiam
 * reativar/suspender tenants). Agora:
 *   - sem ASAAS_WEBHOOK_TOKEN no env  → 503 webhook_not_configured
 *   - token errado                    → 401 invalid_signature
 *   - token correto                   → 200 ok
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildBillingRoutes } from '../../../src/server/adminRoutes.js';

const ORIGINAL_TOKEN = process.env.ASAAS_WEBHOOK_TOKEN;

function post(app: ReturnType<typeof buildBillingRoutes>, headers: Record<string, string> = {}) {
  return app.fetch(new Request('http://local/webhooks/asaas', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    // payload sem event/payment — rota responde ok sem side effects
    body: JSON.stringify({}),
  }));
}

describe('Asaas webhook auth (fail-closed)', () => {
  beforeEach(() => { delete process.env.ASAAS_WEBHOOK_TOKEN; });
  afterEach(() => {
    if (ORIGINAL_TOKEN === undefined) delete process.env.ASAAS_WEBHOOK_TOKEN;
    else process.env.ASAAS_WEBHOOK_TOKEN = ORIGINAL_TOKEN;
  });

  it('rejeita com 503 quando ASAAS_WEBHOOK_TOKEN nao esta configurado', async () => {
    const app = buildBillingRoutes();
    const res = await post(app, { 'asaas-access-token': 'qualquer' });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'webhook_not_configured' });
  });

  it('rejeita com 401 quando o token nao bate', async () => {
    process.env.ASAAS_WEBHOOK_TOKEN = 'token-certo';
    const app = buildBillingRoutes();
    const res = await post(app, { 'asaas-access-token': 'token-errado' });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'invalid_signature' });
  });

  it('rejeita com 401 quando o header esta ausente', async () => {
    process.env.ASAAS_WEBHOOK_TOKEN = 'token-certo';
    const app = buildBillingRoutes();
    const res = await post(app);
    expect(res.status).toBe(401);
  });

  it('aceita com 200 quando o token bate', async () => {
    process.env.ASAAS_WEBHOOK_TOKEN = 'token-certo';
    const app = buildBillingRoutes();
    const res = await post(app, { 'asaas-access-token': 'token-certo' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });
});
