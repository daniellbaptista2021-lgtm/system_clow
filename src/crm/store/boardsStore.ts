// CRM boardsStore module — split out from the legacy monolithic file in a refactor.
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


export function createBoard(tenantId: string, input: {
  name: string; type?: BoardType; description?: string;
}): Board {
  const db = getCrmDb();
  const board: Board = {
    id: nid('crm_board'),
    tenantId,
    name: input.name,
    type: input.type ?? 'sales',
    description: input.description,
    position: getNextBoardPosition(db, tenantId),
    createdAt: now(),
    updatedAt: now(),
  };
  db.prepare(`
    INSERT INTO crm_boards (id, tenant_id, name, type, description, position, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(board.id, board.tenantId, board.name, board.type, board.description ?? null,
    board.position, board.createdAt, board.updatedAt);
  return board;
}

function getNextBoardPosition(db: Database.Database, tenantId: string): number {
  const r = db.prepare('SELECT COALESCE(MAX(position), -1) as m FROM crm_boards WHERE tenant_id = ?')
    .get(tenantId) as { m: number };
  return r.m + 1;
}

export function listBoards(tenantId: string): Board[] {
  const db = getCrmDb();
  const rows = db.prepare(`
    SELECT * FROM crm_boards WHERE tenant_id = ? ORDER BY position ASC, created_at ASC
  `).all(tenantId) as any[];
  return rows.map(rowToBoard);
}

export function getBoard(tenantId: string, boardId: string): Board | null {
  const db = getCrmDb();
  const r = db.prepare('SELECT * FROM crm_boards WHERE id = ? AND tenant_id = ?').get(boardId, tenantId) as any;
  return r ? rowToBoard(r) : null;
}

export function updateBoard(tenantId: string, boardId: string, patch: Partial<Pick<Board, 'name' | 'description' | 'type' | 'position'>>): Board | null {
  const db = getCrmDb();
  const existing = getBoard(tenantId, boardId);
  if (!existing) return null;
  const upd = { ...existing, ...patch, updatedAt: now() };
  db.prepare(`
    UPDATE crm_boards SET name = ?, description = ?, type = ?, position = ?, updated_at = ?
    WHERE id = ? AND tenant_id = ?
  `).run(upd.name, upd.description ?? null, upd.type, upd.position, upd.updatedAt, boardId, tenantId);
  return upd;
}

export function deleteBoard(tenantId: string, boardId: string): boolean {
  const db = getCrmDb();
  const r = db.prepare('DELETE FROM crm_boards WHERE id = ? AND tenant_id = ?').run(boardId, tenantId);
  return r.changes > 0;
}

function rowToBoard(r: any): Board {
  return {
    id: r.id, tenantId: r.tenant_id, name: r.name, type: r.type as BoardType,
    description: r.description ?? undefined, position: r.position,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export function createColumn(tenantId: string, input: {
  boardId: string; name: string; color?: string; isTerminal?: boolean;
  autoRule?: { trigger: string; action: string; params?: Record<string, unknown> };
}): BoardColumn | null {
  const db = getCrmDb();
  if (!getBoard(tenantId, input.boardId)) return null;
  const col: BoardColumn = {
    id: nid('crm_col'),
    boardId: input.boardId,
    name: input.name,
    position: getNextColumnPosition(db, input.boardId),
    color: input.color ?? '#9B59FC',
    autoRule: input.autoRule ?? null,
    isTerminal: input.isTerminal ?? false,
    createdAt: now(),
  };
  db.prepare(`
    INSERT INTO crm_columns (id, board_id, name, position, color, auto_rule_json, is_terminal, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(col.id, col.boardId, col.name, col.position, col.color,
    col.autoRule ? J.stringify(col.autoRule) : null, col.isTerminal ? 1 : 0, col.createdAt);
  return col;
}

function getNextColumnPosition(db: Database.Database, boardId: string): number {
  const r = db.prepare('SELECT COALESCE(MAX(position), -1) as m FROM crm_columns WHERE board_id = ?')
    .get(boardId) as { m: number };
  return r.m + 1;
}

export function listColumns(tenantId: string, boardId: string): BoardColumn[] {
  const db = getCrmDb();
  if (!getBoard(tenantId, boardId)) return [];
  const rows = db.prepare(`
    SELECT * FROM crm_columns WHERE board_id = ? ORDER BY position ASC, created_at ASC
  `).all(boardId) as any[];
  return rows.map(rowToColumn);
}

export function updateColumn(tenantId: string, columnId: string, patch: Partial<Pick<BoardColumn, 'name' | 'color' | 'position' | 'isTerminal'>>): BoardColumn | null {
  const db = getCrmDb();
  const r = db.prepare(`
    SELECT c.* FROM crm_columns c
    JOIN crm_boards b ON b.id = c.board_id
    WHERE c.id = ? AND b.tenant_id = ?
  `).get(columnId, tenantId) as any;
  if (!r) return null;
  const upd: BoardColumn = { ...rowToColumn(r), ...patch };
  db.prepare(`UPDATE crm_columns SET name = ?, color = ?, position = ?, is_terminal = ? WHERE id = ?`)
    .run(upd.name, upd.color, upd.position, upd.isTerminal ? 1 : 0, columnId);
  return upd;
}

export function deleteColumn(tenantId: string, columnId: string): boolean {
  const db = getCrmDb();
  const r = db.prepare(`
    DELETE FROM crm_columns WHERE id = ? AND board_id IN (SELECT id FROM crm_boards WHERE tenant_id = ?)
  `).run(columnId, tenantId);
  return r.changes > 0;
}

function rowToColumn(r: any): BoardColumn {
  // Onda 62 (migration 004): leitura defensiva dos campos de agente.
  // Colunas criadas antes da migration podem nao ter as colunas (raro,
  // mas idempotente) → entao usamos `r.foo ?? undefined`.
  return {
    id: r.id, boardId: r.board_id, name: r.name, position: r.position, color: r.color,
    autoRule: J.parse(r.auto_rule_json, null),
    isTerminal: r.is_terminal === 1, createdAt: r.created_at,
    agentEnabled: r.agent_enabled === 1,
    agentName: r.agent_name ?? undefined,
    agentSystemPrompt: r.agent_system_prompt ?? undefined,
    agentRole: r.agent_role ?? undefined,
    agentRoleType: r.agent_role_type ?? undefined,
    agentPromoteToColumnId: r.agent_promote_to_column_id ?? undefined,
    agentInactivityTimeoutMinutes: r.agent_inactivity_timeout_minutes ?? undefined,
    agentMaxTurns: r.agent_max_turns ?? undefined,
    agentActiveHoursStart: r.agent_active_hours_start ?? undefined,
    agentActiveHoursEnd: r.agent_active_hours_end ?? undefined,
    agentPromotionCriteria: r.agent_promotion_criteria ?? undefined,
    agentEntryDelayMinutes: r.agent_entry_delay_minutes ?? undefined,
    agentNoResponseChaseStepsJson: r.agent_no_response_chase_steps_json ?? undefined,
    agentFollowupStepsHoursJson: r.agent_followup_steps_hours_json ?? undefined,
  };
}

export function seedDefaultBoards(tenantId: string): Board {
  const existing = listBoards(tenantId);
  if (existing.length > 0) return existing[0];

  const salesBoard = createBoard(tenantId, { name: 'Pipeline de Vendas', type: 'sales',
    description: 'Leads do primeiro contato até o fechamento' });

  const salesCols = [
    { name: 'Lead novo', color: '#94A3B8' },
    { name: 'Qualificado', color: '#4A9EFF' },
    { name: 'Proposta enviada', color: '#9B59FC' },
    { name: 'Negociação', color: '#F59E0B' },
    { name: 'Ganho', color: '#22C55E', isTerminal: true },
    { name: 'Perdido', color: '#EF4444', isTerminal: true },
  ];
  for (const c of salesCols) {
    createColumn(tenantId, { boardId: salesBoard.id, name: c.name, color: c.color, isTerminal: c.isTerminal });
  }

  const supportBoard = createBoard(tenantId, {
    name: 'Atendimento', type: 'support',
    description: 'Tickets de suporte e pós-venda',
  });
  for (const c of [
    { name: 'Aberto', color: '#EF4444' },
    { name: 'Em andamento', color: '#F59E0B' },
    { name: 'Aguardando cliente', color: '#94A3B8' },
    { name: 'Resolvido', color: '#22C55E', isTerminal: true },
  ]) {
    createColumn(tenantId, { boardId: supportBoard.id, name: c.name, color: c.color, isTerminal: c.isTerminal });
  }

  return salesBoard;
}

export function setColumnWipLimit(tenantId: string, columnId: string, wipLimit: number | null): boolean {
  const db = getCrmDb();
  // Ensure column belongs to a board of this tenant
  const col = db.prepare(`
    SELECT c.* FROM crm_columns c JOIN crm_boards b ON b.id = c.board_id
    WHERE c.id = ? AND b.tenant_id = ?
  `).get(columnId, tenantId) as any;
  if (!col) return false;
  db.prepare('UPDATE crm_columns SET wip_limit = ? WHERE id = ?').run(wipLimit, columnId);
  return true;
}

export function setColumnStageType(tenantId: string, columnId: string, stageType: ColumnStageType): boolean {
  const db = getCrmDb();
  const col = db.prepare(`
    SELECT c.* FROM crm_columns c JOIN crm_boards b ON b.id = c.board_id
    WHERE c.id = ? AND b.tenant_id = ?
  `).get(columnId, tenantId) as any;
  if (!col) return false;
  const isTerminal = stageType === 'won' || stageType === 'lost' ? 1 : 0;
  db.prepare('UPDATE crm_columns SET stage_type = ?, is_terminal = ? WHERE id = ?')
    .run(stageType, isTerminal, columnId);
  return true;
}

export function checkWipLimit(tenantId: string, columnId: string): { allowed: boolean; current: number; limit?: number } {
  const db = getCrmDb();
  const col = db.prepare(`
    SELECT c.wip_limit, b.settings_json FROM crm_columns c JOIN crm_boards b ON b.id = c.board_id
    WHERE c.id = ? AND b.tenant_id = ?
  `).get(columnId, tenantId) as any;
  if (!col) return { allowed: true, current: 0 };
  const settings: BoardSettings = JSON.parse(col.settings_json || '{}');
  if (!settings.wipEnforce || col.wip_limit == null) return { allowed: true, current: 0, limit: col.wip_limit ?? undefined };

  const count = (db.prepare("SELECT COUNT(*) as n FROM crm_cards WHERE column_id = ? AND COALESCE(status,'active') = 'active'").get(columnId) as any).n;
  return { allowed: count < col.wip_limit, current: count, limit: col.wip_limit };
}

export function updateBoardSettings(tenantId: string, boardId: string, settings: Partial<BoardSettings>): Board | null {
  const db = getCrmDb();
  const b = db.prepare('SELECT * FROM crm_boards WHERE id=? AND tenant_id=?').get(boardId, tenantId) as any;
  if (!b) return null;
  const current: BoardSettings = JSON.parse(b.settings_json || '{}');
  const merged = { ...current, ...settings };
  db.prepare('UPDATE crm_boards SET settings_json=?, updated_at=? WHERE id=? AND tenant_id=?')
    .run(JSON.stringify(merged), Date.now(), boardId, tenantId);
  return { ...rowToBoard(b), settings: merged } as any;
}

export function createSwimlane(tenantId: string, boardId: string, input: { name: string; color?: string; position?: number }): Swimlane | null {
  const db = getCrmDb();
  const b = db.prepare('SELECT id FROM crm_boards WHERE id=? AND tenant_id=?').get(boardId, tenantId);
  if (!b) return null;
  const pos = input.position ?? (((db.prepare('SELECT MAX(position) as m FROM crm_swimlanes WHERE board_id=?').get(boardId) as any).m ?? -1) + 1);
  const s: Swimlane = {
    id: nid('crm_sl'), tenantId, boardId, name: input.name,
    color: input.color || '#9B59FC', position: pos, createdAt: now(),
  };
  db.prepare('INSERT INTO crm_swimlanes (id, tenant_id, board_id, name, color, position, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(s.id, tenantId, boardId, s.name, s.color, s.position, s.createdAt);
  return s;
}

export function listSwimlanes(tenantId: string, boardId: string): Swimlane[] {
  const db = getCrmDb();
  const rows = db.prepare('SELECT * FROM crm_swimlanes WHERE tenant_id=? AND board_id=? ORDER BY position ASC').all(tenantId, boardId) as any[];
  return rows.map((r: any) => ({
    id: r.id, tenantId: r.tenant_id, boardId: r.board_id,
    name: r.name, color: r.color, position: r.position, createdAt: r.created_at,
  }));
}

export function updateSwimlane(tenantId: string, id: string, patch: Partial<Omit<Swimlane,'id'|'tenantId'|'boardId'|'createdAt'>>): Swimlane | null {
  const db = getCrmDb();
  const r = db.prepare('SELECT * FROM crm_swimlanes WHERE id=? AND tenant_id=?').get(id, tenantId) as any;
  if (!r) return null;
  const upd = { name: patch.name ?? r.name, color: patch.color ?? r.color, position: patch.position ?? r.position };
  db.prepare('UPDATE crm_swimlanes SET name=?, color=?, position=? WHERE id=? AND tenant_id=?')
    .run(upd.name, upd.color, upd.position, id, tenantId);
  return { id, tenantId, boardId: r.board_id, ...upd, createdAt: r.created_at } as Swimlane;
}

export function deleteSwimlane(tenantId: string, id: string): boolean {
  const db = getCrmDb();
  // Clear swimlane_id em cards
  db.prepare('UPDATE crm_cards SET swimlane_id=NULL WHERE swimlane_id=? AND tenant_id=?').run(id, tenantId);
  const r = db.prepare('DELETE FROM crm_swimlanes WHERE id=? AND tenant_id=?').run(id, tenantId);
  return r.changes > 0;
}

export function createChecklist(tenantId: string, cardId: string, input: { title: string; items?: string[] }): Checklist | null {
  const db = getCrmDb();
  const card = db.prepare('SELECT id FROM crm_cards WHERE id=? AND tenant_id=?').get(cardId, tenantId);
  if (!card) return null;
  const items: ChecklistItem[] = (input.items || []).map((t, i) => ({ id: nid('ci'), text: t, done: false }));
  const cl: Checklist = {
    id: nid('crm_cl'), tenantId, cardId, title: input.title,
    items, createdAt: now(), updatedAt: now(),
  };
  db.prepare('INSERT INTO crm_checklists (id, tenant_id, card_id, title, items_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(cl.id, tenantId, cardId, cl.title, JSON.stringify(cl.items), cl.createdAt, cl.updatedAt);
  return cl;
}

export function listChecklists(tenantId: string, cardId: string): Checklist[] {
  const db = getCrmDb();
  const rows = db.prepare('SELECT * FROM crm_checklists WHERE tenant_id=? AND card_id=? ORDER BY created_at ASC').all(tenantId, cardId) as any[];
  return rows.map((r: any) => ({
    id: r.id, tenantId: r.tenant_id, cardId: r.card_id,
    title: r.title, items: JSON.parse(r.items_json || '[]') as ChecklistItem[],
    createdAt: r.created_at, updatedAt: r.updated_at,
  }));
}

export function updateChecklist(tenantId: string, id: string, patch: { title?: string; items?: ChecklistItem[] }): Checklist | null {
  const db = getCrmDb();
  const r = db.prepare('SELECT * FROM crm_checklists WHERE id=? AND tenant_id=?').get(id, tenantId) as any;
  if (!r) return null;
  const title = patch.title ?? r.title;
  const items = patch.items ?? JSON.parse(r.items_json || '[]');
  db.prepare('UPDATE crm_checklists SET title=?, items_json=?, updated_at=? WHERE id=? AND tenant_id=?')
    .run(title, JSON.stringify(items), Date.now(), id, tenantId);
  return { id, tenantId, cardId: r.card_id, title, items, createdAt: r.created_at, updatedAt: Date.now() };
}

export function toggleChecklistItem(tenantId: string, checklistId: string, itemId: string): Checklist | null {
  const db = getCrmDb();
  const r = db.prepare('SELECT * FROM crm_checklists WHERE id=? AND tenant_id=?').get(checklistId, tenantId) as any;
  if (!r) return null;
  const items: ChecklistItem[] = JSON.parse(r.items_json || '[]');
  const it = items.find(i => i.id === itemId);
  if (!it) return null;
  it.done = !it.done;
  db.prepare('UPDATE crm_checklists SET items_json=?, updated_at=? WHERE id=? AND tenant_id=?')
    .run(JSON.stringify(items), Date.now(), checklistId, tenantId);
  return { id: checklistId, tenantId, cardId: r.card_id, title: r.title, items, createdAt: r.created_at, updatedAt: Date.now() };
}

export function deleteChecklist(tenantId: string, id: string): boolean {
  const db = getCrmDb();
  const r = db.prepare('DELETE FROM crm_checklists WHERE id=? AND tenant_id=?').run(id, tenantId);
  return r.changes > 0;
}
