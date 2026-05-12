/**
 * Agent assignment — round-robin auto-assigner + per-agent metrics.
 *
 * Strategies:
 *   round_robin   — circular rotation, persisted via tenant key
 *   load_balanced — agent with fewest open cards wins
 *   manual        — no auto, must be set explicitly
 *
 * Per-tenant strategy via crm_settings (json kv table — created here lazily).
 */

import { getCrmDb } from './schema.js';
import * as store from './store.js';
import type { Agent, Card, Activity } from './types.js';

// ─── Settings table (lazy) ──────────────────────────────────────────────
function ensureSettingsTable(): void {
  const db = getCrmDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS crm_settings (
      tenant_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, key)
    );
  `);
}

export function getSetting(tenantId: string, key: string, def: any = null): any {
  ensureSettingsTable();
  const db = getCrmDb();
  const r = db.prepare('SELECT value FROM crm_settings WHERE tenant_id = ? AND key = ?').get(tenantId, key) as any;
  if (!r) return def;
  try { return JSON.parse(r.value); } catch { return def; }
}

export function setSetting(tenantId: string, key: string, value: any): void {
  ensureSettingsTable();
  const db = getCrmDb();
  db.prepare(`
    INSERT INTO crm_settings (tenant_id, key, value, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(tenantId, key, JSON.stringify(value), Date.now());
}

// ─── Strategy types ─────────────────────────────────────────────────────
export type AssignmentStrategy = 'round_robin' | 'load_balanced' | 'manual';

export function getStrategy(tenantId: string): AssignmentStrategy {
  return getSetting(tenantId, 'assignment_strategy', 'manual');
}
export function setStrategy(tenantId: string, strategy: AssignmentStrategy): void {
  setSetting(tenantId, 'assignment_strategy', strategy);
}

// ─── Picker ─────────────────────────────────────────────────────────────
export function pickAgentForNewCard(tenantId: string): Agent | null {
  const strategy = getStrategy(tenantId);
  if (strategy === 'manual') return null;
  const agents = store.listAgents(tenantId).filter(a => a.active && a.role !== 'viewer');
  if (!agents.length) return null;

  if (strategy === 'round_robin') {
    const lastIdx = getSetting(tenantId, 'assignment_rr_idx', -1);
    const next = (lastIdx + 1) % agents.length;
    setSetting(tenantId, 'assignment_rr_idx', next);
    return agents[next];
  }

  if (strategy === 'load_balanced') {
    const counts = countOpenCardsByAgent(tenantId, agents);
    let min = Infinity, picked: Agent | null = null;
    for (const a of agents) {
      const n = counts[a.id] || 0;
      if (n < min) { min = n; picked = a; }
    }
    return picked;
  }
  return null;
}

function countOpenCardsByAgent(tenantId: string, agents: Agent[]): Record<string, number> {
  const db = getCrmDb();
  const out: Record<string, number> = {};
  for (const a of agents) {
    const r = db.prepare(`
      SELECT COUNT(*) as n FROM crm_cards c
      JOIN crm_columns col ON col.id = c.column_id
      WHERE c.tenant_id = ? AND c.owner_agent_id = ? AND col.is_terminal = 0
    `).get(tenantId, a.id) as any;
    out[a.id] = r?.n || 0;
  }
  return out;
}

// ─── Hook: assign on createCard ─────────────────────────────────────────
/**
 * Called from store.createCard after the card is created (without owner).
 * Returns true if assignment happened.
 */
export function maybeAutoAssign(tenantId: string, cardId: string): boolean {
  const card = store.getCard(tenantId, cardId);
  if (!card || card.ownerAgentId) return false;
  const agent = pickAgentForNewCard(tenantId);
  if (!agent) return false;
  store.updateCard(tenantId, cardId, { ownerAgentId: agent.id });
  store.logActivity(tenantId, {
    cardId, contactId: card.contactId,
    type: 'assignment', channel: 'ai',
    content: `🤝 Atribuído automaticamente para ${agent.name} (${getStrategy(tenantId)})`,
    metadata: { agentId: agent.id },
  });
  return true;
}

// ─── Per-agent metrics ──────────────────────────────────────────────────
export interface AgentMetrics {
  agentId: string;
  name: string;
  email: string;
  openCards: number;
  wonCards: number;
  lostCards: number;
  totalValueOpenCents: number;
  totalValueWonCents: number;
  weightedForecastCents: number;
  activitiesLast7d: number;
  averageResponseMinutes: number | null;
}

export function getAgentMetrics(tenantId: string, agentId: string): AgentMetrics | null {
  const agent = store.getAgent(tenantId, agentId);
  if (!agent) return null;
  const db = getCrmDb();

  // Cards by status
  const cards = db.prepare(`
    SELECT c.*, col.name AS col_name, col.is_terminal FROM crm_cards c
    JOIN crm_columns col ON col.id = c.column_id
    WHERE c.tenant_id = ? AND c.owner_agent_id = ?
  `).all(tenantId, agentId) as any[];

  let openCards = 0, wonCards = 0, lostCards = 0;
  let totalValueOpen = 0, totalValueWon = 0, weightedForecast = 0;
  for (const c of cards) {
    if (c.is_terminal === 1) {
      if (c.col_name.toLowerCase().includes('ganho') || c.col_name.toLowerCase().includes('won')) {
        wonCards++; totalValueWon += c.value_cents;
      } else { lostCards++; }
    } else {
      openCards++; totalValueOpen += c.value_cents;
      weightedForecast += c.value_cents * c.probability / 100;
    }
  }

  // Activities last 7 days created BY this agent (sent messages, notes, etc)
  const since = Date.now() - 7 * 86400_000;
  const actCount = db.prepare(`
    SELECT COUNT(*) as n FROM crm_activities
    WHERE tenant_id = ? AND created_by_agent_id = ? AND created_at >= ?
  `).get(tenantId, agentId, since) as any;

  // Average response time: time between message_in and next message_out by this agent
  // (per card; takes median of last 30 pairings)
  const pairs = db.prepare(`
    SELECT a1.created_at AS in_at, MIN(a2.created_at) AS out_at
    FROM crm_activities a1
    JOIN crm_activities a2 ON a2.card_id = a1.card_id
      AND a2.created_at > a1.created_at AND a2.type = 'message_out'
      AND a2.created_by_agent_id = ?
    WHERE a1.tenant_id = ? AND a1.type = 'message_in' AND a1.created_at >= ?
    GROUP BY a1.id
    LIMIT 30
  `).all(agentId, tenantId, since) as any[];
  const responseTimes = pairs.map((p: any) => (p.out_at - p.in_at) / 60_000).filter((m: number) => m > 0 && m < 1440);
  const avg = responseTimes.length
    ? responseTimes.reduce((a: number, b: number) => a + b, 0) / responseTimes.length
    : null;

  return {
    agentId: agent.id, name: agent.name, email: agent.email,
    openCards, wonCards, lostCards,
    totalValueOpenCents: totalValueOpen,
    totalValueWonCents: totalValueWon,
    weightedForecastCents: Math.round(weightedForecast),
    activitiesLast7d: actCount?.n || 0,
    averageResponseMinutes: avg ? Math.round(avg) : null,
  };
}

export function getAllAgentMetrics(tenantId: string): AgentMetrics[] {
  return store.listAgents(tenantId)
    .filter(a => a.active)
    .map(a => getAgentMetrics(tenantId, a.id))
    .filter((m): m is AgentMetrics => m !== null);
}
