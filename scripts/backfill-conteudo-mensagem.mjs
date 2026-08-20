#!/usr/bin/env node
/**
 * Backfill — reconstrói o conteúdo das mensagens que ficaram em branco.
 *
 * Enquanto o parser conhecia só sete formatos de `message`, tudo o mais caía
 * em `text` com texto vazio; e mídia sem legenda já gravava conteúdo vazio de
 * propósito, contando com o player. Quando a Evolution não entregava o
 * binário (ela só o faz com S3 ligado), sobrava um balão com o horário e nada
 * dentro.
 *
 * O conteúdo original continua no banco da Evolution, em `Message.message`.
 * Este script relê aquele payload e passa pelo MESMO normalizador que o
 * webhook usa agora — nada de uma segunda implementação que possa divergir.
 *
 * Não inventa texto: quando o payload não tem conteúdo recuperável, a
 * mensagem entra no relatório de pendências em vez de receber um rótulo
 * qualquer. Não toca em id, horário, direção, contato nem mídia.
 *
 *   node backfill-conteudo-mensagem.mjs             simula
 *   node backfill-conteudo-mensagem.mjs --executar  aplica
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { normalizarMensagemWhatsApp, chavesDeConteudo } from '../dist/crm/channels/whatsappMessage.js';

const require = createRequire(import.meta.url);
const Database = require('/opt/system_clow/node_modules/better-sqlite3');

const DB_PATH = process.env.CRM_DB_PATH || '/var/lib/system-clow/crm.sqlite3';
const PG = process.env.EVOLUTION_PG_CONTAINER || 'system_clow_evolution_postgres';
const executar = process.argv.includes('--executar');

const db = new Database(DB_PATH);

// Balão vazio = sem conteúdo E sem mídia para renderizar. Mensagem sem texto
// mas com mídia salva aparece pelo player e não é problema.
const vazias = db.prepare(`
  SELECT id, provider_message_id, contact_id, card_id, type, direction, media_type, created_at
  FROM crm_activities
  WHERE type LIKE 'message%'
    AND (content IS NULL OR content = '')
    AND (media_url IS NULL OR media_url = '')
`).all();

console.log(`mensagens com balão vazio: ${vazias.length}\n`);

// ── payloads originais, em lotes para não estourar a linha de comando ─────
// Sem balão vazio o laço não roda, mas o script segue: o passo 2 (unificação
// de rótulos) é independente e precisa acontecer mesmo com o passo 1 vazio.
const ids = vazias.map((v) => v.provider_message_id).filter(Boolean);
const payloads = new Map();
const LOTE = 200;
for (let i = 0; i < ids.length; i += LOTE) {
  const lista = ids.slice(i, i + LOTE).map((x) => `'${String(x).replace(/'/g, "''")}'`).join(',');
  let saida;
  try {
    saida = execFileSync('docker', [
      'exec', PG, 'psql', '-U', 'evolution', '-d', 'evolution_db', '-t', '-A', '-c',
      `SELECT json_build_object('id', key->>'id', 'mt', "messageType", 'm', message)::text
       FROM "Message" WHERE key->>'id' IN (${lista})`,
    ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120000 });
  } catch (err) {
    console.error('falha ao ler a Evolution:', err.message);
    process.exit(1);
  }
  for (const linha of saida.trim().split('\n').filter(Boolean)) {
    try {
      const o = JSON.parse(linha.replace(/\\\\/g, '\\'));
      if (o?.id) payloads.set(o.id, o);
    } catch { /* linha ilegível: vira pendência mais abaixo */ }
  }
}
console.log(`payloads recuperados da Evolution: ${payloads.size} de ${ids.length}\n`);

const atualiza = db.prepare('UPDATE crm_activities SET content = ? WHERE id = ?');
const r = { recuperadas: 0, pendentes: [] };
const porFormato = new Map();

