/**
 * 007 — PR 5.1: substitui planos Real Pax (ficticios) pelos planos
 * reais SulAmerica AP Flex pra tenant PV Corretora.
 *
 * Pra envs novos (test/CI/dev fresco), migration 006 ainda roda primeiro
 * com seed Real Pax (ja committed). 007 entao DELETA Real Pax e INSERE
 * SulAmerica. Resultado: env converge pro estado correto.
 *
 * Pra prod existente onde 006 ja foi aplicada antes do PR 5.1: 007 vai
 * rodar e fazer o cleanup direto (DELETE dos 4 Real Pax + INSERT dos 4
 * SulAmerica).
 *
 * Idempotencia:
 *   - DELETE filtra por nome exato dos 4 seeds Real Pax — se admin renomeou
 *     algum plano, nao toca (defensivo).
 *   - INSERT usa OR IGNORE via UNIQUE (tenant_id, name).
 *
 * Por que migration nova ao inves de editar 006:
 *   - 006 ja aplicada em prod. Editar ela retroativamente nao re-roda
 *     (schema_migrations marca version=6 como aplicada). Migration 007
 *     eh forward-only e roda em qualquer estado.
 */
import type { Database } from 'better-sqlite3';
import { randomBytes } from 'node:crypto';

export const version = 7;
export const description = 'PR 5.1: cleanup Real Pax + seed SulAmerica AP Flex pra PV Corretora';

const PV_TENANT_ID = 'be5f5042-d939-447d-8777-5ac841e7aa07';

const REAL_PAX_NAMES_TO_REMOVE = [
  'Real Pax Essencial Individual',
  'Real Pax Essencial Casal',
  'Real Pax Essencial Familiar',
  'Real Pax Essencial Familiar Ampliado',
];

const COVERAGE_BASE = 'Assistência funeral nacional + R$ 50.000 morte acidental + telemedicina + descontos farmácia + sorteios mensais. Cobertura em todo o Brasil, sem taxa de adesão.';

interface SeedPlan {
  name: string;
  base_price_cents: number;
  coverage_summary: string;
  min_age: number | null;
  max_age: number | null;
  allows_dependents: number;
  additional_per_dependent_cents: number;
  surcharge_outside_rio_cents: number;
  priority: number;
}

const SULAMERICA_SEED: SeedPlan[] = [
  {
    name: 'SulAmérica AP Flex Individual',
    base_price_cents: 2990, // R$ 29,90
    coverage_summary: COVERAGE_BASE,
    min_age: 1, max_age: 74,
    allows_dependents: 0, additional_per_dependent_cents: 0,
    surcharge_outside_rio_cents: 0, // SulAmerica eh nacional, sem regional
    priority: 10,
  },
  {
    name: 'SulAmérica AP Flex Casal',
    base_price_cents: 3990, // R$ 39,90
    coverage_summary: COVERAGE_BASE + ' Inclui titular + cônjuge.',
    min_age: 1, max_age: 74,
    allows_dependents: 0, additional_per_dependent_cents: 0,
    surcharge_outside_rio_cents: 0,
    priority: 20,
  },
  {
    name: 'SulAmérica AP Flex Familiar',
    base_price_cents: 4990, // R$ 49,90 (corrigido de 5990)
    coverage_summary: COVERAGE_BASE + ' Inclui titular + cônjuge + filhos até 21 anos.',
    min_age: 1, max_age: 74,
    allows_dependents: 1, additional_per_dependent_cents: 0,
    surcharge_outside_rio_cents: 0,
    priority: 30,
  },
  {
    name: 'SulAmérica AP Flex Familiar Ampliado',
    base_price_cents: 8990, // R$ 89,90
    coverage_summary: COVERAGE_BASE + ' Inclui titular + cônjuge + filhos + pais e/ou sogros, sem limite de idade pros dependentes adicionais.',
    min_age: 1, max_age: 74,
    allows_dependents: 1, additional_per_dependent_cents: 0,
    surcharge_outside_rio_cents: 0,
    priority: 40,
  },
];

function tableExists(db: Database, table: string): boolean {
  const r = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(table) as { name?: string } | undefined;
  return !!r?.name;
}

export function up(db: Database): void {
  if (!tableExists(db, 'tenant_plans')) return;

  // 1) Remove os 4 seeds Real Pax do PV (se existirem). Nao toca em planos
  //    que admin tenha renomeado/alterado.
  const delStmt = db.prepare(`DELETE FROM tenant_plans WHERE tenant_id = ? AND name = ?`);
  for (const oldName of REAL_PAX_NAMES_TO_REMOVE) {
    delStmt.run(PV_TENANT_ID, oldName);
  }

  // 2) Insere os 4 planos SulAmerica AP Flex (idempotente via UNIQUE index)
  const ts = Date.now();
  const insStmt = db.prepare(`
    INSERT OR IGNORE INTO tenant_plans (
      id, tenant_id, name, product_type, base_price_cents, coverage_summary,
      min_age, max_age, allows_dependents, additional_per_dependent_cents,
      surcharge_outside_rio_cents, active, priority, created_at, updated_at, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const p of SULAMERICA_SEED) {
    insStmt.run(
      'tplan_' + randomBytes(6).toString('hex'),
      PV_TENANT_ID,
      p.name,
      'acidentes_pessoais',
      p.base_price_cents,
      p.coverage_summary,
      p.min_age, p.max_age,
      p.allows_dependents,
      p.additional_per_dependent_cents,
      p.surcharge_outside_rio_cents,
      1, // active
      p.priority,
      ts, ts,
      null,
    );
  }
}

export function down(db: Database): void {
  // Nao restaura os Real Pax (eram seed errado). Apenas remove SulAmerica.
  if (!tableExists(db, 'tenant_plans')) return;
  const delStmt = db.prepare(`DELETE FROM tenant_plans WHERE tenant_id = ? AND name = ?`);
  for (const p of SULAMERICA_SEED) {
    delStmt.run(PV_TENANT_ID, p.name);
  }
}
