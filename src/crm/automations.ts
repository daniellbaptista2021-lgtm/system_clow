/**
 * CRM automations — trigger → conditions → actions engine.
 *
 * Architecture:
 *   1. Hot points (inbox/store) call `emit(event)` after important actions
 *   2. emit() loads enabled automations matching the trigger type
 *   3. For each, conditions are checked; if all match, actions run sequentially
 *   4. Each run increments runs_count + sets last_run_at (audit)
 *
 * Triggers:
 *   inbound_message    — incoming WhatsApp message ingested
 *   outbound_message   — message sent via channel
 *   card_created
 *   card_moved
 *   card_stale         — emitted by scheduler when no activity for N days
 *   due_approaching    — emitted by scheduler when card.dueDate < now + N days
 *
 * Conditions (stackable; ALL must match):
 *   text_contains     params: { value: string, caseInsensitive?: boolean }
 *   text_matches      params: { regex: string, flags?: string }
 *   column_is         params: { columnName: string }
 *   column_is_not     params: { columnName: string }
 *   value_above       params: { cents: number }
 *   value_below       params: { cents: number }
 *   tag_has           params: { tag: string }
 *   contact_source    params: { source: string }
 *   days_since_activity params: { days: number, op: 'gte'|'lte' }
 *
 * Actions (run in order, fire-and-forget):
 *   move_card         params: { toColumnName: string }
 *   add_label         params: { label: string }
 *   add_note          params: { content: string }
 *   send_whatsapp     params: { text: string, channelId?: string }   — supports {{name}} {{phone}} placeholders
 *   create_reminder   params: { content: string, hoursFromNow: number }
 *   set_probability   params: { value: number }
 *   set_owner         params: { agentId: string }
 *   webhook           params: { url: string, method?: 'GET'|'POST' }
 */

import * as store from './store.js';
import { sendOutbound } from './inbox.js';
import { getCrmDb } from './schema.js';
import type { Card, Contact, Activity, Automation } from './types.js';

// ─── Event types ────────────────────────────────────────────────────────
export type TriggerType =
  | 'inbound_message' | 'outbound_message'
  | 'card_created' | 'card_moved'
  | 'card_stale' | 'due_approaching'
  | 'webhook' | 'schedule';

export interface AutomationEvent {
  trigger: TriggerType;
  tenantId: string;
  cardId?: string;
  contactId?: string;
  activityId?: string;
  fromColumnId?: string;
  toColumnId?: string;
  text?: string;
  metadata?: Record<string, unknown>;
}

// ─── Engine: emit + run ─────────────────────────────────────────────────
const _runningEvents = new Set<string>(); // dedup re-entrant runs

export async function emit(event: AutomationEvent): Promise<void> {
  const dedupeKey = `${event.tenantId}:${event.trigger}:${event.cardId || event.contactId || ''}:${event.activityId || ''}`;
  if (_runningEvents.has(dedupeKey)) return;
  _runningEvents.add(dedupeKey);
  try {
    const db = getCrmDb();
    const rules = db.prepare(`
      SELECT * FROM crm_automations WHERE tenant_id = ? AND enabled = 1
    `).all(event.tenantId) as any[];

    for (const r of rules) {
      try {
        const trigger = JSON.parse(r.trigger_json || '{}');
        if (trigger.type !== event.trigger) continue;
        const conditions = JSON.parse(r.conditions_json || '[]');
        const actions = JSON.parse(r.actions_json || '[]');

        if (!await checkConditions(event, conditions)) continue;

        // Run actions
        for (const action of actions) {
          try { await runAction(event, action); }
          catch (err: any) {
            console.warn(`[crm-automation] action ${action.type} failed: ${err.message}`);
          }
        }

        // Audit
        db.prepare(`
          UPDATE crm_automations SET last_run_at = ?, runs_count = runs_count + 1 WHERE id = ?
        `).run(Date.now(), r.id);
      } catch (err: any) {
        console.warn(`[crm-automation] rule ${r.id} eval failed: ${err.message}`);
      }
    }
  } finally {
    _runningEvents.delete(dedupeKey);
  }
}

