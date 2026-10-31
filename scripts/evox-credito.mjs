#!/usr/bin/env node
// Libera crédito de IA (ou troca o plano) de uma conta do EVOX.
//   node scripts/evox-credito.mjs pedidos                       → lista pedidos pendentes
//   node scripts/evox-credito.mjs liberar <pedido>              → credita o pedido pago (85% do valor)
//   node scripts/evox-credito.mjs credito <conta> <valor>        → crédito avulso (R$)
//   node scripts/evox-credito.mjs plano <conta> essencial|completo
import Database from 'better-sqlite3';
import path from 'path';
const home = process.env.CLOW_HOME || path.join(process.env.HOME, '.clow');
const arquivo = process.env.EVOX_CRM_DB || path.join(home, 'crm.sqlite3');
const db = new Database(arquivo);
// As mesmas tabelas de src/tenancy/usoIa.ts — o script pode rodar antes do servidor criá-las.
db.exec(`CREATE TABLE IF NOT EXISTS evox_uso_ia (tenant_id TEXT NOT NULL, mes TEXT NOT NULL, custo_usd REAL NOT NULL DEFAULT 0, PRIMARY KEY (tenant_id, mes));
CREATE TABLE IF NOT EXISTS evox_credito_ia (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, mes TEXT NOT NULL, valor_brl REAL NOT NULL, origem TEXT, criado_em INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS evox_plano_ia (tenant_id TEXT PRIMARY KEY, plano TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS evox_pedido_credito (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, valor_brl REAL NOT NULL, status TEXT NOT NULL DEFAULT 'pendente', criado_em INTEGER NOT NULL);`);
const mes = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 7);
const [cmd, a, b] = process.argv.slice(2);
if (cmd === 'pedidos') {
  console.table(db.prepare("SELECT id, tenant_id, valor_brl, datetime(criado_em/1000,'unixepoch','-3 hours') AS quando FROM evox_pedido_credito WHERE status='pendente' ORDER BY id").all());
} else if (cmd === 'liberar') {
  const p = db.prepare("SELECT * FROM evox_pedido_credito WHERE id=? AND status='pendente'").get(Number(a));
  if (!p) { console.error('Pedido não encontrado ou já liberado.'); process.exit(1); }
  // Recarga paga: 85% vira crédito de IA do cliente, 15% fica com o EVOX (igual a PARTE_CLIENTE_RECARGA em src/tenancy/usoIa.ts).
  const credito = Math.round(p.valor_brl * 0.85 * 100) / 100;
  db.prepare('INSERT INTO evox_credito_ia (tenant_id, mes, valor_brl, origem, criado_em) VALUES (?,?,?,?,?)').run(p.tenant_id, mes, credito, 'pedido #' + p.id, Date.now());
  db.prepare("UPDATE evox_pedido_credito SET status='pago' WHERE id=?").run(p.id);
  console.log(`Liberado: pago R$ ${p.valor_brl} → R$ ${credito} de crédito de IA para ${p.tenant_id} em ${mes}.`);
} else if (cmd === 'credito') {
  db.prepare('INSERT INTO evox_credito_ia (tenant_id, mes, valor_brl, origem, criado_em) VALUES (?,?,?,?,?)').run(a, mes, Number(b), 'avulso', Date.now());
  console.log(`Crédito de R$ ${b} para ${a} em ${mes}.`);
} else if (cmd === 'plano') {
  db.prepare('INSERT INTO evox_plano_ia (tenant_id, plano) VALUES (?,?) ON CONFLICT(tenant_id) DO UPDATE SET plano=excluded.plano').run(a, b);
  console.log(`Plano de ${a}: ${b}.`);
} else {
  console.log('Use: pedidos | liberar <pedido> | credito <conta> <valor> | plano <conta> essencial|completo');
}
