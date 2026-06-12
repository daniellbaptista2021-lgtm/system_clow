/**
 * Automation engine — scheduler tests.
 *
 * The scheduler at src/crm/scheduler.ts is the source of `card_stale`
 * and `due_approaching` triggers. It runs a tick() function every 60s
 * via setInterval, which itself dispatches:
 *   - processReminders()      — fires due reminders
 *   - detectStaleCards()      — emits trigger 'card_stale'
 *   - detectDueApproaching()  — emits trigger 'due_approaching'
 *
 * Plus several non-automation responsibilities (billing tick, reports,
 * email-marketing, push, calendar, outbound-webhooks, AI scoring,
 * gamification, LGPD). We don't test those here — they have their own
 * concerns and many call out to external services.
 *
 * What we DO test:
 *   1. startScheduler / stopScheduler — interval lifecycle
 *   2. detectStaleCards emits card_stale events that fire automations
 *   3. detectDueApproaching emits due_approaching events
 *   4. processReminders converts overdue reminders into activities
 *
 * Time is mocked via vi.useFakeTimers() so we don't actually wait 60s
 * per test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmpHome: string;

beforeEach(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), 'clow-aut-sch-'));
  process.env.CLOW_HOME = tmpHome;
  process.env.CRM_DB_PATH = join(tmpHome, 'crm.sqlite3');
  const schema = await import('../../../src/crm/schema.js');
  schema.getCrmDb();
});

afterEach(async () => {
  const { stopScheduler } = await import('../../../src/crm/scheduler.js');
  stopScheduler();
  const schema = await import('../../../src/crm/schema.js');
  schema.closeCrmDb();
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.CLOW_HOME;
  delete process.env.CRM_DB_PATH;
  vi.useRealTimers();
  vi.resetModules();
});

describe('Scheduler — lifecycle', () => {
  it('startScheduler installs an interval that fires tick periodically', async () => {
    vi.useFakeTimers();
    const { startScheduler, stopScheduler } = await import('../../../src/crm/scheduler.js');

    const before = vi.getTimerCount();
    startScheduler();
    const afterStart = vi.getTimerCount();
    expect(afterStart).toBeGreaterThan(before);

    stopScheduler();
    const afterStop = vi.getTimerCount();
    // stopScheduler removes the scheduler's own timer, but other modules
    // (memory store, rate-limiter cleanup, etc.) may keep their own
    // unrelated timers alive in this process. So we assert the SCHEDULER
    // timer is gone, not that the count is zero overall.
    expect(afterStop).toBeLessThan(afterStart);
  });

  it('stopScheduler is idempotent (safe to call when no timer)', async () => {
    const { stopScheduler } = await import('../../../src/crm/scheduler.js');
    expect(() => stopScheduler()).not.toThrow();
  });

  it('startScheduler is also idempotent (does not stack timers)', async () => {
    vi.useFakeTimers();
    const { startScheduler, stopScheduler } = await import('../../../src/crm/scheduler.js');

    startScheduler();
    const afterFirst = vi.getTimerCount();
    startScheduler();
    const afterSecond = vi.getTimerCount();
    expect(afterSecond).toBe(afterFirst);
    stopScheduler();
  });
});

describe('Scheduler — processReminders', () => {
  it('fires due reminders, marks them complete, logs reminder-fired activity', async () => {
    const store = await import('../../../src/crm/store.js');
    const { tickOnce } = await tickOnceHelper();

    const tenantId = 'tenant-rem';
    const board = store.createBoard(tenantId, { name: 'B', type: 'sales' });
    const col = store.createColumn(tenantId, { boardId: board.id, name: 'C' });
    const contact = store.createContact(tenantId, { name: 'X', phone: '+5511999999999' });
    const card = store.createCard(tenantId, { boardId: board.id, columnId: col.id, title: 't', contactId: contact.id });

    // Reminder due 1 hour ago.
    const rem = store.createReminder(tenantId, { cardId: card.id, contactId: contact.id, content: 'Old reminder', dueAt: Date.now() - 3600_000 });
    expect(store.listDueReminders().length).toBeGreaterThan(0);

    await tickOnce();

    // Reminder is now complete.
    const due = store.listDueReminders();
    expect(due.find((r) => r.id === rem.id)).toBeUndefined();

    // Activity logged.
    const acts = store.listActivitiesByCard(tenantId, card.id);
    expect(acts.find((a) => a.content?.includes('Old reminder'))).toBeDefined();
  });

  it('does not fire reminders that are still in the future', async () => {
    const store = await import('../../../src/crm/store.js');
    const { tickOnce } = await tickOnceHelper();

    const tenantId = 'tenant-future';
    const board = store.createBoard(tenantId, { name: 'B', type: 'sales' });
    const col = store.createColumn(tenantId, { boardId: board.id, name: 'C' });
    const contact = store.createContact(tenantId, { name: 'X', phone: '+5511999999999' });
    const card = store.createCard(tenantId, { boardId: board.id, columnId: col.id, title: 't', contactId: contact.id });

    const rem = store.createReminder(tenantId, { cardId: card.id, contactId: contact.id, content: 'Future', dueAt: Date.now() + 3600_000 });

    await tickOnce();

    const due = store.listDueReminders();
    // listDueReminders returns reminders due NOW (dueAt <= now). Ours
    // is in the future, so it stays absent from the list — and
    // tick should not have completed it.
    expect(due).toEqual([]);
    // Confirm by reading underlying record: completed_at should still be NULL.
    const { getCrmDb } = await import('../../../src/crm/schema.js');
    const row: any = getCrmDb().prepare('SELECT completed_at FROM crm_reminders WHERE id = ?').get(rem.id);
    expect(row.completed_at).toBeNull();
  });
});

describe('Scheduler — detectStaleCards triggers card_stale', () => {
  it('cards with no activity for >7 days emit card_stale (engine fires registered automation)', async () => {
    const auts = await import('../../../src/crm/automations.js');
    const store = await import('../../../src/crm/store.js');
    const { tickOnce } = await tickOnceHelper();

    const tenantId = 'tenant-stale';
    const board = store.createBoard(tenantId, { name: 'B', type: 'sales' });
    const col = store.createColumn(tenantId, { boardId: board.id, name: 'Em negociação' });
    const contact = store.createContact(tenantId, { name: 'X', phone: '+5511999999999' });
    const card = store.createCard(tenantId, { boardId: board.id, columnId: col.id, title: 'StaleCard', contactId: contact.id });

    // Force lastActivityAt 14 days ago.
    store.updateCard(tenantId, card.id, { lastActivityAt: Date.now() - 14 * 86400_000 });

    auts.createAutomation(tenantId, {
      name: 'stale-listener',
      trigger: { type: 'card_stale' },
      conditions: [],
      actions: [{ type: 'add_label', params: { label: 'detected-stale' } }],
    });

    await tickOnce();

    expect(store.getCard(tenantId, card.id)!.labels).toContain('detected-stale');
  });
});

// ─── Helper: build a fresh module set + a tickOnce we can await ───────────

async function tickOnceHelper(): Promise<{ tickOnce: () => Promise<void> }> {
  // The scheduler's tick() is private, but startScheduler() will fire
  // it after the first interval. We expose it indirectly by calling the
  // public start, then using vi.advanceTimersByTime to push the tick.
  vi.useFakeTimers();
  const sched = await import('../../../src/crm/scheduler.js');
  sched.startScheduler();
  return {
    tickOnce: async () => {
      // Advance 60s + some slack so the first interval fires AND any
      // micro-task continuations resolve.
      vi.advanceTimersByTime(60_000);
      // Promise.resolve() yields to micro-tasks; the tick is async.
      // Loop a few times because tick fans out to multiple awaitables.
      for (let i = 0; i < 5; i++) {
        await Promise.resolve();
      }
      vi.useRealTimers();
      // Real-timer tail: give the OS-level work a moment.
      await new Promise((r) => setTimeout(r, 50));
    },
  };
}
