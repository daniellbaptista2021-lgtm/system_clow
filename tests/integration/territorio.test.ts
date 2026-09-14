import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { emitirCredencialCrm } from '../../src/tenancy/territorioToken.js';
import { ensureTerritorioTenant, createTenant, listTenants, listApiKeysForTenant, updateTenant } from '../../src/tenancy/tenantStore.js';
import { tenantAuth, createAdminSessionToken, verifyAdminSessionToken } from '../../src/server/middleware/tenantAuth.js';
import { verifyUserToken, signUserToken } from '../../src/auth/authRoutes.js';
import { buildTerritorioRoutes } from '../../src/server/territorioRoutes.js';
import crmRoutes from '../../src/crm/routes.js';
import { closeCrmDb } from '../../src/crm/schema.js';
import { createContact, getContact } from '../../src/crm/store/contactsStore.js';
import { subscriberCount, publish } from '../../src/crm/events.js';

const a = { sub: '11111111-1111-4111-8111-111111111111', email: 'ana@example.test', name: 'Ana' };
const b = { sub: '22222222-2222-4222-8222-222222222222', email: 'bia@example.test', name: 'Bia' };
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'crm-territorio-test-'));
  vi.stubEnv('CLOW_HOME', home);
  vi.stubEnv('CRM_DB_PATH', join(home, 'crm.sqlite3'));
  vi.stubEnv('CRM_TERRITORIO_ENABLED', 'true');
  vi.stubEnv('CRM_TERRITORIO_EXCLUSIVO', 'true');
  vi.stubEnv('CRM_TERRITORIO_SECRET', 'segredo-de-teste-do-crm-com-32-caracteres');
  vi.stubEnv('CLOW_ADMIN_SESSION_SECRET', 'teste-admin-secret');
  vi.stubEnv('CLOW_MIGRATION_LOG', '0');
});
afterEach(() => { closeCrmDb(); rmSync(home, { recursive: true, force: true }); vi.useRealTimers(); vi.unstubAllEnvs(); });

function app() {
  const server = new Hono();
  server.route('/', buildTerritorioRoutes());
  server.use('/v1/crm/*', tenantAuth);
  server.route('/v1/crm', crmRoutes);
  return server;
}
const session = (p: typeof a, tid: string, now = Date.now()) => emitirCredencialCrm({ ...p, tid }, 'session', undefined, now);
const req = (server: Hono, path: string, token: string, method = 'GET', body?: unknown) => server.request(path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });

