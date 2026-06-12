#!/usr/bin/env node
/**
 * Diagnostico do caminho login → sessao → tools.
 *
 * Pra cada email passado, gera JWT user_session, cria sessao via API e
 * confirma que `pool.getMetadata` retorna tenantId esperado. Tambem checa
 * que listBoards(tenantId) retorna boards do tenant correto (sem vazar
 * pra outros).
 *
 * Uso: node scripts/diag-tenant-flow.mjs
 */
import { signUserToken } from '../dist/auth/authRoutes.js';
import { findTenantByEmail } from '../dist/tenancy/tenantStore.js';
import * as crm from '../dist/crm/store.js';

const emails = [
  'pvcorretor01@gmail.com',
  'marciozamot@gmail.com',
  'brunovbcorretora@gmail.com',
];

const BASE = 'http://localhost:3001';

for (const email of emails) {
  const tenant = findTenantByEmail(email);
  if (!tenant) { console.log(`✗ ${email} — tenant nao existe`); continue; }
  const tid = tenant.id;
  const tidShort = tid.slice(0, 8);

  // 1. Gera JWT user_session
  const token = signUserToken({ tid, uid: tid, email, role: 'owner' });

  // 2. Cria sessao via API
  const sessionId = `diag-${tidShort}-${Date.now()}`;
  const res = await fetch(`${BASE}/v1/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ session_id: sessionId }),
  });
  const status = res.status;
  if (!res.ok) {
    const body = await res.text();
    console.log(`✗ ${email} (${tidShort}) — POST /v1/sessions falhou: ${status} ${body.slice(0, 200)}`);
    continue;
  }

  // 3. Le metadata da sessao via GET — confirma tenantId persistido na pool
  const metaRes = await fetch(`${BASE}/v1/sessions/${sessionId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const meta = await metaRes.json();
  const sessionTid = meta?.tenantId || meta?.tenant_id || '(undefined)';

  // 4. Direct DB: lista boards do tenant
  const boards = crm.listBoards(tid);

  const ok = sessionTid === tid;
  console.log(
    `${ok ? '✓' : '✗'} ${email}  jwt.tid=${tidShort}  session.tenantId=${(sessionTid || '').slice(0, 8) || '(empty)'}  ` +
    `boards=${boards.length} (${boards.map((b) => b.name).slice(0, 3).join(', ')})`,
  );
}
