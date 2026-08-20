#!/usr/bin/env node
/**
 * Backfill — desfaz o estrago do bug do `pushName` em `fromMe`.
 *
 * Enquanto o bug esteve ativo, toda mensagem que o corretor mandava pelo
 * celular renomeava o contato do CLIENTE com o nome da conta dele ("Você" ou
 * o nome do operador). Cards abertos por uma mensagem de saída nasceram com
 * esse nome no título também.
 *
 * A correção NÃO pode partir do título do card: pode existir cliente com o
 * mesmo nome do operador, e títulos personalizados como "Seguro Empresarial"
 * não podem ser destruídos. A fonte de verdade é o `pushName` das mensagens
 * RECEBIDAS no banco da Evolution: ali o campo descreve o remetente, que é o
 * cliente. Um contato só é renomeado quando essa fonte discorda do que está
 * gravado — mantendo o nome do operador quando é mesmo o nome do contato.
 *
 * O título do card só é reescrito quando ele é idêntico ao nome corrompido do
 * contato, ou seja, quando foi derivado dele. Título editado à mão fica.
 *
 *   CLOW_TENANT_ID=<uuid> node backfill-nome-contato.cjs             simula
 *   CLOW_TENANT_ID=<uuid> node backfill-nome-contato.cjs --executar  aplica
 */
const { execFileSync } = require('child_process');
const Database = require('/opt/system_clow/node_modules/better-sqlite3');

const TENANT = process.env.CLOW_TENANT_ID;
if (!TENANT) {
  console.error('defina CLOW_TENANT_ID com o tenant a corrigir');
  process.exit(1);
}
const DB_PATH = process.env.CRM_DB_PATH || '/var/lib/system-clow/crm.sqlite3';
const PG = process.env.EVOLUTION_PG_CONTAINER || 'system_clow_evolution_postgres';
const executar = process.argv.includes('--executar');

// Nomes que o WhatsApp usa para a própria conta. Nunca são nome de contato
// quando aparecem via mensagem de saída — mas podem ser legítimos quando vêm
// numa mensagem recebida, e por isso a checagem é feita na origem, não aqui.
const NOMES_DA_CONTA = new Set(['você', 'voce', 'you']);

// ── 1. tabela de verdade: telefone -> pushName de mensagem RECEBIDA ──────
const sql = `
  SELECT telefone, "pushName", n FROM (
    SELECT
      COALESCE(
        split_part(key->>'remoteJidAlt','@',1),
        CASE WHEN key->>'remoteJid' LIKE '%@s.whatsapp.net'
             THEN split_part(key->>'remoteJid','@',1) END
      ) AS telefone,
      "pushName",
      COUNT(*) AS n,
      ROW_NUMBER() OVER (
        PARTITION BY COALESCE(
          split_part(key->>'remoteJidAlt','@',1),
          CASE WHEN key->>'remoteJid' LIKE '%@s.whatsapp.net'
               THEN split_part(key->>'remoteJid','@',1) END)
        ORDER BY COUNT(*) DESC, MAX("messageTimestamp") DESC
      ) AS rk
    FROM "Message"
    WHERE key->>'fromMe' = 'false'
      AND "pushName" IS NOT NULL AND "pushName" <> ''
      AND key->>'remoteJid' NOT LIKE '%@g.us'
    GROUP BY 1, 2
  ) t
  WHERE rk = 1 AND telefone IS NOT NULL AND telefone ~ '^[0-9]{10,}$'`;

let linhas;
try {
  linhas = execFileSync('docker', [
    'exec', PG, 'psql', '-U', 'evolution', '-d', 'evolution_db', '-t', '-A', '-F', '|', '-c', sql,
  ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 120000 }).trim().split('\n').filter(Boolean);
} catch (err) {
  console.error('nao consegui consultar a Evolution:', err.message);
  process.exit(1);
}

const verdade = new Map();
for (const l of linhas) {
  const [tel, nome] = l.split('|');
  if (!tel || !nome) continue;
  // pushName que é só o próprio número não identifica ninguém
  if (nome.replace(/\D/g, '') === nome) continue;
  if (NOMES_DA_CONTA.has(nome.trim().toLowerCase())) continue;
  verdade.set(tel, nome.trim());
}
console.log(`fonte de verdade: ${verdade.size} telefones com nome vindo de mensagem recebida`);

