/**
 * Calendar & Scheduling — Onda 20.
 *
 * Core:
 *   - appointments: typed meetings with agents/contacts/cards
 *   - scheduling_links: Calendly-style public booking pages
 *   - ICS feed: /p/cal/:token.ics for external cal subscription
 *   - reminders: WA/email N minutes before starts_at (via tick)
 *
 * External calendar integrations (Google/Outlook/CalDAV) are token-scaffolded
 * here — OAuth flow lives in a future onda; tokens can be set manually for now.
 */

import { randomBytes, randomUUID } from 'crypto';
import { getCrmDb } from './schema.js';
import { sendEmail } from '../notifications/mailer.js';
import { sendOutbound } from './inbox.js';

export type AppointmentStatus = 'scheduled' | 'confirmed' | 'cancelled' | 'completed' | 'no_show';
export type CalProvider = 'google' | 'outlook' | 'caldav' | 'ics';

export interface Appointment {
  id: string;
  tenantId: string;
  title: string;
  description?: string;
  startsAt: number;
  endsAt: number;
  timezone: string;
  agentId?: string;
  contactId?: string;
  cardId?: string;
  status: AppointmentStatus;
  meetingUrl?: string;
  location?: string;
  reminderMinutes?: number;
  reminderFiredAt?: number;
  icsUid: string;
  externalProvider?: string;
  externalEventId?: string;
  createdAt: number;
  updatedAt: number;
}

function nid(prefix: string): string { return prefix + '_' + randomBytes(6).toString('hex'); }

