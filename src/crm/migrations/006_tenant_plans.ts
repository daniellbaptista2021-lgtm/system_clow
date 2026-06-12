/**
 * 006 — tenant_plans + seed PV Corretora.
 *
 * Cada tenant cadastra os planos que comercializa. Tool gerar_cotacao
 * (PR 5 da Onda 62) le essa tabela ao inves do mock fixo.
 *
 * Regras especificas (Real Pax) ficam em src/crm/agents/quotation/realPaxRules.ts.
 *
 * Seed PV Corretora: 4 planos do Real Pax Essencial. Idempotente (so
 * insere se a row nao existir). tenant_id e PV em prod —
 * be5f5042-d939-447d-8777-5ac841e7aa07. Em outros envs (dev/test/CI)
 * a row vai existir mas nao vai ser consultada (queries filtram por
 * tenant_id real). Harmless.
 */
import type { Database } from 'better-sqlite3';
import { randomBytes } from 'node:crypto';

export const version = 6;
export const description = 'tenant_plans + seed PV Corretora Real Pax Essencial';

const PV_TENANT_ID = 'be5f5042-d939-447d-8777-5ac841e7aa07';

function tableExists(db: Database, table: string): boolean {
  const r = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(table) as { name?: string } | undefined;
  return !!r?.name;
}

export function up(db: Database): void {
  // ── DDL ─────────────────────────────────────────────────────────────
  if (!tableExists(db, 'tenant_plans')) {
    db.exec(`
      CREATE TABLE tenant_plans (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        product_type TEXT NOT NULL,
        base_price_cents INTEGER NOT NULL,
        coverage_summary TEXT NOT NULL,
        min_age INTEGER,
        max_age INTEGER,
        allows_dependents INTEGER NOT NULL DEFAULT 0,
        additional_per_dependent_cents INTEGER NOT NULL DEFAULT 0,
        surcharge_outside_rio_cents INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1,
        priority INTEGER NOT NULL DEFAULT 100,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        metadata TEXT
      )
    `);
    db.exec(`
      CREATE INDEX idx_tenant_plans_active
      ON tenant_plans(tenant_id, active, product_type)
    `);
    db.exec(`
      CREATE UNIQUE INDEX idx_tenant_plans_tenant_name
      ON tenant_plans(tenant_id, name)
    `);
  }

  // ── Seed PV Corretora (idempotente via UNIQUE index + INSERT OR IGNORE) ─
  const ts = Date.now();
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO tenant_plans (
      id, tenant_id, name, product_type, base_price_cents, coverage_summary,
      min_age, max_age, allows_dependents, additional_per_dependent_cents,
      surcharge_outside_rio_cents, active, priority, created_at, updated_at, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const seedPlans: Array<{
    name: string;
    base_price_cents: number;
    coverage_summary: string;
    min_age: number | null;
    max_age: number | null;
    allows_dependents: number;
    additional_per_dependent_cents: number;
    surcharge_outside_rio_cents: number;
    priority: number;
  }> = [
    {
      name: 'Real Pax Essencial Individual',
      base_price_cents: 2990, // R$ 29,90
      coverage_summary: 'Assistência funeral até R$ 5.000, sem carência, atendimento 24h.',
      min_age: 0,
      max_age: 75,
      allows_dependents: 0,
      additional_per_dependent_cents: 0,
      surcharge_outside_rio_cents: 800, // +R$ 8 fora do Rio
      priority: 10,
    },
    {
      name: 'Real Pax Essencial Casal',
      base_price_cents: 3990, // R$ 39,90
      coverage_summary: 'Assistência funeral pra você + cônjuge até R$ 5.000 cada, sem carência.',
      min_age: 0,
      max_age: 75,
      allows_dependents: 0, // casal é par fixo, não dependente extra
      additional_per_dependent_cents: 0,
      surcharge_outside_rio_cents: 800,
      priority: 20,
    },
    {
      name: 'Real Pax Essencial Familiar',
      base_price_cents: 5990, // R$ 59,90
      coverage_summary: 'Cobertura familiar até 4 pessoas (titular + 3 dependentes), assistência R$ 5.000 por pessoa.',
      min_age: 0,
      max_age: 75,
      allows_dependents: 1,
      additional_per_dependent_cents: 0, // ja incluso no preco até 3 dependentes
      surcharge_outside_rio_cents: 800,
      priority: 30,
    },
    {
      name: 'Real Pax Essencial Familiar Ampliado',
      base_price_cents: 8990, // R$ 89,90
      coverage_summary: 'Cobertura familiar até 6 pessoas, assistência ampliada R$ 7.000 por pessoa, traslado nacional.',
      min_age: 0,
      max_age: 75,
      allows_dependents: 1,
      additional_per_dependent_cents: 0,
      surcharge_outside_rio_cents: 800,
      priority: 40,
    },
  ];

  for (const p of seedPlans) {
    stmt.run(
      'tplan_' + randomBytes(6).toString('hex'),
      PV_TENANT_ID,
      p.name,
      'funeral',
      p.base_price_cents,
      p.coverage_summary,
      p.min_age, p.max_age,
      p.allows_dependents,
      p.additional_per_dependent_cents,
      p.surcharge_outside_rio_cents,
      1, // active
      p.priority,
      ts, ts,
      null, // metadata
    );
  }
}

export function down(db: Database): void {
  if (tableExists(db, 'tenant_plans')) {
    db.exec('DROP TABLE tenant_plans');
  }
}
