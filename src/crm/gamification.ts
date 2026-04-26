/**
 * Gamification — Onda 27.
 *
 *   - Leaderboard: ranking de agentes por métrica em período
 *   - Goals: metas individuais (agent_id) ou de equipe (team_id)
 *   - Badges: catálogo de conquistas + auto-award via criteria_json
 *   - Performance dashboard: comparativo entre agentes
 */

import { randomBytes } from 'crypto';
import { getCrmDb } from './schema.js';

function nid(prefix: string): string { return prefix + '_' + randomBytes(6).toString('hex'); }
const now = () => Date.now();

export type MetricKind = 'deals_won' | 'revenue' | 'activities' | 'tasks_completed' | 'calls' | 'meetings';
export type Period = 'day' | 'week' | 'month' | 'quarter' | 'year' | 'all_time';

// ─── Period → timestamp range ──────────────────────────────────────────
function periodRange(period: Period, anchor: number = Date.now()): { from: number; to: number } {
  const d = new Date(anchor);
  const to = anchor;
  let from = 0;
  if (period === 'day')      { d.setUTCHours(0, 0, 0, 0); from = d.getTime(); }
  else if (period === 'week'){
    const day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() - (day - 1));
    d.setUTCHours(0, 0, 0, 0); from = d.getTime();
  }
  else if (period === 'month')   { from = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); }
  else if (period === 'quarter') { const q = Math.floor(d.getUTCMonth() / 3); from = Date.UTC(d.getUTCFullYear(), q * 3, 1); }
  else if (period === 'year')    { from = Date.UTC(d.getUTCFullYear(), 0, 1); }
  return { from, to };
}

// ─── Leaderboard ───────────────────────────────────────────────────────
export interface LeaderRow {
  agentId: string;
  agentName: string;
  value: number;
  rank: number;
}

export function computeLeaderboard(
  tenantId: string,
  kind: MetricKind,
  period: Period = 'month',
): LeaderRow[] {
  const db = getCrmDb();
  const { from, to } = periodRange(period);

  const sql = (() => {
    switch (kind) {
      case 'deals_won':
        return `
          SELECT c.owner_agent_id AS agent_id, a.name AS agent_name,
            COUNT(c.id) AS value
          FROM crm_cards c
          JOIN crm_columns col ON col.id = c.column_id
          LEFT JOIN crm_agents a ON a.id = c.owner_agent_id
          WHERE c.tenant_id = ? AND col.stage_type = 'won'
            AND c.updated_at BETWEEN ? AND ?
            AND c.owner_agent_id IS NOT NULL
          GROUP BY c.owner_agent_id
          ORDER BY value DESC
        `;
      case 'revenue':
        return `
          SELECT c.owner_agent_id AS agent_id, a.name AS agent_name,
            COALESCE(SUM(c.value_cents), 0) AS value
          FROM crm_cards c
          JOIN crm_columns col ON col.id = c.column_id
          LEFT JOIN crm_agents a ON a.id = c.owner_agent_id
          WHERE c.tenant_id = ? AND col.stage_type = 'won'
            AND c.updated_at BETWEEN ? AND ?
            AND c.owner_agent_id IS NOT NULL
          GROUP BY c.owner_agent_id
          ORDER BY value DESC
        `;
      case 'activities':
        return `
          SELECT act.created_by_agent_id AS agent_id, ag.name AS agent_name,
            COUNT(act.id) AS value
          FROM crm_activities act
          LEFT JOIN crm_agents ag ON ag.id = act.created_by_agent_id
          WHERE act.tenant_id = ? AND act.created_at BETWEEN ? AND ?
            AND act.created_by_agent_id IS NOT NULL
          GROUP BY act.created_by_agent_id
          ORDER BY value DESC
        `;
      case 'calls':
        return `
          SELECT act.created_by_agent_id AS agent_id, ag.name AS agent_name,
            COUNT(act.id) AS value
          FROM crm_activities act
          LEFT JOIN crm_agents ag ON ag.id = act.created_by_agent_id
          WHERE act.tenant_id = ? AND act.created_at BETWEEN ? AND ?
            AND act.type = 'call'
            AND act.created_by_agent_id IS NOT NULL
          GROUP BY act.created_by_agent_id
          ORDER BY value DESC
        `;
      case 'meetings':
        return `
          SELECT ap.agent_id AS agent_id, ag.name AS agent_name,
            COUNT(ap.id) AS value
          FROM crm_appointments ap
          LEFT JOIN crm_agents ag ON ag.id = ap.agent_id
          WHERE ap.tenant_id = ? AND ap.starts_at BETWEEN ? AND ?
            AND ap.status IN ('completed', 'confirmed')
            AND ap.agent_id IS NOT NULL
          GROUP BY ap.agent_id
          ORDER BY value DESC
        `;
      case 'tasks_completed':
        return `
          SELECT t.assigned_to_agent_id AS agent_id, ag.name AS agent_name,
            COUNT(t.id) AS value
          FROM crm_tasks t
          LEFT JOIN crm_agents ag ON ag.id = t.assigned_to_agent_id
          WHERE t.tenant_id = ? AND t.completed_at BETWEEN ? AND ?
            AND t.status = 'completed'
            AND t.assigned_to_agent_id IS NOT NULL
          GROUP BY t.assigned_to_agent_id
          ORDER BY value DESC
        `;
    }
  })();

  const rows = db.prepare(sql).all(tenantId, from, to) as any[];
  return rows.map((r, i) => ({
    agentId: r.agent_id,
    agentName: r.agent_name || r.agent_id,
    value: r.value,
    rank: i + 1,
  }));
}

