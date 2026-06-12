/**
 * Mobile-optimized compact API — Onda 24.
 *
 * Returns minimal-payload bundles for mobile home screens and widgets.
 * Prefer over multiple round-trips on mobile networks.
 */

import { getCrmDb } from './schema.js';

export function todayBundle(tenantId: string, agentId?: string): any {
  const db = getCrmDb();
  const now = Date.now();
  const todayStart = new Date(now); todayStart.setUTCHours(0, 0, 0, 0);
  const todayEnd = new Date(now); todayEnd.setUTCHours(23, 59, 59, 999);

  const agentFilter = agentId ? 'AND assigned_to_agent_id = ?' : '';
  const agentParam = agentId ? [agentId] : [];

  const tasksToday = db.prepare(`
    SELECT id, title, priority, due_at, card_id
    FROM crm_tasks
    WHERE tenant_id = ? AND status = 'open' AND due_at BETWEEN ? AND ? ${agentFilter}
    ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'med' THEN 2 ELSE 3 END, due_at
    LIMIT 20
  `).all(tenantId, todayStart.getTime(), todayEnd.getTime(), ...agentParam) as any[];

  const overdue = db.prepare(`
    SELECT id, title, priority, due_at FROM crm_tasks
    WHERE tenant_id = ? AND status = 'open' AND due_at < ? ${agentFilter}
    ORDER BY due_at ASC LIMIT 10
  `).all(tenantId, now, ...agentParam) as any[];

  const apptFilter = agentId ? 'AND agent_id = ?' : '';
  const appts = db.prepare(`
    SELECT id, title, starts_at, ends_at, meeting_url, contact_id FROM crm_appointments
    WHERE tenant_id = ? AND status IN ('scheduled', 'confirmed')
      AND starts_at BETWEEN ? AND ? ${apptFilter}
    ORDER BY starts_at ASC
  `).all(tenantId, todayStart.getTime(), todayEnd.getTime(), ...agentParam) as any[];

  const mentions = agentId ? (db.prepare(`
    SELECT id, source_type, snippet, created_at, card_id, contact_id
    FROM crm_agent_mentions
    WHERE tenant_id = ? AND mentioned_agent_id = ? AND read_at IS NULL
    ORDER BY created_at DESC LIMIT 10
  `).all(tenantId, agentId) as any[]) : [];

  // Quick KPIs
  const openCards = (db.prepare(
    `SELECT COUNT(*) n FROM crm_cards c JOIN crm_columns col ON col.id = c.column_id WHERE c.tenant_id = ? AND col.stage_type = 'open'`
  ).get(tenantId) as any).n;
  const wonThisMonth = (db.prepare(`
    SELECT COUNT(*) n FROM crm_cards c
    JOIN crm_columns col ON col.id = c.column_id
    WHERE c.tenant_id = ? AND col.stage_type = 'won' AND c.updated_at >= ?
  `).get(tenantId, todayStart.getTime() - 30 * 86400000) as any).n;

  return {
    kpis: { openCards, wonThisMonth, tasksToday: tasksToday.length, overdue: overdue.length, mentions: mentions.length },
    tasksToday, overdue, appointments: appts, mentions,
  };
}

export function cardCompact(tenantId: string, cardId: string): any {
  const db = getCrmDb();
  const card = db.prepare('SELECT * FROM crm_cards WHERE id = ? AND tenant_id = ?').get(cardId, tenantId) as any;
  if (!card) return null;
  const contact = card.contact_id
    ? (db.prepare('SELECT id, name, phone, email FROM crm_contacts WHERE id = ? AND tenant_id = ?').get(card.contact_id, tenantId) as any)
    : null;
  const recentActivities = db.prepare(
    'SELECT id, type, channel, direction, content, created_at FROM crm_activities WHERE tenant_id = ? AND card_id = ? ORDER BY created_at DESC LIMIT 5'
  ).all(tenantId, cardId) as any[];
  const openTasks = db.prepare(
    "SELECT id, title, priority, due_at FROM crm_tasks WHERE tenant_id = ? AND card_id = ? AND status = 'open' ORDER BY due_at"
  ).all(tenantId, cardId) as any[];
  const comments = db.prepare(
    'SELECT id, author_agent_id, content, created_at FROM crm_card_comments WHERE tenant_id = ? AND card_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 5'
  ).all(tenantId, cardId) as any[];
  return {
    id: card.id, title: card.title, valueCents: card.value_cents,
    columnId: card.column_id, probability: card.probability,
    contact, recentActivities, openTasks, comments,
  };
}

export function agentDashboard(tenantId: string, agentId: string): any {
  const db = getCrmDb();
  const assignedCards = (db.prepare(
    'SELECT COUNT(*) n FROM crm_cards WHERE tenant_id = ? AND owner_agent_id = ?'
  ).get(tenantId, agentId) as any).n;
  const openTasks = (db.prepare(
    "SELECT COUNT(*) n FROM crm_tasks WHERE tenant_id = ? AND assigned_to_agent_id = ? AND status = 'open'"
  ).get(tenantId, agentId) as any).n;
  const unreadMentions = (db.prepare(
    'SELECT COUNT(*) n FROM crm_agent_mentions WHERE tenant_id = ? AND mentioned_agent_id = ? AND read_at IS NULL'
  ).get(tenantId, agentId) as any).n;
  const todayAppts = (db.prepare(`
    SELECT COUNT(*) n FROM crm_appointments
    WHERE tenant_id = ? AND agent_id = ? AND status IN ('scheduled', 'confirmed')
      AND starts_at > ? AND starts_at < ?
  `).get(tenantId, agentId, Date.now(), Date.now() + 86400_000) as any).n;

  return { agentId, assignedCards, openTasks, unreadMentions, todayAppts };
}
