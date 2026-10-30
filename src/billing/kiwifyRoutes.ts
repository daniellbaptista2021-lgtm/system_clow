/**
 * Kiwify → EVOX: rotas.
 *
 *   POST /webhooks/kiwify        avisos de venda (token em EVOX_KIWIFY_TOKEN)
 *   POST /auth/definir-senha     { token, senha } — o link do e-mail de boas-vindas
 *
 * Venda aprovada cria a conta (ou reativa) no plano do link de checkout e
 * manda o link para o cliente criar a senha. Cancelamento, reembolso e
 * chargeback encerram o acesso. Cada aviso fica em evox_kiwify_log: reentrega
 * do mesmo evento não repete nada, e o que aconteceu fica conferível.
 */
import type { Hono } from 'hono';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';
import { getCrmDb } from '../crm/schema.js';
import { createTenant, findTenantByEmail, updateTenant, getTenant } from '../tenancy/tenantStore.js';
import { definirPlano } from '../tenancy/usoIa.js';
import { sendMail } from '../utils/mailer.js';
import { logger } from '../utils/logger.js';
import { validarKiwify, lerVenda, acaoDaVenda, ehDeOutraAssinatura } from './kiwifyEvox.js';
import { emailBoasVindas } from './emailBoasVindas.js';

const VALIDADE_LINK_MS = 7 * 24 * 3600_000;