// ─── Conditions ─────────────────────────────────────────────────────────
async function checkConditions(event: AutomationEvent, conditions: any[]): Promise<boolean> {
  const { tenantId } = event;
  const card = event.cardId ? store.getCard(tenantId, event.cardId) : null;
  const contact = event.contactId ? store.getContact(tenantId, event.contactId) : null;

  for (const cond of conditions) {
    const ok = await checkOne(event, cond, card, contact);
    if (!ok) return false;
  }
  return true;
}

async function checkOne(event: AutomationEvent, cond: any, card: Card | null, contact: Contact | null): Promise<boolean> {
  const p = cond.params || {};
  switch (cond.type) {
    case 'text_contains': {
      const txt = (event.text || '').toString();
      const needle = String(p.value || '');
      return p.caseInsensitive
        ? txt.toLowerCase().includes(needle.toLowerCase())
        : txt.includes(needle);
    }
    case 'text_matches': {
      try {
        const re = new RegExp(p.regex, p.flags || 'i');
        return re.test(event.text || '');
      } catch { return false; }
    }
    case 'column_is': {
      if (!card) return false;
      const cols = store.listColumns(event.tenantId, card.boardId);
      const target = cols.find(c => c.id === card.columnId);
      return target?.name.toLowerCase() === String(p.columnName).toLowerCase();
    }
    case 'column_is_not': {
      if (!card) return true;
      const cols = store.listColumns(event.tenantId, card.boardId);
      const target = cols.find(c => c.id === card.columnId);
      return target?.name.toLowerCase() !== String(p.columnName).toLowerCase();
    }
    case 'value_above': return (card?.valueCents ?? 0) > Number(p.cents || 0);
    case 'value_below': return (card?.valueCents ?? 0) < Number(p.cents || 0);
    case 'tag_has': return Boolean(contact?.tags?.includes(String(p.tag)));
    case 'contact_source': return contact?.source === String(p.source);
    case 'days_since_activity': {
      const ts = card?.lastActivityAt ?? card?.updatedAt ?? contact?.lastInteractionAt;
      if (!ts) return false;
      const days = (Date.now() - ts) / 86400_000;
      return p.op === 'lte' ? days <= Number(p.days) : days >= Number(p.days);
    }
    default:
      return false;
  }
}

// ─── Actions ────────────────────────────────────────────────────────────
async function runAction(event: AutomationEvent, action: any): Promise<void> {
  const p = action.params || {};
  const { tenantId } = event;

  switch (action.type) {
    case 'move_card': {
      if (!event.cardId) return;
      const card = store.getCard(tenantId, event.cardId);
      if (!card) return;
      const cols = store.listColumns(tenantId, card.boardId);
      const target = cols.find(c => c.name.toLowerCase() === String(p.toColumnName).toLowerCase());
      if (!target || target.id === card.columnId) return;
      store.moveCard(tenantId, event.cardId, target.id);
      break;
    }
    case 'add_label': {
      if (!event.cardId) return;
      const card = store.getCard(tenantId, event.cardId);
      if (!card) return;
      const labels = [...new Set([...(card.labels || []), String(p.label)])];
      store.updateCard(tenantId, event.cardId, { labels });
      break;
    }
    case 'add_note': {
      const content = renderTemplate(String(p.content || ''), event);
      store.logActivity(tenantId, {
        cardId: event.cardId, contactId: event.contactId,
        type: 'note', channel: 'ai',
        content,
        createdByAgentId: 'automation',
      });
      break;
    }
    case 'send_whatsapp': {
      const channels = store.listChannels(tenantId).filter(c => c.status !== 'disabled');
      const channel = p.channelId
        ? channels.find(c => c.id === p.channelId)
        : channels[0];
      if (!channel) return;
      const contact = event.contactId ? store.getContact(tenantId, event.contactId) : null;
      if (!contact?.phone) return;
      const text = renderTemplate(String(p.text || ''), event, contact);
      await sendOutbound(channel, {
        to: contact.phone, text,
        cardId: event.cardId, contactId: event.contactId,
      });
      break;
    }
    case 'create_reminder': {
      const dueAt = Date.now() + Number(p.hoursFromNow || 24) * 3600_000;
      store.createReminder(tenantId, {
        cardId: event.cardId, contactId: event.contactId,
        content: renderTemplate(String(p.content || 'Follow-up'), event),
        dueAt,
      });
      break;
    }
    case 'set_probability': {
      if (!event.cardId) return;
      const v = Math.max(0, Math.min(100, Number(p.value || 0)));
      store.updateCard(tenantId, event.cardId, { probability: v });
      break;
    }
    case 'set_owner': {
      if (!event.cardId) return;
      store.updateCard(tenantId, event.cardId, { ownerAgentId: String(p.agentId) });
      break;
    }
    case 'webhook': {
      const url = String(p.url || '');
      if (!url.startsWith('http')) return;
      try {
        await fetch(url, {
          method: p.method || 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ event, action }),
        });
      } catch { /* webhook failures non-critical */ }
      break;
    }
  }
}