const rodar = db.transaction(() => {
  for (const v of vazias) {
    const p = payloads.get(v.provider_message_id);
    if (!p?.m) {
      r.pendentes.push({
        conversation_id: v.card_id || '(sem card)',
        message_id: v.provider_message_id || '(sem id)',
        from_me: v.type === 'message_out',
        message_type: v.media_type,
        available_message_keys: [],
        raw_payload_present: false,
        normalized_text: null,
        motivo: 'payload não encontrado no banco da Evolution',
      });
      continue;
    }

    const norm = normalizarMensagemWhatsApp(p.m);
    // Texto de verdade tem precedência; o rótulo entra só quando não há nada.
    const conteudo = norm.texto || norm.rotulo;

    if (!conteudo || norm.desconhecido) {
      r.pendentes.push({
        conversation_id: v.card_id || '(sem card)',
        message_id: v.provider_message_id,
        from_me: v.type === 'message_out',
        message_type: p.mt || v.media_type,
        available_message_keys: chavesDeConteudo(p.m),
        raw_payload_present: true,
        normalized_text: norm.texto ?? null,
        motivo: 'formato sem conteúdo recuperável',
      });
      continue;
    }

    if (executar) atualiza.run(conteudo, v.id);
    r.recuperadas++;
    const chave = `${p.mt || v.media_type} -> ${norm.texto ? 'texto' : 'rótulo'}`;
    porFormato.set(chave, (porFormato.get(chave) || 0) + 1);
  }
});

rodar();

// ── passo 2: unifica os rótulos antigos com o vocabulário atual ──────────
//
// O import do histórico gravou "[áudio]" onde o normalizador hoje escreve
// "🎤 Áudio". Os dois convivendo deixam a mesma conversa com dois estilos
// para a mesma coisa. A troca só acontece quando o tipo da mensagem confirma
// o rótulo e não há mídia — assim, alguém que tenha realmente digitado
// "[áudio]" numa conversa não tem a própria mensagem reescrita.
const EQUIVALENTES = [
  { de: '[áudio]', para: '🎤 Áudio', tipo: 'audio' },
  { de: '[documento]', para: '📄 Documento', tipo: 'document' },
  { de: '[localização]', para: '📍 Localização', tipo: 'location' },
];
const unifica = db.prepare(`
  UPDATE crm_activities SET content = ?
  WHERE type LIKE 'message%' AND content = ? AND media_type = ?
    AND (media_url IS NULL OR media_url = '')
`);
const contaUnifica = db.prepare(`
  SELECT COUNT(*) n FROM crm_activities
  WHERE type LIKE 'message%' AND content = ? AND media_type = ?
    AND (media_url IS NULL OR media_url = '')
`);
let unificadas = 0;
const rodarUnificacao = db.transaction(() => {
  for (const e of EQUIVALENTES) {
    const n = contaUnifica.get(e.de, e.tipo).n;
    if (!n) continue;
    if (executar) unifica.run(e.para, e.de, e.tipo);
    console.log(`  unificando ${n}x  "${e.de}" -> "${e.para}"`);
    unificadas += n;
  }
});
rodarUnificacao();

db.close();

console.log(executar ? '=== APLICADO ===' : '=== SIMULACAO (nada escrito) ===');
console.log('recuperadas:', r.recuperadas);
console.log('rótulos unificados:', unificadas);
console.log('pendentes:  ', r.pendentes.length);

if (porFormato.size) {
  console.log('\npor formato:');
  for (const [k, n] of [...porFormato].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${k}`);
  }
}

if (r.pendentes.length) {
  console.log('\n=== NAO RECUPERADAS — diagnóstico ===');
  for (const p of r.pendentes) {
    console.log(`  conversation_id:        ${p.conversation_id}`);
    console.log(`  message_id:             ${p.message_id}`);
    console.log(`  from_me:                ${p.from_me}`);
    console.log(`  message_type:           ${p.message_type}`);
    console.log(`  available_message_keys: ${p.available_message_keys.join(', ') || '(nenhuma)'}`);
    console.log(`  raw_payload_present:    ${p.raw_payload_present}`);
    console.log(`  normalized_text:        ${p.normalized_text ?? 'null'}`);
    console.log(`  motivo:                 ${p.motivo}\n`);
  }
}
