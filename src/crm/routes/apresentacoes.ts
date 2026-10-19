/**
 * Apresentação MetLife — rotas.
 *
 *   GET  /apresentacao/perfil            dados do corretor (foto e logo em dataURL)
 *   PUT  /apresentacao/perfil            grava; foto/logo: dataURL grava, null apaga, ausente mantém
 *   GET  /apresentacao/coberturas        catálogo da tabela "Proteção Financeira"
 *   POST /apresentacao/calcular          prévia das contas (a tela mostra enquanto o corretor digita)
 *   GET  /apresentacoes                  lista do corretor
 *   POST /apresentacoes                  cria
 *   GET  /apresentacoes/:id              uma
 *   PUT  /apresentacoes/:id              atualiza
 *   DELETE /apresentacoes/:id
 *   PUT  /apresentacoes/:id/cotacao      sobe a cotação (dataURL: PDF, PNG ou JPEG)
 *   DELETE /apresentacoes/:id/cotacao
 *   GET  /apresentacoes/:id/pdf          monta e devolve o PDF
 *
 * Cada corretor tem a própria conta no CRM Vector, então "do tenant" é "do
 * corretor": ninguém enxerga apresentação de outro.
 *
 * O perfil vai no crm_settings (é pequeno: as imagens chegam já reduzidas
 * pela tela). A cotação vai para o disco, em CLOW_HOME/apresentacoes/<tenant>,
 * porque um PDF de cotação passa fácil de alguns MB.
 */
import type { Hono } from 'hono';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { tenantOf } from './_helpers.js';
import { getCrmDb } from '../schema.js';
import { getSetting, setSetting } from '../assignment.js';
import { getTenant } from '../../tenancy/tenantStore.js';
import { calcular, COBERTURAS, type DadosApresentacao } from '../apresentacao/calculos.js';
import { gerarApresentacao, type PerfilCorretor } from '../apresentacao/gerador.js';
import { logger } from '../../utils/logger.js';

const CHAVE_PERFIL = 'apresentacao_perfil';
const MAX_IMAGEM = 3 * 1024 * 1024;
const MAX_COTACAO = 20 * 1024 * 1024;
const TIPOS_IMAGEM = ['image/png', 'image/jpeg'];
const TIPOS_COTACAO = ['application/pdf', 'image/png', 'image/jpeg'];

