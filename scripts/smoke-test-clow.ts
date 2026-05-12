#!/usr/bin/env tsx
/**
 * smoke-test-clow.ts — verifica saúde end-to-end do System Clow PV.
 *
 * Daniel 2026-05-07 (Fase 3.2): roda diariamente (via cron) pra pegar
 * regressão ANTES do cliente. Não manda mensagem real pelo WhatsApp;
 * roda em-processo com fixtures.
 *
 * Uso:
 *   tsx scripts/smoke-test-clow.ts
 *   npm run smoke-test
 *
 * Saída: JSON com pass/fail por check + summary. Exit code 0 se tudo
 * verde, 1 se qualquer check falhou.
 *
 * Checks:
 *   1. /health/ready responde 200
 *   2. /health/clow-dashboard retorna JSON válido
 *   3. Coluna Atendimento existe + tem prompt unificado + agent_enabled=1
 *   4. Tool cotar_sulamerica_api retorna valor da tabela (todos os 6
 *      preços principais bate exato)
 *   5. outputValidator bloqueia: forbidden_term, price_below_floor,
 *      price_off_table; libera valor da tabela
 *   6. looksLikeMetaCommentary bloqueia patterns conhecidos
 */

import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.chdir(path.resolve(__dirname, '..'));

const HEALTH_BASE = process.env.SMOKE_HEALTH_URL || 'http://localhost:3001';
const PV_TENANT = 'be5f5042-d939-447d-8777-5ac841e7aa07';
const ATEND_COLUMN_ID = 'crm_col_591b12179732';

type CheckResult = { name: string; ok: boolean; details?: string };
const results: CheckResult[] = [];

function record(name: string, ok: boolean, details?: string) {
  results.push({ name, ok, details });
}

async function fetchJson(url: string): Promise<{ status: number; body: any }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  } finally {
    clearTimeout(t);
  }
}

// ─── Check 1: /health/ready ──────────────────────────────────────────
async function check_health_ready() {
  try {
    const r = await fetchJson(`${HEALTH_BASE}/health/ready`);
    const ok = r.status === 200 && r.body?.status === 'ok';
    record('health_ready', ok, ok ? `status=${r.body?.status}` : `status=${r.status} body=${JSON.stringify(r.body)?.slice(0, 80)}`);
  } catch (err: any) {
    record('health_ready', false, `fetch_failed: ${err?.message}`);
  }
}

// ─── Check 2: /health/clow-dashboard ─────────────────────────────────
async function check_clow_dashboard() {
  try {
    const r = await fetchJson(`${HEALTH_BASE}/health/clow-dashboard`);
    const ok = r.status === 200
      && typeof r.body?.collected_at === 'string'
      && Array.isArray(r.body?.column_load)
      && Array.isArray(r.body?.alerts);
    record('clow_dashboard', ok, ok ? `cards_total=${r.body?.cards_waiting_client_reply?.total} alerts=${r.body?.alerts?.length}` : `status=${r.status}`);
  } catch (err: any) {
    record('clow_dashboard', false, `fetch_failed: ${err?.message}`);
  }
}

// ─── Check 3: coluna Atendimento configurada ─────────────────────────
async function check_atendimento_column() {
  const { getCrmDb } = await import('../src/crm/schema.js');
  const row = getCrmDb().prepare(
    `SELECT name, agent_enabled, agent_role, length(agent_system_prompt) as prompt_len, agent_system_prompt FROM crm_columns WHERE id=?`,
  ).get(ATEND_COLUMN_ID) as { name: string; agent_enabled: number; agent_role: string; prompt_len: number; agent_system_prompt: string } | undefined;

  if (!row) return record('atendimento_column', false, 'coluna não encontrada');
  const prompt = row.agent_system_prompt || '';
  const checks = [
    { ok: row.name === 'Atendimento', what: `name=${row.name}` },
    { ok: row.agent_enabled === 1, what: `agent_enabled=${row.agent_enabled}` },
    { ok: row.agent_role === 'vendedor', what: `role=${row.agent_role}` },
    { ok: row.prompt_len > 5000, what: `prompt_len=${row.prompt_len}` },
    { ok: prompt.includes('R$ 29,90'), what: 'prompt contém R$ 29,90' },
    { ok: prompt.includes('R$ 109,90'), what: 'prompt contém R$ 109,90' },
    { ok: prompt.includes('cotar_sulamerica_api'), what: 'prompt menciona cotar_sulamerica_api' },
    { ok: !/Real Pax|AP Flex/i.test(prompt), what: 'prompt sem "Real Pax"/"AP Flex"' },
  ];
  const failed = checks.filter((c) => !c.ok);
  record('atendimento_column', failed.length === 0, failed.length === 0
    ? 'todos os 8 sub-checks ok'
    : `falhas: ${failed.map((f) => f.what).join(', ')}`);
}

