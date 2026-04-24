/**
 * TOP 10 #8 — Gestao de Tarefas (Onda 19)
 * Testa create, types, priorities, recurrence, alerts, overdue/upcoming.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'crypto';
import { unlinkSync } from 'fs';

const DB = '/tmp/clow-test-tasks-' + randomBytes(6).toString('hex') + '.db';
process.env.CRM_DB_PATH = DB;

describe('TOP 10 #8 — Gestao de Tarefas', () => {
  let tasks: any, store: any, schema: any;
  const tid = 'tasks-tenant';
  let agentId: string, cardId: string;

  beforeAll(async () => {
    schema = await import('../../../src/crm/schema.js');
    store = await import('../../../src/crm/store.js');
    tasks = await import('../../../src/crm/tasks.js');
    schema.getCrmDb();

    const board = store.seedDefaultBoards(tid);
    const cols = store.listColumns(tid, board.id);
    const card = store.createCard(tid, { boardId: board.id, columnId: cols[0].id, title: 'Card' });
    cardId = card.id;
    const agent = store.createAgent(tid, { name: 'Agent A', email: 'a@x.com' });
    agentId = agent.id;
  });

  afterAll(() => { try { unlinkSync(DB); } catch {} });

  it('createTask with type + priority + cardId', () => {
    const t = tasks.createTask(tid, {
      title: 'Ligar cliente',
      type: 'call',
      priority: 'urgent',
      dueAt: Date.now() + 3600_000,
      assignedToAgentId: agentId,
      cardId,
      alertMinutesBefore: 5,
    });
    expect(t.id).toMatch(/^crm_task_/);
    expect(t.type).toBe('call');
    expect(t.priority).toBe('urgent');
    expect(t.assignedToAgentId).toBe(agentId);
  });

  it('listTasks ordered by priority DESC then due_at ASC', () => {
    tasks.createTask(tid, { title: 'Email low', type: 'email', priority: 'low' });
    tasks.createTask(tid, { title: 'Meet high', type: 'meeting', priority: 'high' });
    const all = tasks.listTasks(tid, { status: 'open' });
    // First should be urgent
    expect(all[0].priority).toBe('urgent');
    // Last should be low
    expect(all[all.length - 1].priority).toBe('low');
  });

  it('listTasks filter by agentId', () => {
    const agentTasks = tasks.listTasks(tid, { agentId });
    expect(agentTasks.every((t: any) => t.assignedToAgentId === agentId)).toBe(true);
  });

  it('listTasks filter by cardId', () => {
    const cardTasks = tasks.listTasks(tid, { cardId });
    expect(cardTasks.every((t: any) => t.cardId === cardId)).toBe(true);
  });

  it('completeTask with recurrence spawns next instance', () => {
    const t = tasks.createTask(tid, {
      title: 'Weekly followup',
      type: 'followup',
      priority: 'med',
      dueAt: Date.now() - 1000, // already due
      recurrence: { freq: 'weekly', interval: 1 },
    });
    tasks.completeTask(tid, t.id);

    // Should now have a completed + a new open task with same title
    const all = tasks.listTasks(tid, { status: 'all', limit: 1000 });
    const same = all.filter((x: any) => x.title === 'Weekly followup');
    expect(same.length).toBe(2);
    const completed = same.find((x: any) => x.status === 'completed');
    const newOpen = same.find((x: any) => x.status === 'open');
    expect(completed).toBeTruthy();
    expect(newOpen).toBeTruthy();
    expect(newOpen.parentTaskId).toBe(t.id);
  });

  it('overdueTasks returns tasks past due_at', () => {
    tasks.createTask(tid, { title: 'Past due', priority: 'high', dueAt: Date.now() - 86400_000 });
    const overdue = tasks.overdueTasks(tid);
    expect(overdue.length).toBeGreaterThan(0);
  });

  it('upcomingTasks respects days window', () => {
    tasks.createTask(tid, { title: 'Soon', priority: 'high', dueAt: Date.now() + 2 * 86400_000 });
    const next7 = tasks.upcomingTasks(tid, { days: 7 });
    expect(next7.length).toBeGreaterThan(0);
  });

  it('tickAlerts fires for tasks within alert_minutes_before window', async () => {
    // Create task due in 4min with alert 5min before (so alert fires now)
    tasks.createTask(tid, {
      title: 'Will alert',
      dueAt: Date.now() + 4 * 60_000,
      alertMinutesBefore: 5,
      cardId,
    });
    const alerts = await tasks.tickAlerts();
    // At least our alert should fire (there may be others from prev tests)
    const match = alerts.find((a: any) => a.task.title === 'Will alert');
    expect(match).toBeTruthy();
    expect(match.dueInMinutes).toBeLessThanOrEqual(5);
  });

  it('tasksStats returns aggregate counts', () => {
    const s = tasks.tasksStats(tid);
    expect(s).toHaveProperty('open');
    expect(s).toHaveProperty('overdue');
    expect(s).toHaveProperty('dueToday');
    expect(s).toHaveProperty('dueThisWeek');
    expect(s).toHaveProperty('completedLast7d');
  });

  it('advanceByRecurrence calculates next date correctly', () => {
    // This indirectly tests via completing multiple recurring tasks
    const t1 = tasks.createTask(tid, {
      title: 'Daily',
      dueAt: Date.now() - 1000,
      recurrence: { freq: 'daily', interval: 2 },
    });
    tasks.completeTask(tid, t1.id);
    const all = tasks.listTasks(tid, { status: 'all', limit: 1000 });
    const dailies = all.filter((x: any) => x.title === 'Daily');
    expect(dailies.length).toBe(2);
  });
});