let tabelaPronta = false;
function db() {
  const d = getCrmDb();
  if (!tabelaPronta) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS vector_apresentacoes (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        cliente_nome TEXT NOT NULL,
        dados_json TEXT NOT NULL,
        cotacao_nome TEXT,
        cotacao_tipo TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_vector_apres_tenant ON vector_apresentacoes(tenant_id, updated_at);
    `);
    tabelaPronta = true;
  }
  return d;
}

function pastaCotacoes(tid: string): string {
  const home = process.env.CLOW_HOME || path.join(os.homedir(), '.clow');
  // tid vem do token (uuid), mas o nome vira caminho: nada além de [\w-].
  const p = path.join(home, 'apresentacoes', tid.replace(/[^\w-]/g, ''));
  fs.mkdirSync(p, { recursive: true, mode: 0o700 });
  return p;
}
const arquivoCotacao = (tid: string, id: string) => path.join(pastaCotacoes(tid), `${id.replace(/[^\w-]/g, '')}.bin`);

/** "data:image/png;base64,AAAA" → { tipo, dados } — ou null se não for um dos tipos aceitos. */
function lerDataUrl(v: unknown, tipos: string[], max: number): { tipo: string; dados: Buffer } | null {
  if (typeof v !== 'string') return null;
  const m = v.match(/^data:([\w/+.-]+);base64,(.+)$/s);
  if (!m || !tipos.includes(m[1])) return null;
  const dados = Buffer.from(m[2], 'base64');
  if (!dados.length || dados.length > max) return null;
  // Confere a assinatura do arquivo: o tipo declarado é só o que o navegador disse.
  const sig = dados.subarray(0, 5).toString('latin1');
  const ok = m[1] === 'application/pdf' ? sig === '%PDF-'
    : m[1] === 'image/png' ? dados[0] === 0x89 && sig.slice(1, 4) === 'PNG'
    : dados[0] === 0xff && dados[1] === 0xd8;
  return ok ? { tipo: m[1], dados } : null;
}

const paraDataUrl = (b64?: string | null, tipo?: string | null) => (b64 && tipo ? `data:${tipo};base64,${b64}` : null);

interface PerfilGuardado {
  nome?: string; cargo?: string; telefone?: string; email?: string; susep?: string;
  foto?: string | null; fotoTipo?: string | null; logo?: string | null; logoTipo?: string | null;
}

function lerPerfil(tid: string): PerfilGuardado {
  const p = getSetting(tid, CHAVE_PERFIL, null) as PerfilGuardado | null;
  if (p) return p;
  // Primeira vez: começa com o nome e o e-mail da conta.
  const t = getTenant(tid) as any;
  return { nome: t?.full_name || t?.name || '', email: t?.email || '', cargo: 'Consultor em proteção financeira' };
}

const txt = (v: unknown, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function limparDados(d: any): DadosApresentacao {
  // Guarda o que veio, mas garante o mínimo que o gerador precisa.
  const dados = (d && typeof d === 'object') ? d : {};
  dados.cliente = dados.cliente && typeof dados.cliente === 'object' ? dados.cliente : {};
  dados.cliente.nome = txt(dados.cliente.nome, 120) || 'Cliente';
  return dados as DadosApresentacao;
}

export function registerApresentacoesRoutes(app: Hono) {
  app.get('/apresentacao/perfil', (c) => {
    const p = lerPerfil(tenantOf(c));
    return c.json({
      perfil: {
        nome: p.nome || '', cargo: p.cargo || '', telefone: p.telefone || '', email: p.email || '', susep: p.susep || '',
        foto: paraDataUrl(p.foto, p.fotoTipo), logo: paraDataUrl(p.logo, p.logoTipo),
      },
    });
  });

  app.put('/apresentacao/perfil', async (c) => {
    const tid = tenantOf(c);
    const b = await c.req.json().catch(() => ({}));
    const atual = lerPerfil(tid);
    const novo: PerfilGuardado = {
      ...atual,
      nome: txt(b.nome, 80), cargo: txt(b.cargo, 80), telefone: txt(b.telefone, 40),
      email: txt(b.email, 120), susep: txt(b.susep, 40),
    };
    for (const campo of ['foto', 'logo'] as const) {
      if (b[campo] === null) { novo[campo] = null; novo[`${campo}Tipo`] = null; continue; }
      if (b[campo] === undefined) continue;
      const img = lerDataUrl(b[campo], TIPOS_IMAGEM, MAX_IMAGEM);
      if (!img) return c.json({ error: 'imagem_invalida', message: `A ${campo === 'foto' ? 'foto' : 'logo'} precisa ser PNG ou JPEG de até 3 MB.` }, 400);
      novo[campo] = img.dados.toString('base64');
      novo[`${campo}Tipo`] = img.tipo;
    }
    setSetting(tid, CHAVE_PERFIL, novo);
    return c.json({ ok: true });
  });

  app.get('/apresentacao/coberturas', (c) => {
    tenantOf(c);
    return c.json({ coberturas: Object.entries(COBERTURAS).map(([chave, v]) => ({ chave, nome: v.nome, situacao: v.situacao, cor: v.cor })) });
  });

  app.post('/apresentacao/calcular', async (c) => {
    tenantOf(c);
    const b = await c.req.json().catch(() => ({}));
    return c.json({ calculo: calcular(limparDados(b.dados)) });
  });

  app.get('/apresentacoes', (c) => {
    const rows = db().prepare(
      'SELECT id, cliente_nome, cotacao_nome, created_at, updated_at FROM vector_apresentacoes WHERE tenant_id = ? ORDER BY updated_at DESC LIMIT 200',
    ).all(tenantOf(c)) as any[];
    return c.json({ apresentacoes: rows.map((r) => ({ id: r.id, clienteNome: r.cliente_nome, cotacao: r.cotacao_nome, criadaEm: r.created_at, atualizadaEm: r.updated_at })) });
  });

  app.post('/apresentacoes', async (c) => {
    const tid = tenantOf(c);
    const b = await c.req.json().catch(() => ({}));
    const dados = limparDados(b.dados);
    const id = randomUUID();
    const agora = Date.now();
    db().prepare('INSERT INTO vector_apresentacoes (id, tenant_id, cliente_nome, dados_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, tid, dados.cliente.nome, JSON.stringify(dados), agora, agora);
    return c.json({ id }, 201);
  });

  const buscar = (tid: string, id: string) =>
    db().prepare('SELECT * FROM vector_apresentacoes WHERE id = ? AND tenant_id = ?').get(id, tid) as any;

  app.get('/apresentacoes/:id', (c) => {
    const r = buscar(tenantOf(c), c.req.param('id'));
    if (!r) return c.json({ error: 'nao_encontrada' }, 404);
    return c.json({ id: r.id, dados: JSON.parse(r.dados_json), cotacao: r.cotacao_nome ? { nome: r.cotacao_nome, tipo: r.cotacao_tipo } : null });
  });

  app.put('/apresentacoes/:id', async (c) => {
    const tid = tenantOf(c);
    const id = c.req.param('id');
    if (!buscar(tid, id)) return c.json({ error: 'nao_encontrada' }, 404);
    const b = await c.req.json().catch(() => ({}));
    const dados = limparDados(b.dados);
    db().prepare('UPDATE vector_apresentacoes SET cliente_nome = ?, dados_json = ?, updated_at = ? WHERE id = ? AND tenant_id = ?')
      .run(dados.cliente.nome, JSON.stringify(dados), Date.now(), id, tid);
    return c.json({ ok: true });
  });

  app.delete('/apresentacoes/:id', (c) => {
    const tid = tenantOf(c);
    const id = c.req.param('id');
    const r = db().prepare('DELETE FROM vector_apresentacoes WHERE id = ? AND tenant_id = ?').run(id, tid);
    try { fs.rmSync(arquivoCotacao(tid, id), { force: true }); } catch { /* sem cotação */ }
    return r.changes ? c.body(null, 204) : c.json({ error: 'nao_encontrada' }, 404);
  });

  app.put('/apresentacoes/:id/cotacao', async (c) => {
    const tid = tenantOf(c);
    const id = c.req.param('id');
    if (!buscar(tid, id)) return c.json({ error: 'nao_encontrada' }, 404);
    const b = await c.req.json().catch(() => ({}));
    const arq = lerDataUrl(b.arquivo, TIPOS_COTACAO, MAX_COTACAO);
    if (!arq) return c.json({ error: 'arquivo_invalido', message: 'A cotação precisa ser PDF, PNG ou JPEG de até 20 MB.' }, 400);
    fs.writeFileSync(arquivoCotacao(tid, id), arq.dados, { mode: 0o600 });
    db().prepare('UPDATE vector_apresentacoes SET cotacao_nome = ?, cotacao_tipo = ?, updated_at = ? WHERE id = ? AND tenant_id = ?')
      .run(txt(b.nome, 120) || 'cotacao', arq.tipo, Date.now(), id, tid);
    return c.json({ ok: true });
  });

  app.delete('/apresentacoes/:id/cotacao', (c) => {
    const tid = tenantOf(c);
    const id = c.req.param('id');
    try { fs.rmSync(arquivoCotacao(tid, id), { force: true }); } catch { /* já não havia */ }
    db().prepare('UPDATE vector_apresentacoes SET cotacao_nome = NULL, cotacao_tipo = NULL WHERE id = ? AND tenant_id = ?').run(id, tid);
    return c.body(null, 204);
  });

  app.get('/apresentacoes/:id/pdf', async (c) => {
    const tid = tenantOf(c);
    const r = buscar(tid, c.req.param('id'));
    if (!r) return c.json({ error: 'nao_encontrada' }, 404);
    const p = lerPerfil(tid);
    const perfil: PerfilCorretor = {
      nome: p.nome || '', cargo: p.cargo, telefone: p.telefone, email: p.email, susep: p.susep,
      foto: p.foto ? Buffer.from(p.foto, 'base64') : null,
      logo: p.logo ? Buffer.from(p.logo, 'base64') : null,
    };
    let cotacao = null;
    if (r.cotacao_tipo) {
      try { cotacao = { dados: fs.readFileSync(arquivoCotacao(tid, r.id)), tipo: r.cotacao_tipo }; }
      catch { logger.warn(`[apresentacao] cotação de ${r.id} sumiu do disco — PDF sai sem ela`); }
    }
    try {
      const pdf = await gerarApresentacao(JSON.parse(r.dados_json), perfil, cotacao);
      const nome = `Apresentacao - ${r.cliente_nome}`.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w .-]/g, '').trim() || 'Apresentacao';
      return new Response(new Uint8Array(pdf), {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="${nome}.pdf"`,
          'Cache-Control': 'no-store',
        },
      });
    } catch (e: any) {
      logger.error(`[apresentacao] falha ao gerar ${r.id}: ${e?.message || e}`);
      const msg = /PDF|encrypt|parse/i.test(String(e?.message)) && r.cotacao_tipo === 'application/pdf'
        ? 'Não consegui ler o PDF da cotação. Tente subir a cotação como imagem (print) ou outro PDF.'
        : 'Não consegui montar o PDF. Confira os dados e tente de novo.';
      return c.json({ error: 'falha_pdf', message: msg }, 500);
    }
  });
}
