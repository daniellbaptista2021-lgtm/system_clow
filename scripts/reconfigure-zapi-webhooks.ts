/**
 * reconfigure-zapi-webhooks.ts — Forca todos os canais Z-API existentes
 * a re-rodarem o autoConfigureWebhooks com a lista atualizada de
 * endpoints (incluindo delivery, presence-chat, receive-all-notifications).
 *
 * Uso na VPS: npx tsx scripts/reconfigure-zapi-webhooks.ts
 *
 * Por que: autoConfigureWebhooks so e chamado em POST/PATCH de canal.
 * Canais ja criados nao tem os endpoints novos setados — Z-API pode
 * estar mandando eventos pra URLs antigas (n8n) ou pra lugar nenhum.
 * Esse script normaliza tudo: cada canal aponta TODOS os webhooks pro
 * System Clow.
 */
import { getCrmDb } from '../src/crm/schema.js';
import { autoConfigureWebhooks, fetchConnectedPhone } from '../src/crm/channels/zapi.js';
import * as store from '../src/crm/store.js';
import type { Channel2 } from '../src/crm/types.js';

const PUBLIC_BASE = process.env.PUBLIC_BASE_URL || 'https://system-clow.pvcorretor01.com.br';

async function main() {
  const db = getCrmDb();
  const rows = db.prepare(`SELECT id, tenant_id, name FROM crm_channels WHERE type = 'zapi'`).all() as Array<{ id: string; tenant_id: string; name: string }>;

  console.log(`\nReconfiguring ${rows.length} Z-API channel(s) → ${PUBLIC_BASE}\n${'='.repeat(60)}`);

  for (const row of rows) {
    const channel = store.getChannel(row.tenant_id, row.id) as Channel2 | null;
    if (!channel) {
      console.log(`\n[${row.name}] SKIP — store.getChannel returned null`);
      continue;
    }
    console.log(`\n[${row.name}] tenant=${row.tenant_id}`);

    // 1. Pre-cache connected phone (so future webhook calls are fast)
    const phone = await fetchConnectedPhone(channel);
    console.log(`  connected phone: ${phone || 'unknown'}`);

    // 2. Reconfigure all webhook endpoints
    const r = await autoConfigureWebhooks(channel, PUBLIC_BASE);
    if (r.ok) {
      console.log(`  ✓ all ${r.configured.length} webhooks set:`);
      for (const ep of r.configured) console.log(`     • ${ep}`);
    } else {
      console.log(`  ⚠ ${r.configured.length} ok, ${r.failed.length} failed:`);
      for (const ep of r.configured) console.log(`     ✓ ${ep}`);
      for (const f of r.failed) console.log(`     ✗ ${f.endpoint}: ${f.error}`);
    }
  }
  console.log(`\nDone.\n`);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
