// CRM Vector — retrato para o `npm run situacao` do Território Próprio.
//
// Roda na tp1, de dentro de /opt/crm-vector, chamado por ssh. SÓ LÊ:
// banco aberto em modo leitura, tenants.json lido do disco, pm2 só listado.
// Devolve uma linha de JSON; quem formata é o situacao.mjs do Território.
import fs from 'fs';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const DADOS = process.env.CLOW_HOME || '/var/lib/crm-vector';
const r = { commit: null, processo: null, contas: [], erro: null };

try { r.commit = execFileSync('git', ['-C', '/opt/crm-vector', 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* sem git */ }

try {
  const lista = JSON.parse(execFileSync('pm2', ['jlist'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  const p = lista.find((x) => x.name === 'crm-vector');
  r.processo = p ? { status: p.pm2_env.status, reinicios: p.pm2_env.restart_time, desde: p.pm2_env.pm_uptime, memoria: p.monit?.memory || 0 } : { status: 'ausente' };
} catch (e) { r.processo = { status: 'erro', detalhe: String(e.message).slice(0, 80) }; }

try {
  const t = JSON.parse(fs.readFileSync(`${DADOS}/tenants.json`, 'utf8'));
  const Database = require('better-sqlite3');
  const db = new Database(`${DADOS}/crm.sqlite3`, { readonly: true, fileMustExist: true });
  const existe = (tab) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(tab);
  const conta = (sql, id) => { try { return db.prepare(sql).get(id)?.n ?? 0; } catch { return 0; } };
  for (const x of t.tenants || []) {
    r.contas.push({
      nome: x.full_name || x.name || '',
      email: x.email,
      criada: x.created_at,
      status: x.status,
      contatos: conta('SELECT COUNT(*) n FROM crm_contacts WHERE tenant_id = ? AND deleted_at IS NULL', x.id),
      cards: conta('SELECT COUNT(*) n FROM crm_cards WHERE tenant_id = ? AND deleted_at IS NULL', x.id),
      canais: conta('SELECT COUNT(*) n FROM crm_channels WHERE tenant_id = ?', x.id),
      apresentacoes: existe('vector_apresentacoes') ? conta('SELECT COUNT(*) n FROM vector_apresentacoes WHERE tenant_id = ?', x.id) : 0,
      apolices: existe('vector_apolices') ? conta('SELECT COUNT(*) n FROM vector_apolices WHERE tenant_id = ?', x.id) : 0,
    });
  }
  db.close();
} catch (e) { r.erro = String(e.message).slice(0, 120); }

console.log(JSON.stringify(r));
