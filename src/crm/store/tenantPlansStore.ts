/**
 * tenantPlansStore — CRUD da tabela tenant_plans (PR 5 da Onda 62).
 *
 * UI pra editar planos vem em PR futuro (post-PR 6). Por enquanto seed
 * via migration 006 + admin pode editar via SQL/API.
 */
import { getCrmDb } from '../schema.js';
import type { TenantPlan, ProductType } from '../types.js';
import { randomBytes } from 'node:crypto';

function rowToPlan(r: any): TenantPlan {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    name: r.name,
    productType: r.product_type as ProductType,
    basePriceCents: r.base_price_cents,
    coverageSummary: r.coverage_summary,
    minAge: r.min_age ?? undefined,
    maxAge: r.max_age ?? undefined,
    allowsDependents: r.allows_dependents === 1,
    additionalPerDependentCents: r.additional_per_dependent_cents,
    surchargeOutsideRioCents: r.surcharge_outside_rio_cents,
    active: r.active === 1,
    priority: r.priority,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    metadata: r.metadata ? safeParse(r.metadata) : undefined,
  };
}

function safeParse(s: string): Record<string, unknown> | undefined {
  try { return JSON.parse(s) as Record<string, unknown>; }
  catch { return undefined; }
}

/** Lista planos ativos do tenant, ordenados por priority ASC depois name ASC.
 *  productType opcional pra filtrar. */
export function listPlansForTenant(tenantId: string, productType?: ProductType): TenantPlan[] {
  const db = getCrmDb();
  let sql = `SELECT * FROM tenant_plans WHERE tenant_id = ? AND active = 1`;
  const params: unknown[] = [tenantId];
  if (productType) {
    sql += ` AND product_type = ?`;
    params.push(productType);
  }
  sql += ` ORDER BY priority ASC, name ASC`;
  const rows = db.prepare(sql).all(...params) as any[];
  return rows.map(rowToPlan);
}

export function getPlan(tenantId: string, planId: string): TenantPlan | null {
  const db = getCrmDb();
  const r = db.prepare(`SELECT * FROM tenant_plans WHERE tenant_id = ? AND id = ?`)
    .get(tenantId, planId) as any;
  return r ? rowToPlan(r) : null;
}

export interface CreatePlanInput {
  tenantId: string;
  name: string;
  productType: ProductType;
  basePriceCents: number;
  coverageSummary: string;
  minAge?: number;
  maxAge?: number;
  allowsDependents?: boolean;
  additionalPerDependentCents?: number;
  surchargeOutsideRioCents?: number;
  priority?: number;
  metadata?: Record<string, unknown>;
}

export function createPlan(input: CreatePlanInput): TenantPlan {
  const db = getCrmDb();
  const ts = Date.now();
  const plan: TenantPlan = {
    id: 'tplan_' + randomBytes(6).toString('hex'),
    tenantId: input.tenantId,
    name: input.name,
    productType: input.productType,
    basePriceCents: input.basePriceCents,
    coverageSummary: input.coverageSummary,
    minAge: input.minAge,
    maxAge: input.maxAge,
    allowsDependents: input.allowsDependents ?? false,
    additionalPerDependentCents: input.additionalPerDependentCents ?? 0,
    surchargeOutsideRioCents: input.surchargeOutsideRioCents ?? 0,
    active: true,
    priority: input.priority ?? 100,
    createdAt: ts,
    updatedAt: ts,
    metadata: input.metadata,
  };
  db.prepare(`
    INSERT INTO tenant_plans (
      id, tenant_id, name, product_type, base_price_cents, coverage_summary,
      min_age, max_age, allows_dependents, additional_per_dependent_cents,
      surcharge_outside_rio_cents, active, priority, created_at, updated_at, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    plan.id, plan.tenantId, plan.name, plan.productType,
    plan.basePriceCents, plan.coverageSummary,
    plan.minAge ?? null, plan.maxAge ?? null,
    plan.allowsDependents ? 1 : 0,
    plan.additionalPerDependentCents,
    plan.surchargeOutsideRioCents,
    plan.active ? 1 : 0,
    plan.priority,
    plan.createdAt, plan.updatedAt,
    plan.metadata ? JSON.stringify(plan.metadata) : null,
  );
  return plan;
}

export function updatePlan(
  tenantId: string, planId: string,
  patch: Partial<Omit<TenantPlan, 'id' | 'tenantId' | 'createdAt'>>,
): TenantPlan | null {
  const existing = getPlan(tenantId, planId);
  if (!existing) return null;
  const merged: TenantPlan = { ...existing, ...patch, updatedAt: Date.now() };
  const db = getCrmDb();
  db.prepare(`
    UPDATE tenant_plans SET
      name = ?, product_type = ?, base_price_cents = ?, coverage_summary = ?,
      min_age = ?, max_age = ?, allows_dependents = ?, additional_per_dependent_cents = ?,
      surcharge_outside_rio_cents = ?, active = ?, priority = ?, updated_at = ?,
      metadata = ?
    WHERE id = ? AND tenant_id = ?
  `).run(
    merged.name, merged.productType, merged.basePriceCents, merged.coverageSummary,
    merged.minAge ?? null, merged.maxAge ?? null,
    merged.allowsDependents ? 1 : 0,
    merged.additionalPerDependentCents,
    merged.surchargeOutsideRioCents,
    merged.active ? 1 : 0,
    merged.priority,
    merged.updatedAt,
    merged.metadata ? JSON.stringify(merged.metadata) : null,
    planId, tenantId,
  );
  return merged;
}

export function deletePlan(tenantId: string, planId: string): boolean {
  const r = getCrmDb().prepare(`DELETE FROM tenant_plans WHERE tenant_id = ? AND id = ?`)
    .run(tenantId, planId);
  return r.changes > 0;
}
