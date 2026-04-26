// Backfill one-shot: itera contatos sem avatar_url e busca foto via Z-API
// Roda com: node -r dotenv/config /opt/system-clow/scripts/backfill-photos.cjs dotenv_config_path=/opt/system-clow/.env
import * as path from 'path';

(async () => {
  const store = await import('/opt/system-clow/dist/crm/store.js');
  const zapi = await import('/opt/system-clow/dist/crm/channels/zapi.js');
  const schema = await import('/opt/system-clow/dist/crm/schema.js');
  const db = schema.getCrmDb();

  // Lista todos os tenants (na pratica vamos iterar por canal)
  const channels = db.prepare("SELECT * FROM crm_channels WHERE type='zapi' AND status != 'disabled'").all();
  if (!channels.length) {
    console.log('Nenhum canal Z-API ativo — abortando');
    process.exit(0);
  }

  // Pega contatos sem foto, agrupados por tenant
  const contacts = db.prepare("SELECT id, tenant_id, name, phone FROM crm_contacts WHERE phone IS NOT NULL AND phone != '' AND avatar_url IS NULL AND deleted_at IS NULL").all();
  console.log(`Total contatos sem foto: ${contacts.length}`);
  console.log(`Canais Z-API ativos: ${channels.length}`);

  let ok = 0, fail = 0, noPhoto = 0;
  for (const c of contacts) {
    // Acha um canal Z-API do mesmo tenant
    const ch = channels.find(ch => ch.tenant_id === c.tenant_id);
    if (!ch) { fail++; continue; }
    // Reconstrói o objeto Channel2 a partir da row
    const channel = {
      id: ch.id,
      tenantId: ch.tenant_id,
      type: ch.type,
      name: ch.name,
      credentialsEncrypted: ch.credentials_encrypted,
      status: ch.status,
    };
    try {
      const url = await zapi.fetchProfilePicture(channel, c.phone);
      if (url) {
        db.prepare('UPDATE crm_contacts SET avatar_url = ?, updated_at = ? WHERE id = ?').run(url, Date.now(), c.id);
        console.log(`✓ ${c.name} (${c.phone}) → ${url.slice(0, 60)}...`);
        ok++;
      } else {
        noPhoto++;
      }
    } catch (e) {
      console.warn(`✗ ${c.name} (${c.phone}): ${e.message}`);
      fail++;
    }
    // throttle leve pra não martelar Z-API
    await new Promise(r => setTimeout(r, 200));
  }
  console.log(`\nResultado: ${ok} fotos baixadas, ${noPhoto} sem foto pública, ${fail} erros (de ${contacts.length} contatos)`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
