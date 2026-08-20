#!/usr/bin/env node
/**
 * Reconcilia contatos importados por LID com o telefone real.
 *
 * Por que existe: o historico do WhatsApp veio do Baileys em formato LID
 * (identificador anonimo), e a Evolution nao guardou o mapeamento LID ->
 * telefone para as conversas antigas. O import de 20/08/2026 criou esses
 * contatos sem telefone, marcados com `custom_fields.waLid`.
 *
 * O mapeamento aparece sozinho, aos poucos: quando a pessoa manda uma
 * mensagem nova, a Evolution grava `key.remoteJidAlt` com o telefone real, e
 * o webhook cria um contato novo — separado do que tem o historico. Este job
 * encontra esses pares e funde os dois registros, movendo o historico para o
 * contato certo.
 *
 * Idempotente: rodar de novo nao faz nada se nao houver par novo.
 *
 *   node reconciliar-lid.js            simula, nao escreve
 *   node reconciliar-lid.js --executar aplica
 */
const { execFileSync } = require('child_process');
const Database = require('/opt/system_clow/node_modules/better-sqlite3');

const TENANT = process.env.CLOW_TENANT_ID;
if (!TENANT) {
  console.error('defina CLOW_TENANT_ID com o tenant a reconciliar');
  process.exit(1);
}
const DB_PATH = process.env.CRM_DB_PATH || '/var/lib/system-clow/crm.sqlite3';
const PG = process.env.EVOLUTION_PG_CONTAINER || 'system_clow_evolution_postgres';
const executar = process.argv.includes('--executar');

// ── 1. pergunta ao Postgres da Evolution quais LIDs ja tem telefone ───────
const sql = `
  SELECT DISTINCT split_part(key->>'remoteJid','@',1) AS lid,
         split_part(key->>'remoteJidAlt','@',1) AS telefone
  FROM "Message"
  WHERE key->>'remoteJid' LIKE '%@lid' AND key ? 'remoteJidAlt'`;

let linhas;
try {
  linhas = execFileSync('docker', [
    'exec', PG, 'psql', '-U', 'evolution', '-d', 'evolution_db', '-t', '-A', '-F', '|', '-c', sql,
  ], { encoding: 'utf8', timeout: 60000 }).trim().split('\n').filter(Boolean);
} catch (err) {
  console.error('nao consegui consultar a Evolution:', err.message);
  process.exit(1);
}

const mapa = new Map();
for (const l of linhas) {
  const [lid, tel] = l.split('|');
  if (lid && tel && /^\d{10,}$/.test(tel)) mapa.set(lid, tel);
}

const db = new Database(DB_PATH);
const achaPorLid = db.prepare(
  "SELECT id, name, phone FROM crm_contacts WHERE tenant_id = ? AND json_extract(custom_fields_json,'$.waLid') = ? AND deleted_at IS NULL"
);
const achaPorTelefone = db.prepare(
  'SELECT id, name FROM crm_contacts WHERE tenant_id = ? AND phone = ? AND deleted_at IS NULL AND id <> ?'
);
const moveAtividades = db.prepare('UPDATE crm_activities SET contact_id = ? WHERE contact_id = ?');
const moveCards = db.prepare('UPDATE crm_cards SET contact_id = ? WHERE contact_id = ?');
const poeTelefone = db.prepare('UPDATE crm_contacts SET phone = ?, updated_at = ? WHERE id = ?');
const renomeia = db.prepare('UPDATE crm_contacts SET name = ?, updated_at = ? WHERE id = ?');
const apaga = db.prepare('UPDATE crm_contacts SET deleted_at = ? WHERE id = ?');

const r = { paresConhecidos: mapa.size, resolvidos: 0, fundidos: 0, msgsMovidas: 0 };

const rodar = db.transaction(() => {
  for (const [lid, telefone] of mapa) {
    const doLid = achaPorLid.get(TENANT, lid);
    if (!doLid || doLid.phone) continue; // ja resolvido antes

    const gemeo = achaPorTelefone.get(TENANT, telefone, doLid.id);
    const nMsgs = db.prepare('SELECT COUNT(*) c FROM crm_activities WHERE contact_id = ?').get(doLid.id).c;

    if (gemeo) {
      // O contato do webhook e o "vivo": tem telefone, cards e o nome que o
      // WhatsApp reporta hoje. Move o historico pra ele e aposenta o do LID.
      if (executar) {
        moveAtividades.run(gemeo.id, doLid.id);
        moveCards.run(gemeo.id, doLid.id);
        apaga.run(Date.now(), doLid.id);
      }
      r.fundidos++;
      r.msgsMovidas += nMsgs;
      console.log(`  fundido: "${doLid.name}" (${nMsgs} msgs) -> "${gemeo.name}" ${telefone}`);
    } else {
      // Ninguem pra fundir: so carimba o telefone no proprio contato do LID.
      if (executar) {
        poeTelefone.run(telefone, Date.now(), doLid.id);
        if (/^WhatsApp \d+$/.test(doLid.name)) renomeia.run(telefone, Date.now(), doLid.id);
      }
      r.resolvidos++;
      console.log(`  telefone descoberto: "${doLid.name}" -> ${telefone} (${nMsgs} msgs)`);
    }
  }
});

rodar();
db.close();

console.log(executar ? '\n=== APLICADO ===' : '\n=== SIMULACAO (nada escrito) ===');
for (const [k, v] of Object.entries(r)) console.log(String(k).padEnd(18), v);
