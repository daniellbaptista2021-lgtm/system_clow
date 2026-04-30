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
import { rotateMonthlyAllTenants } from '../billing/quotaGuard.js';
import * as reportsScheduler from './reportsScheduler.js';
import * as emailMarketing from './emailMarketing.js';
import * as tasks from './tasks.js';
import * as cal from './calendar.js';
import * as outboundWebhooks from './outboundWebhooks.js';
import * as push from './push.js';
import * as ai from './ai.js';
import * as gam from './gamification.js';
import * as lgpd from './lgpd.js';
import { logger } from '../utils/logger.js';

const TICK_INTERVAL_MS = 60_000;
const INACTIVITY_TICK_INTERVAL_MS = 30_000; // PR 4 Onda 62
const COLUMN_TIMER_TICK_INTERVAL_MS = 60_000; // PR 7.0
const STALE_DAYS = 7;
const DUE_APPROACHING_HOURS = 24;

let _timer: NodeJS.Timeout | null = null;
let _inactivityTimer: NodeJS.Timeout | null = null;
let _columnTimerTimer: NodeJS.Timeout | null = null;
let _runningInactivityTick = false;
let _runningColumnTimerTick = false;
let _runningTick = false;

/**
 * Returns true on the worker that should run cluster-wide cron jobs
 * (reminders, stale detection, billing tick, monthly quota rotation,
 * etc.). Without this gate, every PM2 cluster worker would tick the
 * scheduler in parallel — reminders would fire N×, quotas would rotate
 * N×, etc.
 *
 * Conventions:
 *   - PM2 cluster mode sets NODE_APP_INSTANCE = '0' on the first worker
 *     and '1', '2', … on subsequent ones. Worker 0 owns scheduling.
 *   - In fork mode (or in tests / dev where NODE_APP_INSTANCE is
 *     unset), the variable is undefined and we treat that as "primary"
 *     so cron still runs.
 *   - Set CLOW_FORCE_SCHEDULER=1 to override (useful for testing
 *     scheduler logic on non-zero workers).
 */
export function isSchedulerWorker(): boolean {
  if (process.env.CLOW_FORCE_SCHEDULER === '1') return true;
  const instance = process.env.NODE_APP_INSTANCE;
  return instance === undefined || instance === '0';
}

export function startScheduler(): void {
  if (_timer) return;
  if (!isSchedulerWorker()) {
    logger.info(`[CRM] Scheduler skipped on worker ${process.env.NODE_APP_INSTANCE} (cluster mode — only worker 0 schedules)`);
    return;
  }
  _timer = setInterval(() => { void tick(); }, TICK_INTERVAL_MS);
  // Run once shortly after boot (10s) to process any due items
  setTimeout(() => { void tick(); }, 10_000);

  // Onda 62 PR 4: sub-tick de inatividade (30s) — varre cards com timer
  // vencido e dispara agente de coluna pra agir (cobrar/morno/frio/perdido).
  _inactivityTimer = setInterval(() => { void inactivityTick(); }, INACTIVITY_TICK_INTERVAL_MS);
  setTimeout(() => { void inactivityTick(); }, 15_000);

  // PR 7.0: column timer scheduler (entry_delay / chase / followup)
  _columnTimerTimer = setInterval(() => { void columnTimerTick(); }, COLUMN_TIMER_TICK_INTERVAL_MS);
  setTimeout(() => { void columnTimerTick(); }, 20_000);

  logger.info(
    `[CRM] Scheduler started (main tick ${TICK_INTERVAL_MS / 1000}s, inactivity tick ${INACTIVITY_TICK_INTERVAL_MS / 1000}s, ` +
    `column-timer tick ${COLUMN_TIMER_TICK_INTERVAL_MS / 1000}s, ` +
    `worker ${process.env.NODE_APP_INSTANCE ?? 'fork'})`,
  );
}

export function stopScheduler(): void {
  if (_timer) { clearInterval(_timer); _timer = null; }
  if (_inactivityTimer) { clearInterval(_inactivityTimer); _inactivityTimer = null; }
  if (_columnTimerTimer) { clearInterval(_columnTimerTimer); _columnTimerTimer = null; }
}

