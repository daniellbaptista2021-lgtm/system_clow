/**
 * CRM scheduler — internal cron for time-based triggers + reminders.
 *
 * Runs every 60s:
 *   1. Fire reminders whose due_at <= now (mark completed + send WA if contact has phone)
 *   2. Bill due subscriptions (TODO wave 7)
 *   3. Detect stale cards (no activity for N days) → emit('card_stale')
 *   4. Detect approaching due_dates → emit('due_approaching')
 */

import { getCrmDb } from './schema.js';
import * as store from './store.js';
import * as automations from './automations.js';
import { processBillingTick } from './billing.js';

const TICK_INTERVAL_MS = 60_000;
const STALE_DAYS = 7;
const DUE_APPROACHING_HOURS = 24;

let _timer: NodeJS.Timeout | null = null;
let _runningTick = false;

export function startScheduler(): void {
  if (_timer) return;
  _timer = setInterval(() => { void tick(); }, TICK_INTERVAL_MS);
  // Run once shortly after boot (10s) to process any due items
  setTimeout(() => { void tick(); }, 10_000);
  console.log(`[CRM] Scheduler started (tick every ${TICK_INTERVAL_MS / 1000}s)`);
}

export function stopScheduler(): void {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

async function tick(): Promise<void> {
  if (_runningTick) return;
  _runningTick = true;
  try {
    await Promise.allSettled([
      processReminders(),
      detectStaleCards(),
      detectDueApproaching(),
      processBillingTick(),
    ]);
  } catch (e: any) {
    console.warn('[CRM scheduler] tick error:', e.message);
  } finally {
    _runningTick = false;
  }
}

// ─── 1. Reminders ───────────────────────────────────────────────────────
async function processReminders(): Promise<void> {
  const due = store.listDueReminders();
  for (const r of due) {
    try {
      // Mark as completed first (avoid double-fire if anything else takes long)
      store.completeReminder(r.tenantId, r.id);

      // Log activity
      store.logActivity(r.tenantId, {
        cardId: r.cardId, contactId: r.contactId,
        type: 'system', channel: 'manual',
        content: `⏰ Lembrete: ${r.content}`,
      });

      // If contact has a phone + active channel, notify them via WA (best effort)
      if (r.contactId) {
        const contact = store.getContact(r.tenantId, r.contactId);
        const channels = store.listChannels(r.tenantId).filter(c => c.status === 'active');
        if (contact?.phone && channels[0]) {
          // Notify the AGENT (not the customer) — for now log. Wave 8 will add
          // agent assignment + DM-the-agent logic.
        }
      }
    } catch (err: any) {
      console.warn(`[CRM reminder] ${r.id} failed: ${err.message}`);
    }
  }
}

// ─── 2. Stale cards ────────────────────────────────────────────────────
async function detectStaleCards(): Promise<void> {
  const db = getCrmDb();
  const cutoff = Date.now() - STALE_DAYS * 86400_000;
  // We want each card to fire only once per "stale period" — track via labels:
  // skip cards already labeled "frio" (set by the matching automation template)
  const rows = db.prepare(`
    SELECT c.* FROM crm_cards c
    JOIN crm_columns col ON col.id = c.column_id
    WHERE col.is_terminal = 0
      AND COALESCE(c.last_activity_at, c.updated_at) < ?
      AND c.labels_json NOT LIKE '%frio%'
    LIMIT 200
  `).all(cutoff) as any[];

  for (const r of rows) {
    void automations.emit({
      trigger: 'card_stale',
      tenantId: r.tenant_id,
      cardId: r.id,
      contactId: r.contact_id,
    });
  }
}

// ─── 3. Due dates approaching ──────────────────────────────────────────
async function detectDueApproaching(): Promise<void> {
  const db = getCrmDb();
  const now = Date.now();
  const window = now + DUE_APPROACHING_HOURS * 3600_000;
  const rows = db.prepare(`
    SELECT c.* FROM crm_cards c
    JOIN crm_columns col ON col.id = c.column_id
    WHERE col.is_terminal = 0
      AND c.due_date IS NOT NULL
      AND c.due_date >= ?
      AND c.due_date <= ?
    LIMIT 200
  `).all(now, window) as any[];

  for (const r of rows) {
    void automations.emit({
      trigger: 'due_approaching',
      tenantId: r.tenant_id,
      cardId: r.id,
      contactId: r.contact_id,
    });
  }
}