// ─── Template rendering: {{name}}, {{phone}}, {{text}}, {{cardTitle}} ──
function renderTemplate(tpl: string, event: AutomationEvent, contact?: Contact | null): string {
  let out = tpl;
  if (contact) {
    out = out.replace(/\{\{name\}\}/g, contact.name || '')
             .replace(/\{\{phone\}\}/g, contact.phone || '')
             .replace(/\{\{firstName\}\}/g, (contact.name || '').split(/\s+/)[0]);
  }
  out = out.replace(/\{\{text\}\}/g, event.text || '');
  if (event.cardId) {
    const card = store.getCard(event.tenantId, event.cardId);
    if (card) out = out.replace(/\{\{cardTitle\}\}/g, card.title);
  }
  return out;
}

// ─── CRUD helpers (used by REST routes) ─────────────────────────────────
export function listAutomations(tenantId: string): Automation[] {
  const db = getCrmDb();
  const rows = db.prepare('SELECT * FROM crm_automations WHERE tenant_id = ? ORDER BY created_at ASC').all(tenantId) as any[];
  return rows.map(rowToAutomation);
}

export function createAutomation(tenantId: string, input: {
  name: string; trigger: any; conditions?: any[]; actions: any[]; enabled?: boolean;
}): Automation {
  const db = getCrmDb();
  const a: Automation = {
    id: 'crm_aut_' + Math.random().toString(36).slice(2, 14),
    tenantId,
    name: input.name,
    enabled: input.enabled !== false,
    trigger: input.trigger,
    conditions: input.conditions || [],
    actions: input.actions,
    runsCount: 0,
    createdAt: Date.now(),
  };
  db.prepare(`
    INSERT INTO crm_automations (id, tenant_id, name, enabled, trigger_json, conditions_json, actions_json, runs_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
  `).run(a.id, a.tenantId, a.name, a.enabled ? 1 : 0,
    JSON.stringify(a.trigger), JSON.stringify(a.conditions), JSON.stringify(a.actions), a.createdAt);
  return a;
}

export function updateAutomation(tenantId: string, id: string, patch: Partial<Automation>): Automation | null {
  const db = getCrmDb();
  const r = db.prepare('SELECT * FROM crm_automations WHERE id = ? AND tenant_id = ?').get(id, tenantId) as any;
  if (!r) return null;
  const existing = rowToAutomation(r);
  const upd = { ...existing, ...patch };
  db.prepare(`
    UPDATE crm_automations SET name = ?, enabled = ?, trigger_json = ?, conditions_json = ?, actions_json = ?
    WHERE id = ? AND tenant_id = ?
  `).run(upd.name, upd.enabled ? 1 : 0, JSON.stringify(upd.trigger),
    JSON.stringify(upd.conditions), JSON.stringify(upd.actions), id, tenantId);
  return upd;
}