let tabelas = false;
function db() {
  const d = getCrmDb();
  if (!tabelas) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS evox_kiwify_log (
        chave TEXT PRIMARY KEY,
        recebido_em INTEGER NOT NULL,
        evento TEXT, email TEXT, plano TEXT,
        payload TEXT NOT NULL,
        processado INTEGER NOT NULL DEFAULT 0,
        resultado TEXT
      );
      CREATE TABLE IF NOT EXISTS evox_definir_senha (
        token_hash TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        expira_em INTEGER NOT NULL,
        usado_em INTEGER
      );
    `);
    tabelas = true;
  }
  return d;
}

const base = () => (process.env.CLOW_PUBLIC_BASE_URL || 'http://127.0.0.1:3041').replace(/\/+$/, '');
const hash = (t: string) => crypto.createHash('sha256').update(t).digest('hex');

/** Link de uso único para o cliente criar a senha. Só o hash fica no banco. */
export function criarLinkDeSenha(tenantId: string): string {
  const token = crypto.randomBytes(24).toString('hex');
  db().prepare('INSERT INTO evox_definir_senha (token_hash, tenant_id, expira_em) VALUES (?, ?, ?)')
    .run(hash(token), tenantId, Date.now() + VALIDADE_LINK_MS);
  return `${base()}/definir-senha.html?t=${token}`;
}

async function mandarBoasVindas(email: string, nome: string, plano: string, link: string) {
  // O logo vai embutido: e-mail que cai no spam não baixa imagem de fora.
  let embutidos: Array<{ cid: string; nome: string; conteudoBase64: string }> | undefined;
  try {
    const arq = path.join(process.cwd(), 'public', 'assets', 'evox', 'email-logo.png');
    embutidos = [{ cid: 'evox-logo', nome: 'evox-logo.png', conteudoBase64: fs.readFileSync(arq).toString('base64') }];
  } catch { /* sem o arquivo, cai no logo por URL */ }
  const { subject, html, text } = emailBoasVindas({ nome, plano, link, base: base(), logoSrc: embutidos ? 'cid:evox-logo' : undefined });
  return sendMail({ to: email, subject, text, html, embutidos });
}

export function registerKiwifyRoutes(app: Hono) {
  app.post('/webhooks/kiwify', async (c) => {
    const segredo = process.env.EVOX_KIWIFY_TOKEN || '';
    if (!segredo) return c.json({ error: 'kiwify_nao_configurada' }, 503);
    const corpo = await c.req.text();
    const metodo = validarKiwify(corpo, c.req.query('signature') || c.req.header('x-kiwify-signature') || null,
      c.req.header('x-kiwify-token') || null, segredo);
    if (!metodo) {
      logger.warn(`[kiwify] aviso recusado: assinatura/token não confere (query: ${Object.keys(c.req.queries()).join(',') || '-'})`);
      return c.json({ error: 'assinatura_invalida' }, 401);
    }
    let payload: any;
    try { payload = JSON.parse(corpo); } catch { return c.json({ error: 'json_invalido' }, 400); }
    const v = lerVenda(payload);
    const d = db();
    const ja = d.prepare('SELECT processado FROM evox_kiwify_log WHERE chave = ?').get(v.chave) as any;
    if (ja?.processado) return c.json({ ok: true, duplicado: true });
    if (!ja) {
      d.prepare('INSERT INTO evox_kiwify_log (chave, recebido_em, evento, email, plano, payload) VALUES (?, ?, ?, ?, ?, ?)')
        .run(v.chave, Date.now(), v.evento, v.email, v.plano, corpo);
    }
    const fim = (resultado: string) => {
      d.prepare('UPDATE evox_kiwify_log SET processado = 1, resultado = ? WHERE chave = ?').run(resultado, v.chave);
      logger.info(`[kiwify] ${v.evento} ${v.email || '-'} → ${resultado}`);
      // O link de senha fica no log daqui, nunca na resposta para a Kiwify.
      return c.json({ ok: true, resultado: resultado.replace(/; link: .*$/, '') });
    };

    if (!v.ehEvox) return fim(`ignorado: produto "${v.produto || '?'}" não é do EVOX`);
    if (!v.email) return fim('ignorado: aviso sem e-mail do cliente');
    const acao = acaoDaVenda(v);
    if (acao === 'registrar') return fim('registrado');

    try {
      let t: any = findTenantByEmail(v.email);
      if (acao === 'encerrar') {
        if (!t) return fim('nada a encerrar: sem conta com este e-mail');
        if (ehDeOutraAssinatura(t.kiwify_subscription_id, v)) return fim(`ignorado: aviso de outra assinatura (${v.subscriptionId})`);
        updateTenant(t.id, { status: 'cancelled' } as any);
        return fim(`acesso encerrado (${t.id})`);
      }

      // liberar
      const novo = !t;
      if (!t) t = createTenant({ email: v.email, name: v.nome || v.email, tier: 'empresarial' as any }).tenant;
      updateTenant(t.id, {
        status: 'active',
        full_name: t.full_name || v.nome || undefined,
        phone_e164: t.phone_e164 || (v.telefone ? '+' + v.telefone.replace(/\D/g, '') : undefined),
        kiwify_subscription_id: v.subscriptionId || v.orderId || t.kiwify_subscription_id,
      } as any);
      if (v.plano) definirPlano(t.id, v.plano);
      // Conta nova (ou que nunca criou senha) recebe o link. Renovação de quem
      // já usa o EVOX não manda e-mail nenhum.
      const semSenha = !(getTenant(t.id) as any)?.password_hash;
      if (novo || semSenha) {
        const link = criarLinkDeSenha(t.id);
        const envio = await mandarBoasVindas(v.email, v.nome || '', v.plano || 'essencial', link);
        if (!envio.ok) {
          // Sem e-mail configurado: o link fica no log para o Daniel mandar à mão.
          logger.error(`[kiwify] e-mail de boas-vindas NÃO saiu para ${v.email} (${envio.backend}: ${envio.reason || '-'}). Link: ${link}`);
          return fim(`${novo ? 'conta criada' : 'conta reativada'} (${t.id}, ${v.plano || 'plano?'}) — e-mail NÃO enviado; link: ${link}`);
        }
        return fim(`${novo ? 'conta criada' : 'conta reativada'} (${t.id}, ${v.plano || 'plano?'}) — e-mail enviado`);
      }
      return fim(`conta ativa (${t.id}, ${v.plano || 'plano mantido'})`);
    } catch (e: any) {
      // Sem `processado`: a Kiwify reentrega e a gente tenta de novo.
      logger.error(`[kiwify] falha ao processar ${v.chave}: ${e?.message || e}`);
      return c.json({ error: 'falha', message: String(e?.message || e) }, 500);
    }
  });

  app.post('/auth/definir-senha', async (c) => {
    const b = await c.req.json().catch(() => ({})) as any;
    const token = typeof b.token === 'string' ? b.token : '';
    const senha = typeof b.senha === 'string' ? b.senha : '';
    if (senha.length < 8) return c.json({ ok: false, error: 'A senha precisa ter pelo menos 8 caracteres.' }, 400);
    const l = db().prepare('SELECT * FROM evox_definir_senha WHERE token_hash = ?').get(hash(token)) as any;
    if (!l || l.usado_em || l.expira_em < Date.now()) {
      return c.json({ ok: false, error: 'Este link já foi usado ou venceu. Fale com o suporte do EVOX para receber outro.' }, 400);
    }
    const t = getTenant(l.tenant_id) as any;
    if (!t || t.status === 'cancelled') return c.json({ ok: false, error: 'Conta não encontrada ou encerrada.' }, 400);
    updateTenant(t.id, { password_hash: await bcrypt.hash(senha, 10), email_verified_at: new Date().toISOString() } as any);
    db().prepare('UPDATE evox_definir_senha SET usado_em = ? WHERE token_hash = ?').run(Date.now(), hash(token));
    return c.json({ ok: true, email: t.email });
  });
}
