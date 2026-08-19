/**
 * /admin/dashboard — controle de acesso.
 *
 * Existe por causa de uma regressao real: o handler chamava
 * `if (!verifyAdminSessionToken(token))`, e a funcao devolve `{ ok, username }`.
 * Objeto e sempre truthy, entao o `!` nunca era verdadeiro e o 401 jamais
 * disparava — o dashboard (metricas, sessoes ativas, custos, estado do banco)
 * respondia 200 pra qualquer um, sem token. Como e uma falha silenciosa, nada
 * na suite acusava.
 *
 * Monta a rota direto via `app.fetch(Request)`, no mesmo estilo de
 * health.test.ts — sem subir listener TCP.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { Hono } from 'hono';
import { buildDashboardRoutes } from '../../src/server/adminDashboard.js';
import { createAdminSessionToken } from '../../src/server/middleware/tenantAuth.js';

/** Pool minimo — o dashboard so chama listActive(). */
const fakePool = { listActive: () => [] };

function mountDashboard(): Hono {
  const app = new Hono();
  app.route('/', buildDashboardRoutes(fakePool));
  return app;
}

function get(app: Hono, path: string, headers: Record<string, string> = {}): Promise<Response> {
  return app.fetch(new Request(`http://localhost${path}`, { headers }));
}

beforeAll(() => {
  // createAdminSessionToken exige segredo configurado.
  process.env.CLOW_ADMIN_SESSION_SECRET ||= 'segredo-de-teste-admin-dashboard';
});

describe('GET /admin/dashboard — exige sessao admin', () => {
  it('nega sem token nenhum', async () => {
    const r = await get(mountDashboard(), '/admin/dashboard');
    expect(r.status).toBe(401);
  });

  it('nega com token invalido na query string', async () => {
    const r = await get(mountDashboard(), '/admin/dashboard?token=nao-e-token');
    expect(r.status).toBe(401);
  });

  it('nega com Bearer invalido', async () => {
    const r = await get(mountDashboard(), '/admin/dashboard', { Authorization: 'Bearer nao-e-token' });
    expect(r.status).toBe(401);
  });

  it('nega token bem-formado mas com assinatura de outro segredo', async () => {
    const legitimo = createAdminSessionToken('daniel');
    const [payload] = legitimo.split('.');
    const forjado = `${payload}.assinaturaForjadaQueNaoBate`;
    const r = await get(mountDashboard(), `/admin/dashboard?token=${forjado}`);
    expect(r.status).toBe(401);
  });

  it('nao vaza o HTML do dashboard junto do 401', async () => {
    const r = await get(mountDashboard(), '/admin/dashboard');
    const body = await r.text();
    expect(body).not.toContain('Admin Dashboard');
    expect(body).toContain('Acesso negado');
  });

  it('libera com token de sessao admin valido', async () => {
    const token = createAdminSessionToken('daniel');
    const r = await get(mountDashboard(), `/admin/dashboard?token=${token}`);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('Admin Dashboard');
  });
});
