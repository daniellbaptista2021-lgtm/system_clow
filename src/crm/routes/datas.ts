/**
 * Datas de relacionamento — rotas.
 *
 *   GET    /datas/resumo                 quantos alertas hoje (bolinha do menu)
 *   GET    /datas/agenda?dias=30         eventos de hoje até hoje+dias
 *   GET    /datas/biblioteca?ano=2026    todas as datas do ano com as mensagens
 *   GET    /datas/clientes?busca=        contatos com nascimento, profissão e apólices
 *   PUT    /datas/clientes/:id           { nascimento: 'AAAA-MM-DD' | '', profissao }
 *   POST   /datas/clientes/:id/apolices  { nome, inicio: 'AAAA-MM-DD' }
 *   DELETE /datas/apolices/:id
 *
 * Nascimento e profissão vão para colunas que o contato do CRM já tinha
 * (birthdate_ts e title) — o resto do CRM passa a enxergar também. Só as
 * apólices ganharam tabela própria.
 *
 * birthdate_ts é gravado ao meio-dia UTC: meia-noite viraria o dia anterior
 * em Brasília e o aniversário cairia um dia antes.
 */
import type { Hono } from 'hono';
import { randomUUID } from 'crypto';
import { tenantOf } from './_helpers.js';
import { getCrmDb } from '../schema.js';
import * as store from '../store.js';
import { getSetting } from '../assignment.js';
import { getTenant } from '../../tenancy/tenantStore.js';
import { eventosEntre, biblioteca, hojeBrasilia, profissaoDo, PROFISSOES, type ContatoData, type ApoliceData } from '../datas/calendario.js';