// ─── Goals ─────────────────────────────────────────────────────────────
export interface Goal {
  id: string;
  tenantId: string;
  agentId?: string;
  teamId?: string;
  kind: MetricKind;
  target: number;
  period: Period;
  startDate: number;
  endDate: number;
  enabled: boolean;
  title?: string;
  createdAt: number;
}

function rowToGoal(r: any): Goal {
  return {
    id: r.id, tenantId: r.tenant_id,
    agentId: r.agent_id ?? undefined, teamId: r.team_id ?? undefined,
    kind: r.kind as MetricKind, target: r.target,
    period: r.period as Period, startDate: r.start_date, endDate: r.end_date,
    enabled: r.enabled === 1, title: r.title ?? undefined, createdAt: r.created_at,
  };
}

export function createGoal(tenantId: string, input: {
  agentId?: string; teamId?: string; kind: MetricKind; target: number;
  period: Period; startDate?: number; endDate?: number; title?: string;
}): Goal {
  if (!input.agentId && !input.teamId) throw new Error('agentId or teamId required');
  const id = nid('crm_goal');
  const t = now();
  const range = periodRange(input.period, t);
  const startDate = input.startDate ?? range.from;
  const endDate = input.endDate ?? range.to + 365 * 86400_000;

  getCrmDb().prepare(`
    INSERT INTO crm_goals (id, tenant_id, agent_id, team_id, kind, target, period, start_date, end_date, enabled, title, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(id, tenantId, input.agentId ?? null, input.teamId ?? null,
    input.kind, input.target, input.period, startDate, endDate, input.title ?? null, t);
  return getGoal(tenantId, id)!;
}

export function getGoal(tenantId: string, id: string): Goal | null {
  const r = getCrmDb().prepare('SELECT * FROM crm_goals WHERE id = ? AND tenant_id = ?').get(id, tenantId) as any;
  return r ? rowToGoal(r) : null;
}

export function listGoals(tenantId: string, opts: { agentId?: string; teamId?: string } = {}): Goal[] {
  const wh = ['tenant_id = ?'];
  const params: any[] = [tenantId];
  if (opts.agentId) { wh.push('agent_id = ?'); params.push(opts.agentId); }
  if (opts.teamId)  { wh.push('team_id = ?'); params.push(opts.teamId); }
  return (getCrmDb().prepare(`SELECT * FROM crm_goals WHERE ${wh.join(' AND ')} ORDER BY created_at DESC`).all(...params) as any[])
    .map(rowToGoal);
}

export function updateGoal(tenantId: string, id: string, patch: Partial<Goal>): Goal | null {
  const ex = getGoal(tenantId, id);
  if (!ex) return null;
  const m = { ...ex, ...patch };
  getCrmDb().prepare(`
    UPDATE crm_goals SET target = ?, period = ?, start_date = ?, end_date = ?, enabled = ?, title = ?, kind = ?
    WHERE id = ? AND tenant_id = ?
  `).run(m.target, m.period, m.startDate, m.endDate, m.enabled ? 1 : 0, m.title ?? null, m.kind, id, tenantId);
  return getGoal(tenantId, id);
}

export function deleteGoal(tenantId: string, id: string): boolean {
  return getCrmDb().prepare('DELETE FROM crm_goals WHERE id = ? AND tenant_id = ?').run(id, tenantId).changes > 0;
}

export function goalProgress(tenantId: string, goalId: string): { goal: Goal; currentValue: number; percent: number } | null {
  const g = getGoal(tenantId, goalId);
  if (!g) return null;

  // Compute current value by metric, scoped to agentId OR teamId members
  const db = getCrmDb();
  let agents: string[] = [];
  if (g.agentId) agents = [g.agentId];
  else if (g.teamId) {
    const team = db.prepare('SELECT members_json FROM crm_teams WHERE id = ? AND tenant_id = ?').get(g.teamId, tenantId) as any;
    if (team) agents = JSON.parse(team.members_json || '[]');
  }
  if (agents.length === 0) return { goal: g, currentValue: 0, percent: 0 };

  const ph = agents.map(() => '?').join(',');
  let sql: string;
  switch (g.kind) {
    case 'deals_won':
      sql = `SELECT COUNT(*) v FROM crm_cards c JOIN crm_columns col ON col.id = c.column_id WHERE c.tenant_id = ? AND col.stage_type = 'won' AND c.updated_at BETWEEN ? AND ? AND c.owner_agent_id IN (${ph})`;
      break;
    case 'revenue':
      sql = `SELECT COALESCE(SUM(c.value_cents), 0) v FROM crm_cards c JOIN crm_columns col ON col.id = c.column_id WHERE c.tenant_id = ? AND col.stage_type = 'won' AND c.updated_at BETWEEN ? AND ? AND c.owner_agent_id IN (${ph})`;
      break;
    case 'activities':
      sql = `SELECT COUNT(*) v FROM crm_activities WHERE tenant_id = ? AND created_at BETWEEN ? AND ? AND created_by_agent_id IN (${ph})`;
      break;
    case 'calls':
      sql = `SELECT COUNT(*) v FROM crm_activities WHERE tenant_id = ? AND type = 'call' AND created_at BETWEEN ? AND ? AND created_by_agent_id IN (${ph})`;
      break;
    case 'meetings':
      sql = `SELECT COUNT(*) v FROM crm_appointments WHERE tenant_id = ? AND starts_at BETWEEN ? AND ? AND status IN ('completed', 'confirmed') AND agent_id IN (${ph})`;
      break;
    case 'tasks_completed':
      sql = `SELECT COUNT(*) v FROM crm_tasks WHERE tenant_id = ? AND status = 'completed' AND completed_at BETWEEN ? AND ? AND assigned_to_agent_id IN (${ph})`;
      break;
  }
  const row = db.prepare(sql).get(tenantId, g.startDate, g.endDate, ...agents) as any;
  const v = row?.v || 0;
  return { goal: g, currentValue: v, percent: g.target > 0 ? Math.min(100, Math.round((v / g.target) * 100)) : 0 };
}

// ─── Badges ────────────────────────────────────────────────────────────
export interface Badge {
  id: string;
  tenantId: string;
  name: string;
  description?: string;
  icon: string;
  criteria: { kind: MetricKind; threshold: number; period: Period };
  autoAward: boolean;
  createdAt: number;
}

function rowToBadge(r: any): Badge {
  return {
    id: r.id, tenantId: r.tenant_id, name: r.name,
    description: r.description ?? undefined, icon: r.icon || '🏆',
    criteria: JSON.parse(r.criteria_json || '{}'),
    autoAward: r.auto_award === 1, createdAt: r.created_at,
  };
}

export function createBadge(tenantId: string, input: {
  name: string; description?: string; icon?: string;
  criteria: { kind: MetricKind; threshold: number; period: Period };
  autoAward?: boolean;
}): Badge {
  const id = nid('crm_bdg');
  getCrmDb().prepare(`
    INSERT INTO crm_badges (id, tenant_id, name, description, icon, criteria_json, auto_award, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, tenantId, input.name, input.description ?? null, input.icon || '🏆',
    JSON.stringify(input.criteria), input.autoAward !== false ? 1 : 0, now());
  return getBadge(tenantId, id)!;
}

export function getBadge(tenantId: string, id: string): Badge | null {
  const r = getCrmDb().prepare('SELECT * FROM crm_badges WHERE id = ? AND tenant_id = ?').get(id, tenantId) as any;
  return r ? rowToBadge(r) : null;
}

export function listBadges(tenantId: string): Badge[] {
  return (getCrmDb().prepare('SELECT * FROM crm_badges WHERE tenant_id = ? ORDER BY created_at DESC').all(tenantId) as any[])
    .map(rowToBadge);
}

export function deleteBadge(tenantId: string, id: string): boolean {
  return getCrmDb().prepare('DELETE FROM crm_badges WHERE id = ? AND tenant_id = ?').run(id, tenantId).changes > 0;
}

export function agentBadges(tenantId: string, agentId: string): any[] {
  return getCrmDb().prepare(`
    SELECT ab.*, b.name, b.description, b.icon, b.criteria_json
    FROM crm_agent_badges ab
    JOIN crm_badges b ON b.id = ab.badge_id
    WHERE b.tenant_id = ? AND ab.agent_id = ?
    ORDER BY ab.earned_at DESC
  `).all(tenantId, agentId) as any[];
}

export function awardBadge(tenantId: string, agentId: string, badgeId: string, evidence?: Record<string, any>): boolean {
  const db = getCrmDb();
  const existing = db.prepare('SELECT id FROM crm_agent_badges WHERE badge_id = ? AND agent_id = ?').get(badgeId, agentId);
  if (existing) return false;
  const badge = db.prepare('SELECT id FROM crm_badges WHERE id = ? AND tenant_id = ?').get(badgeId, tenantId);
  if (!badge) return false;
  db.prepare(`
    INSERT INTO crm_agent_badges (id, agent_id, badge_id, earned_at, evidence_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(nid('crm_abdg'), agentId, badgeId, now(), JSON.stringify(evidence || {}));
  return true;
}

/** Evaluate all auto-award badges for all agents and award when criteria met. */
export function evaluateAllBadges(tenantId: string): { awarded: number } {
  const db = getCrmDb();
  const badges = db.prepare('SELECT * FROM crm_badges WHERE tenant_id = ? AND auto_award = 1').all(tenantId) as any[];
  const agents = db.prepare('SELECT id FROM crm_agents WHERE tenant_id = ? AND active = 1').all(tenantId) as any[];
  let awarded = 0;

  for (const b of badges) {
    const badge = rowToBadge(b);
    const board = computeLeaderboard(tenantId, badge.criteria.kind, badge.criteria.period);
    for (const row of board) {
      if (row.value >= badge.criteria.threshold) {
        if (awardBadge(tenantId, row.agentId, badge.id, {
          metric: badge.criteria.kind, value: row.value,
          threshold: badge.criteria.threshold, period: badge.criteria.period,
        })) {
          awarded++;
        }
      }
    }
  }
  return { awarded };
}

// ─── Performance dashboard ─────────────────────────────────────────────
export function performanceDashboard(tenantId: string, period: Period = 'month'): any {
  const deals = computeLeaderboard(tenantId, 'deals_won', period);
  const revenue = computeLeaderboard(tenantId, 'revenue', period);
  const activities = computeLeaderboard(tenantId, 'activities', period);
  const tasks = computeLeaderboard(tenantId, 'tasks_completed', period);

  // Merge by agentId
  const byAgent = new Map<string, any>();
  const put = (kind: string, row: LeaderRow) => {
    const r = byAgent.get(row.agentId) || { agentId: row.agentId, agentName: row.agentName };
    r[kind] = row.value;
    byAgent.set(row.agentId, r);
  };
  deals.forEach(r => put('dealsWon', r));
  revenue.forEach(r => put('revenueCents', r));
  activities.forEach(r => put('activities', r));
  tasks.forEach(r => put('tasksCompleted', r));

  return {
    period,
    rows: Array.from(byAgent.values()).sort((a, b) => (b.revenueCents || 0) - (a.revenueCents || 0)),
    leaderboards: {
      dealsWon: deals.slice(0, 10),
      revenue: revenue.slice(0, 10),
      activities: activities.slice(0, 10),
      tasksCompleted: tasks.slice(0, 10),
    },
  };
}

/** Seed default badges (called on migration). */
export function seedDefaultBadges(tenantId: string): void {
  const db = getCrmDb();
  const existing = (db.prepare('SELECT COUNT(*) n FROM crm_badges WHERE tenant_id = ?').get(tenantId) as any).n;
  if (existing > 0) return;
  const defaults: Array<Parameters<typeof createBadge>[1]> = [
    { name: 'Primeiro venda', icon: '🎉', description: 'Fechou o primeiro deal', criteria: { kind: 'deals_won', threshold: 1, period: 'all_time' } },
    { name: 'Vendedor do mês', icon: '🏆', description: '5 vendas em 1 mês', criteria: { kind: 'deals_won', threshold: 5, period: 'month' } },
    { name: 'Máquina de vendas', icon: '💰', description: '10 vendas em 1 mês', criteria: { kind: 'deals_won', threshold: 10, period: 'month' } },
    { name: 'Contato ouro', icon: '⭐', description: '50 atividades na semana', criteria: { kind: 'activities', threshold: 50, period: 'week' } },
    { name: 'Mestre dos calls', icon: '📞', description: '20 calls em 1 mês', criteria: { kind: 'calls', threshold: 20, period: 'month' } },
    { name: 'Executor', icon: '✅', description: '30 tarefas concluídas no mês', criteria: { kind: 'tasks_completed', threshold: 30, period: 'month' } },
  ];
  for (const d of defaults) createBadge(tenantId, d);
}

// ─── Scheduler daily hook ───────────────────────────────────────────────
let _lastEvalDay = -1;
export function tickDailyBadges(): void {
  const day = new Date().getUTCDate();
  if (_lastEvalDay === day) return;
  _lastEvalDay = day;
  try {
    const db = getCrmDb();
    const tenants = db.prepare('SELECT DISTINCT tenant_id FROM crm_badges WHERE auto_award = 1').all() as any[];
    for (const t of tenants) evaluateAllBadges(t.tenant_id);
  } catch (err: any) { console.warn('[gam daily]', err.message); }
}
