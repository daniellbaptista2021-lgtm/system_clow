/**
 * Tasks Pro — Onda 19.
 *
 * Tasks are richer than reminders: typed, prioritized, linked to cards/contacts,
 * recurring, and have alerts firing N minutes before due_at.
 *
 * Completing a recurring task auto-spawns the next occurrence.
 */

import { randomBytes } from 'crypto';
import { getCrmDb } from './schema.js';

export type TaskType = 'call' | 'email' | 'meeting' | 'followup' | 'other';
export type TaskPriority = 'low' | 'med' | 'high' | 'urgent';
export type TaskStatus = 'open' | 'completed' | 'cancelled';
export type RecurFreq = 'daily' | 'weekly' | 'monthly';

export interface TaskRecurrence {
  freq: RecurFreq;
  interval: number;        // every N of freq (1 = every day, 2 = every 2 weeks, etc.)
  until?: number;          // epoch ms stop
  weekdays?: number[];     // 0-6 for weekly (0 = Sunday)
}

export interface Task {
  id: string;
  tenantId: string;
  title: string;
  description?: string;
  type: TaskType;
  priority: TaskPriority;
  status: TaskStatus;
  dueAt?: number;
  completedAt?: number;
  assignedToAgentId?: string;
  cardId?: string;
  contactId?: string;
  recurrence?: TaskRecurrence;
  parentTaskId?: string;
  alertMinutesBefore?: number;
  alertFiredAt?: number;
  createdByAgentId?: string;
  createdAt: number;
  updatedAt: number;
}

function nid(): string { return 'crm_task_' + randomBytes(6).toString('hex'); }

function rowToTask(r: any): Task {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    title: r.title,
    description: r.description ?? undefined,
    type: (r.type || 'other') as TaskType,
    priority: (r.priority || 'med') as TaskPriority,
    status: (r.status || 'open') as TaskStatus,
    dueAt: r.due_at ?? undefined,
    completedAt: r.completed_at ?? undefined,
    assignedToAgentId: r.assigned_to_agent_id ?? undefined,
    cardId: r.card_id ?? undefined,
    contactId: r.contact_id ?? undefined,
    recurrence: r.recurrence_json ? JSON.parse(r.recurrence_json) : undefined,
    parentTaskId: r.parent_task_id ?? undefined,
    alertMinutesBefore: r.alert_minutes_before ?? undefined,
    alertFiredAt: r.alert_fired_at ?? undefined,
    createdByAgentId: r.created_by_agent_id ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  type?: TaskType;
  priority?: TaskPriority;
  dueAt?: number;
  assignedToAgentId?: string;
  cardId?: string;
  contactId?: string;
  recurrence?: TaskRecurrence;
  alertMinutesBefore?: number;
  createdByAgentId?: string;
}

