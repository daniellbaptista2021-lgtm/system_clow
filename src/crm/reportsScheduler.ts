/**
 * Scheduled reports runner.
 *
 * Every tick (60s) check for schedules due. A schedule has a `next_run_at`
 * (epoch ms). When <= now: run the report, email it as PDF, advance
 * next_run_at by the interval.
 *
 * Hooked into crm/scheduler.ts tick().
 */

import { getCrmDb } from './schema.js';
import * as reports from './reports.js';
import { toPDF, toCSV, type ReportKind } from './reportsExport.js';
import { sendEmail } from '../notifications/mailer.js';

export type SchedInterval = 'daily' | 'weekly' | 'monthly';

interface SchedRow {
  id: string;
  tenant_id: string;
  name: string;
  kind: ReportKind;
  interval: SchedInterval;
  format: 'pdf' | 'csv';
  email_to: string;
  board_id: string | null;
  next_run_at: number;
  last_run_at: number | null;
  enabled: number;
  created_at: number;
}

function advanceNextRun(from: number, interval: SchedInterval): number {
  const d = new Date(from);
  if (interval === 'daily')   d.setUTCDate(d.getUTCDate() + 1);
  if (interval === 'weekly')  d.setUTCDate(d.getUTCDate() + 7);
  if (interval === 'monthly') d.setUTCMonth(d.getUTCMonth() + 1);
  return d.getTime();
}

export async function tick(): Promise<void> {
  const db = getCrmDb();
  const now = Date.now();
  const due = db.prepare(
    'SELECT * FROM crm_scheduled_reports WHERE enabled = 1 AND next_run_at <= ?'
  ).all(now) as SchedRow[];

  for (const sched of due) {
    try {
      await runOne(sched);
      db.prepare(
        'UPDATE crm_scheduled_reports SET last_run_at = ?, next_run_at = ? WHERE id = ?'
      ).run(now, advanceNextRun(now, sched.interval), sched.id);
    } catch (err: any) {
      console.warn('[reports-scheduler]', sched.id, err?.message || err);
      // Still advance to avoid tight-loop on broken schedules
      db.prepare(
        'UPDATE crm_scheduled_reports SET next_run_at = ? WHERE id = ?'
      ).run(advanceNextRun(now, sched.interval), sched.id);
    }
  }
}

async function runOne(sched: SchedRow): Promise<void> {
  const win = rangeForInterval(sched.interval);
  const rows = await gatherRows(sched, win);
  const title = `${prettyKind(sched.kind)} — ${sched.name}`;
  const subtitle = `Período: ${fmtDate(win.from)} a ${fmtDate(win.to)}`;

  if (sched.format === 'pdf') {
    const pdf = await toPDF(sched.kind, rows, { title, subtitle });
    await sendEmail({
      to: sched.email_to,
      subject: `[Clow CRM] ${title}`,
      html: `<p>Relatório ${sched.kind} anexo.</p><p>${subtitle}</p><p>Total de registros: ${rows.length}</p>`,
      attachments: [{ filename: `${sched.kind}-${fmtDate(win.to)}.pdf`, content: pdf }],
    });
  } else {
    const csv = toCSV(sched.kind, rows);
    await sendEmail({
      to: sched.email_to,
      subject: `[Clow CRM] ${title}`,
      html: `<p>Relatório ${sched.kind} anexo (CSV).</p><p>${subtitle}</p>`,
      attachments: [{ filename: `${sched.kind}-${fmtDate(win.to)}.csv`, content: Buffer.from(csv, 'utf-8') }],
    });
  }
}

async function gatherRows(sched: SchedRow, win: { from: number; to: number }): Promise<any[]> {
  switch (sched.kind) {
    case 'sales':        return reports.salesByPeriod(sched.tenant_id, { ...win, bucket: sched.interval === 'monthly' ? 'month' : sched.interval === 'weekly' ? 'week' : 'day', boardId: sched.board_id ?? undefined });
    case 'agents':       return reports.activitiesByAgent(sched.tenant_id, win);
    case 'sources':      return reports.leadSources(sched.tenant_id, win);
    case 'lost-reasons': return reports.lostReasons(sched.tenant_id, sched.board_id ?? undefined, win);
  }
}

function rangeForInterval(interval: SchedInterval): { from: number; to: number } {
  const to = Date.now();
  const d = new Date(to);
  if (interval === 'daily')   d.setUTCDate(d.getUTCDate() - 1);
  if (interval === 'weekly')  d.setUTCDate(d.getUTCDate() - 7);
  if (interval === 'monthly') d.setUTCMonth(d.getUTCMonth() - 1);
  return { from: d.getTime(), to };
}

function prettyKind(k: ReportKind): string {
  return k === 'sales' ? 'Vendas'
    : k === 'agents' ? 'Atividades por agente'
    : k === 'sources' ? 'Origem de leads'
    : 'Razões de perda';
}

function fmtDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}