// ─── Check 4: tool cotar_sulamerica_api retorna tabela correta ───────
async function check_cotacao_tool() {
  const { COTACAO_SULAMERICA_TOOLS } = await import('../src/crm/agents/tools/cotacao_sulamerica.js');
  const tool = COTACAO_SULAMERICA_TOOLS[0];
  if (!tool) return record('cotacao_tool', false, 'tool não encontrada');

  // Mock context — a tool não toca canal, só o state store
  const { upsertCardAgentState, getCardAgentState } = await import('../src/crm/store/cardAgentStateStore.js');
  const { getCrmDb } = await import('../src/crm/schema.js');

  const cardId = 'smoke_card_' + Date.now();
  // Cria card fake mínimo no DB (state store referencia)
  getCrmDb().prepare(
    `INSERT OR IGNORE INTO crm_cards (id, tenant_id, board_id, column_id, title, value_cents, probability, position, custom_fields_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, 0, 0, '{}', ?, ?)`,
  ).run(cardId, PV_TENANT, 'crm_board_048c4738a15b', ATEND_COLUMN_ID, 'Smoke Test', Date.now(), Date.now());

  upsertCardAgentState({
    cardId, columnId: ATEND_COLUMN_ID, currentAgentRole: 'vendedor',
    tenantId: PV_TENANT, status: 'active',
  });
  const state = getCardAgentState(cardId)!;

  const ctx = {
    tenantId: PV_TENANT,
    channel: { id: 'smoke', tenantId: PV_TENANT, type: 'zapi' as const, name: 'Smoke', credentialsEncrypted: '', webhookSecret: '', createdAt: Date.now() },
    card: { id: cardId, tenantId: PV_TENANT, boardId: 'crm_board_048c4738a15b', columnId: ATEND_COLUMN_ID, title: 'Smoke', valueCents: 0, probability: 0, position: 0, customFields: {}, createdAt: Date.now(), updatedAt: Date.now() } as any,
    column: { id: ATEND_COLUMN_ID, name: 'Atendimento', position: 1, color: '#000', createdAt: Date.now() } as any,
    state,
    customerPhone: '+5511999999999',
    role: 'vendedor' as const,
  };

  const expected: Array<[number, 'individual' | 'casal' | 'casal_filhos' | 'completo', number]> = [
    [30, 'individual', 2990],
    [50, 'individual', 3990],
    [35, 'casal', 3990],
    [60, 'casal', 4990],
    [35, 'casal_filhos', 4990],
    [50, 'casal_filhos', 5990],
    [30, 'completo', 8990],
    [65, 'completo', 10990],
  ];

  const fails: string[] = [];
  for (const [idade, composicao, expectedCents] of expected) {
    const r = await tool.execute({ idade, composicao }, ctx);
    if (!r.ok) {
      fails.push(`${composicao}/${idade}: error=${(r as any).error}`);
      continue;
    }
    const cents = (r as any).result?.total_cents;
    if (cents !== expectedCents) {
      fails.push(`${composicao}/${idade}: got ${cents}, expected ${expectedCents}`);
    }
    if (!r.userVisible || /\bAPI\b|cotador|sistema oficial/i.test(r.userVisible)) {
      fails.push(`${composicao}/${idade}: userVisible vazia ou com termo proibido`);
    }
  }

  // Cleanup
  getCrmDb().prepare(`DELETE FROM crm_cards WHERE id=?`).run(cardId);

  record('cotacao_tool', fails.length === 0,
    fails.length === 0 ? `8 cenários ok (preços: 2990/3990/3990/4990/4990/5990/8990/10990)` : `falhas: ${fails.join(' | ')}`);
}

