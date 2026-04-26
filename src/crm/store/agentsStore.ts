// CRM agentsStore module — split out from the legacy monolithic file in a refactor.
// Edit this file directly; scripts/split-store.cjs is retained only as a record
// of how the original was decomposed (it ran once against the .ts.bak snapshot).
import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import { getCrmDb } from '.././schema.js';
import type {
  Board, BoardColumn, Contact, Card, Activity, Agent, Channel2,
  Subscription, Automation, InventoryItem, BoardType, ActivityType,
  Channel, MediaType, ChannelType, ChannelStatus, BillingCycle, SubscriptionStatus, AgentRole,
} from '.././types.js';
import type { Segment, SegmentFilter, BulkContactOp } from '.././types.js';
import type { Swimlane, Checklist, ChecklistItem, BoardSettings, ColumnStageType } from '.././types.js';
import type { Team, AgentPermissions, AgentMetricsPro, SlaRule,
              Label, QuickReply, InboxRule } from '.././types.js';
import type { ActivityFilter, ReminderChannel, ReminderStatus, ReminderPro } from '.././types.js';
import type { InventoryCategory, InventoryVariant, InventoryMovement,
              Proposal, ProposalStatus, ProposalTemplate } from '.././types.js';
import type { StripeConnectAccount, InvoicePro, InvoiceStatus, Coupon, DunningLog, MrrSnapshot } from '.././types.js';
import type { AutomationLog, AssignmentRule, AssignmentConditions, AssignmentLog } from '.././types.js';
import type { ChannelTemplate, ChannelHealth, ChannelMetrics } from '.././types.js';
import { now, getAutoAssign, getCommitStock, getPublish, getEmit, nid, J, HEADER_ALIASES } from './_internals.js';
import type { ImportResult, EvalContext } from './_internals.js';