async function columnTimerTick(): Promise<void> {
  if (_runningColumnTimerTick) return;
  _runningColumnTimerTick = true;
  try {
    const { tickColumnTimers } = await import('./agents/columnTimerScheduler.js');
    await tickColumnTimers();
  } catch (err: any) {
    logger.warn('[column-timer-tick] err:', err?.message);
  } finally {
    _runningColumnTimerTick = false;
  }
}

async function inactivityTick(): Promise<void> {
  if (_runningInactivityTick) return; // skip se anterior ainda nao acabou
  _runningInactivityTick = true;
  try {
    const { tickInactivity } = await import('./agents/inactivityScheduler.js');
    await tickInactivity();
  } catch (err: any) {
    logger.warn('[inactivity-tick] err:', err?.message);
  } finally {
    _runningInactivityTick = false;
  }
}



/** Retenção de logs internos (audit + automation runs) — mantém últimos N dias. */
const AUTOMATION_LOGS_RETENTION_DAYS = Number(process.env.CLOW_AUTOMATION_LOGS_RETENTION_DAYS ?? 90);
let _lastLogsCleanupDay = -1;
function maybeCleanupAutomationLogs() {
  try {
    const now = new Date();
    const dayKey = now.getUTCFullYear() * 1000 + (now.getUTCMonth() + 1) * 32 + now.getUTCDate();
    if (_lastLogsCleanupDay === dayKey) return;
    _lastLogsCleanupDay = dayKey;
    const cutoff = Date.now() - AUTOMATION_LOGS_RETENTION_DAYS * 86400_000;
    const r = getCrmDb().prepare('DELETE FROM crm_automation_logs WHERE fired_at < ?').run(cutoff);
    if (r.changes > 0) {
      logger.info(`[scheduler] cleaned ${r.changes} crm_automation_logs older than ${AUTOMATION_LOGS_RETENTION_DAYS}d`);
    }
  } catch (err: any) {
    logger.warn('[scheduler logs cleanup] err:', err.message);
  }
}

/** Track last rotation day to avoid running twice per day. */
let _lastRotationDay = -1;
function maybeRotateMonthly() {
  try {
    const now = new Date();
    const day = now.getUTCDate();
    // Only on day 1 of month, and not already done today
    if (day !== 1) return;
    const key = now.getUTCFullYear() * 100 + now.getUTCMonth();
    if (_lastRotationDay === key) return;
    _lastRotationDay = key;
    rotateMonthlyAllTenants();
  } catch (err: any) {
    logger.warn('[scheduler monthly rotate] err:', err.message);
  }
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
      reportsScheduler.tick(),
      (async () => {
        try {
          emailMarketing.promoteScheduledCampaigns();
          await emailMarketing.tick(process.env.PUBLIC_BASE_URL || '');
          await emailMarketing.tickSequences(process.env.PUBLIC_BASE_URL || '');
          {
            const alerts = await tasks.tickAlerts();
            for (const alert of alerts) {
              if (alert.task.assignedToAgentId) {
                try {
                  await push.sendToAgent(alert.task.tenantId, alert.task.assignedToAgentId, {
                    title: 'Tarefa vencendo',
                    body: `${alert.task.title} — vence em ${alert.dueInMinutes} min`,
                    url: '/crm/?card=' + (alert.task.cardId || ''),
                  });
                } catch (err: any) { /* non-blocking */ }
              }
            }
          }
          await cal.tickReminders();
          await outboundWebhooks.tickRetries();
          // AI: keep top 5 cards freshly scored (rotates through pipeline)
          await ai.tickAutoScore(5).catch(() => { /* non-blocking */ });
          try { gam.tickDailyBadges(); } catch { /* non-blocking */ }
          try {
            lgpd.processRetentionPolicies();
            lgpd.processScheduledDeletions();
          } catch { /* non-blocking */ }
        } catch (err: any) { logger.warn('[email-marketing tick]', err?.message); }
      })(),
    ]);
    maybeRotateMonthly();
    maybeCleanupAutomationLogs();
  } catch (e: any) {
    logger.warn('[CRM scheduler] tick error:', e.message);
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
      logger.warn(`[CRM reminder] ${r.id} failed: ${err.message}`);
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
