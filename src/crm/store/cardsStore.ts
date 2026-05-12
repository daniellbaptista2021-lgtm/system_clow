// CRM cardsStore module — split out from the legacy monolithic file in a refactor.
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
import { getBoard, listColumns } from './boardsStore.js';

export function createCard(tenantId: string, input: {
  boardId: string; columnId: string; title: string; description?: string;
  contactId?: string; ownerAgentId?: string; valueCents?: number; probability?: number;
  labels?: string[]; dueDate?: number; customFields?: Record<string, unknown>;
  position?: number;
}): Card | null {
  const db = getCrmDb();
  if (!getBoard(tenantId, input.boardId)) return null;
  const card: Card = {
    id: nid('crm_card'),
    tenantId,
    boardId: input.boardId,
    columnId: input.columnId,
    title: input.title,
    description: input.description,
    contactId: input.contactId,
    ownerAgentId: input.ownerAgentId,
    valueCents: input.valueCents ?? 0,
    probability: input.probability ?? 0,
    labels: input.labels ?? [],
    dueDate: input.dueDate,
    position: input.position !== undefined ? input.position : getNextCardPosition(db, input.columnId),
    customFields: input.customFields ?? {},
    createdAt: now(),
    updatedAt: now(),
  };
  db.prepare(`
    INSERT INTO crm_cards (id, tenant_id, board_id, column_id, title, description, contact_id, owner_agent_id,
      value_cents, probability, labels_json, due_date, position, custom_fields_json, created_at, updated_at,
      column_changed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(card.id, card.tenantId, card.boardId, card.columnId, card.title, card.description ?? null,
    card.contactId ?? null, card.ownerAgentId ?? null, card.valueCents, card.probability,
    J.stringify(card.labels), card.dueDate ?? null, card.position, J.stringify(card.customFields),
    card.createdAt, card.updatedAt, card.createdAt);
  logActivity(tenantId, { cardId: card.id, contactId: card.contactId, type: 'system', channel: 'manual',
    content: `Card criado na coluna ${card.columnId}` });
  void (async () => { (await getEmit())({ trigger: 'card_created', tenantId, cardId: card.id, contactId: card.contactId }); (await getAutoAssign())(tenantId, card.id); (await getPublish())(tenantId, 'card', { action: 'created', cardId: card.id }); })();
  return card;
}

function getNextCardPosition(db: Database.Database, columnId: string): number {
  const r = db.prepare('SELECT COALESCE(MAX(position), -1) as m FROM crm_cards WHERE column_id = ?')
    .get(columnId) as { m: number };
  return r.m + 1;
}

function getTopCardPosition(db: Database.Database, columnId: string): number {
  const r = db.prepare('SELECT COALESCE(MIN(position), 0) as m FROM crm_cards WHERE column_id = ?')
    .get(columnId) as { m: number };
  return r.m - 1;
}

export function getCard(tenantId: string, cardId: string): Card | null {
  const db = getCrmDb();
  const r = db.prepare('SELECT * FROM crm_cards WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL').get(cardId, tenantId) as any;
  return r ? rowToCard(r) : null;
}

export function listCardsByColumn(tenantId: string, columnId: string): Card[] {
  const db = getCrmDb();
  const rows = db.prepare(`
    SELECT * FROM crm_cards WHERE tenant_id = ? AND column_id = ? AND deleted_at IS NULL ORDER BY position ASC, created_at ASC
  `).all(tenantId, columnId) as any[];
  return rows.map(rowToCard);
}

export function listCardsByBoard(tenantId: string, boardId: string): Card[] {
  const db = getCrmDb();
  const rows = db.prepare(`
    SELECT * FROM crm_cards WHERE tenant_id = ? AND board_id = ? AND deleted_at IS NULL ORDER BY column_id, position ASC
  `).all(tenantId, boardId) as any[];
  return rows.map(rowToCard);
}

export function listCardsByContact(tenantId: string, contactId: string): Card[] {
  const db = getCrmDb();
  const rows = db.prepare(`
    SELECT * FROM crm_cards WHERE tenant_id = ? AND contact_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC
  `).all(tenantId, contactId) as any[];
  return rows.map(rowToCard);
}

export function updateCard(tenantId: string, cardId: string, patch: Partial<Omit<Card, 'id' | 'tenantId' | 'createdAt'>>): Card | null {
  const db = getCrmDb();
  const existing = getCard(tenantId, cardId);
  if (!existing) return null;
  const upd: Card = { ...existing, ...patch, updatedAt: now() };
  db.prepare(`
    UPDATE crm_cards SET board_id = ?, column_id = ?, title = ?, description = ?, contact_id = ?,
      owner_agent_id = ?, value_cents = ?, probability = ?, labels_json = ?, due_date = ?,
      position = ?, custom_fields_json = ?, updated_at = ?, last_activity_at = ?
    WHERE id = ? AND tenant_id = ?
  `).run(upd.boardId, upd.columnId, upd.title, upd.description ?? null, upd.contactId ?? null,
    upd.ownerAgentId ?? null, upd.valueCents, upd.probability, J.stringify(upd.labels), upd.dueDate ?? null,
    upd.position, J.stringify(upd.customFields), upd.updatedAt, upd.lastActivityAt ?? null, cardId, tenantId);
  return upd;
}

export function moveCard(tenantId: string, cardId: string, toColumnId: string, position?: number): Card | null {
  const db = getCrmDb();
  const existing = getCard(tenantId, cardId);
  if (!existing) return null;
  const pos = position ?? getNextCardPosition(db, toColumnId);
  const moved = updateCard(tenantId, cardId, { columnId: toColumnId, position: pos });
  if (moved && moved.columnId !== existing.columnId) {
    db.prepare('UPDATE crm_cards SET column_changed_at = ? WHERE id = ? AND tenant_id = ?')
      .run(Date.now(), cardId, tenantId);
    logActivity(tenantId, {
      cardId, contactId: existing.contactId, type: 'stage_change', channel: 'manual',
      content: `Movido de ${existing.columnId} para ${toColumnId}`,
    });
    void (async () => { (await getEmit())({ trigger: 'card_moved', tenantId, cardId, contactId: existing.contactId, fromColumnId: existing.columnId, toColumnId }); const cols2 = listColumns(tenantId, existing.boardId); const tgt = cols2.find(c => c.id === toColumnId); if (tgt?.isTerminal && /ganho|won/i.test(tgt.name)) { (await getCommitStock())(tenantId, cardId); } (await getPublish())(tenantId, 'card', { action: 'moved', cardId, toColumnId }); })();
  }
  return moved;
}

export function reorderCard(
  tenantId: string,
  cardId: string,
  toColumnId: string,
  opts: { beforeCardId?: string; atIndex?: number } = {},
): Card | null {
  const db = getCrmDb();
  const card = getCard(tenantId, cardId);
  if (!card) return null;
  const fromColumnId = card.columnId;

  // Pega cards da coluna alvo (excluindo o que vamos mover)
  const colCards = (db.prepare(`SELECT id, position FROM crm_cards WHERE tenant_id = ? AND column_id = ? AND id != ? ORDER BY position ASC, created_at ASC`).all(tenantId, toColumnId, cardId) as any[]);

  // Determina indice de insercao
  let insertAt: number;
  if (opts.beforeCardId) {
    const idx = colCards.findIndex(c => c.id === opts.beforeCardId);
    insertAt = idx >= 0 ? idx : colCards.length;
  } else if (typeof opts.atIndex === 'number') {
    insertAt = Math.max(0, Math.min(opts.atIndex, colCards.length));
  } else {
    insertAt = colCards.length; // adicionar no final
  }

  // Constroi nova ordem e re-numera 0..N
  const newOrder = [...colCards];
  newOrder.splice(insertAt, 0, { id: cardId, position: 0 });

  const tx = db.transaction(() => {
    // Atualiza coluna do card movido
    if (fromColumnId !== toColumnId) {
      const nowMs = Date.now();
      db.prepare(`UPDATE crm_cards SET column_id = ?, updated_at = ?, column_changed_at = ? WHERE id = ? AND tenant_id = ?`)
        .run(toColumnId, nowMs, nowMs, cardId, tenantId);
    }
    // Renumera todos os cards da coluna
    const stmt = db.prepare(`UPDATE crm_cards SET position = ?, updated_at = ? WHERE id = ? AND tenant_id = ?`);
    const now = Date.now();
    for (let i = 0; i < newOrder.length; i++) {
      stmt.run(i, now, newOrder[i].id, tenantId);
    }
  });
  tx();

  // Se mudou de coluna, loga atividade igual moveCard
  if (fromColumnId !== toColumnId) {
    logActivity(tenantId, {
      cardId, contactId: card.contactId, type: 'stage_change', channel: 'manual',
      content: 'Movido de ' + fromColumnId + ' para ' + toColumnId,
    });
    void (async () => {
      try {
        (await getEmit())({ trigger: 'card_moved', tenantId, cardId, contactId: card.contactId, fromColumnId, toColumnId });
        const cols2 = listColumns(tenantId, card.boardId);
        const tgt = cols2.find((c: any) => c.id === toColumnId);
        if (tgt?.isTerminal && /ganho|won/i.test(tgt.name)) { (await getCommitStock())(tenantId, cardId); }
        (await getPublish())(tenantId, 'card', { action: 'moved', cardId, toColumnId });
      } catch { /* silent */ }
    })();
  } else {
    // Reorder dentro da mesma coluna: notificar SSE pra atualizar UI dos outros usuarios
    void (async () => {
      try { (await getPublish())(tenantId, 'card', { action: 'reordered', cardId, columnId: toColumnId }); } catch {}
    })();
  }

  return getCard(tenantId, cardId);
}

export function deleteCard(tenantId: string, cardId: string): boolean {
  // Soft delete: preserva crm_activities (FK card_id tem ON DELETE CASCADE,
  // hard delete apaga todo o histórico de conversa do cliente). Card some
  // das listagens via filtro deleted_at IS NULL nas queries.
  const db = getCrmDb();
  const r = db.prepare('UPDATE crm_cards SET deleted_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL')
    .run(now(), now(), cardId, tenantId);
  return r.changes > 0;
}

function rowToCard(r: any): Card {
  return {
    id: r.id, tenantId: r.tenant_id, boardId: r.board_id, columnId: r.column_id,
    title: r.title, description: r.description ?? undefined,
    contactId: r.contact_id ?? undefined, ownerAgentId: r.owner_agent_id ?? undefined,
    valueCents: r.value_cents, probability: r.probability,
    labels: J.parse(r.labels_json, []),
    dueDate: r.due_date ?? undefined, position: r.position,
    customFields: J.parse(r.custom_fields_json, {}),
    createdAt: r.created_at, updatedAt: r.updated_at,
    lastActivityAt: r.last_activity_at ?? undefined,
    // Onda 48
    unreadCount: r.unread_count ?? 0,
    lastInboundAt: r.last_inbound_at ?? undefined,
  };
}

export function logActivity(tenantId: string, input: {
  cardId?: string; contactId?: string; type: ActivityType; channel: Channel;
  direction?: 'in' | 'out'; content: string; mediaUrl?: string; mediaType?: MediaType;
  providerMessageId?: string; createdByAgentId?: string; metadata?: Record<string, unknown>;
}): Activity {
  const db = getCrmDb();
  const a: Activity = {
    id: nid('crm_act'),
    tenantId,
    cardId: input.cardId,
    contactId: input.contactId,
    type: input.type,
    channel: input.channel,
    direction: input.direction,
    content: input.content,
    mediaUrl: input.mediaUrl,
    mediaType: input.mediaType,
    providerMessageId: input.providerMessageId,
    createdByAgentId: input.createdByAgentId,
    metadata: input.metadata,
    createdAt: now(),
  };
  db.prepare(`
    INSERT INTO crm_activities (id, tenant_id, card_id, contact_id, type, channel, direction,
      content, media_url, media_type, provider_message_id, created_by_agent_id, metadata_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(a.id, a.tenantId, a.cardId ?? null, a.contactId ?? null, a.type, a.channel, a.direction ?? null,
    a.content, a.mediaUrl ?? null, a.mediaType ?? null, a.providerMessageId ?? null,
    a.createdByAgentId ?? null, a.metadata ? J.stringify(a.metadata) : null, a.createdAt);

  // Touch parent entities for sort-by-recent
  if (a.cardId) {
    db.prepare('UPDATE crm_cards SET last_activity_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ?')
      .run(a.createdAt, a.createdAt, a.cardId, tenantId);
    // Onda 46: WhatsApp-style — qualquer mensagem (in/out) bumpa o card pro
    // TOPO da coluna atual. Funciona em qualquer aba (Lead novo, Qualificado,
    // Negociacao, etc). Ordering ASC + position negativo decrescente garante
    // que o card mais recentemente ativo fica no topo.
    if (a.type === 'message_in' || a.type === 'message_out') {
      const cardRow = db.prepare('SELECT column_id FROM crm_cards WHERE id = ? AND tenant_id = ?').get(a.cardId, tenantId) as { column_id?: string } | undefined;
      if (cardRow?.column_id) {
        const minPosRow = db.prepare('SELECT COALESCE(MIN(position), 0) as m FROM crm_cards WHERE column_id = ?').get(cardRow.column_id) as { m: number };
        const newPos = (minPosRow?.m ?? 0) - 1;
        db.prepare('UPDATE crm_cards SET position = ? WHERE id = ? AND tenant_id = ?').run(newPos, a.cardId, tenantId);
      }
      // Onda 48: contador de mensagens nao respondidas (estilo WhatsApp)
      if (a.type === 'message_in') {
        db.prepare('UPDATE crm_cards SET unread_count = COALESCE(unread_count,0) + 1, last_inbound_at = ?, last_client_message_at = ? WHERE id = ? AND tenant_id = ?')
          .run(a.createdAt, a.createdAt, a.cardId, tenantId);
      } else if (a.type === 'message_out') {
        db.prepare('UPDATE crm_cards SET unread_count = 0, last_bot_message_at = ? WHERE id = ? AND tenant_id = ?')
          .run(a.createdAt, a.cardId, tenantId);
      }
    }
  }
  if (a.contactId) {
    db.prepare('UPDATE crm_contacts SET last_interaction_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ?')
      .run(a.createdAt, a.createdAt, a.contactId, tenantId);
  }
  void (async () => {
    const pub = await getPublish();
    pub(tenantId, 'activity', { activityId: a.id, cardId: a.cardId, contactId: a.contactId, type: a.type });
    // Onda 48: evento rico pra notificar UI de mensagem nova
    if (a.type === 'message_in' && a.cardId) {
      const card = db.prepare('SELECT id, title, column_id, unread_count, contact_id FROM crm_cards WHERE id=? AND tenant_id=?').get(a.cardId, tenantId) as any;
      const contact = a.contactId ? db.prepare('SELECT name, phone FROM crm_contacts WHERE id=?').get(a.contactId) as any : null;
      const pushPayload = {
        cardId: a.cardId,
        columnId: card?.column_id,
        unreadCount: card?.unread_count || 0,
        cardTitle: card?.title,
        contactName: contact?.name,
        contactPhone: contact?.phone,
        preview: String(a.content || '').slice(0, 120),
        mediaType: a.mediaType,
        activityId: a.id,
      };
      pub(tenantId, 'message.in', pushPayload);
      // Onda 49: push notification pra mobile (app closed tambem)
      try {
        const { broadcastToTenant } = await import('.././push.js');
        const previewText = a.mediaType && a.mediaType !== 'text'
          ? `[${String(a.mediaType).toUpperCase()}] ${pushPayload.preview || ''}`.trim()
          : (pushPayload.preview || 'Mensagem nova');
        void broadcastToTenant(tenantId, {
          title: contact?.name || card?.title || 'Nova mensagem WhatsApp',
          body: previewText,
          url: `/crm/#card=${a.cardId}`,
          data: { cardId: a.cardId, type: 'message_in' },
        }).catch(() => {});
      } catch (err) { /* push optional */ }
    } else if (a.type === 'message_out' && a.cardId) {
      pub(tenantId, 'message.read', { cardId: a.cardId });
    }
  })();
  return a;
}

export function markCardRead(tenantId: string, cardId: string): boolean {
  const db = getCrmDb();
  const r = db.prepare('UPDATE crm_cards SET unread_count = 0 WHERE id = ? AND tenant_id = ? AND unread_count > 0')
    .run(cardId, tenantId);
  if (r.changes > 0) {
    void (async () => { (await getPublish())(tenantId, 'message.read', { cardId }); })();
  }
  return r.changes > 0;
}

export function listActivitiesByCard(tenantId: string, cardId: string, limit = 100): Activity[] {
  const db = getCrmDb();
  const rows = db.prepare(`
    SELECT * FROM crm_activities WHERE tenant_id = ? AND card_id = ?
    ORDER BY created_at ASC LIMIT ?
  `).all(tenantId, cardId, limit) as any[];
  return rows.map(rowToActivity);
}

export function listActivitiesByContact(tenantId: string, contactId: string, limit = 100): Activity[] {
  const db = getCrmDb();
  const rows = db.prepare(`
    SELECT * FROM crm_activities WHERE tenant_id = ? AND contact_id = ?
      AND deleted_at IS NULL
    ORDER BY created_at ASC LIMIT ?
  `).all(tenantId, contactId, limit) as any[];
  return rows.map(rowToActivity);
}

function rowToActivity(r: any): Activity {
  return {
    id: r.id, tenantId: r.tenant_id, cardId: r.card_id ?? undefined, contactId: r.contact_id ?? undefined,
    type: r.type as ActivityType, channel: r.channel as Channel,
    direction: r.direction ?? undefined, content: r.content,
    mediaUrl: r.media_url ?? undefined, mediaType: r.media_type as MediaType ?? undefined,
    providerMessageId: r.provider_message_id ?? undefined,
    createdByAgentId: r.created_by_agent_id ?? undefined,
    metadata: J.parse(r.metadata_json, undefined),
    createdAt: r.created_at,
  };
}

export function createReminder(tenantId: string, input: {
  cardId?: string; contactId?: string; content: string; dueAt: number; createdByAgentId?: string;
}): { id: string; tenantId: string; cardId?: string; contactId?: string; content: string; dueAt: number; createdAt: number } {
  const db = getCrmDb();
  const r = {
    id: nid('crm_rem'), tenantId, cardId: input.cardId, contactId: input.contactId,
    content: input.content, dueAt: input.dueAt, createdAt: now(),
  };
  db.prepare(`
    INSERT INTO crm_reminders (id, tenant_id, card_id, contact_id, content, due_at, created_by_agent_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(r.id, tenantId, r.cardId ?? null, r.contactId ?? null, r.content, r.dueAt,
    input.createdByAgentId ?? null, r.createdAt);
  return r;
}

export function listDueReminders(): Array<{ id: string; tenantId: string; cardId?: string; contactId?: string; content: string; dueAt: number }> {
  const db = getCrmDb();
  const rows = db.prepare(`
    SELECT * FROM crm_reminders WHERE completed_at IS NULL AND due_at <= ? ORDER BY due_at ASC LIMIT 500
  `).all(now()) as any[];
  return rows.map((r: any) => ({
    id: r.id, tenantId: r.tenant_id, cardId: r.card_id ?? undefined,
    contactId: r.contact_id ?? undefined, content: r.content, dueAt: r.due_at,
  }));
}

export function completeReminder(tenantId: string, reminderId: string): boolean {
  const db = getCrmDb();
  const r = db.prepare('UPDATE crm_reminders SET completed_at = ? WHERE id = ? AND tenant_id = ?')
    .run(now(), reminderId, tenantId);
  return r.changes > 0;
}

export function archiveCard(tenantId: string, cardId: string): Card | null {
  const db = getCrmDb();
  const existing = db.prepare('SELECT * FROM crm_cards WHERE id=? AND tenant_id=?').get(cardId, tenantId) as any;
  if (!existing) return null;
  db.prepare("UPDATE crm_cards SET status='archived', archived_at=?, updated_at=? WHERE id=? AND tenant_id=?")
    .run(Date.now(), Date.now(), cardId, tenantId);
  return rowToCard({ ...existing, status: 'archived', archived_at: Date.now() });
}

export function unarchiveCard(tenantId: string, cardId: string): Card | null {
  const db = getCrmDb();
  const existing = db.prepare('SELECT * FROM crm_cards WHERE id=? AND tenant_id=?').get(cardId, tenantId) as any;
  if (!existing) return null;
  db.prepare("UPDATE crm_cards SET status='active', archived_at=NULL, updated_at=? WHERE id=? AND tenant_id=?")
    .run(Date.now(), cardId, tenantId);
  return rowToCard({ ...existing, status: 'active', archived_at: null });
}

function rowToLabel(r: any): Label {
  return { id: r.id, tenantId: r.tenant_id, name: r.name, color: r.color || '#9B59FC', scope: (r.scope || 'inbox') as any, createdAt: r.created_at };
}

export function createLabel(tenantId: string, input: { name: string; color?: string; scope?: 'inbox'|'contact'|'both' }): Label {
  const l: Label = { id: nid('crm_lbl'), tenantId, name: input.name,
    color: input.color || '#9B59FC', scope: input.scope || 'inbox', createdAt: now() };
  getCrmDb().prepare('INSERT INTO crm_labels (id,tenant_id,name,color,scope,created_at) VALUES (?,?,?,?,?,?)')
    .run(l.id, tenantId, l.name, l.color, l.scope, l.createdAt);
  return l;
}

export function listLabels(tenantId: string, scope?: 'inbox'|'contact'|'both'): Label[] {
  const db = getCrmDb();
  let sql = 'SELECT * FROM crm_labels WHERE tenant_id=?';
  const args: any[] = [tenantId];
  if (scope) { sql += " AND (scope=? OR scope='both')"; args.push(scope); }
  return (db.prepare(sql + ' ORDER BY name').all(...args) as any[]).map(rowToLabel);
}

export function updateLabel(tenantId: string, id: string, patch: Partial<Omit<Label,'id'|'tenantId'|'createdAt'>>): Label | null {
  const db = getCrmDb();
  const r = db.prepare('SELECT * FROM crm_labels WHERE id=? AND tenant_id=?').get(id, tenantId) as any;
  if (!r) return null;
  const upd = { name: patch.name ?? r.name, color: patch.color ?? r.color, scope: patch.scope ?? r.scope };
  db.prepare('UPDATE crm_labels SET name=?, color=?, scope=? WHERE id=? AND tenant_id=?')
    .run(upd.name, upd.color, upd.scope, id, tenantId);
  return { id, tenantId, ...upd, createdAt: r.created_at } as Label;
}

export function deleteLabel(tenantId: string, id: string): boolean {
  return getCrmDb().prepare('DELETE FROM crm_labels WHERE id=? AND tenant_id=?').run(id, tenantId).changes > 0;
}

export function addLabelToActivity(tenantId: string, activityId: string, labelId: string): boolean {
  const db = getCrmDb();
  const a = db.prepare('SELECT labels_json FROM crm_activities WHERE id=? AND tenant_id=?').get(activityId, tenantId) as any;
  if (!a) return false;
  const labels: string[] = JSON.parse(a.labels_json || '[]');
  if (!labels.includes(labelId)) {
    labels.push(labelId);
    db.prepare('UPDATE crm_activities SET labels_json=? WHERE id=? AND tenant_id=?').run(JSON.stringify(labels), activityId, tenantId);
  }
  return true;
}

export function removeLabelFromActivity(tenantId: string, activityId: string, labelId: string): boolean {
  const db = getCrmDb();
  const a = db.prepare('SELECT labels_json FROM crm_activities WHERE id=? AND tenant_id=?').get(activityId, tenantId) as any;
  if (!a) return false;
  const labels: string[] = JSON.parse(a.labels_json || '[]').filter((x: string) => x !== labelId);
  db.prepare('UPDATE crm_activities SET labels_json=? WHERE id=? AND tenant_id=?').run(JSON.stringify(labels), activityId, tenantId);
  return true;
}

function rowToQr(r: any): QuickReply {
  return { id: r.id, tenantId: r.tenant_id, title: r.title, body: r.body,
    shortcut: r.shortcut ?? undefined, category: r.category ?? undefined,
    useCount: r.use_count, createdAt: r.created_at, updatedAt: r.updated_at };
}

export function createQuickReply(tenantId: string, input: { title: string; body: string; shortcut?: string; category?: string }): QuickReply {
  const q: QuickReply = { id: nid('crm_qr'), tenantId, ...input, useCount: 0, createdAt: now(), updatedAt: now() };
  getCrmDb().prepare('INSERT INTO crm_quick_replies (id,tenant_id,title,body,shortcut,category,use_count,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(q.id, tenantId, q.title, q.body, q.shortcut ?? null, q.category ?? null, 0, q.createdAt, q.updatedAt);
  return q;
}

export function listQuickReplies(tenantId: string, category?: string): QuickReply[] {
  const db = getCrmDb();
  let sql = 'SELECT * FROM crm_quick_replies WHERE tenant_id=?';
  const args: any[] = [tenantId];
  if (category) { sql += ' AND category=?'; args.push(category); }
  return (db.prepare(sql + ' ORDER BY use_count DESC, title ASC').all(...args) as any[]).map(rowToQr);
}

export function updateQuickReply(tenantId: string, id: string, patch: Partial<Omit<QuickReply,'id'|'tenantId'|'createdAt'|'useCount'>>): QuickReply | null {
  const db = getCrmDb();
  const r = db.prepare('SELECT * FROM crm_quick_replies WHERE id=? AND tenant_id=?').get(id, tenantId) as any;
  if (!r) return null;
  const upd = { title: patch.title ?? r.title, body: patch.body ?? r.body,
    shortcut: patch.shortcut ?? r.shortcut, category: patch.category ?? r.category,
    updatedAt: now() };
  db.prepare('UPDATE crm_quick_replies SET title=?, body=?, shortcut=?, category=?, updated_at=? WHERE id=? AND tenant_id=?')
    .run(upd.title, upd.body, upd.shortcut ?? null, upd.category ?? null, upd.updatedAt, id, tenantId);
  return { id, tenantId, title: upd.title, body: upd.body, shortcut: upd.shortcut, category: upd.category, useCount: r.use_count, createdAt: r.created_at, updatedAt: upd.updatedAt };
}

export function deleteQuickReply(tenantId: string, id: string): boolean {
  return getCrmDb().prepare('DELETE FROM crm_quick_replies WHERE id=? AND tenant_id=?').run(id, tenantId).changes > 0;
}

export function bumpQuickReplyUse(tenantId: string, id: string): void {
  getCrmDb().prepare('UPDATE crm_quick_replies SET use_count=use_count+1 WHERE id=? AND tenant_id=?').run(id, tenantId);
}

export function markActivityRead(tenantId: string, activityId: string, agentId: string): boolean {
  const db = getCrmDb();
  const a = db.prepare('SELECT read_by_json FROM crm_activities WHERE id=? AND tenant_id=?').get(activityId, tenantId) as any;
  if (!a) return false;
  const readBy: string[] = JSON.parse(a.read_by_json || '[]');
  if (!readBy.includes(agentId)) {
    readBy.push(agentId);
    db.prepare('UPDATE crm_activities SET read_by_json=? WHERE id=? AND tenant_id=?').run(JSON.stringify(readBy), activityId, tenantId);
  }
  return true;
}

export function snoozeActivity(tenantId: string, activityId: string, untilTs: number): boolean {
  return getCrmDb().prepare('UPDATE crm_activities SET snoozed_until=? WHERE id=? AND tenant_id=?')
    .run(untilTs, activityId, tenantId).changes > 0;
}

export function listActivitiesFiltered(tenantId: string, filter: ActivityFilter, limit: number = 200, offset: number = 0): any[] {
  const db = getCrmDb();
  const conds: string[] = ['tenant_id = ?'];
  const args: any[] = [tenantId];
  if (filter.types?.length) {
    conds.push('type IN (' + filter.types.map(() => '?').join(',') + ')');
    args.push(...filter.types);
  }
  if (filter.agentId) { conds.push('created_by_agent_id = ?'); args.push(filter.agentId); }
  if (filter.contactId) { conds.push('contact_id = ?'); args.push(filter.contactId); }
  if (filter.cardId) { conds.push('card_id = ?'); args.push(filter.cardId); }
  if (filter.dateFrom) { conds.push('created_at >= ?'); args.push(filter.dateFrom); }
  if (filter.dateTo) { conds.push('created_at <= ?'); args.push(filter.dateTo); }
  if (filter.isPrivate != null) { conds.push('COALESCE(is_private,0) = ?'); args.push(filter.isPrivate ? 1 : 0); }
  if (filter.mentionedAgent) { conds.push('mentions_json LIKE ?'); args.push('%"' + filter.mentionedAgent + '"%'); }
  if (filter.hasAttachment) conds.push("COALESCE(attachments_json, '[]') != '[]'");

  const sql = `SELECT * FROM crm_activities WHERE ${conds.join(' AND ')} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
  args.push(Math.min(limit, 1000), offset);
  return db.prepare(sql).all(...args) as any[];
}

export function addMentionsToActivity(tenantId: string, activityId: string, agentIds: string[]): boolean {
  const db = getCrmDb();
  const a = db.prepare('SELECT mentions_json FROM crm_activities WHERE id=? AND tenant_id=?').get(activityId, tenantId) as any;
  if (!a) return false;
  const existing: string[] = JSON.parse(a.mentions_json || '[]');
  for (const id of agentIds) if (!existing.includes(id)) existing.push(id);
  db.prepare('UPDATE crm_activities SET mentions_json=? WHERE id=? AND tenant_id=?').run(JSON.stringify(existing), activityId, tenantId);
  return true;
}

export function createActivityPro(tenantId: string, input: {
  type: string; content: string; cardId?: string; contactId?: string;
  channel?: string; direction?: string; createdByAgentId?: string;
  durationSeconds?: number; callOutcome?: string; emailSubject?: string;
  attachments?: string[]; mentions?: string[]; isPrivate?: boolean;
  metadata?: Record<string, unknown>; mediaUrl?: string; mediaType?: string;
  providerMessageId?: string;
}): any {
  const db = getCrmDb();
  const id = nid('crm_act');
  const t = now();
  db.prepare(`INSERT INTO crm_activities
    (id, tenant_id, card_id, contact_id, type, channel, direction, content,
     media_url, media_type, provider_message_id, metadata_json, created_by_agent_id,
     created_at, duration_seconds, call_outcome, email_subject, attachments_json,
     mentions_json, is_private)
    VALUES (?,?,?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?, ?,?)`)
    .run(id, tenantId, input.cardId ?? null, input.contactId ?? null, input.type,
         input.channel ?? null, input.direction ?? null, input.content,
         input.mediaUrl ?? null, input.mediaType ?? null, input.providerMessageId ?? null,
         JSON.stringify(input.metadata || {}), input.createdByAgentId ?? null, t,
         input.durationSeconds ?? null, input.callOutcome ?? null, input.emailSubject ?? null,
         JSON.stringify(input.attachments || []),
         JSON.stringify(input.mentions || []), input.isPrivate ? 1 : 0);
  return { id, tenantId, ...input, createdAt: t };
}

function rowToReminderPro(r: any): ReminderPro {
  return {
    id: r.id, tenantId: r.tenant_id, title: r.title,
    description: r.description ?? undefined, dueAt: r.due_at,
    agentId: r.agent_id ?? undefined, contactId: r.contact_id ?? undefined,
    cardId: r.card_id ?? undefined,
    recurrenceRule: r.recurrence_rule ?? undefined,
    recurrenceEndTs: r.recurrence_end_ts ?? undefined,
    snoozeUntil: r.snooze_until ?? undefined,
    channels: JSON.parse(r.channels_json || '["in_app"]'),
    preNotifyMins: r.pre_notify_mins ?? undefined,
    status: (r.status || 'active') as ReminderStatus,
    createdAt: r.created_at,
    completedAt: r.completed_at ?? undefined,
  };
}

export function createReminderPro(tenantId: string, input: {
  title: string; description?: string; dueAt: number;
  agentId?: string; contactId?: string; cardId?: string;
  recurrenceRule?: string; recurrenceEndTs?: number;
  channels?: ReminderChannel[]; preNotifyMins?: number;
}): ReminderPro {
  const db = getCrmDb();
  const id = nid('crm_rem');
  const t = now();
  const channels = input.channels || ['in_app'];
  db.prepare(`INSERT INTO crm_reminders
    (id, tenant_id, card_id, contact_id, agent_id, title, description, due_at,
     status, created_at, completed_at, recurrence_rule, recurrence_end_ts,
     snooze_until, channels_json, pre_notify_mins)
    VALUES (?,?,?,?,?,?,?,?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, tenantId, input.cardId ?? null, input.contactId ?? null, input.agentId ?? null,
         input.title, input.description ?? null, input.dueAt, 'active', t, null,
         input.recurrenceRule ?? null, input.recurrenceEndTs ?? null,
         null, JSON.stringify(channels), input.preNotifyMins ?? null);
  return { id, tenantId, title: input.title, description: input.description, dueAt: input.dueAt,
    agentId: input.agentId, contactId: input.contactId, cardId: input.cardId,
    recurrenceRule: input.recurrenceRule, recurrenceEndTs: input.recurrenceEndTs,
    channels, preNotifyMins: input.preNotifyMins, status: 'active', createdAt: t };
}

export function listRemindersPro(tenantId: string, opts: { agentId?: string; status?: ReminderStatus; dueBefore?: number; limit?: number } = {}): ReminderPro[] {
  const db = getCrmDb();
  const conds: string[] = ['tenant_id = ?'];
  const args: any[] = [tenantId];
  if (opts.agentId) { conds.push('agent_id = ?'); args.push(opts.agentId); }
  if (opts.status) { conds.push('status = ?'); args.push(opts.status); }
  if (opts.dueBefore) { conds.push('due_at <= ?'); args.push(opts.dueBefore); }
  const sql = `SELECT * FROM crm_reminders WHERE ${conds.join(' AND ')} ORDER BY due_at ASC LIMIT ?`;
  args.push(Math.min(opts.limit || 200, 1000));
  return (db.prepare(sql).all(...args) as any[]).map(rowToReminderPro);
}

export function snoozeReminder(tenantId: string, id: string, untilTs: number): ReminderPro | null {
  const db = getCrmDb();
  const r = db.prepare('SELECT * FROM crm_reminders WHERE id=? AND tenant_id=?').get(id, tenantId) as any;
  if (!r) return null;
  db.prepare('UPDATE crm_reminders SET snooze_until=?, due_at=? WHERE id=? AND tenant_id=?')
    .run(untilTs, untilTs, id, tenantId);
  return rowToReminderPro({ ...r, snooze_until: untilTs, due_at: untilTs });
}

function advanceRecurrence(rule: string, from: number): number | null {
  try {
    const parts: Record<string, string> = {};
    rule.split(';').forEach(kv => {
      const [k, v] = kv.split('=');
      if (k) parts[k.trim().toUpperCase()] = (v || '').trim().toUpperCase();
    });
    const freq = parts['FREQ'];
    const interval = parseInt(parts['INTERVAL'] || '1', 10) || 1;
    const d = new Date(from);
    if (freq === 'DAILY') d.setDate(d.getDate() + interval);
    else if (freq === 'WEEKLY') d.setDate(d.getDate() + 7 * interval);
    else if (freq === 'MONTHLY') d.setMonth(d.getMonth() + interval);
    else if (freq === 'YEARLY') d.setFullYear(d.getFullYear() + interval);
    else return null;
    return d.getTime();
  } catch { return null; }
}

export function completeReminderPro(tenantId: string, id: string): ReminderPro | null {
  const db = getCrmDb();
  const r = db.prepare('SELECT * FROM crm_reminders WHERE id=? AND tenant_id=?').get(id, tenantId) as any;
  if (!r) return null;
  if (r.recurrence_rule) {
    const nextAt = advanceRecurrence(r.recurrence_rule, r.due_at);
    if (nextAt && (!r.recurrence_end_ts || nextAt <= r.recurrence_end_ts)) {
      db.prepare('UPDATE crm_reminders SET due_at=?, snooze_until=NULL, status=?, completed_at=? WHERE id=? AND tenant_id=?')
        .run(nextAt, 'active', null, id, tenantId);
      return rowToReminderPro({ ...r, due_at: nextAt, snooze_until: null, status: 'active', completed_at: null });
    }
  }
  db.prepare('UPDATE crm_reminders SET status=?, completed_at=? WHERE id=? AND tenant_id=?')
    .run('done', Date.now(), id, tenantId);
  return rowToReminderPro({ ...r, status: 'done', completed_at: Date.now() });
}

export function logReminderFired(tenantId: string, reminderId: string, channel: string, delivered: boolean, error?: string): void {
  getCrmDb().prepare('INSERT INTO crm_reminder_history (id, tenant_id, reminder_id, fired_at, channel, delivered, error) VALUES (?,?,?,?,?,?,?)')
    .run(nid('crm_remh'), tenantId, reminderId, Date.now(), channel, delivered ? 1 : 0, error ?? null);
}

export function getReminderHistory(tenantId: string, reminderId: string, limit: number = 100): any[] {
  return getCrmDb().prepare('SELECT * FROM crm_reminder_history WHERE tenant_id=? AND reminder_id=? ORDER BY fired_at DESC LIMIT ?')
    .all(tenantId, reminderId, Math.min(limit, 500)) as any[];
}