let tabelaPronta = false;
function db() {
  const d = getCrmDb();
  if (!tabelaPronta) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS vector_apolices (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        contact_id TEXT NOT NULL,
        nome TEXT NOT NULL,
        inicio TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_vector_apolices_tenant ON vector_apolices(tenant_id, contact_id);
    `);
    tabelaPronta = true;
  }
  return d;
}

const DATA_OK = /^\d{4}-\d{2}-\d{2}$/;
function dataValida(s: string): boolean {
  if (!DATA_OK.test(s)) return false;
  const [a, m, d] = s.split('-').map(Number);
  const x = new Date(Date.UTC(a, m - 1, d));
  return x.getUTCFullYear() === a && x.getUTCMonth() === m - 1 && x.getUTCDate() === d && a >= 1900 && a <= 2100;
}
const tsParaData = (ts?: number | null) => {
  if (!ts) return null;
  const x = new Date(ts);
  return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}-${String(x.getUTCDate()).padStart(2, '0')}`;
};
const dataParaTs = (s: string) => { const [a, m, d] = s.split('-').map(Number); return Date.UTC(a, m - 1, d, 12); };

function carregar(tid: string): { contatos: ContatoData[]; apolices: ApoliceData[] } {
  const rows = db().prepare(
    'SELECT id, name, phone, birthdate_ts, title FROM crm_contacts WHERE tenant_id = ? AND deleted_at IS NULL',
  ).all(tid) as any[];
  const contatos = rows.map((r) => ({ id: r.id, nome: r.name, telefone: r.phone, nascimento: tsParaData(r.birthdate_ts), profissao: r.title }));
  const apolices = (db().prepare('SELECT id, contact_id, nome, inicio FROM vector_apolices WHERE tenant_id = ?').all(tid) as any[])
    .map((a) => ({ id: a.id, contatoId: a.contact_id, nome: a.nome, inicio: a.inicio }));
  return { contatos, apolices };
}

/** Nome que assina as mensagens: o do perfil da Apresentação, senão o da conta. */
function nomeCorretor(tid: string): string {
  const p = getSetting(tid, 'apresentacao_perfil', null) as any;
  if (p?.nome) return p.nome;
  const t = getTenant(tid) as any;
  return t?.full_name || t?.name || '';
}

const txt = (v: unknown, max = 120) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export function registerDatasRoutes(app: Hono) {
  app.get('/datas/resumo', (c) => {
    const tid = tenantOf(c);
    const { contatos, apolices } = carregar(tid);
    const hoje = hojeBrasilia();
    const ev = eventosEntre(hoje, 0, contatos, apolices);
    // Data comemorativa sem cliente casado não é alerta; é sugestão.
    const alertas = ev.filter((e) => e.tipo === 'aniversario' || e.tipo === 'apolice' || e.geral || e.contatos.length).length;
    return c.json({ hoje, alertas });
  });

  app.get('/datas/agenda', (c) => {
    const tid = tenantOf(c);
    const dias = Math.min(366, Math.max(0, parseInt(c.req.query('dias') || '30', 10) || 30));
    const { contatos, apolices } = carregar(tid);
    const hoje = hojeBrasilia();
    return c.json({
      hoje,
      corretor: nomeCorretor(tid),
      semData: contatos.filter((x) => !x.nascimento).length,
      totalContatos: contatos.length,
      eventos: eventosEntre(hoje, dias, contatos, apolices),
    });
  });

  app.get('/datas/biblioteca', (c) => {
    const tid = tenantOf(c);
    const ano = parseInt(c.req.query('ano') || hojeBrasilia().slice(0, 4), 10);
    return c.json({ ano, corretor: nomeCorretor(tid), datas: biblioteca(ano) });
  });

  app.get('/datas/clientes', (c) => {
    const tid = tenantOf(c);
    const busca = txt(c.req.query('busca'), 60).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const { contatos, apolices } = carregar(tid);
    const porContato = new Map<string, ApoliceData[]>();
    for (const a of apolices) porContato.set(a.contatoId, [...(porContato.get(a.contatoId) || []), a]);
    const lista = contatos
      .filter((x) => !busca || `${x.nome} ${x.telefone || ''}`.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().includes(busca))
      .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'))
      .slice(0, 300)
      .map((x) => ({ ...x, profissaoReconhecida: profissaoDo(x.profissao)?.nome || null, apolices: porContato.get(x.id) || [] }));
    return c.json({ clientes: lista, profissoes: PROFISSOES.map((p) => p.nome) });
  });

  app.put('/datas/clientes/:id', async (c) => {
    const tid = tenantOf(c);
    const b = await c.req.json().catch(() => ({}));
    const nasc = txt(b.nascimento, 10);
    if (nasc && !dataValida(nasc)) return c.json({ error: 'data_invalida', message: 'Data de nascimento inválida.' }, 400);
    const patch: any = {};
    if ('nascimento' in b) patch.birthdateTs = nasc ? dataParaTs(nasc) : undefined;
    if ('profissao' in b) patch.title = txt(b.profissao, 80) || undefined;
    const upd = store.updateContact(tid, c.req.param('id'), patch);
    if (!upd) return c.json({ error: 'nao_encontrado' }, 404);
    return c.json({ ok: true, profissaoReconhecida: profissaoDo(upd.title)?.nome || null });
  });

  app.post('/datas/clientes/:id/apolices', async (c) => {
    const tid = tenantOf(c);
    const contato = store.getContact(tid, c.req.param('id'));
    if (!contato) return c.json({ error: 'nao_encontrado' }, 404);
    const b = await c.req.json().catch(() => ({}));
    const inicio = txt(b.inicio, 10);
    if (!dataValida(inicio)) return c.json({ error: 'data_invalida', message: 'Data de início da apólice inválida.' }, 400);
    const id = randomUUID();
    db().prepare('INSERT INTO vector_apolices (id, tenant_id, contact_id, nome, inicio, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, tid, contato.id, txt(b.nome, 80) || 'Apólice', inicio, Date.now());
    return c.json({ id }, 201);
  });

  app.delete('/datas/apolices/:id', (c) => {
    const r = db().prepare('DELETE FROM vector_apolices WHERE id = ? AND tenant_id = ?').run(c.req.param('id'), tenantOf(c));
    return r.changes ? c.body(null, 204) : c.json({ error: 'nao_encontrada' }, 404);
  });
}
