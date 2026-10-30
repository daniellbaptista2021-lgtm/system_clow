/**
 * usoIa.ts — limite de uso de IA por conta do EVOX (decisão do Daniel, 29/10/2026).
 *
 * No EVOX a IA não é mais "traga sua chave": todas as contas usam a chave do
 * EVOX (`EVOX_IA_KEY`, DeepSeek), e cada conta tem um limite mensal em reais
 * que o cliente NUNCA vê como valor — só como barra de uso, igual ao plano Pro
 * do Claude:
 *
 *   Essencial (R$ 189,90) → R$ 70 de IA por mês
 *   Completo  (R$ 249,90) → R$ 120 de IA por mês
 *
 * Cada resposta da IA traz quantos tokens gastou; aqui isso vira dólar pelo
 * preço do modelo, dólar vira real pela cotação de `EVOX_DOLAR_BRL`, e soma no
 * mês da conta. Crédito comprado (R$ 50/100/150) soma no limite do mês em que
 * entrou. Chegou a 100%, a IA para de responder naquela conta até virar o mês
 * ou entrar crédito — melhor parar do que estourar a fatura do DeepSeek.
 */
import { getCrmDb } from '../crm/schema.js';
import { logger } from '../utils/logger.js';

export type PlanoIa = 'essencial' | 'completo';

export const LIMITE_PLANO_BRL: Record<PlanoIa, number> = { essencial: 70, completo: 120 };

/** Pacotes de crédito extra: preço que o cliente paga = reais somados ao limite. */
export const PACOTES_CREDITO_BRL = [50, 100, 150];

// Preço do deepseek-flash por token (US$). Ajustável sem deploy: quando a
// DeepSeek mudar a tabela, só a env muda.
const PRECO = {
  entrada: Number(process.env.EVOX_PRECO_ENTRADA_USD_M || 0.3) / 1_000_000,
  entradaCache: Number(process.env.EVOX_PRECO_CACHE_USD_M || 0.03) / 1_000_000,
  saida: Number(process.env.EVOX_PRECO_SAIDA_USD_M || 1.2) / 1_000_000,
};
const DOLAR_BRL = () => Number(process.env.EVOX_DOLAR_BRL || 5.6);

/** A chave do EVOX está configurada — sem ela o sistema segue no modo antigo (chave do cliente). */
export function iaCentral(): boolean {
  return !!process.env.EVOX_IA_KEY;
}

export class LimiteIaAtingido extends Error {
  constructor(public tenantId: string) {
    super('Você atingiu o limite de uso da IA deste mês. Libere mais uso em Configurações → Uso da IA.');
    this.name = 'LimiteIaAtingido';
  }
}