// ─── Check 5: outputValidator regras ─────────────────────────────────
async function check_output_validator() {
  const { validateOutput } = await import('../src/crm/agents/outputValidator.js');
  const fails: string[] = [];

  // Deve PASSAR: valor da tabela com tool ok
  const okTable = validateOutput('Sai por R$ 29,90/mês', [{ name: 'cotar_sulamerica_api', ok: true }]);
  if (!okTable.ok) fails.push(`R$ 29,90 deveria passar mas: ${okTable.reason}`);

  // Deve BLOQUEAR: forbidden term
  const fb = validateOutput('Vou consultar a API oficial', [{ name: 'cotar_sulamerica_api', ok: true }]);
  if (fb.ok || fb.reason !== 'forbidden_term') fails.push(`forbidden_term não pegou: ${fb.ok}/${fb.reason}`);

  // Deve BLOQUEAR: price_below_floor
  const flo = validateOutput('Sai por R$ 9,98/mês', [{ name: 'cotar_sulamerica_api', ok: true }]);
  if (flo.ok || flo.reason !== 'price_below_floor') fails.push(`price_below_floor não pegou: ${flo.ok}/${flo.reason}`);

  // Deve BLOQUEAR: price_off_table
  const off = validateOutput('Sai por R$ 76,62/mês', [{ name: 'cotar_sulamerica_api', ok: true }]);
  if (off.ok || off.reason !== 'price_off_table') fails.push(`price_off_table não pegou: ${off.ok}/${off.reason}`);

  // Deve BLOQUEAR: unbacked_currency
  const ub = validateOutput('R$ 50,00 mensais', []);
  if (ub.ok || ub.reason !== 'unbacked_currency') fails.push(`unbacked_currency não pegou: ${ub.ok}/${ub.reason}`);

  record('output_validator', fails.length === 0,
    fails.length === 0 ? '5 regras ativas (table/forbidden/floor/off-table/unbacked)' : `falhas: ${fails.join(' | ')}`);
}

// ─── Check 6: looksLikeMetaCommentary patterns ───────────────────────
async function check_meta_commentary() {
  const { looksLikeMetaCommentary } = await import('../src/crm/agents/columnAgentRunner.js');
  const fails: string[] = [];

  const shouldBlock = [
    'Tag já estava aplicada. Vou seguir.',
    'Vou agora fazer as 4 perguntas na ordem',
    'Vou dar uma leve cobrada',
    'cotação automática pra você',
    'A cliente Norma já preencheu os dados',
    'Vou cotar com a API oficial',
  ];
  for (const text of shouldBlock) {
    if (!looksLikeMetaCommentary(text)) fails.push(`não bloqueou: "${text.slice(0, 40)}..."`);
  }

  const shouldPass = [
    'Oi! Como posso te ajudar?',
    'O plano cobre toda a família',
    'Vou seguir as orientações do médico',
  ];
  for (const text of shouldPass) {
    if (looksLikeMetaCommentary(text)) fails.push(`bloqueou indevidamente: "${text.slice(0, 40)}..."`);
  }

  record('meta_commentary', fails.length === 0,
    fails.length === 0 ? `${shouldBlock.length} patterns + ${shouldPass.length} negativos ok` : `falhas: ${fails.join(' | ')}`);
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
  const t0 = Date.now();

  await check_health_ready();
  await check_clow_dashboard();
  await check_atendimento_column();
  await check_cotacao_tool();
  await check_output_validator();
  await check_meta_commentary();

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  const summary = {
    timestamp: new Date().toISOString(),
    duration_ms: Date.now() - t0,
    total: results.length,
    passed,
    failed,
    status: failed === 0 ? 'ok' : 'FAIL',
    checks: results,
  };

  console.log(JSON.stringify(summary, null, 2));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(JSON.stringify({ status: 'ERROR', error: err?.message || String(err) }));
  process.exit(2);
});
