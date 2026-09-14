/** Ensaio local: CRM real + Supabase fictício, sem dados/serviços de produção. */
import { mkdtempSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';

if (process.env.NODE_ENV === 'production') throw new Error('Ensaio exclusivo para ambiente local');
const testHome = mkdtempSync(join(tmpdir(), 'crm-browser-'));
Object.assign(process.env, {
  CLOW_HOME: testHome, CRM_DB_PATH: join(testHome, 'crm.sqlite3'),
  CRM_TERRITORIO_ENABLED: 'true', CRM_TERRITORIO_SECRET: 'segredo-exclusivo-do-ensaio-local-nao-usar-em-producao',
  TERRITORIO_APP_URL: 'http://127.0.0.1:3400', CLOW_MODO_BONUS: 'true', CLOW_MIGRATION_LOG: '0',
});
const { tenantAuth } = await import('../src/server/middleware/tenantAuth.js');
const { buildTerritorioRoutes } = await import('../src/server/territorioRoutes.js');
const { default: routes } = await import('../src/crm/routes.js');
const { default: auth, verifyUserToken } = await import('../src/auth/authRoutes.js');
const { buildIaCredenciaisRoutes } = await import('../src/server/routes/iaCredenciais.js');
const { createContact } = await import('../src/crm/store/contactsStore.js');
const { ensureTerritorioTenant } = await import('../src/tenancy/tenantStore.js');

const users = [
  { id: '11111111-1111-4111-8111-111111111111', email: 'ana@example.test', full_name: 'Ana de Teste', role: 'member' },
  { id: '22222222-2222-4222-8222-222222222222', email: 'bia@example.test', full_name: 'Bia de Teste', role: 'member' },
];
for (const user of users) {
  const t = ensureTerritorioTenant({ sub: user.id, email: user.email, name: user.full_name });
  createContact(t.id, { name: `Contato exclusivo de ${user.full_name}` });
}
const crm = new Hono();
crm.route('/', buildTerritorioRoutes());
crm.use('/v1/crm/*', tenantAuth);
crm.route('/v1/crm', routes);
crm.get('/auth/verify', c => c.json({ ok: !!verifyUserToken(c.req.header('Authorization')?.slice(7)) }));
crm.route('/auth', auth);
crm.use('/v1/ia-credenciais/*', tenantAuth);
crm.route('/v1/ia-credenciais', buildIaCredenciaisRoutes());
crm.get('*', c => {
  let pathname = c.req.path;
  if (pathname.endsWith('/')) pathname += 'index.html';
  const root = resolve('public');
  const file = resolve(root, '.' + pathname);
  if (!file.startsWith(root + '/') || !existsSync(file) || !statSync(file).isFile()) return c.notFound();
  const type = file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : file.endsWith('.png') ? 'image/png' : 'application/octet-stream';
  return c.body(readFileSync(file), 200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Content-Security-Policy': "frame-ancestors 'self' http://127.0.0.1:3400" });
});
serve({ fetch: crm.fetch, port: 3401, hostname: '127.0.0.1' });

let active = true;
const userJson = (u: typeof users[number]) => ({ ...u, aud: 'authenticated', created_at: new Date().toISOString(), email_confirmed_at: new Date().toISOString(), app_metadata: { provider: 'email' }, user_metadata: {} });
createServer(async (request, response) => {
  const url = new URL(request.url || '/', 'http://127.0.0.1:3402');
  response.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1:3400');
  response.setHeader('Access-Control-Allow-Headers', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  response.setHeader('Content-Type', 'application/json');
  const end = (value: unknown) => response.end(JSON.stringify(value));
  if (request.method === 'OPTIONS') { response.statusCode = 204; response.end(); return; }
  if (url.pathname === '/controle') {
    if (url.searchParams.has('active')) active = url.searchParams.get('active') === 'true';
    response.setHeader('Content-Type', 'text/html');
    response.end(`<h1>Ensaio local — assinatura ${active ? 'ativa' : 'cancelada'}</h1><a href="?active=true">Ativar assinatura fictícia</a><p><a href="?active=false">Cancelar assinatura fictícia</a></p>`); return;
  }
  let id = users[0].id;
  try { id = JSON.parse(Buffer.from((request.headers.authorization || '').split('.')[1], 'base64url').toString()).sub; } catch {}
  const user = users.find(u => u.id === id) || users[0];
  if (url.pathname === '/auth/v1/token') {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const data = JSON.parse(raw || '{}');
    const u = users.find(u => u.email === data.email) || user;
    const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const jwt = `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc({ sub: u.id, aud: 'authenticated', role: 'authenticated', exp: Math.floor(Date.now()/1000)+3600, iat: Math.floor(Date.now()/1000) })}.local-test-signature`;
    end({ access_token: jwt, refresh_token: 'test-refresh', token_type: 'bearer', expires_in: 3600, user: userJson(u) }); return;
  }
  if (url.pathname === '/auth/v1/user') { end(userJson(user)); return; }
  if (url.pathname.startsWith('/auth/v1/admin/users/')) { end(userJson(users.find(u => u.id === url.pathname.split('/').pop()) || user)); return; }
  if (url.pathname === '/auth/v1/logout') { response.statusCode = 204; response.end(); return; }
  if (url.pathname === '/rest/v1/profiles') {
    const u = users.find(u => 'eq.' + u.id === url.searchParams.get('id')) || user;
    end(request.headers.accept?.includes('vnd.pgrst.object') ? u : [u]); return;
  }
  if (url.pathname === '/rest/v1/subscriptions') { end(active ? [{ id: 'sub-test', status: 'active', profile_id: user.id }] : []); return; }
  response.statusCode = 404; end({ error: 'Rota não simulada' });
}).listen(3402, '127.0.0.1');
console.log('Ensaio: CRM 3401, Supabase fictício 3402. Use ana@example.test ou bia@example.test, qualquer senha.');