export function deleteAutomation(tenantId: string, id: string): boolean {
  const db = getCrmDb();
  const r = db.prepare('DELETE FROM crm_automations WHERE id = ? AND tenant_id = ?').run(id, tenantId);
  return r.changes > 0;
}

function rowToAutomation(r: any): Automation {
  return {
    id: r.id, tenantId: r.tenant_id, name: r.name, enabled: r.enabled === 1,
    trigger: JSON.parse(r.trigger_json || '{}'),
    conditions: JSON.parse(r.conditions_json || '[]'),
    actions: JSON.parse(r.actions_json || '[]'),
    lastRunAt: r.last_run_at ?? undefined,
    runsCount: r.runs_count,
    createdAt: r.created_at,
  };
}

// ─── Templates: pre-built automations the user can install in 1 click ──
export const AUTOMATION_TEMPLATES = [
  {
    key: 'auto_qualify_on_keyword',
    name: 'Mover pra Qualificado quando cliente diz "preço"',
    description: 'Quando lead novo manda msg contendo "preço/orçamento/valor", move pra "Qualificado"',
    trigger: { type: 'inbound_message' },
    conditions: [
      { type: 'column_is', params: { columnName: 'Lead novo' } },
      { type: 'text_matches', params: { regex: 'pre[çc]o|or[cç]amento|valor|quanto custa', flags: 'i' } },
    ],
    actions: [
      { type: 'move_card', params: { toColumnName: 'Qualificado' } },
      { type: 'add_note', params: { content: '🤖 Auto-qualificado: cliente perguntou sobre preço.' } },
    ],
  },
  {
    key: 'welcome_new_lead',
    name: 'Saudação automática pra novo lead',
    description: 'Primeira msg recebida → responde apresentação + cria reminder follow-up 24h',
    trigger: { type: 'card_created' },
    conditions: [],
    actions: [
      { type: 'send_whatsapp', params: { text: 'Olá {{firstName}}! Recebi sua mensagem e em breve um especialista vai te atender. 🚀' } },
      { type: 'create_reminder', params: { content: 'Dar follow-up no lead {{name}}', hoursFromNow: 24 } },
    ],
  },
  {
    key: 'cold_lead_alert',
    name: 'Alerta lead esfriando (7 dias sem atividade)',
    description: 'Cards sem atividade ≥ 7 dias geram nota + lembrete pro vendedor',
    trigger: { type: 'card_stale' },
    conditions: [
      { type: 'days_since_activity', params: { days: 7, op: 'gte' } },
      { type: 'column_is_not', params: { columnName: 'Ganho' } },
      { type: 'column_is_not', params: { columnName: 'Perdido' } },
    ],
    actions: [
      { type: 'add_label', params: { label: 'frio' } },
      { type: 'add_note', params: { content: '⚠️ Lead sem atividade há 7+ dias. Recuperar ou descartar.' } },
      { type: 'create_reminder', params: { content: 'Recuperar lead frio: {{cardTitle}}', hoursFromNow: 4 } },
    ],
  },
  {
    key: 'high_value_set_priority',
    name: 'Marcar high-value (valor > R$ 5.000)',
    description: 'Card criado com valor > R$5k ganha label e probabilidade base 60%',
    trigger: { type: 'card_created' },
    conditions: [
      { type: 'value_above', params: { cents: 500000 } },
    ],
    actions: [
      { type: 'add_label', params: { label: 'high-value' } },
      { type: 'set_probability', params: { value: 60 } },
    ],
  },
  {
    key: 'won_thank_you',
    name: 'Agradecer quando ganhar',
    description: 'Card movido pra "Ganho" → manda mensagem de agradecimento + lembrete pós-venda',
    trigger: { type: 'card_moved' },
    conditions: [
      { type: 'column_is', params: { columnName: 'Ganho' } },
    ],
    actions: [
      { type: 'send_whatsapp', params: { text: '🎉 Obrigado pela confiança, {{firstName}}! Em breve você recebe os próximos passos.' } },
      { type: 'create_reminder', params: { content: 'Pós-venda: {{name}} (NPS / upsell)', hoursFromNow: 168 } },
    ],
  },
];