describe('Território → CRM real com SQLite isolado', () => {
  it('provisiona uma vez, sem senha, API key ou cobrança; ignora tenant escolhido pelo cliente', async () => {
    const server = app();
    const token = emitirCredencialCrm(a, 'provision');
    const first = await req(server, '/integrations/territorio/tenant', token, 'POST', { tenant_id: 'admin' });
    expect(first.status).toBe(200);
    const id = (await first.json()).tenant_id;
    const again = await req(server, '/integrations/territorio/tenant', token, 'POST');
    expect((await again.json()).tenant_id).toBe(id);
    expect(listTenants()).toHaveLength(1);
    expect(listTenants()[0].password_hash).toBeUndefined();
    expect(listTenants()[0].stripe_customer_id).toBeUndefined();
    expect(listApiKeysForTenant(id)).toHaveLength(0);
  });

  it('preserva CRM existente e dados ao vincular o dono confirmado; não duplica na troca de email', () => {
    const { tenant } = createTenant({ email: a.email, name: 'CRM antigo', tier: 'starter' });
    const contact = createContact(tenant.id, { name: 'Contato já existente' });
    expect(ensureTerritorioTenant(a).id).toBe(tenant.id);
    expect(ensureTerritorioTenant({ ...a, email: 'novo@example.test' }).id).toBe(tenant.id);
    expect(getContact(tenant.id, contact.id)?.name).toBe('Contato já existente');
    expect(() => ensureTerritorioTenant({ ...b, email: a.email })).toThrow();
  });

  it('o admin é mapeado só pelo UUID configurado e recebe sessão limitada ao próprio CRM', () => {
    const { tenant } = createTenant({ email: 'admin@clow.dev', name: 'Daniel', tier: 'starter' });
    vi.stubEnv('CRM_TERRITORIO_OWNER_PROFILE_ID', a.sub);
    vi.stubEnv('CRM_TERRITORIO_OWNER_TENANT_ID', tenant.id);
    expect(ensureTerritorioTenant(b).id).not.toBe(tenant.id);
    expect(ensureTerritorioTenant(a).id).toBe(tenant.id);
    expect(verifyAdminSessionToken(session(a, tenant.id)).ok).toBe(false);
    expect(verifyUserToken(session(a, tenant.id))?.tid).toBe(tenant.id);
  });

  it('um cliente não lista, lê, edita nem apaga contato de outro cliente', async () => {
    const ta = ensureTerritorioTenant(a), tb = ensureTerritorioTenant(b);
    const contact = createContact(ta.id, { name: 'Contato privado de Ana' });
    const server = app();
    const token = session(b, tb.id);
    const list = await req(server, '/v1/crm/contacts', token);
    expect(list.status).toBe(200);
    expect(JSON.stringify(await list.json())).not.toContain(contact.name);
    for (const method of ['GET', 'PATCH', 'DELETE']) {
      const result = await req(server, `/v1/crm/contacts/${contact.id}`, token, method, method === 'PATCH' ? { name: 'invadido' } : undefined);
      expect(result.status).toBe(404);
    }
    expect(getContact(ta.id, contact.id)?.name).toBe(contact.name);
    const forgedTenant = session(a, tb.id);
    expect((await req(server, '/v1/crm/contacts', forgedTenant)).status).toBe(401);
    expect((await req(server, '/v1/crm/admin/perf-stats', token)).status).toBe(403);
    expect((await req(server, '/v1/crm/admin/db-vacuum', token, 'POST')).status).toBe(403);
  });

  it('não troca sessão curta por API key permanente e bloqueia caminhos antigos', async () => {
    const { tenant, apiKey } = createTenant({ email: a.email, name: a.name, tier: 'starter' });
    ensureTerritorioTenant(a);
    const server = app();
    const token = session(a, tenant.id);
    const keysBefore = listApiKeysForTenant(tenant.id).length;
    const exchange = await req(server, '/v1/crm/auth/exchange', token, 'POST');
    expect((await exchange.json()).api_key).toBe(token);
    expect(listApiKeysForTenant(tenant.id)).toHaveLength(keysBefore);
    const legacy = signUserToken({ tid: tenant.id, uid: tenant.id, email: a.email, role: 'owner' });
    for (const key of [apiKey, legacy, createAdminSessionToken('Daniel'), emitirCredencialCrm(a, 'provision')]) {
      expect((await req(server, '/v1/crm/contacts', key)).status).toBe(401);
    }
  });

  it('sessão expirada ou conta suspensa perde acesso; provisão não remove suspensão', async () => {
    const t = ensureTerritorioTenant(a);
    const server = app();
    expect((await req(server, '/v1/crm/contacts', session(a, t.id, Date.now() - 120001))).status).toBe(401);
    updateTenant(t.id, { status: 'suspended' });
    expect(verifyUserToken(session(a, t.id))).toBeNull();
    expect((await req(server, '/integrations/territorio/tenant', emitirCredencialCrm(a, 'provision'), 'POST')).status).toBe(403);
  });

  it('encerra stream aberto no vencimento e não recebe eventos de outro tenant', async () => {
    vi.useFakeTimers();
    const ta = ensureTerritorioTenant(a), tb = ensureTerritorioTenant(b);
    const result = await app().request(`/v1/crm/events?token=${encodeURIComponent(session(a, ta.id))}`);
    expect(result.status).toBe(200);
    const reader = result.body!.getReader();
    await reader.read();
    expect(subscriberCount(ta.id)).toBe(1);
    publish(tb.id, 'message.in', { secret: 'privado' });
    await vi.advanceTimersByTimeAsync(120001);
    let content = '';
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; content += new TextDecoder().decode(chunk.value); }
    expect(content).not.toContain('privado');
    expect(subscriberCount(ta.id)).toBe(0);
  });

  it('sem o modo exclusivo, ligar a integração não tranca quem já usa o Clow direto', async () => {
    vi.stubEnv('CRM_TERRITORIO_EXCLUSIVO', 'false');
    const { tenant, apiKey } = createTenant({ email: 'antigo@example.test', name: 'Cliente antigo', tier: 'starter' });
    const t = ensureTerritorioTenant(a);
    const server = app();
    const legacy = signUserToken({ tid: tenant.id, uid: tenant.id, email: tenant.email, role: 'owner' });
    expect((await req(server, '/v1/crm/contacts', apiKey)).status).toBe(200);
    expect(verifyUserToken(legacy)?.tid).toBe(tenant.id);
    expect((await req(server, '/v1/crm/contacts', session(a, t.id))).status).toBe(200);
    expect((await req(server, '/v1/crm/admin/perf-stats', session(a, t.id))).status).toBe(403);
    const sse = await server.request(`/v1/crm/events?token=${encodeURIComponent(session(a, t.id))}`);
    expect(sse.status).toBe(200);
    await sse.body?.cancel();
  });

  it('arquivo de tenants corrompido nunca é tratado como vazio nem sobrescrito', () => {
    const file = join(home, 'tenants.json');
    writeFileSync(file, '{quebrado');
    expect(() => ensureTerritorioTenant(a)).toThrow();
    expect(readFileSync(file, 'utf8')).toBe('{quebrado');
  });
});
