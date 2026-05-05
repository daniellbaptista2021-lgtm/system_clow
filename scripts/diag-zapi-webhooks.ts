/**
 * diag-zapi-webhooks.ts — Diagnostic: lista webhooks atuais configurados
 * na Z-API pra cada canal, mostra quais NAO apontam pro System Clow.
 *
 * Uso: tsx scripts/diag-zapi-webhooks.ts
 *
 * Z-API webhook endpoints (todos PUT /update-webhook-*; GET retorna o
 * value atual). A gente confere os 6 que importam:
 *   received, delivery, message-status, connection-status,
 *   presence-chat, receive-all-notifications
 */
import { getCrmDb } from '../src/crm/schema.js';
import { decryptJson } from '../src/crm/crypto.js';
import type { ZapiCreds } from '../src/crm/channels/zapi.js';

const PUBLIC_BASE = process.env.PUBLIC_BASE_URL || 'https://system-clow.pvcorretor01.com.br';

const ENDPOINTS = [
  'webhook-received',
  'webhook-delivery',
  'webhook-message-status',
  'webhook-connection-status',
  'webhook-presence-chat',
  'webhook-receive-all-notifications',
];

async function getZapiWebhook(creds: ZapiCreds, endpoint: string): Promise<{ value?: string; status: number; error?: string }> {
  // Z-API GET retorna { value: "url" } ou { value: "" }
  // Formato URL Z-API: https://api.z-api.io/instances/{instanceId}/token/{clientToken}/{endpoint}
  const baseUrl = creds.baseUrl?.replace(/\/$/, '') || 'https://api.z-api.io';
  const u = `${baseUrl}/instances/${creds.instanceId}/token/${creds.token}/${endpoint}`;
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (creds.clientToken) headers['Client-Token'] = creds.clientToken;
    const r = await fetch(u, { method: 'GET', headers });
    const txt = await r.text().catch(() => '');
    if (!r.ok) return { status: r.status, error: txt.slice(0, 100) };
    try {
      const j = JSON.parse(txt);
      return { value: j?.value ?? j?.webhookUrl ?? '', status: r.status };
    } catch {
      return { status: r.status, error: 'non-json: ' + txt.slice(0, 80) };
    }
  } catch (err: any) {
    return { status: 0, error: err?.message || 'fetch failed' };
  }
}

async function main() {
  const db = getCrmDb();
  const channels = db.prepare(`SELECT id, name, tenant_id, webhook_secret, credentials_encrypted FROM crm_channels WHERE type = 'zapi'`).all() as any[];

  console.log(`\nFound ${channels.length} Z-API channel(s)\n${'='.repeat(60)}`);

  for (const ch of channels) {
    console.log(`\n[${ch.name}] tenant=${ch.tenant_id} id=${ch.id}`);
    const expectedUrl = `${PUBLIC_BASE}/webhooks/crm/zapi/${ch.webhook_secret}`;
    console.log(`  expected: ${expectedUrl}`);
    let creds: ZapiCreds;
    try { creds = decryptJson<ZapiCreds>(ch.credentials_encrypted); }
    catch (e: any) { console.log(`  ERR: cannot decrypt creds: ${e.message}`); continue; }

    for (const ep of ENDPOINTS) {
      const r = await getZapiWebhook(creds, ep);
      const v = r.value || '(empty)';
      const match = r.value === expectedUrl;
      const flag = match ? '✓' : (r.value ? '⚠ ' : '·');
      console.log(`  ${flag} ${ep.padEnd(38)} ${v}${r.error ? ` [err: ${r.error}]` : ''}`);
    }
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