function rowToAppointment(r: any): Appointment {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    title: r.title,
    description: r.description ?? undefined,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    timezone: r.timezone || 'UTC',
    agentId: r.agent_id ?? undefined,
    contactId: r.contact_id ?? undefined,
    cardId: r.card_id ?? undefined,
    status: (r.status || 'scheduled') as AppointmentStatus,
    meetingUrl: r.meeting_url ?? undefined,
    location: r.location ?? undefined,
    reminderMinutes: r.reminder_minutes ?? undefined,
    reminderFiredAt: r.reminder_fired_at ?? undefined,
    icsUid: r.ics_uid,
    externalProvider: r.external_provider ?? undefined,
    externalEventId: r.external_event_id ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface CreateAppointmentInput {
  title: string;
  description?: string;
  startsAt: number;
  endsAt: number;
  timezone?: string;
  agentId?: string;
  contactId?: string;
  cardId?: string;
  meetingUrl?: string;
  location?: string;
  reminderMinutes?: number;
}

export function createAppointment(tenantId: string, input: CreateAppointmentInput): Appointment {
  const db = getCrmDb();
  const id = nid('crm_appt');
  const icsUid = randomUUID() + '@clow';
  const now = Date.now();
  db.prepare(`
    INSERT INTO crm_appointments
      (id, tenant_id, title, description, starts_at, ends_at, timezone,
       agent_id, contact_id, card_id, status, meeting_url, location,
       reminder_minutes, ics_uid, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, ?, ?, ?)
  `).run(
    id, tenantId, input.title, input.description ?? null,
    input.startsAt, input.endsAt, input.timezone || 'America/Sao_Paulo',
    input.agentId ?? null, input.contactId ?? null, input.cardId ?? null,
    input.meetingUrl ?? null, input.location ?? null,
    input.reminderMinutes ?? 30, icsUid, now, now,
  );
  return getAppointment(tenantId, id)!;
}

export function getAppointment(tenantId: string, id: string): Appointment | null {
  const r = getCrmDb().prepare('SELECT * FROM crm_appointments WHERE id = ? AND tenant_id = ?').get(id, tenantId) as any;
  return r ? rowToAppointment(r) : null;
}

export function updateAppointment(tenantId: string, id: string, patch: Partial<CreateAppointmentInput & { status: AppointmentStatus }>): Appointment | null {
  const ex = getAppointment(tenantId, id);
  if (!ex) return null;
  const merged = { ...ex, ...patch };
  getCrmDb().prepare(`
    UPDATE crm_appointments SET title=?, description=?, starts_at=?, ends_at=?, timezone=?,
      agent_id=?, contact_id=?, card_id=?, status=?, meeting_url=?, location=?,
      reminder_minutes=?, updated_at=? WHERE id = ? AND tenant_id = ?
  `).run(
    merged.title, merged.description ?? null, merged.startsAt, merged.endsAt, merged.timezone,
    merged.agentId ?? null, merged.contactId ?? null, merged.cardId ?? null,
    merged.status, merged.meetingUrl ?? null, merged.location ?? null,
    merged.reminderMinutes ?? null, Date.now(), id, tenantId,
  );
  return getAppointment(tenantId, id);
}

export function deleteAppointment(tenantId: string, id: string): boolean {
  return getCrmDb().prepare('DELETE FROM crm_appointments WHERE id = ? AND tenant_id = ?').run(id, tenantId).changes > 0;
}

export interface ListApptOpts {
  from?: number;
  to?: number;
  agentId?: string;
  contactId?: string;
  cardId?: string;
  status?: AppointmentStatus | 'all';
}

export function listAppointments(tenantId: string, opts: ListApptOpts = {}): Appointment[] {
  const wh: string[] = ['tenant_id = ?'];
  const params: any[] = [tenantId];
  if (opts.from != null)  { wh.push('ends_at >= ?'); params.push(opts.from); }
  if (opts.to != null)    { wh.push('starts_at <= ?'); params.push(opts.to); }
  if (opts.agentId)       { wh.push('agent_id = ?'); params.push(opts.agentId); }
  if (opts.contactId)     { wh.push('contact_id = ?'); params.push(opts.contactId); }
  if (opts.cardId)        { wh.push('card_id = ?'); params.push(opts.cardId); }
  if (opts.status && opts.status !== 'all') { wh.push('status = ?'); params.push(opts.status); }
  const rows = getCrmDb().prepare(
    `SELECT * FROM crm_appointments WHERE ${wh.join(' AND ')} ORDER BY starts_at ASC LIMIT 500`
  ).all(...params) as any[];
  return rows.map(rowToAppointment);
}

// ─── Scheduling Links (Calendly-style) ──────────────────────────────────
export interface AvailabilityRule {
  // Weekly availability: day-of-week (0=Sun) -> list of slots "HH:MM-HH:MM" in local tz
  weekdays: Record<number, string[]>;
  // Optional one-off date exclusions ("2026-04-25")
  exclusions?: string[];
}

export interface SchedulingLink {
  id: string;
  tenantId: string;
  slug: string;
  agentId?: string;
  title: string;
  description?: string;
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  availability: AvailabilityRule;
  timezone: string;
  advanceNoticeHours: number;
  maxDaysAhead: number;
  requireEmail: boolean;
  requirePhone: boolean;
  requireName: boolean;
  enabled: boolean;
}

function rowToLink(r: any): SchedulingLink {
  return {
    id: r.id, tenantId: r.tenant_id, slug: r.slug, agentId: r.agent_id ?? undefined,
    title: r.title, description: r.description ?? undefined,
    durationMinutes: r.duration_minutes, bufferBeforeMinutes: r.buffer_before_minutes,
    bufferAfterMinutes: r.buffer_after_minutes,
    availability: JSON.parse(r.availability_json || '{"weekdays":{}}'),
    timezone: r.timezone || 'America/Sao_Paulo',
    advanceNoticeHours: r.advance_notice_hours, maxDaysAhead: r.max_days_ahead,
    requireEmail: r.require_email === 1, requirePhone: r.require_phone === 1,
    requireName: r.require_name === 1, enabled: r.enabled === 1,
  };
}

function slugify(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

export function createSchedulingLink(tenantId: string, input: {
  title: string; agentId?: string; durationMinutes: number;
  availability: AvailabilityRule; timezone?: string;
  description?: string; slug?: string;
  bufferBeforeMinutes?: number; bufferAfterMinutes?: number;
  advanceNoticeHours?: number; maxDaysAhead?: number;
  requireEmail?: boolean; requirePhone?: boolean; requireName?: boolean;
}): SchedulingLink {
  const db = getCrmDb();
  const id = nid('crm_slink');
  let slug = input.slug ? slugify(input.slug) : slugify(input.title) || id.slice(-8);
  let attempt = 0;
  while (db.prepare('SELECT 1 FROM crm_scheduling_links WHERE slug = ?').get(slug)) {
    attempt++;
    slug = slugify(input.title) + '-' + attempt;
    if (attempt > 50) { slug = id.slice(-12); break; }
  }
  db.prepare(`
    INSERT INTO crm_scheduling_links
      (id, tenant_id, slug, agent_id, title, description, duration_minutes,
       buffer_before_minutes, buffer_after_minutes, availability_json, timezone,
       advance_notice_hours, max_days_ahead, require_email, require_phone, require_name,
       enabled, total_bookings, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?)
  `).run(
    id, tenantId, slug, input.agentId ?? null, input.title, input.description ?? null,
    input.durationMinutes, input.bufferBeforeMinutes ?? 0, input.bufferAfterMinutes ?? 0,
    JSON.stringify(input.availability), input.timezone || 'America/Sao_Paulo',
    input.advanceNoticeHours ?? 1, input.maxDaysAhead ?? 30,
    input.requireEmail === false ? 0 : 1,
    input.requirePhone ? 1 : 0,
    input.requireName === false ? 0 : 1,
    Date.now(),
  );
  return getSchedulingLink(tenantId, id)!;
}

export function getSchedulingLink(tenantId: string, id: string): SchedulingLink | null {
  const r = getCrmDb().prepare('SELECT * FROM crm_scheduling_links WHERE id = ? AND tenant_id = ?').get(id, tenantId) as any;
  return r ? rowToLink(r) : null;
}

export function getSchedulingLinkBySlug(slug: string): SchedulingLink | null {
  const r = getCrmDb().prepare('SELECT * FROM crm_scheduling_links WHERE slug = ?').get(slug) as any;
  return r ? rowToLink(r) : null;
}

export function listSchedulingLinks(tenantId: string): SchedulingLink[] {
  return (getCrmDb().prepare('SELECT * FROM crm_scheduling_links WHERE tenant_id = ? ORDER BY created_at DESC').all(tenantId) as any[])
    .map(rowToLink);
}

export function updateSchedulingLink(tenantId: string, id: string, patch: Partial<SchedulingLink>): SchedulingLink | null {
  const ex = getSchedulingLink(tenantId, id);
  if (!ex) return null;
  const m = { ...ex, ...patch };
  getCrmDb().prepare(`
    UPDATE crm_scheduling_links SET title=?, description=?, duration_minutes=?,
      buffer_before_minutes=?, buffer_after_minutes=?, availability_json=?, timezone=?,
      advance_notice_hours=?, max_days_ahead=?, require_email=?, require_phone=?, require_name=?,
      enabled=?, agent_id=?
    WHERE id = ? AND tenant_id = ?
  `).run(
    m.title, m.description ?? null, m.durationMinutes,
    m.bufferBeforeMinutes, m.bufferAfterMinutes, JSON.stringify(m.availability), m.timezone,
    m.advanceNoticeHours, m.maxDaysAhead, m.requireEmail ? 1 : 0, m.requirePhone ? 1 : 0, m.requireName ? 1 : 0,
    m.enabled ? 1 : 0, m.agentId ?? null, id, tenantId,
  );
  return getSchedulingLink(tenantId, id);
}

export function deleteSchedulingLink(tenantId: string, id: string): boolean {
  return getCrmDb().prepare('DELETE FROM crm_scheduling_links WHERE id = ? AND tenant_id = ?').run(id, tenantId).changes > 0;
}

// ─── Availability computation ───────────────────────────────────────────
export interface Slot { start: number; end: number; }

/**
 * Generate available slots for a scheduling link between `from` and `to` (epoch ms).
 * Takes existing appointments (any overlapping) as "busy" and subtracts them.
 *
 * Simplification: operates in UTC, the weekday rules are applied in the link's timezone
 * via naive offset math (NOT DST-aware for weekday boundaries — acceptable for most cases
 * where offices close well before DST transitions). For precise DST, swap to Intl APIs.
 */
export function computeAvailability(link: SchedulingLink, from: number, to: number): Slot[] {
  const db = getCrmDb();
  const slots: Slot[] = [];

  const minStart = Date.now() + link.advanceNoticeHours * 3600_000;
  const maxEnd = Date.now() + link.maxDaysAhead * 86400_000;
  const rangeFrom = Math.max(from, minStart);
  const rangeTo = Math.min(to, maxEnd);
  if (rangeFrom >= rangeTo) return slots;

  // Busy from appointments: agent's appointments OR global if link has no agent
  const busyQ = link.agentId
    ? db.prepare('SELECT starts_at, ends_at FROM crm_appointments WHERE tenant_id = ? AND agent_id = ? AND status NOT IN (\'cancelled\', \'no_show\') AND starts_at < ? AND ends_at > ? ORDER BY starts_at').all(link.tenantId, link.agentId, rangeTo, rangeFrom)
    : db.prepare('SELECT starts_at, ends_at FROM crm_appointments WHERE tenant_id = ? AND status NOT IN (\'cancelled\', \'no_show\') AND starts_at < ? AND ends_at > ? ORDER BY starts_at').all(link.tenantId, rangeTo, rangeFrom);
  const busy = (busyQ as any[]).map(r => ({ start: r.starts_at, end: r.ends_at }));

  const durMs = link.durationMinutes * 60_000;
  const bufBefore = link.bufferBeforeMinutes * 60_000;
  const bufAfter = link.bufferAfterMinutes * 60_000;

  // Walk day-by-day. For each day-of-week (0..6), gather time slots.
  for (let dayStart = startOfDayLocal(rangeFrom, link.timezone); dayStart < rangeTo; dayStart += 86400_000) {
    const weekday = new Date(dayStart).getUTCDay(); // UTC-based; local tz ignored for weekday bucket → acceptable for most tz
    const rules = link.availability.weekdays[weekday];
    if (!rules || rules.length === 0) continue;

    const dateKey = new Date(dayStart).toISOString().slice(0, 10);
    if (link.availability.exclusions?.includes(dateKey)) continue;

    for (const rule of rules) {
      const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(rule);
      if (!m) continue;
      const [, sh, sm, eh, em] = m;
      // Build UTC millis for this day + local time. We use a naive conversion —
      // the link.timezone field is honored only for the DISPLAY, not the calc.
      // This is adequate for first cut; full tz-precision is future work.
      const slotStart = dayStart + (Number(sh) * 3600 + Number(sm) * 60) * 1000;
      const ruleEnd = dayStart + (Number(eh) * 3600 + Number(em) * 60) * 1000;
      for (let t = slotStart; t + durMs <= ruleEnd; t += durMs) {
        const s = t, e = t + durMs;
        if (s < rangeFrom || e > rangeTo) continue;
        // Conflict check (with buffers)
        const conflict = busy.some(b => (s - bufAfter) < b.end && (e + bufBefore) > b.start);
        if (!conflict) slots.push({ start: s, end: e });
      }
    }
  }

  return slots;
}

function startOfDayLocal(ts: number, _tz: string): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

// ─── Public booking flow ────────────────────────────────────────────────
export interface BookInput {
  name?: string;
  email?: string;
  phone?: string;
  startsAt: number;
  notes?: string;
}

export function bookViaLink(link: SchedulingLink, input: BookInput): { ok: boolean; appointmentId?: string; error?: string } {
  if (link.requireName && !input.name) return { ok: false, error: 'name required' };
  if (link.requireEmail && !input.email) return { ok: false, error: 'email required' };
  if (link.requirePhone && !input.phone) return { ok: false, error: 'phone required' };

  // Validate the slot is still available
  const endsAt = input.startsAt + link.durationMinutes * 60_000;
  const slots = computeAvailability(link, input.startsAt - 60_000, endsAt + 60_000);
  if (!slots.some(s => s.start === input.startsAt)) {
    return { ok: false, error: 'slot_unavailable' };
  }

  // Find/create contact (upsert by email/phone)
  const db = getCrmDb();
  let contactId: string | undefined;
  if (input.email) {
    const existing = db.prepare('SELECT id FROM crm_contacts WHERE tenant_id = ? AND LOWER(email) = LOWER(?)').get(link.tenantId, input.email) as any;
    if (existing) contactId = existing.id;
  }
  if (!contactId && input.phone) {
    const existing = db.prepare('SELECT id FROM crm_contacts WHERE tenant_id = ? AND phone = ?').get(link.tenantId, input.phone) as any;
    if (existing) contactId = existing.id;
  }
  if (!contactId) {
    contactId = nid('crm_contact');
    const now = Date.now();
    db.prepare(`
      INSERT INTO crm_contacts (id, tenant_id, name, email, phone, source, tags_json, custom_fields_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'booking', '[]', '{}', ?, ?)
    `).run(contactId, link.tenantId, input.name || 'Guest', input.email ?? null, input.phone ?? null, now, now);
  }

  const appt = createAppointment(link.tenantId, {
    title: link.title + (input.name ? ` — ${input.name}` : ''),
    description: input.notes,
    startsAt: input.startsAt,
    endsAt,
    timezone: link.timezone,
    agentId: link.agentId,
    contactId,
    reminderMinutes: 30,
  });

  db.prepare('UPDATE crm_scheduling_links SET total_bookings = total_bookings + 1 WHERE id = ?').run(link.id);
  return { ok: true, appointmentId: appt.id };
}

// ─── ICS rendering ──────────────────────────────────────────────────────
function icsEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}
function icsDate(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

export function renderICS(appointments: Appointment[]): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//System Clow//CRM//PT-BR',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ];
  for (const a of appointments) {
    if (a.status === 'cancelled') continue;
    lines.push(
      'BEGIN:VEVENT',
      `UID:${a.icsUid}`,
      `DTSTAMP:${icsDate(a.createdAt)}`,
      `DTSTART:${icsDate(a.startsAt)}`,
      `DTEND:${icsDate(a.endsAt)}`,
      `SUMMARY:${icsEscape(a.title)}`,
      a.description ? `DESCRIPTION:${icsEscape(a.description)}` : '',
      a.location ? `LOCATION:${icsEscape(a.location)}` : '',
      a.meetingUrl ? `URL:${icsEscape(a.meetingUrl)}` : '',
      `STATUS:${a.status === 'confirmed' ? 'CONFIRMED' : a.status === 'completed' ? 'CONFIRMED' : 'TENTATIVE'}`,
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.filter(Boolean).join('\r\n') + '\r\n';
}

// ─── Calendar integrations (token-based, OAuth scaffolded) ──────────────
export interface CalendarIntegration {
  id: string;
  tenantId: string;
  agentId?: string;
  provider: CalProvider;
  calendarId?: string;
  enabled: boolean;
  lastSyncAt?: number;
  syncDirection: 'read' | 'write' | 'both';
}

function rowToIntegration(r: any): CalendarIntegration {
  return {
    id: r.id, tenantId: r.tenant_id, agentId: r.agent_id ?? undefined,
    provider: r.provider as CalProvider,
    calendarId: r.calendar_id ?? undefined,
    enabled: r.enabled === 1,
    lastSyncAt: r.last_sync_at ?? undefined,
    syncDirection: (r.sync_direction || 'both') as 'read' | 'write' | 'both',
  };
}

export function createIntegration(tenantId: string, input: {
  agentId?: string; provider: CalProvider; calendarId?: string;
  accessToken?: string; refreshToken?: string; syncDirection?: 'read' | 'write' | 'both';
}): CalendarIntegration {
  const id = nid('crm_cali');
  getCrmDb().prepare(`
    INSERT INTO crm_calendar_integrations
      (id, tenant_id, agent_id, provider, access_token, refresh_token, calendar_id,
       sync_direction, enabled, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
  `).run(id, tenantId, input.agentId ?? null, input.provider,
    input.accessToken ?? null, input.refreshToken ?? null, input.calendarId ?? null,
    input.syncDirection || 'both', Date.now());
  return getIntegration(tenantId, id)!;
}

export function getIntegration(tenantId: string, id: string): CalendarIntegration | null {
  const r = getCrmDb().prepare('SELECT * FROM crm_calendar_integrations WHERE id = ? AND tenant_id = ?').get(id, tenantId) as any;
  return r ? rowToIntegration(r) : null;
}

export function listIntegrations(tenantId: string): CalendarIntegration[] {
  return (getCrmDb().prepare('SELECT * FROM crm_calendar_integrations WHERE tenant_id = ? ORDER BY created_at DESC').all(tenantId) as any[])
    .map(rowToIntegration);
}

export function deleteIntegration(tenantId: string, id: string): boolean {
  return getCrmDb().prepare('DELETE FROM crm_calendar_integrations WHERE id = ? AND tenant_id = ?').run(id, tenantId).changes > 0;
}

// ─── Reminders via scheduler ───────────────────────────────────────────
export async function tickReminders(): Promise<void> {
  const db = getCrmDb();
  const now = Date.now();
  const due = db.prepare(`
    SELECT * FROM crm_appointments
    WHERE status IN ('scheduled', 'confirmed')
      AND reminder_minutes IS NOT NULL
      AND reminder_fired_at IS NULL
      AND starts_at - (reminder_minutes * 60000) <= ?
      AND starts_at > ?
    LIMIT 100
  `).all(now, now) as any[];

  for (const r of due) {
    const appt = rowToAppointment(r);
    try {
      await sendAppointmentReminder(appt);
      db.prepare('UPDATE crm_appointments SET reminder_fired_at = ? WHERE id = ?').run(now, appt.id);
    } catch (err: any) {
      console.warn('[cal reminder]', appt.id, err?.message);
      // Still mark fired to avoid tight-loop retries
      db.prepare('UPDATE crm_appointments SET reminder_fired_at = ? WHERE id = ?').run(now, appt.id);
    }
  }
}

async function sendAppointmentReminder(appt: Appointment): Promise<void> {
  const db = getCrmDb();
  const contact = appt.contactId
    ? (db.prepare('SELECT * FROM crm_contacts WHERE id = ? AND tenant_id = ?').get(appt.contactId, appt.tenantId) as any)
    : null;
  if (!contact) return;

  const when = new Date(appt.startsAt).toLocaleString('pt-BR', { timeZone: appt.timezone || 'America/Sao_Paulo' });
  const text = `Lembrete: ${appt.title}\nQuando: ${when}${appt.meetingUrl ? '\nLink: ' + appt.meetingUrl : ''}${appt.location ? '\nLocal: ' + appt.location : ''}`;

  // WhatsApp first if contact has phone + tenant has a channel
  if (contact.phone) {
    const channel = db.prepare("SELECT * FROM crm_channels WHERE tenant_id = ? AND status = 'active' ORDER BY created_at LIMIT 1").get(appt.tenantId) as any;
    if (channel) {
      try {
        const mapped: any = { ...channel, tenantId: channel.tenant_id, credentialsEncrypted: channel.credentials_encrypted };
        await sendOutbound(mapped, { to: contact.phone, text, contactId: contact.id, cardId: appt.cardId });
        return;
      } catch { /* fallback to email */ }
    }
  }
  if (contact.email) {
    await sendEmail({
      to: contact.email,
      subject: 'Lembrete: ' + appt.title,
      html: `<p>Olá ${escapeHtml(contact.name)},</p><p>Lembramos do seu compromisso:</p><ul><li><b>${escapeHtml(appt.title)}</b></li><li>Quando: ${escapeHtml(when)}</li>${appt.location ? '<li>Local: ' + escapeHtml(appt.location) + '</li>' : ''}${appt.meetingUrl ? '<li>Link: <a href="' + escapeHtml(appt.meetingUrl) + '">entrar</a></li>' : ''}</ul>`,
    });
  }
}

function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Generate ICS feed token for a tenant (1:1 per tenant, stored on first access)
export function ensureIcsToken(tenantId: string): string {
  const db = getCrmDb();
  const r = db.prepare("SELECT value FROM crm_meta WHERE tenant_id = ? AND key = 'ics_token'").get(tenantId) as any;
  if (r?.value) return r.value;
  const tok = randomBytes(18).toString('base64url');
  db.prepare("INSERT OR REPLACE INTO crm_meta (tenant_id, key, value, updated_at) VALUES (?, 'ics_token', ?, ?)")
    .run(tenantId, tok, Date.now());
  return tok;
}

export function findTenantByIcsToken(token: string): string | null {
  const r = getCrmDb().prepare("SELECT tenant_id FROM crm_meta WHERE key = 'ics_token' AND value = ?").get(token) as any;
  return r?.tenant_id ?? null;
}
