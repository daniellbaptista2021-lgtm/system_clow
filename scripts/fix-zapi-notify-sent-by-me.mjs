// One-shot: re-aplica autoConfigureWebhooks na instancia Z-API do tenant PV
// pra (re)ativar `notify-sent-by-me`. Sem isso, msgs que Daniel envia
// direto do app/WhatsApp Web nao chegam ao CRM.
//
// Daniel 2026-05-06: bug confirmado via log [zapi-webhook DBG] — webhooks
// recebidos cobrem ReceivedCallback (cliente manda) mas nao
// MessageSentCallback (Daniel manda do app). Sintoma: 0 mensagens com
// metadata sentFromDevice no DB nas ultimas 2h.

import { autoConfigureWebhooks } from '../dist/crm/channels/zapi.js';
import * as store from '../dist/crm/store.js';

const TENANT_ID = 'be5f5042-d939-447d-8777-5ac841e7aa07';
const CHANNEL_ID = 'crm_ch_f1d74f5aabd9';
const BASE_URL = process.env.PUBLIC_BASE_URL || 'https://system-clow.pvcorretor01.com.br';

const channel = store.getChannel(TENANT_ID, CHANNEL_ID);
if (!channel) {
  console.error(`ERRO: canal ${CHANNEL_ID} nao encontrado pra tenant ${TENANT_ID}`);
  process.exit(1);
}
console.log(`Canal: ${channel.name} (${channel.type}) status=${channel.status}`);
console.log(`Base URL: ${BASE_URL}`);
console.log('');

const result = await autoConfigureWebhooks(channel, BASE_URL);
console.log('=== RESULTADO ===');
console.log(`ok: ${result.ok}`);
console.log(`configured (${result.configured.length}):`);
for (const c of result.configured) console.log(`  ✓ ${c}`);
if (result.failed.length > 0) {
  console.log(`failed (${result.failed.length}):`);
  for (const f of result.failed) console.log(`  ✗ ${f.endpoint}: ${f.error}`);
  process.exit(1);
}
console.log('');
console.log('✓ Z-API configurada. Webhooks "Ao Enviar" devem chegar a partir de agora.');
console.log('  Manda uma msg teste do app pra confirmar.');