export function createAgent(tenantId: string, input: {
  name: string; email: string; phone?: string; role?: AgentRole; apiKeyHash?: string;
}): Agent {
  const db = getCrmDb();
  const a: Agent = {
    id: nid('crm_agent'),
    tenantId, name: input.name, email: input.email.toLowerCase(),
    phone: input.phone, role: input.role ?? 'agent', active: true,
    apiKeyHash: input.apiKeyHash, createdAt: now(),
  };
  db.prepare(`
    INSERT INTO crm_agents (id, tenant_id, name, email, phone, role, active, api_key_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(a.id, a.tenantId, a.name, a.email, a.phone ?? null, a.role, a.apiKeyHash ?? null, a.createdAt);
  return a;
}

export function listAgents(tenantId: string): Agent[] {
  const db = getCrmDb();
  const rows = db.prepare('SELECT * FROM crm_agents WHERE tenant_id = ? ORDER BY created_at ASC').all(tenantId) as any[];
  return rows.map(rowToAgent);
}

export function getAgent(tenantId: string, agentId: string): Agent | null {
  const db = getCrmDb();
  const r = db.prepare('SELECT * FROM crm_agents WHERE id = ? AND tenant_id = ?').get(agentId, tenantId) as any;
  return r ? rowToAgent(r) : null;
}

export function updateAgent(tenantId: string, agentId: string, patch: Partial<Omit<Agent, 'id' | 'tenantId' | 'createdAt'>>): Agent | null {
  const db = getCrmDb();
  const existing = getAgent(tenantId, agentId);
  if (!existing) return null;
  const upd = { ...existing, ...patch };
  db.prepare(`
    UPDATE crm_agents SET name = ?, email = ?, phone = ?, role = ?, active = ?, api_key_hash = ?
    WHERE id = ? AND tenant_id = ?
  `).run(upd.name, upd.email.toLowerCase(), upd.phone ?? null, upd.role, upd.active ? 1 : 0,
    upd.apiKeyHash ?? null, agentId, tenantId);
  return upd;
}

export function deleteAgent(tenantId: string, agentId: string): boolean {
  const db = getCrmDb();
  const r = db.prepare('DELETE FROM crm_agents WHERE id = ? AND tenant_id = ?').run(agentId, tenantId);
  return r.changes > 0;
}

function rowToAgent(r: any): Agent {
  return {
    id: r.id, tenantId: r.tenant_id, name: r.name, email: r.email,
    phone: r.phone ?? undefined, role: r.role as AgentRole, active: r.active === 1,
    apiKeyHash: r.api_key_hash ?? undefined, createdAt: r.created_at,
  };
}

function rowToTeam(r: any): Team {
  return { id: r.id, tenantId: r.tenant_id, name: r.name, color: r.color || '#9B59FC',
    description: r.description ?? undefined, managerAgentId: r.manager_agent_id ?? undefined,
    createdAt: r.created_at, updatedAt: r.updated_at };
}

export function createTeam(tenantId: string, input: { name: string; color?: string; description?: string; managerAgentId?: string }): Team {
  const db = getCrmDb();
  const t: Team = { id: nid('crm_team'), tenantId, name: input.name,
    color: input.color || '#9B59FC', description: input.description,
    managerAgentId: input.managerAgentId, createdAt: now(), updatedAt: now() };
  db.prepare('INSERT INTO crm_teams (id,tenant_id,name,color,description,manager_agent_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(t.id, tenantId, t.name, t.color, t.description ?? null, t.managerAgentId ?? null, t.createdAt, t.updatedAt);
  return t;
}

export function listTeams(tenantId: string): Team[] {
  const db = getCrmDb();
  return (db.prepare('SELECT * FROM crm_teams WHERE tenant_id=? ORDER BY name').all(tenantId) as any[]).map(rowToTeam);
}

export function getTeam(tenantId: string, id: string): Team | null {
  const db = getCrmDb();
  const r = db.prepare('SELECT * FROM crm_teams WHERE id=? AND tenant_id=?').get(id, tenantId) as any;
  return r ? rowToTeam(r) : null;
}

export function updateTeam(tenantId: string, id: string, patch: Partial<Omit<Team,'id'|'tenantId'|'createdAt'>>): Team | null {
  const existing = getTeam(tenantId, id);
  if (!existing) return null;
  const upd = { ...existing, ...patch, updatedAt: now() };
  getCrmDb().prepare('UPDATE crm_teams SET name=?, color=?, description=?, manager_agent_id=?, updated_at=? WHERE id=? AND tenant_id=?')
    .run(upd.name, upd.color, upd.description ?? null, upd.managerAgentId ?? null, upd.updatedAt, id, tenantId);
  return upd;
}

export function deleteTeam(tenantId: string, id: string): boolean {
  const db = getCrmDb();
  db.prepare('UPDATE crm_agents SET team_id=NULL WHERE team_id=? AND tenant_id=?').run(id, tenantId);
  return db.prepare('DELETE FROM crm_teams WHERE id=? AND tenant_id=?').run(id, tenantId).changes > 0;
}

export function setAgentPermissions(tenantId: string, agentId: string, perms: AgentPermissions): boolean {
  const db = getCrmDb();
  return db.prepare('UPDATE crm_agents SET permissions_json=?, updated_at=? WHERE id=? AND tenant_id=?')
    .run(JSON.stringify(perms), Date.now(), agentId, tenantId).changes > 0;
}

export function setAgentTeam(tenantId: string, agentId: string, teamId: string | null): boolean {
  return getCrmDb().prepare('UPDATE crm_agents SET team_id=?, updated_at=? WHERE id=? AND tenant_id=?')
    .run(teamId, Date.now(), agentId, tenantId).changes > 0;
}

export function setAgentStatus(tenantId: string, agentId: string, status: 'online' | 'away' | 'offline'): boolean {
  return getCrmDb().prepare('UPDATE crm_agents SET status=?, last_seen_at=?, updated_at=? WHERE id=? AND tenant_id=?')
    .run(status, Date.now(), Date.now(), agentId, tenantId).changes > 0;
}

export function getAgentMetricsPro(tenantId: string, agentId?: string): AgentMetricsPro[] {
  const db = getCrmDb();
  const agents = agentId
    ? (db.prepare('SELECT * FROM crm_agents WHERE tenant_id=? AND id=?').all(tenantId, agentId) as any[])
    : (db.prepare('SELECT * FROM crm_agents WHERE tenant_id=?').all(tenantId) as any[]);
  const now24h = Date.now() - 24*60*60*1000;
  return agents.map((a: any) => {
    const opened = (db.prepare("SELECT COUNT(*) n FROM crm_cards WHERE tenant_id=? AND owner_agent_id=? AND COALESCE(status,'active')='active'").get(tenantId, a.id) as any).n;
    // won/lost precisam de stage_type
    const won = (db.prepare("SELECT COUNT(*) n FROM crm_cards c JOIN crm_columns col ON col.id=c.column_id WHERE c.tenant_id=? AND c.owner_agent_id=? AND col.stage_type='won'").get(tenantId, a.id) as any).n;
    const lost = (db.prepare("SELECT COUNT(*) n FROM crm_cards c JOIN crm_columns col ON col.id=c.column_id WHERE c.tenant_id=? AND c.owner_agent_id=? AND col.stage_type='lost'").get(tenantId, a.id) as any).n;
    const totalValue = (db.prepare("SELECT COALESCE(SUM(c.value_cents),0) v FROM crm_cards c JOIN crm_columns col ON col.id=c.column_id WHERE c.tenant_id=? AND c.owner_agent_id=? AND col.stage_type='won'").get(tenantId, a.id) as any).v;
    const msgsToday = (db.prepare("SELECT COUNT(*) n FROM crm_activities WHERE tenant_id=? AND created_by_agent_id=? AND created_at>=?").get(tenantId, a.id, now24h) as any).n;
    const total = won + lost;
    return {
      agentId: a.id, agentName: a.name,
      cardsOpen: opened, cardsWon: won, cardsLost: lost,
      conversionRate: total > 0 ? won / total : 0,
      totalValueCents: totalValue,
      avgResponseMins: 0, // heuristica futura
      messagesToday: msgsToday,
      lastSeenAt: a.last_seen_at ?? undefined,
      status: (a.status || 'offline') as any,
    };
  });
}

function rowToSla(r: any): SlaRule {
  return { id: r.id, tenantId: r.tenant_id, teamId: r.team_id ?? undefined,
    agentId: r.agent_id ?? undefined, name: r.name, maxResponseMins: r.max_response_mins,
    escalateToAgentId: r.escalate_to_agent_id ?? undefined,
    enabled: !!r.enabled, createdAt: r.created_at };
}

export function createSlaRule(tenantId: string, input: Omit<SlaRule,'id'|'tenantId'|'createdAt'>): SlaRule {
  const rule: SlaRule = { id: nid('crm_sla'), tenantId, ...input, createdAt: now() };
  getCrmDb().prepare('INSERT INTO crm_sla_rules (id,tenant_id,team_id,agent_id,name,max_response_mins,escalate_to_agent_id,enabled,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(rule.id, tenantId, rule.teamId ?? null, rule.agentId ?? null, rule.name, rule.maxResponseMins,
         rule.escalateToAgentId ?? null, rule.enabled ? 1 : 0, rule.createdAt);
  return rule;
}

export function listSlaRules(tenantId: string): SlaRule[] {
  return (getCrmDb().prepare('SELECT * FROM crm_sla_rules WHERE tenant_id=? ORDER BY created_at DESC').all(tenantId) as any[]).map(rowToSla);
}

export function deleteSlaRule(tenantId: string, id: string): boolean {
  return getCrmDb().prepare('DELETE FROM crm_sla_rules WHERE id=? AND tenant_id=?').run(id, tenantId).changes > 0;
}

function rowToAsRule(r: any): AssignmentRule {
  return { id: r.id, tenantId: r.tenant_id, name: r.name,
    conditions: JSON.parse(r.conditions_json || '{}'),
    assignToAgentId: r.assign_to_agent_id ?? undefined,
    assignToTeamId: r.assign_to_team_id ?? undefined,
    skillRequired: r.skill_required ?? undefined,
    slaMinutes: r.sla_minutes ?? undefined,
    escalateToAgentId: r.escalate_to_agent_id ?? undefined,
    priority: r.priority, enabled: !!r.enabled, createdAt: r.created_at };
}

export function createAssignmentRule(tenantId: string, input: Omit<AssignmentRule,'id'|'tenantId'|'createdAt'>): AssignmentRule {
  const rule: AssignmentRule = { id: nid('crm_asrule'), tenantId, ...input, createdAt: now() };
  getCrmDb().prepare('INSERT INTO crm_assignment_rules (id,tenant_id,name,conditions_json,assign_to_agent_id,assign_to_team_id,skill_required,sla_minutes,escalate_to_agent_id,priority,enabled,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(rule.id, tenantId, rule.name, JSON.stringify(rule.conditions),
         rule.assignToAgentId ?? null, rule.assignToTeamId ?? null,
         rule.skillRequired ?? null, rule.slaMinutes ?? null,
         rule.escalateToAgentId ?? null, rule.priority, rule.enabled ? 1 : 0, rule.createdAt);
  return rule;
}

export function listAssignmentRules(tenantId: string): AssignmentRule[] {
  return (getCrmDb().prepare('SELECT * FROM crm_assignment_rules WHERE tenant_id=? ORDER BY priority DESC, created_at ASC').all(tenantId) as any[]).map(rowToAsRule);
}

export function deleteAssignmentRule(tenantId: string, id: string): boolean {
  return getCrmDb().prepare('DELETE FROM crm_assignment_rules WHERE id=? AND tenant_id=?').run(id, tenantId).changes > 0;
}

function matchCondition(cond: AssignmentConditions, ctx: EvalContext): boolean {
  if (cond.minValueCents != null && (ctx.card.valueCents || 0) < cond.minValueCents) return false;
  if (cond.maxValueCents != null && (ctx.card.valueCents || 0) > cond.maxValueCents) return false;

  if (cond.tags?.length) {
    const cardLabels: string[] = ctx.card.labels || [];
    const contactTags: string[] = ctx.contact?.tags || [];
    const combined = new Set([...cardLabels, ...contactTags]);
    if (!cond.tags.some(t => combined.has(t))) return false;
  }
  if (cond.source && ctx.contact?.source !== cond.source) return false;
  if (cond.channel && ctx.channel !== cond.channel) return false;
  if (cond.keyword && ctx.keyword && !ctx.keyword.toLowerCase().includes(cond.keyword.toLowerCase())) return false;
  if (cond.tier) {
    const score = ctx.contact?.leadScore || 0;
    // Exemplo: tier='hot' = score>=80, tier='warm'>=50, tier='cold'<50
    const mapped = score >= 80 ? 'hot' : score >= 50 ? 'warm' : 'cold';
    if (mapped !== cond.tier) return false;
  }
  if (cond.timeWindow) {
    const d = new Date();
    const wd = d.getDay();
    if (cond.timeWindow.weekdays?.length && !cond.timeWindow.weekdays.includes(wd)) return false;
    const hh = d.getHours(), mm = d.getMinutes();
    const cur = hh * 60 + mm;
    const parse = (t: string) => {
      const [h, m] = t.split(':').map(Number);
      return (h || 0) * 60 + (m || 0);
    };
    const start = parse(cond.timeWindow.start);
    const end = parse(cond.timeWindow.end);
    if (start <= end) { if (cur < start || cur > end) return false; }
    else { if (cur < start && cur > end) return false; } // cross midnight
  }
  return true;
}

export function evaluateAssignment(tenantId: string, ctx: EvalContext): { rule?: AssignmentRule; agentId?: string; teamId?: string; slaDeadlineTs?: number } {
  const rules = listAssignmentRules(tenantId).filter(r => r.enabled);
  for (const rule of rules) {
    if (matchCondition(rule.conditions, ctx)) {
      let agentId = rule.assignToAgentId;
      // Se tem skill requirement, tenta encontrar agent com skill
      if (rule.skillRequired) {
        const candidates = getCrmDb().prepare(`
          SELECT id, skills_json FROM crm_agents
          WHERE tenant_id=? AND status!='offline'
            AND skills_json LIKE ?
          ORDER BY last_seen_at DESC
        `).all(tenantId, '%"' + rule.skillRequired + '"%') as any[];
        if (candidates.length) agentId = candidates[0].id;
      }
      // Load balance: se ha team e sem agentId, pega o menos ocupado do team
      if (!agentId && rule.assignToTeamId) {
        const agents = getCrmDb().prepare(`
          SELECT a.id, (SELECT COUNT(*) FROM crm_cards WHERE owner_agent_id=a.id AND status='active') as load
          FROM crm_agents a WHERE tenant_id=? AND team_id=? ORDER BY load ASC LIMIT 1
        `).all(tenantId, rule.assignToTeamId) as any[];
        if (agents[0]) agentId = agents[0].id;
      }
      const slaDeadlineTs = rule.slaMinutes ? Date.now() + rule.slaMinutes * 60 * 1000 : undefined;
      return { rule, agentId, teamId: rule.assignToTeamId, slaDeadlineTs };
    }
  }
  return {};
}

export function logAssignment(tenantId: string, input: { ruleId?: string; cardId: string; agentId?: string; teamId?: string; slaDeadlineTs?: number }): AssignmentLog {
  const log: AssignmentLog = { id: nid('crm_asl'), tenantId, ...input, escalated: false, createdAt: now() };
  getCrmDb().prepare('INSERT INTO crm_assignment_log (id,tenant_id,rule_id,card_id,agent_id,team_id,escalated,sla_deadline_ts,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(log.id, tenantId, log.ruleId ?? null, log.cardId, log.agentId ?? null, log.teamId ?? null, 0, log.slaDeadlineTs ?? null, log.createdAt);
  return log;
}

export function escalateAssignment(tenantId: string, assignmentLogId: string, newAgentId: string): boolean {
  return getCrmDb().prepare('UPDATE crm_assignment_log SET escalated=1, agent_id=? WHERE id=? AND tenant_id=?')
    .run(newAgentId, assignmentLogId, tenantId).changes > 0;
}

export function slaViolations(tenantId: string): any[] {
  return getCrmDb().prepare(`
    SELECT * FROM crm_assignment_log
    WHERE tenant_id=? AND sla_deadline_ts IS NOT NULL AND sla_deadline_ts < ?
      AND resolved_at IS NULL AND escalated=0
    ORDER BY sla_deadline_ts ASC
  `).all(tenantId, Date.now()) as any[];
}