let tabelasOk = false;
function db() {
  const d = getCrmDb();
  if (!tabelasOk) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS evox_uso_ia (
        tenant_id TEXT NOT NULL, mes TEXT NOT NULL, custo_usd REAL NOT NULL DEFAULT 0,
        PRIMARY KEY (tenant_id, mes));
      CREATE TABLE IF NOT EXISTS evox_credito_ia (
        id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, mes TEXT NOT NULL,
        valor_brl REAL NOT NULL, origem TEXT, criado_em INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS evox_plano_ia (
        tenant_id TEXT PRIMARY KEY, plano TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS evox_pedido_credito (
        id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, valor_brl REAL NOT NULL,
        status TEXT NOT NULL DEFAULT 'pendente', criado_em INTEGER NOT NULL);
    `);
    tabelasOk = true;
  }
  return d;
}

/** Mês corrente no fuso de Brasília (o limite vira junto com o calendário do cliente). */
export function mesAtual(agora = new Date()): string {
  const br = new Date(agora.getTime() - 3 * 3600_000);
  return br.toISOString().slice(0, 7);
}

/** Primeiro dia do mês seguinte, para a tela dizer quando o uso renova. */
export function renovaEm(agora = new Date()): string {
  const [a, m] = mesAtual(agora).split('-').map(Number);
  return `${a + (m === 12 ? 1 : 0)}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01`;
}

export function custoUsd(uso: { inputTokens?: number; outputTokens?: number; cachedTokens?: number; uncachedTokens?: number }): number {
  const entrada = uso.inputTokens || 0;
  const cache = Math.min(uso.cachedTokens || 0, entrada);
  const semCache = uso.uncachedTokens ?? Math.max(entrada - cache, 0);
  return semCache * PRECO.entrada + cache * PRECO.entradaCache + (uso.outputTokens || 0) * PRECO.saida;
}

export function planoDa(tenantId: string): PlanoIa {
  const l = db().prepare('SELECT plano FROM evox_plano_ia WHERE tenant_id = ?').get(tenantId) as any;
  return l?.plano === 'completo' ? 'completo' : 'essencial';
}

export function definirPlano(tenantId: string, plano: PlanoIa): void {
  db().prepare('INSERT INTO evox_plano_ia (tenant_id, plano) VALUES (?, ?) ON CONFLICT(tenant_id) DO UPDATE SET plano = excluded.plano').run(tenantId, plano);
}

function gastoBrl(tenantId: string, mes = mesAtual()): number {
  const l = db().prepare('SELECT custo_usd FROM evox_uso_ia WHERE tenant_id = ? AND mes = ?').get(tenantId, mes) as any;
  return (l?.custo_usd || 0) * DOLAR_BRL();
}

function limiteBrl(tenantId: string, mes = mesAtual()): number {
  const c = db().prepare('SELECT COALESCE(SUM(valor_brl), 0) AS t FROM evox_credito_ia WHERE tenant_id = ? AND mes = ?').get(tenantId, mes) as any;
  return LIMITE_PLANO_BRL[planoDa(tenantId)] + (c?.t || 0);
}

/** Soma o gasto de uma resposta. Nunca lança: medir não pode derrubar a resposta. */
export function registrarUso(tenantId: string | undefined, uso: Parameters<typeof custoUsd>[0] | undefined): void {
  if (!tenantId || tenantId === 'default' || !uso || !iaCentral()) return;
  try {
    const usd = custoUsd(uso);
    if (usd <= 0) return;
    db().prepare(`INSERT INTO evox_uso_ia (tenant_id, mes, custo_usd) VALUES (?, ?, ?)
      ON CONFLICT(tenant_id, mes) DO UPDATE SET custo_usd = custo_usd + excluded.custo_usd`).run(tenantId, mesAtual(), usd);
  } catch (e: any) {
    logger.warn('[uso-ia] não consegui registrar o uso:', e?.message);
  }
}

/** Bloqueia antes de chamar a IA quando a conta já passou do limite do mês. */
export function conferirLimite(tenantId: string | undefined): void {
  if (!tenantId || tenantId === 'default' || !iaCentral()) return;
  if (gastoBrl(tenantId) >= limiteBrl(tenantId)) throw new LimiteIaAtingido(tenantId);
}

export function adicionarCredito(tenantId: string, valorBrl: number, origem: string): void {
  db().prepare('INSERT INTO evox_credito_ia (tenant_id, mes, valor_brl, origem, criado_em) VALUES (?, ?, ?, ?, ?)')
    .run(tenantId, mesAtual(), valorBrl, origem, Date.now());
}

export function registrarPedido(tenantId: string, valorBrl: number): number {
  return Number(db().prepare('INSERT INTO evox_pedido_credito (tenant_id, valor_brl, criado_em) VALUES (?, ?, ?)')
    .run(tenantId, valorBrl, Date.now()).lastInsertRowid);
}

/** O que a tela mostra: só porcentagem, nunca reais. */
export function resumoUso(tenantId: string) {
  const limite = limiteBrl(tenantId);
  const gasto = gastoBrl(tenantId);
  const extra = limite - LIMITE_PLANO_BRL[planoDa(tenantId)];
  return {
    plano: planoDa(tenantId),
    percentual: limite > 0 ? Math.min(100, Math.round((gasto / limite) * 1000) / 10) : 100,
    bloqueado: gasto >= limite,
    renova_em: renovaEm(),
    // Uso extra comprado neste mês, contado em pacotes (o menor vale 1).
    extra_pacotes: Math.round((extra / PACOTES_CREDITO_BRL[0]) * 10) / 10,
    // Crédito é igual nos dois planos (decisão do Daniel): o plano mais caro só
    // ganha no limite da mensalidade. Por isso o pacote nunca é mostrado em %
    // do plano — isso faria o mesmo pacote parecer menor no Completo.
    pacotes: PACOTES_CREDITO_BRL.map((v) => ({
      valor: v,
      nome: 'Crédito extra',
      link: process.env[`EVOX_LINK_CREDITO_${v}`] || null,
    })),
    // Trocar de plano: o pagamento vai pela Kiwify (link por plano, quando existir).
    planos: (['essencial', 'completo'] as PlanoIa[]).map((p) => ({
      id: p,
      atual: p === planoDa(tenantId),
      link: process.env[`EVOX_LINK_PLANO_${p.toUpperCase()}`] || null,
    })),
  };
}