// ── 1b. os nomes que a conta do WhatsApp usa para si mesma ───────────────
// Derivado dos dados, não escrito à mão: é exatamente o conjunto de valores
// que o bug tinha para vazar para o campo errado. Um card batizado com um
// desses nomes, apontando para um contato que se chama outra coisa, só pode
// ter vindo do bug — enquanto "Seguro Empresarial" jamais aparece aqui.
let nomesDaConta = new Set();
try {
  const saida = execFileSync('docker', [
    'exec', PG, 'psql', '-U', 'evolution', '-d', 'evolution_db', '-t', '-A', '-c',
    `SELECT DISTINCT "pushName" FROM "Message"
     WHERE key->>'fromMe' = 'true' AND "pushName" IS NOT NULL AND "pushName" <> ''`,
  ], { encoding: 'utf8', timeout: 60000 }).trim().split('\n').filter(Boolean);
  nomesDaConta = new Set(saida.map((s) => s.trim()));
} catch { /* sem essa lista o backfill ainda corrige os contatos */ }
console.log(`nomes da própria conta: ${[...nomesDaConta].join(', ') || '(nenhum)'}\n`);

// ── 2. compara com o CRM ────────────────────────────────────────────────
const db = new Database(DB_PATH);
const contatos = db.prepare(
  'SELECT id, name, phone FROM crm_contacts WHERE tenant_id = ? AND deleted_at IS NULL AND phone IS NOT NULL'
).all(TENANT);

const renomeiaContato = db.prepare('UPDATE crm_contacts SET name = ?, updated_at = ? WHERE id = ?');
const cardsDo = db.prepare('SELECT id, title FROM crm_cards WHERE tenant_id = ? AND contact_id = ? AND deleted_at IS NULL');
const renomeiaCard = db.prepare('UPDATE crm_cards SET title = ?, updated_at = ? WHERE id = ?');

const r = { contatosCorrigidos: 0, cardsCorrigidos: 0, jaCertos: 0, semFonte: [] };

const rodar = db.transaction(() => {
  for (const ct of contatos) {
    const real = verdade.get(ct.phone);

    if (!real) {
      // Sem fonte confiável. Só vira pendência se o nome atual parecer
      // corrompido; contato com nome plausível e sem histórico na Evolution
      // simplesmente não foi tocado pelo bug.
      const suspeito = NOMES_DA_CONTA.has(String(ct.name).trim().toLowerCase());
      if (suspeito) {
        r.semFonte.push({
          contact_id: ct.id, nome_atual: ct.name, telefone: ct.phone,
          motivo: 'sem mensagem recebida com pushName no banco da Evolution',
        });
      }
      continue;
    }

    if (ct.name === real) {
      r.jaCertos++;
      // O contato já se corrigiu sozinho numa mensagem recebida posterior,
      // mas o card aberto durante o bug continua com o nome do operador no
      // título. Só reescreve quando o título é um nome da própria conta.
      for (const card of cardsDo.all(TENANT, ct.id)) {
        if (card.title === real) continue;
        if (!nomesDaConta.has(card.title)) continue;
        console.log(`  card ${card.id}: titulo "${card.title}" -> "${real}"  (${ct.phone})`);
        if (executar) renomeiaCard.run(real, Date.now(), card.id);
        r.cardsCorrigidos++;
      }
      continue;
    }

    const nomeErrado = ct.name;
    console.log(`  contato: "${nomeErrado}" -> "${real}"  (${ct.phone})`);
    if (executar) renomeiaContato.run(real, Date.now(), ct.id);
    r.contatosCorrigidos++;

    // Título derivado do nome corrompido acompanha a correção. Título que o
    // usuário escreveu ("Seguro Empresarial") não é tocado.
    for (const card of cardsDo.all(TENANT, ct.id)) {
      if (card.title !== nomeErrado) continue;
      console.log(`    card ${card.id}: titulo "${card.title}" -> "${real}"`);
      if (executar) renomeiaCard.run(real, Date.now(), card.id);
      r.cardsCorrigidos++;
    }
  }
});

rodar();
db.close();

console.log(executar ? '\n=== APLICADO ===' : '\n=== SIMULACAO (nada escrito) ===');
console.log('contatos corrigidos:', r.contatosCorrigidos);
console.log('cards corrigidos:   ', r.cardsCorrigidos);
console.log('ja estavam certos:  ', r.jaCertos);

if (r.semFonte.length) {
  console.log('\n=== NAO RESOLVIDOS — precisam de correcao manual ===');
  for (const p of r.semFonte) {
    console.log(`  contact_id: ${p.contact_id}`);
    console.log(`  nome_atual: ${p.nome_atual}`);
    console.log(`  telefone:   ${p.telefone}`);
    console.log(`  motivo:     ${p.motivo}\n`);
  }
} else {
  console.log('\nnenhum registro ficou sem resolucao.');
}