export function createTask(tenantId: string, input: CreateTaskInput): Task {
  const db = getCrmDb();
  const id = nid();
  const now = Date.now();
  db.prepare(`
    INSERT INTO crm_tasks
      (id, tenant_id, title, description, type, priority, status, due_at,
       assigned_to_agent_id, card_id, contact_id, recurrence_json, alert_minutes_before,
       created_by_agent_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, tenantId, input.title, input.description ?? null,
    input.type || 'other', input.priority || 'med', input.dueAt ?? null,
    input.assignedToAgentId ?? null, input.cardId ?? null, input.contactId ?? null,
    input.recurrence ? JSON.stringify(input.recurrence) : null,
    input.alertMinutesBefore ?? null,
    input.createdByAgentId ?? null, now, now,
  );
  return getTask(tenantId, id)!;
}

export function getTask(tenantId: string, id: string): Task | null {
  const r = getCrmDb().prepare('SELECT * FROM crm_tasks WHERE id = ? AND tenant_id = ?').get(id, tenantId) as any;
  return r ? rowToTask(r) : null;
}

export function updateTask(tenantId: string, id: string, patch: Partial<CreateTaskInput & { status: TaskStatus }>): Task | null {
  const existing = getTask(tenantId, id);
  if (!existing) return null;
  const db = getCrmDb();
  const merged = { ...existing, ...patch };
  db.prepare(`
    UPDATE crm_tasks SET title=?, description=?, type=?, priority=?, status=?, due_at=?,
      assigned_to_agent_id=?, card_id=?, contact_id=?, recurrence_json=?, alert_minutes_before=?,
      updated_at=? WHERE id = ? AND tenant_id = ?
  `).run(
    merged.title, merged.description ?? null, merged.type, merged.priority, merged.status,
    merged.dueAt ?? null, merged.assignedToAgentId ?? null, merged.cardId ?? null, merged.contactId ?? null,
    merged.recurrence ? JSON.stringify(merged.recurrence) : null,
    merged.alertMinutesBefore ?? null, Date.now(), id, tenantId,
  );
  return getTask(tenantId, id);
}

export function deleteTask(tenantId: string, id: string): boolean {
  return getCrmDb().prepare('DELETE FROM crm_tasks WHERE id = ? AND tenant_id = ?').run(id, tenantId).changes > 0;
}

// ─── Listing with filters ──────────────────────────────────────────────
export interface ListOpts {
  agentId?: string;
  cardId?: string;
  contactId?: string;
  status?: TaskStatus | 'all';
  type?: TaskType;
  priority?: TaskPriority;
  dueBefore?: number;
  dueAfter?: number;
  limit?: number;
}

export function listTasks(tenantId: string, opts: ListOpts = {}): Task[] {
  const db = getCrmDb();
  const wh: string[] = ['tenant_id = ?'];
  const params: any[] = [tenantId];
  if (opts.agentId)    { wh.push('assigned_to_agent_id = ?'); params.push(opts.agentId); }
  if (opts.cardId)     { wh.push('card_id = ?');              params.push(opts.cardId); }
  if (opts.contactId)  { wh.push('contact_id = ?');           params.push(opts.contactId); }
  if (opts.type)       { wh.push('type = ?');                 params.push(opts.type); }
  if (opts.priority)   { wh.push('priority = ?');             params.push(opts.priority); }
  if (opts.status && opts.status !== 'all') { wh.push('status = ?'); params.push(opts.status); }
  else if (!opts.status) { wh.push("status = 'open'"); }
  if (opts.dueBefore != null) { wh.push('due_at <= ?'); params.push(opts.dueBefore); }
  if (opts.dueAfter != null)  { wh.push('due_at >= ?'); params.push(opts.dueAfter); }

  const limit = Math.min(1000, opts.limit || 200);
  const rows = db.prepare(
    `SELECT * FROM crm_tasks WHERE ${wh.join(' AND ')} ORDER BY
      CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'med' THEN 2 ELSE 3 END,
      COALESCE(due_at, 9999999999999) ASC
     LIMIT ?`
  ).all(...params, limit) as any[];
  return rows.map(rowToTask);
}

export function overdueTasks(tenantId: string, opts: { agentId?: string } = {}): Task[] {
  return listTasks(tenantId, { ...opts, status: 'open', dueBefore: Date.now() });
}

export function upcomingTasks(tenantId: string, opts: { agentId?: string; days?: number } = {}): Task[] {
  const days = opts.days ?? 7;
  const now = Date.now();
  return listTasks(tenantId, {
    ...opts, status: 'open',
    dueAfter: now,
    dueBefore: now + days * 86400_000,
  });
}

// ─── Completion + recurrence advance ───────────────────────────────────
export function completeTask(tenantId: string, id: string, completedByAgentId?: string): Task | null {
  const t = getTask(tenantId, id);
  if (!t) return null;
  if (t.status === 'completed') return t;

  const db = getCrmDb();
  db.prepare("UPDATE crm_tasks SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ?")
    .run(Date.now(), Date.now(), id, tenantId);

  // Spawn next recurrence if configured
  if (t.recurrence && t.dueAt) {
    const nextDue = advanceByRecurrence(t.dueAt, t.recurrence);
    if (nextDue !== null && (t.recurrence.until == null || nextDue <= t.recurrence.until)) {
      createTask(tenantId, {
        title: t.title,
        description: t.description,
        type: t.type,
        priority: t.priority,
        dueAt: nextDue,
        assignedToAgentId: t.assignedToAgentId,
        cardId: t.cardId,
        contactId: t.contactId,
        recurrence: t.recurrence,
        alertMinutesBefore: t.alertMinutesBefore,
        createdByAgentId: completedByAgentId,
      });
      // Link via parent_task_id (stored on the new task)
      db.prepare('UPDATE crm_tasks SET parent_task_id = ? WHERE tenant_id = ? AND title = ? AND due_at = ? AND status = \'open\'')
        .run(t.id, tenantId, t.title, nextDue);
    }
  }

  return getTask(tenantId, id);
}

function advanceByRecurrence(fromTs: number, r: TaskRecurrence): number | null {
  const d = new Date(fromTs);
  if (r.freq === 'daily')    { d.setUTCDate(d.getUTCDate() + (r.interval || 1)); return d.getTime(); }
  if (r.freq === 'weekly')   {
    if (r.weekdays && r.weekdays.length > 0) {
      // Find next weekday in list
      for (let i = 1; i <= 14; i++) {
        const candidate = new Date(fromTs);
        candidate.setUTCDate(candidate.getUTCDate() + i);
        if (r.weekdays.includes(candidate.getUTCDay())) return candidate.getTime();
      }
      return null;
    }
    d.setUTCDate(d.getUTCDate() + 7 * (r.interval || 1));
    return d.getTime();
  }
  if (r.freq === 'monthly')  { d.setUTCMonth(d.getUTCMonth() + (r.interval || 1)); return d.getTime(); }
  return null;
}

// ─── Due alerts ─────────────────────────────────────────────────────────
export interface DueAlert {
  task: Task;
  dueInMinutes: number;
}

/** Called every tick. Find tasks whose alert window just hit and fire hooks. */
export async function tickAlerts(): Promise<DueAlert[]> {
  const db = getCrmDb();
  const now = Date.now();
  const rows = db.prepare(`
    SELECT * FROM crm_tasks
    WHERE status = 'open'
      AND due_at IS NOT NULL
      AND alert_fired_at IS NULL
      AND alert_minutes_before IS NOT NULL
      AND due_at - (alert_minutes_before * 60000) <= ?
      AND due_at > ?
    LIMIT 200
  `).all(now, now) as any[];

  const alerts: DueAlert[] = [];
  for (const r of rows) {
    const t = rowToTask(r);
    alerts.push({ task: t, dueInMinutes: Math.round(((t.dueAt || now) - now) / 60000) });
    db.prepare('UPDATE crm_tasks SET alert_fired_at = ? WHERE id = ?').run(now, t.id);
    // Log as activity on the linked card (if any) for visibility
    try {
      if (t.cardId) {
        const actId = 'crm_act_' + randomBytes(6).toString('hex');
        db.prepare(`
          INSERT INTO crm_activities (id, tenant_id, card_id, contact_id, type, channel, content, created_at)
          VALUES (?, ?, ?, ?, 'note', 'system', ?, ?)
        `).run(actId, t.tenantId, t.cardId, t.contactId ?? null,
          `Alerta de tarefa: "${t.title}" vence em ${Math.max(1, Math.round(((t.dueAt || now) - now) / 60000))} min`, now);
      }
    } catch { /* don't block on activity log */ }
  }
  return alerts;
}

// ─── Stats ──────────────────────────────────────────────────────────────
export function tasksStats(tenantId: string, agentId?: string): {
  open: number; overdue: number; dueToday: number; dueThisWeek: number; completedLast7d: number;
} {
  const db = getCrmDb();
  const now = Date.now();
  const startOfDay = new Date(now); startOfDay.setUTCHours(0, 0, 0, 0);
  const endOfDay = new Date(now); endOfDay.setUTCHours(23, 59, 59, 999);
  const weekEnd = now + 7 * 86400_000;
  const weekAgo = now - 7 * 86400_000;
  const agentFilter = agentId ? 'AND assigned_to_agent_id = ?' : '';
  const agentParam = agentId ? [agentId] : [];

  const get = (sql: string, params: any[]) => (db.prepare(sql).get(...params) as any).n as number;

  return {
    open:      get(`SELECT COUNT(*) n FROM crm_tasks WHERE tenant_id = ? AND status = 'open' ${agentFilter}`, [tenantId, ...agentParam]),
    overdue:   get(`SELECT COUNT(*) n FROM crm_tasks WHERE tenant_id = ? AND status = 'open' AND due_at < ? ${agentFilter}`, [tenantId, now, ...agentParam]),
    dueToday:  get(`SELECT COUNT(*) n FROM crm_tasks WHERE tenant_id = ? AND status = 'open' AND due_at BETWEEN ? AND ? ${agentFilter}`, [tenantId, startOfDay.getTime(), endOfDay.getTime(), ...agentParam]),
    dueThisWeek: get(`SELECT COUNT(*) n FROM crm_tasks WHERE tenant_id = ? AND status = 'open' AND due_at BETWEEN ? AND ? ${agentFilter}`, [tenantId, now, weekEnd, ...agentParam]),
    completedLast7d: get(`SELECT COUNT(*) n FROM crm_tasks WHERE tenant_id = ? AND status = 'completed' AND completed_at >= ? ${agentFilter}`, [tenantId, weekAgo, ...agentParam]),
  };
}
