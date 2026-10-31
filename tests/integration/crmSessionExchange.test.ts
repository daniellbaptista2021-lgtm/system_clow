import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let home: string;
let HonoClass: typeof import('hono').Hono;
let registerAuthExchangeRoutes: typeof import('../../src/crm/routes/auth-exchange.js').registerAuthExchangeRoutes;
let createTenant: typeof import('../../src/tenancy/tenantStore.js').createTenant;
let listApiKeysForTenant: typeof import('../../src/tenancy/tenantStore.js').listApiKeysForTenant;
let signUserToken: typeof import('../../src/auth/authRoutes.js').signUserToken;

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'evox-session-exchange-'));
  process.env.CLOW_HOME = home;
  process.env.CRM_DB_PATH = path.join(home, 'crm.sqlite3');
  process.env.CLOW_USER_SESSION_SECRET = 'teste-session-exchange-nao-usar-em-producao';
  ({ Hono: HonoClass } = await import('hono'));
  ({ registerAuthExchangeRoutes } = await import('../../src/crm/routes/auth-exchange.js'));
  ({ createTenant, listApiKeysForTenant } = await import('../../src/tenancy/tenantStore.js'));
  ({ signUserToken } = await import('../../src/auth/authRoutes.js'));
});

afterAll(() => {
  delete process.env.CLOW_HOME;
  delete process.env.CRM_DB_PATH;
  delete process.env.CLOW_USER_SESSION_SECRET;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('sessão do CRM em mais de um aparelho', () => {
  it('reutiliza a sessão válida sem criar nem revogar API keys', async () => {
    const { tenant } = createTenant({ email: 'daniel@teste.local', name: 'Daniel', tier: 'starter' });
    const token = signUserToken({ tid: tenant.id, uid: tenant.id, email: tenant.email, role: 'owner' });
    const antes = listApiKeysForTenant(tenant.id).length;

    const app = new HonoClass();
    registerAuthExchangeRoutes(app);
    const trocar = () => app.request('/auth/exchange', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });

    const primeira = await trocar();
    const segunda = await trocar();
    expect(primeira.status).toBe(200);
    expect(segunda.status).toBe(200);
    expect((await primeira.json()).api_key).toBe(token);
    expect((await segunda.json()).api_key).toBe(token);
    expect(listApiKeysForTenant(tenant.id)).toHaveLength(antes);
  });
});
