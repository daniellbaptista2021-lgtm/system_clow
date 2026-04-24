/**
 * CRM schema — SQLite migrations, idempotent.
 *
 * Single-DB design (one file for all tenants). Every entity row carries
 * `tenant_id`. All queries MUST filter by tenant_id. This is enforced by
 * the store layer (never expose raw DB to routes).
 *
 * Storage: ~/.clow/crm.sqlite3 — separated from memory.sqlite3 so CRM
 * growth doesn't bloat AI memory and vice-versa.
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

let _db: Database.Database | null = null;

function getDbPath(): string {
  const home = process.env.CLOW_HOME || path.join(os.homedir(), '.clow');
  if (!fs.existsSync(home)) fs.mkdirSync(home, { recursive: true });
  return path.join(home, 'crm.sqlite3');
}

export function getCrmDb(): Database.Database {
  if (_db) return _db;
  const p = getDbPath();
  _db = new Database(p);
  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous = NORMAL');
  _db.pragma('foreign_keys = ON');
  _db.pragma('busy_timeout = 5000');
  migrate(_db);
  return _db;
}

export function closeCrmDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS crm_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);

  // ONDA 1 — Contatos Pro: colunas typed + tabela segments
  const onda1Applied = db.prepare('SELECT 1 FROM crm_migrations WHERE version = ?').get(101);
  if (!onda1Applied) {
    const existingCols = db.prepare("PRAGMA table_info(crm_contacts)").all() as any[];
    const colNames = new Set(existingCols.map((c: any) => c.name));
    const addCol = (name: string, type: string) => {
      if (!colNames.has(name)) db.exec(`ALTER TABLE crm_contacts ADD COLUMN ${name} ${type}`);
    };
    addCol('company', 'TEXT');
    addCol('title', 'TEXT');
    addCol('website', 'TEXT');
    addCol('address', 'TEXT');
    addCol('birthdate_ts', 'INTEGER');
    addCol('cpf_cnpj', 'TEXT');
    addCol('lead_score', 'INTEGER DEFAULT 0');

    db.exec(`
      CREATE TABLE IF NOT EXISTS crm_segments (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        filter_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_segments_tenant ON crm_segments(tenant_id);
    `);

    db.prepare('INSERT INTO crm_migrations (version, applied_at) VALUES (?, ?)').run(101, Date.now());
    console.log('[crm-migrate] Onda 1 applied: +typed cols + crm_segments');
  }

  // ONDA 2 — Kanban Pro: WIP, priority, swimlanes, checklists
  const onda2Applied = db.prepare('SELECT 1 FROM crm_migrations WHERE version = ?').get(102);
  if (!onda2Applied) {
    const colsCol = db.prepare("PRAGMA table_info(crm_columns)").all() as any[];
    const colsColNames = new Set(colsCol.map((c: any) => c.name));
    if (!colsColNames.has('wip_limit')) db.exec('ALTER TABLE crm_columns ADD COLUMN wip_limit INTEGER');
    if (!colsColNames.has('stage_type')) db.exec("ALTER TABLE crm_columns ADD COLUMN stage_type TEXT DEFAULT 'open'");

    const cardsCol = db.prepare("PRAGMA table_info(crm_cards)").all() as any[];
    const cardsColNames = new Set(cardsCol.map((c: any) => c.name));
    if (!cardsColNames.has('priority')) db.exec('ALTER TABLE crm_cards ADD COLUMN priority INTEGER DEFAULT 3');
    if (!cardsColNames.has('color')) db.exec('ALTER TABLE crm_cards ADD COLUMN color TEXT');
    if (!cardsColNames.has('status')) db.exec("ALTER TABLE crm_cards ADD COLUMN status TEXT DEFAULT 'active'");
    if (!cardsColNames.has('archived_at')) db.exec('ALTER TABLE crm_cards ADD COLUMN archived_at INTEGER');
    if (!cardsColNames.has('swimlane_id')) db.exec('ALTER TABLE crm_cards ADD COLUMN swimlane_id TEXT');

    const boardsCol = db.prepare("PRAGMA table_info(crm_boards)").all() as any[];
    const boardsColNames = new Set(boardsCol.map((c: any) => c.name));
    if (!boardsColNames.has('settings_json')) db.exec("ALTER TABLE crm_boards ADD COLUMN settings_json TEXT DEFAULT '{}'");

    db.exec(`
      CREATE TABLE IF NOT EXISTS crm_swimlanes (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        board_id TEXT NOT NULL REFERENCES crm_boards(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        color TEXT NOT NULL DEFAULT '#9B59FC',
        position INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_swimlanes_board ON crm_swimlanes(board_id, position);

      CREATE TABLE IF NOT EXISTS crm_checklists (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        card_id TEXT NOT NULL REFERENCES crm_cards(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        items_json TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_checklists_card ON crm_checklists(card_id);
    `);

    db.prepare('INSERT INTO crm_migrations (version, applied_at) VALUES (?, ?)').run(102, Date.now());
    console.log('[crm-migrate] Onda 2 applied: +wip/priority/color/swimlanes/checklists');
  }

  // ONDA 3 — Agentes Pro
  const onda3Applied = db.prepare('SELECT 1 FROM crm_migrations WHERE version = ?').get(103);
  if (!onda3Applied) {
    const agCols = db.prepare("PRAGMA table_info(crm_agents)").all() as any[];
    const agColNames = new Set(agCols.map((c: any) => c.name));
    const addAgCol = (n: string, t: string) => { if (!agColNames.has(n)) db.exec(`ALTER TABLE crm_agents ADD COLUMN ${n} ${t}`); };
    addAgCol('permissions_json', "TEXT DEFAULT '{}'");
    addAgCol('team_id', 'TEXT');
    addAgCol('avatar_url', 'TEXT');
    addAgCol('working_hours_json', "TEXT DEFAULT '{}'");
    addAgCol('status', "TEXT DEFAULT 'offline'");
    addAgCol('last_seen_at', 'INTEGER');
    addAgCol('skills_json', "TEXT DEFAULT '[]'");

    db.exec(`
      CREATE TABLE IF NOT EXISTS crm_teams (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        color TEXT DEFAULT '#9B59FC',
        description TEXT,
        manager_agent_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_teams_tenant ON crm_teams(tenant_id);

      CREATE TABLE IF NOT EXISTS crm_sla_rules (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        team_id TEXT,
        agent_id TEXT,
        name TEXT NOT NULL,
        max_response_mins INTEGER NOT NULL,
        escalate_to_agent_id TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sla_tenant ON crm_sla_rules(tenant_id, enabled);
    `);
    db.prepare('INSERT INTO crm_migrations (version, applied_at) VALUES (?, ?)').run(103, Date.now());
    console.log('[crm-migrate] Onda 3 applied: +agent perms/teams/SLA');
  }

  // ONDA 4 — Inbox Pro
  const onda4Applied = db.prepare('SELECT 1 FROM crm_migrations WHERE version = ?').get(104);
  if (!onda4Applied) {
    const actCols = db.prepare("PRAGMA table_info(crm_activities)").all() as any[];
    const actColNames = new Set(actCols.map((c: any) => c.name));
    const addActCol = (n: string, t: string) => { if (!actColNames.has(n)) db.exec(`ALTER TABLE crm_activities ADD COLUMN ${n} ${t}`); };
    addActCol('thread_id', 'TEXT');
    addActCol('read_by_json', "TEXT DEFAULT '[]'");
    addActCol('is_private', 'INTEGER DEFAULT 0');
    addActCol('labels_json', "TEXT DEFAULT '[]'");
    addActCol('snoozed_until', 'INTEGER');
    addActCol('priority', 'INTEGER DEFAULT 0');

    db.exec(`
      CREATE TABLE IF NOT EXISTS crm_labels (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        color TEXT DEFAULT '#9B59FC',
        scope TEXT NOT NULL DEFAULT 'inbox',
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_labels_tenant ON crm_labels(tenant_id);

      CREATE TABLE IF NOT EXISTS crm_quick_replies (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        shortcut TEXT,
        category TEXT,
        use_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_qr_tenant ON crm_quick_replies(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_qr_shortcut ON crm_quick_replies(tenant_id, shortcut);

      CREATE TABLE IF NOT EXISTS crm_inbox_rules (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        keyword TEXT,
        assign_to_agent_id TEXT,
        assign_to_team_id TEXT,
        label_id TEXT,
        priority INTEGER DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_inbox_rules_tenant ON crm_inbox_rules(tenant_id, enabled);
    `);
    db.prepare('INSERT INTO crm_migrations (version, applied_at) VALUES (?, ?)').run(104, Date.now());
    console.log('[crm-migrate] Onda 4 applied: +labels/quick-replies/inbox-rules/thread-id');
  }

  // ONDA 5 — Timeline Pro
  const onda5Applied = db.prepare('SELECT 1 FROM crm_migrations WHERE version = ?').get(105);
  if (!onda5Applied) {
    const actCols2 = db.prepare("PRAGMA table_info(crm_activities)").all() as any[];
    const actColNames2 = new Set(actCols2.map((c: any) => c.name));
    const addActCol2 = (n: string, t: string) => { if (!actColNames2.has(n)) db.exec(`ALTER TABLE crm_activities ADD COLUMN ${n} ${t}`); };
    addActCol2('duration_seconds', 'INTEGER');
    addActCol2('call_outcome', 'TEXT');
    addActCol2('email_subject', 'TEXT');
    addActCol2('attachments_json', "TEXT DEFAULT '[]'");
    addActCol2('mentions_json', "TEXT DEFAULT '[]'");
    db.prepare('INSERT INTO crm_migrations (version, applied_at) VALUES (?, ?)').run(105, Date.now());
    console.log('[crm-migrate] Onda 5 applied: +activity call/email/mentions fields');
  }

  // ONDA 6 — Lembretes Pro
  const onda6Applied = db.prepare('SELECT 1 FROM crm_migrations WHERE version = ?').get(106);
  if (!onda6Applied) {
    const remCols = db.prepare("PRAGMA table_info(crm_reminders)").all() as any[];
    const remColNames = new Set(remCols.map((c: any) => c.name));
    const addRemCol = (n: string, t: string) => { if (!remColNames.has(n)) db.exec(`ALTER TABLE crm_reminders ADD COLUMN ${n} ${t}`); };
    addRemCol('recurrence_rule', 'TEXT');
    addRemCol('recurrence_end_ts', 'INTEGER');
    addRemCol('snooze_until', 'INTEGER');
    addRemCol('channels_json', "TEXT DEFAULT '[\"in_app\"]'");
    addRemCol('pre_notify_mins', 'INTEGER');
    addRemCol('status', "TEXT DEFAULT 'active'");

    db.exec(`
      CREATE TABLE IF NOT EXISTS crm_reminder_history (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        reminder_id TEXT NOT NULL,
        fired_at INTEGER NOT NULL,
        channel TEXT NOT NULL,
        delivered INTEGER NOT NULL DEFAULT 1,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_remhist_reminder ON crm_reminder_history(reminder_id);
    `);
    db.prepare('INSERT INTO crm_migrations (version, applied_at) VALUES (?, ?)').run(106, Date.now());
    console.log('[crm-migrate] Onda 6 applied: +recurrence/snooze/channels/reminder-history');
  }

  // ONDA 7 — Inventario Pro
  const onda7Applied = db.prepare('SELECT 1 FROM crm_migrations WHERE version = ?').get(107);
  if (!onda7Applied) {
    const invCols = db.prepare("PRAGMA table_info(crm_inventory)").all() as any[];
    const invColNames = new Set(invCols.map((c: any) => c.name));
    const addIv = (n: string, t: string) => { if (!invColNames.has(n)) db.exec(`ALTER TABLE crm_inventory ADD COLUMN ${n} ${t}`); };
    addIv('category_id', 'TEXT');
    addIv('barcode', 'TEXT');
    addIv('images_json', "TEXT DEFAULT '[]'");
    addIv('min_stock', 'INTEGER DEFAULT 0');
    addIv('max_stock', 'INTEGER');
    addIv('cost_cents', 'INTEGER DEFAULT 0');
    addIv('price_wholesale_cents', 'INTEGER');
    addIv('brand', 'TEXT');
    addIv('weight_grams', 'INTEGER');

    db.exec(`
      CREATE TABLE IF NOT EXISTS crm_inv_categories (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        parent_id TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_invcat_tenant ON crm_inv_categories(tenant_id);

      CREATE TABLE IF NOT EXISTS crm_inv_variants (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        inventory_id TEXT NOT NULL REFERENCES crm_inventory(id) ON DELETE CASCADE,
        sku TEXT NOT NULL,
        name TEXT NOT NULL,
        attrs_json TEXT NOT NULL DEFAULT '{}',
        stock INTEGER NOT NULL DEFAULT 0,
        price_cents INTEGER,
        barcode TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_invvar_item ON crm_inv_variants(inventory_id);

      CREATE TABLE IF NOT EXISTS crm_inv_movements (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        inventory_id TEXT NOT NULL,
        variant_id TEXT,
        delta INTEGER NOT NULL,
        reason TEXT,
        reference TEXT,
        created_by_agent_id TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_invmov_item ON crm_inv_movements(inventory_id, created_at);
    `);
    db.prepare('INSERT INTO crm_migrations (version, applied_at) VALUES (?, ?)').run(107, Date.now());
    console.log('[crm-migrate] Onda 7 applied: inventory variants/categories/movements');
  }

  // ONDA 8 — Line Items Pro
  const onda8Applied = db.prepare('SELECT 1 FROM crm_migrations WHERE version = ?').get(108);
  if (!onda8Applied) {
    const liCols = db.prepare("PRAGMA table_info(crm_card_items)").all() as any[];
    const liColNames = new Set(liCols.map((c: any) => c.name));
    const addLi = (n: string, t: string) => { if (!liColNames.has(n)) db.exec(`ALTER TABLE crm_card_items ADD COLUMN ${n} ${t}`); };
    addLi('discount_cents', 'INTEGER DEFAULT 0');
    addLi('discount_percent', 'REAL');
    addLi('tax_cents', 'INTEGER DEFAULT 0');
    addLi('tax_percent', 'REAL');
    addLi('notes', 'TEXT');
    addLi('variant_id', 'TEXT');

    db.exec(`
      CREATE TABLE IF NOT EXISTS crm_proposals (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        card_id TEXT NOT NULL REFERENCES crm_cards(id) ON DELETE CASCADE,
        version INTEGER NOT NULL DEFAULT 1,
        subtotal_cents INTEGER NOT NULL DEFAULT 0,
        discount_cents INTEGER NOT NULL DEFAULT 0,
        tax_cents INTEGER NOT NULL DEFAULT 0,
        total_cents INTEGER NOT NULL DEFAULT 0,
        valid_until_ts INTEGER,
        status TEXT NOT NULL DEFAULT 'draft',
        terms TEXT,
        signed_at INTEGER,
        signed_by TEXT,
        signed_ip TEXT,
        pdf_url TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_prop_tenant ON crm_proposals(tenant_id, card_id);

      CREATE TABLE IF NOT EXISTS crm_proposal_templates (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        items_json TEXT NOT NULL DEFAULT '[]',
        default_terms TEXT,
        tax_percent REAL,
        discount_percent REAL,
        valid_for_days INTEGER,
        created_at INTEGER NOT NULL
      );
    `);
    db.prepare('INSERT INTO crm_migrations (version, applied_at) VALUES (?, ?)').run(108, Date.now());
    console.log('[crm-migrate] Onda 8 applied: line-items pro + proposals');
  }

  // ONDA 9 — Subscriptions Pro + Stripe Connect
  const onda9Applied = db.prepare('SELECT 1 FROM crm_migrations WHERE version = ?').get(109);
  if (!onda9Applied) {
    const subCols = db.prepare("PRAGMA table_info(crm_subscriptions)").all() as any[];
    const subColNames = new Set(subCols.map((c: any) => c.name));
    const addSub = (n: string, t: string) => { if (!subColNames.has(n)) db.exec(`ALTER TABLE crm_subscriptions ADD COLUMN ${n} ${t}`); };
    addSub('trial_until', 'INTEGER');
    addSub('stripe_subscription_id', 'TEXT');
    addSub('stripe_customer_id', 'TEXT');
    addSub('stripe_price_id', 'TEXT');
    addSub('cancel_reason', 'TEXT');
    addSub('cancel_at', 'INTEGER');
    addSub('cancelled_at', 'INTEGER');
    addSub('upgrade_from_id', 'TEXT');
    addSub('payment_link', 'TEXT');
    addSub('last_invoice_id', 'TEXT');
    addSub('coupon_code', 'TEXT');
    addSub('mrr_cents', 'INTEGER DEFAULT 0');

    db.exec(`
      CREATE TABLE IF NOT EXISTS crm_invoices (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        subscription_id TEXT,
        contact_id TEXT,
        amount_cents INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        due_at INTEGER,
        paid_at INTEGER,
        pdf_url TEXT,
        stripe_invoice_id TEXT,
        payment_method TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_invoices_tenant ON crm_invoices(tenant_id, status);
      CREATE INDEX IF NOT EXISTS idx_invoices_sub ON crm_invoices(subscription_id);

      CREATE TABLE IF NOT EXISTS crm_stripe_connect (
        tenant_id TEXT PRIMARY KEY,
        stripe_account_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        charges_enabled INTEGER NOT NULL DEFAULT 0,
        payouts_enabled INTEGER NOT NULL DEFAULT 0,
        onboarded_at INTEGER,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS crm_coupons (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        code TEXT NOT NULL,
        discount_percent INTEGER,
        discount_cents INTEGER,
        max_redemptions INTEGER,
        times_redeemed INTEGER NOT NULL DEFAULT 0,
        valid_until INTEGER,
        active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        UNIQUE(tenant_id, code)
      );
      CREATE INDEX IF NOT EXISTS idx_coupons_tenant ON crm_coupons(tenant_id, active);

      CREATE TABLE IF NOT EXISTS crm_dunning_log (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        subscription_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        action TEXT NOT NULL,
        success INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_dunning_sub ON crm_dunning_log(subscription_id, created_at);
    `);
    db.prepare('INSERT INTO crm_migrations (version, applied_at) VALUES (?, ?)').run(109, Date.now());
    console.log('[crm-migrate] Onda 9 applied: subs pro + stripe connect + invoices + coupons + dunning');
  }

  // ONDA 10 — Automacoes Pro
  const onda10Applied = db.prepare('SELECT 1 FROM crm_migrations WHERE version = ?').get(110);
  if (!onda10Applied) {
    const autoCols = db.prepare("PRAGMA table_info(crm_automations)").all() as any[];
    const autoColNames = new Set(autoCols.map((c: any) => c.name));
    const addAuto = (n: string, t: string) => { if (!autoColNames.has(n)) db.exec(`ALTER TABLE crm_automations ADD COLUMN ${n} ${t}`); };
    addAuto('schedule_cron', 'TEXT');
    addAuto('last_run_at', 'INTEGER');
    addAuto('next_run_at', 'INTEGER');
    addAuto('run_count', 'INTEGER DEFAULT 0');
    addAuto('webhook_secret', 'TEXT');

    db.exec(`
      CREATE TABLE IF NOT EXISTS crm_automation_logs (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        automation_id TEXT NOT NULL,
        fired_at INTEGER NOT NULL,
        trigger_payload_json TEXT,
        actions_executed INTEGER DEFAULT 0,
        success INTEGER NOT NULL DEFAULT 1,
        error TEXT,
        duration_ms INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_autlog ON crm_automation_logs(automation_id, fired_at);
    `);
    db.prepare('INSERT INTO crm_migrations (version, applied_at) VALUES (?, ?)').run(110, Date.now());
    console.log('[crm-migrate] Onda 10 applied: automation pro (cron/webhook/logs)');
  }

  // ONDA 11 — Assignment Pro
  const onda11Applied = db.prepare('SELECT 1 FROM crm_migrations WHERE version = ?').get(111);
  if (!onda11Applied) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS crm_assignment_rules (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        conditions_json TEXT NOT NULL DEFAULT '{}',
        assign_to_agent_id TEXT,
        assign_to_team_id TEXT,
        skill_required TEXT,
        sla_minutes INTEGER,
        escalate_to_agent_id TEXT,
        priority INTEGER DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_asrules_tenant ON crm_assignment_rules(tenant_id, enabled, priority);

      CREATE TABLE IF NOT EXISTS crm_assignment_log (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        rule_id TEXT,
        card_id TEXT NOT NULL,
        agent_id TEXT,
        team_id TEXT,
        escalated INTEGER NOT NULL DEFAULT 0,
        sla_deadline_ts INTEGER,
        resolved_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_aslog_card ON crm_assignment_log(card_id, created_at);
    `);
    db.prepare('INSERT INTO crm_migrations (version, applied_at) VALUES (?, ?)').run(111, Date.now());
    console.log('[crm-migrate] Onda 11 applied: assignment rules + log');
  }

  // ONDA 12 — Canais + SSE + Midia upgrade
  const onda12Applied = db.prepare('SELECT 1 FROM crm_migrations WHERE version = ?').get(112);
  if (!onda12Applied) {
    const chCols = db.prepare("PRAGMA table_info(crm_channels)").all() as any[];
    const chColNames = new Set(chCols.map((c: any) => c.name));
    if (!chColNames.has('health_json')) db.exec("ALTER TABLE crm_channels ADD COLUMN health_json TEXT DEFAULT '{}'");
    if (!chColNames.has('messages_sent')) db.exec('ALTER TABLE crm_channels ADD COLUMN messages_sent INTEGER DEFAULT 0');
    if (!chColNames.has('messages_received')) db.exec('ALTER TABLE crm_channels ADD COLUMN messages_received INTEGER DEFAULT 0');
    if (!chColNames.has('last_error')) db.exec('ALTER TABLE crm_channels ADD COLUMN last_error TEXT');
    if (!chColNames.has('last_health_check')) db.exec('ALTER TABLE crm_channels ADD COLUMN last_health_check INTEGER');

    db.exec(`
      CREATE TABLE IF NOT EXISTS crm_channel_templates (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        channel_id TEXT NOT NULL REFERENCES crm_channels(id) ON DELETE CASCADE,
        template_name TEXT NOT NULL,
        language_code TEXT NOT NULL DEFAULT 'pt_BR',
        category TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        body TEXT,
        synced_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_chtmpl_channel ON crm_channel_templates(channel_id);
    `);
    db.prepare('INSERT INTO crm_migrations (version, applied_at) VALUES (?, ?)').run(112, Date.now());
    console.log('[crm-migrate] Onda 12 applied: channel templates + health + metrics');
  }

  // ONDA 14 — Reports & Dashboards (lost_reason + scheduled reports)
  const onda14Applied = db.prepare('SELECT 1 FROM crm_migrations WHERE version = ?').get(114);
  if (!onda14Applied) {
    const cardCols = db.prepare("PRAGMA table_info(crm_cards)").all() as any[];
    const cardColNames = new Set(cardCols.map((c: any) => c.name));
    if (!cardColNames.has('lost_reason'))  db.exec("ALTER TABLE crm_cards ADD COLUMN lost_reason TEXT");
    if (!cardColNames.has('won_reason'))   db.exec("ALTER TABLE crm_cards ADD COLUMN won_reason TEXT");

    db.exec(`
      CREATE TABLE IF NOT EXISTS crm_scheduled_reports (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,           -- sales | agents | sources | lost-reasons
        interval TEXT NOT NULL,       -- daily | weekly | monthly
        format TEXT NOT NULL DEFAULT 'pdf',  -- pdf | csv
        email_to TEXT NOT NULL,
        board_id TEXT,
        next_run_at INTEGER NOT NULL,
        last_run_at INTEGER,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sched_reports_next ON crm_scheduled_reports(next_run_at) WHERE enabled = 1;
      CREATE INDEX IF NOT EXISTS idx_sched_reports_tenant ON crm_scheduled_reports(tenant_id);
    `);
    db.prepare('INSERT INTO crm_migrations (version, applied_at) VALUES (?, ?)').run(114, Date.now());
    console.log('[crm-migrate] Onda 14 applied: lost_reason + scheduled reports');
  }

  // ONDA 16 — Proposals Pro (send, track, sign, auto-convert)
  const onda16Applied = db.prepare('SELECT 1 FROM crm_migrations WHERE version = ?').get(116);
  if (!onda16Applied) {
    const pCols = db.prepare("PRAGMA table_info(crm_proposals)").all() as any[];
    const pColNames = new Set(pCols.map((c: any) => c.name));
    if (!pColNames.has('public_token'))          db.exec("ALTER TABLE crm_proposals ADD COLUMN public_token TEXT");
    if (!pColNames.has('viewed_at'))             db.exec("ALTER TABLE crm_proposals ADD COLUMN viewed_at INTEGER");
    if (!pColNames.has('viewed_count'))          db.exec("ALTER TABLE crm_proposals ADD COLUMN viewed_count INTEGER DEFAULT 0");
    if (!pColNames.has('first_viewed_ip'))       db.exec("ALTER TABLE crm_proposals ADD COLUMN first_viewed_ip TEXT");
    if (!pColNames.has('sent_via'))              db.exec("ALTER TABLE crm_proposals ADD COLUMN sent_via TEXT");
    if (!pColNames.has('sent_to'))               db.exec("ALTER TABLE crm_proposals ADD COLUMN sent_to TEXT");
    if (!pColNames.has('sent_at'))               db.exec("ALTER TABLE crm_proposals ADD COLUMN sent_at INTEGER");
    if (!pColNames.has('auto_convert_on_accept'))db.exec("ALTER TABLE crm_proposals ADD COLUMN auto_convert_on_accept INTEGER DEFAULT 1");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_proposals_token ON crm_proposals(public_token) WHERE public_token IS NOT NULL");

    db.exec(`
      CREATE TABLE IF NOT EXISTS crm_proposal_events (
        id TEXT PRIMARY KEY,
        proposal_id TEXT NOT NULL,
        event TEXT NOT NULL,
        ts INTEGER NOT NULL,
        ip TEXT,
        ua TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_prop_events ON crm_proposal_events(proposal_id, ts);
    `);
    db.prepare('INSERT INTO crm_migrations (version, applied_at) VALUES (?, ?)').run(116, Date.now());
    console.log('[crm-migrate] Onda 16 applied: proposals tracking + events');
  }

  // ONDA 17 — Email Marketing (campaigns + templates + drips + tracking + unsubs)
  const onda17Applied = db.prepare('SELECT 1 FROM crm_migrations WHERE version = ?').get(117);
  if (!onda17Applied) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS crm_email_templates (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        subject TEXT NOT NULL,
        body_html TEXT NOT NULL,
        variables_json TEXT DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_email_tpl_tenant ON crm_email_templates(tenant_id);

      CREATE TABLE IF NOT EXISTS crm_email_campaigns (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        segment_id TEXT,
        template_id TEXT,
        subject TEXT NOT NULL,
        body_html TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        scheduled_at INTEGER,
        started_at INTEGER,
        finished_at INTEGER,
        stats_queued INTEGER DEFAULT 0,
        stats_sent INTEGER DEFAULT 0,
        stats_opened INTEGER DEFAULT 0,
        stats_clicked INTEGER DEFAULT 0,
        stats_unsubscribed INTEGER DEFAULT 0,
        stats_bounced INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_campaigns_tenant ON crm_email_campaigns(tenant_id, status);
      CREATE INDEX IF NOT EXISTS idx_campaigns_scheduled ON crm_email_campaigns(scheduled_at) WHERE status = 'scheduled';

      CREATE TABLE IF NOT EXISTS crm_campaign_sends (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL,
        contact_id TEXT,
        email TEXT NOT NULL,
        send_token TEXT NOT NULL UNIQUE,
        unsub_token TEXT,
        sent_at INTEGER,
        opened_at INTEGER,
        opened_count INTEGER DEFAULT 0,
        opened_ip TEXT,
        clicked_at INTEGER,
        click_count INTEGER DEFAULT 0,
        last_clicked_url TEXT,
        bounced INTEGER DEFAULT 0,
        error TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_csends_campaign ON crm_campaign_sends(campaign_id, sent_at);
      CREATE INDEX IF NOT EXISTS idx_csends_token ON crm_campaign_sends(send_token);
      CREATE INDEX IF NOT EXISTS idx_csends_unsub ON crm_campaign_sends(unsub_token);

      CREATE TABLE IF NOT EXISTS crm_unsubscribes (
        tenant_id TEXT NOT NULL,
        email TEXT NOT NULL,
        reason TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, email)
      );

      CREATE TABLE IF NOT EXISTS crm_email_sequences (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        segment_id TEXT,
        steps_json TEXT NOT NULL DEFAULT '[]',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sequences_tenant ON crm_email_sequences(tenant_id);

      CREATE TABLE IF NOT EXISTS crm_sequence_enrollments (
        id TEXT PRIMARY KEY,
        sequence_id TEXT NOT NULL,
        contact_id TEXT NOT NULL,
        step_idx INTEGER NOT NULL DEFAULT 0,
        next_run_at INTEGER NOT NULL,
        finished_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_enr_due ON crm_sequence_enrollments(next_run_at) WHERE finished_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_enr_lookup ON crm_sequence_enrollments(sequence_id, contact_id);
    `);
    db.prepare('INSERT INTO crm_migrations (version, applied_at) VALUES (?, ?)').run(117, Date.now());
    console.log('[crm-migrate] Onda 17 applied: email marketing (campaigns + templates + sequences + unsubs)');
  }

  // ONDA 18 — Forms / Landing Pages / Inbound Webhooks
  const onda18Applied = db.prepare('SELECT 1 FROM crm_migrations WHERE version = ?').get(118);
  if (!onda18Applied) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS crm_forms (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        public_key TEXT NOT NULL,
        fields_json TEXT NOT NULL DEFAULT '[]',
        mapping_json TEXT NOT NULL DEFAULT '{}',
        redirect_url TEXT,
        board_id TEXT,
        column_id TEXT,
        default_source TEXT DEFAULT 'form',
        notify_emails_json TEXT DEFAULT '[]',
        total_submissions INTEGER DEFAULT 0,
        last_submission_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_forms_tenant ON crm_forms(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_forms_key ON crm_forms(public_key);

      CREATE TABLE IF NOT EXISTS crm_form_submissions (
        id TEXT PRIMARY KEY,
        form_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        contact_id TEXT,
        card_id TEXT,
        ip TEXT,
        ua TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_submissions_form ON crm_form_submissions(form_id, created_at);

      CREATE TABLE IF NOT EXISTS crm_inbound_webhooks (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        hook_key TEXT NOT NULL UNIQUE,
        secret TEXT,
        mapping_json TEXT NOT NULL DEFAULT '{}',
        board_id TEXT,
        column_id TEXT,
        default_source TEXT DEFAULT 'webhook',
        enabled INTEGER NOT NULL DEFAULT 1,
        total_received INTEGER DEFAULT 0,
        last_received_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_hooks_tenant ON crm_inbound_webhooks(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_hooks_key ON crm_inbound_webhooks(hook_key);
    `);
    db.prepare('INSERT INTO crm_migrations (version, applied_at) VALUES (?, ?)').run(118, Date.now());
    console.log('[crm-migrate] Onda 18 applied: forms + submissions + inbound webhooks');
  }

  // ONDA 19 — Tasks Pro (typed, prioritized, recurring, alerts)
  const onda19Applied = db.prepare('SELECT 1 FROM crm_migrations WHERE version = ?').get(119);
  if (!onda19Applied) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS crm_tasks (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        type TEXT NOT NULL DEFAULT 'other',
        priority TEXT NOT NULL DEFAULT 'med',
        status TEXT NOT NULL DEFAULT 'open',
        due_at INTEGER,
        completed_at INTEGER,
        assigned_to_agent_id TEXT,
        card_id TEXT REFERENCES crm_cards(id) ON DELETE CASCADE,
        contact_id TEXT REFERENCES crm_contacts(id) ON DELETE CASCADE,
        recurrence_json TEXT,
        parent_task_id TEXT,
        alert_minutes_before INTEGER,
        alert_fired_at INTEGER,
        created_by_agent_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_tenant ON crm_tasks(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_agent_status ON crm_tasks(tenant_id, assigned_to_agent_id, status);
      CREATE INDEX IF NOT EXISTS idx_tasks_due ON crm_tasks(tenant_id, due_at) WHERE status = 'open';
      CREATE INDEX IF NOT EXISTS idx_tasks_card ON crm_tasks(card_id) WHERE card_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_tasks_contact ON crm_tasks(contact_id) WHERE contact_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_tasks_alerts ON crm_tasks(due_at, alert_fired_at) WHERE alert_fired_at IS NULL AND alert_minutes_before IS NOT NULL;
    `);
    db.prepare('INSERT INTO crm_migrations (version, applied_at) VALUES (?, ?)').run(119, Date.now());
    console.log('[crm-migrate] Onda 19 applied: tasks (typed + priority + recurrence + alerts)');
  }

  // ONDA 20 — Calendar / Scheduling
  const onda20Applied = db.prepare('SELECT 1 FROM crm_migrations WHERE version = ?').get(120);
  if (!onda20Applied) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS crm_meta (
        tenant_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT,
        updated_at INTEGER,
        PRIMARY KEY (tenant_id, key)
      );

      CREATE TABLE IF NOT EXISTS crm_appointments (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        starts_at INTEGER NOT NULL,
        ends_at INTEGER NOT NULL,
        timezone TEXT DEFAULT 'America/Sao_Paulo',
        agent_id TEXT,
        contact_id TEXT REFERENCES crm_contacts(id) ON DELETE SET NULL,
        card_id TEXT REFERENCES crm_cards(id) ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'scheduled',
        meeting_url TEXT,
        location TEXT,
        reminder_minutes INTEGER DEFAULT 30,
        reminder_fired_at INTEGER,
        ics_uid TEXT NOT NULL,
        external_provider TEXT,
        external_event_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_appt_tenant_start ON crm_appointments(tenant_id, starts_at);
      CREATE INDEX IF NOT EXISTS idx_appt_agent ON crm_appointments(agent_id, starts_at);
      CREATE INDEX IF NOT EXISTS idx_appt_contact ON crm_appointments(contact_id);
      CREATE INDEX IF NOT EXISTS idx_appt_reminder ON crm_appointments(starts_at, reminder_fired_at) WHERE reminder_fired_at IS NULL AND reminder_minutes IS NOT NULL;

      CREATE TABLE IF NOT EXISTS crm_scheduling_links (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        agent_id TEXT,
        title TEXT NOT NULL,
        description TEXT,
        duration_minutes INTEGER NOT NULL DEFAULT 30,
        buffer_before_minutes INTEGER NOT NULL DEFAULT 0,
        buffer_after_minutes INTEGER NOT NULL DEFAULT 0,
        availability_json TEXT NOT NULL DEFAULT '{"weekdays":{}}',
        timezone TEXT DEFAULT 'America/Sao_Paulo',
        advance_notice_hours INTEGER NOT NULL DEFAULT 1,
        max_days_ahead INTEGER NOT NULL DEFAULT 30,
        require_email INTEGER NOT NULL DEFAULT 1,
        require_phone INTEGER NOT NULL DEFAULT 0,
        require_name INTEGER NOT NULL DEFAULT 1,
        enabled INTEGER NOT NULL DEFAULT 1,
        total_bookings INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_slinks_tenant ON crm_scheduling_links(tenant_id);

      CREATE TABLE IF NOT EXISTS crm_calendar_integrations (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        agent_id TEXT,
        provider TEXT NOT NULL,
        access_token TEXT,
        refresh_token TEXT,
        calendar_id TEXT,
        sync_direction TEXT DEFAULT 'both',
        last_sync_at INTEGER,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_calint_tenant ON crm_calendar_integrations(tenant_id);
    `);
    db.prepare('INSERT INTO crm_migrations (version, applied_at) VALUES (?, ?)').run(120, Date.now());
    console.log('[crm-migrate] Onda 20 applied: calendar + appointments + scheduling links + integrations');
  }

  // ONDA 21 — Internal Chat + Comments + Notes + Mentions
  const onda21Applied = db.prepare('SELECT 1 FROM crm_migrations WHERE version = ?').get(121);
  if (!onda21Applied) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS crm_card_comments (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        card_id TEXT NOT NULL REFERENCES crm_cards(id) ON DELETE CASCADE,
        author_agent_id TEXT,
        content TEXT NOT NULL,
        mentions_json TEXT NOT NULL DEFAULT '[]',
        parent_comment_id TEXT,
        edited_at INTEGER,
        deleted_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_cmts_card ON crm_card_comments(card_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_cmts_tenant ON crm_card_comments(tenant_id);

      CREATE TABLE IF NOT EXISTS crm_chat_rooms (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'group',
        card_id TEXT,
        contact_id TEXT,
        members_json TEXT NOT NULL DEFAULT '[]',
        created_by_agent_id TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_rooms_tenant ON crm_chat_rooms(tenant_id);

      CREATE TABLE IF NOT EXISTS crm_chat_messages (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES crm_chat_rooms(id) ON DELETE CASCADE,
        author_agent_id TEXT,
        content TEXT NOT NULL,
        mentions_json TEXT NOT NULL DEFAULT '[]',
        reply_to_id TEXT,
        edited_at INTEGER,
        deleted_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_msgs_room ON crm_chat_messages(room_id, created_at);

      CREATE TABLE IF NOT EXISTS crm_chat_reads (
        room_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        last_read_message_id TEXT,
        last_read_at INTEGER NOT NULL,
        PRIMARY KEY (room_id, agent_id)
      );

      CREATE TABLE IF NOT EXISTS crm_contact_notes (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        contact_id TEXT NOT NULL REFERENCES crm_contacts(id) ON DELETE CASCADE,
        author_agent_id TEXT,
        content TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        mentions_json TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_notes_contact ON crm_contact_notes(contact_id, pinned DESC, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_notes_tenant ON crm_contact_notes(tenant_id);

      CREATE TABLE IF NOT EXISTS crm_agent_mentions (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        mentioned_agent_id TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        card_id TEXT,
        contact_id TEXT,
        snippet TEXT,
        read_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_mentions_agent ON crm_agent_mentions(tenant_id, mentioned_agent_id, read_at, created_at);
    `);
    db.prepare('INSERT INTO crm_migrations (version, applied_at) VALUES (?, ?)').run(121, Date.now());
    console.log('[crm-migrate] Onda 21 applied: card comments + chat rooms + notes + mentions');
  }

  // ONDA 22 — FTS5 full-text search + saved views
  const onda22Applied = db.prepare('SELECT 1 FROM crm_migrations WHERE version = ?').get(122);
  if (!onda22Applied) {
    db.exec(`
      -- FTS5 external content tables (rowid mirrors source id)
      CREATE VIRTUAL TABLE IF NOT EXISTS crm_fts_cards USING fts5(
        title, description,
        content='crm_cards', content_rowid='rowid',
        tokenize = 'unicode61 remove_diacritics 2'
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS crm_fts_contacts USING fts5(
        name, email, phone, notes,
        content='crm_contacts', content_rowid='rowid',
        tokenize = 'unicode61 remove_diacritics 2'
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS crm_fts_activities USING fts5(
        content,
        content='crm_activities', content_rowid='rowid',
        tokenize = 'unicode61 remove_diacritics 2'
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS crm_fts_notes USING fts5(
        content,
        content='crm_contact_notes', content_rowid='rowid',
        tokenize = 'unicode61 remove_diacritics 2'
      );

      -- Sync triggers
      CREATE TRIGGER IF NOT EXISTS tg_fts_cards_ai AFTER INSERT ON crm_cards BEGIN
        INSERT INTO crm_fts_cards(rowid, title, description) VALUES (new.rowid, new.title, COALESCE(new.description,''));
      END;
      CREATE TRIGGER IF NOT EXISTS tg_fts_cards_ad AFTER DELETE ON crm_cards BEGIN
        INSERT INTO crm_fts_cards(crm_fts_cards, rowid, title, description) VALUES ('delete', old.rowid, old.title, COALESCE(old.description,''));
      END;
      CREATE TRIGGER IF NOT EXISTS tg_fts_cards_au AFTER UPDATE ON crm_cards BEGIN
        INSERT INTO crm_fts_cards(crm_fts_cards, rowid, title, description) VALUES ('delete', old.rowid, old.title, COALESCE(old.description,''));
        INSERT INTO crm_fts_cards(rowid, title, description) VALUES (new.rowid, new.title, COALESCE(new.description,''));
      END;

      CREATE TRIGGER IF NOT EXISTS tg_fts_contacts_ai AFTER INSERT ON crm_contacts BEGIN
        INSERT INTO crm_fts_contacts(rowid, name, email, phone, notes)
        VALUES (new.rowid, new.name, COALESCE(new.email,''), COALESCE(new.phone,''), COALESCE(new.notes,''));
      END;
      CREATE TRIGGER IF NOT EXISTS tg_fts_contacts_ad AFTER DELETE ON crm_contacts BEGIN
        INSERT INTO crm_fts_contacts(crm_fts_contacts, rowid, name, email, phone, notes)
        VALUES ('delete', old.rowid, old.name, COALESCE(old.email,''), COALESCE(old.phone,''), COALESCE(old.notes,''));
      END;
      CREATE TRIGGER IF NOT EXISTS tg_fts_contacts_au AFTER UPDATE ON crm_contacts BEGIN
        INSERT INTO crm_fts_contacts(crm_fts_contacts, rowid, name, email, phone, notes)
        VALUES ('delete', old.rowid, old.name, COALESCE(old.email,''), COALESCE(old.phone,''), COALESCE(old.notes,''));
        INSERT INTO crm_fts_contacts(rowid, name, email, phone, notes)
        VALUES (new.rowid, new.name, COALESCE(new.email,''), COALESCE(new.phone,''), COALESCE(new.notes,''));
      END;

      CREATE TRIGGER IF NOT EXISTS tg_fts_acts_ai AFTER INSERT ON crm_activities BEGIN
        INSERT INTO crm_fts_activities(rowid, content) VALUES (new.rowid, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS tg_fts_acts_ad AFTER DELETE ON crm_activities BEGIN
        INSERT INTO crm_fts_activities(crm_fts_activities, rowid, content) VALUES ('delete', old.rowid, old.content);
      END;

      CREATE TRIGGER IF NOT EXISTS tg_fts_notes_ai AFTER INSERT ON crm_contact_notes BEGIN
        INSERT INTO crm_fts_notes(rowid, content) VALUES (new.rowid, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS tg_fts_notes_ad AFTER DELETE ON crm_contact_notes BEGIN
        INSERT INTO crm_fts_notes(crm_fts_notes, rowid, content) VALUES ('delete', old.rowid, old.content);
      END;
      CREATE TRIGGER IF NOT EXISTS tg_fts_notes_au AFTER UPDATE ON crm_contact_notes BEGIN
        INSERT INTO crm_fts_notes(crm_fts_notes, rowid, content) VALUES ('delete', old.rowid, old.content);
        INSERT INTO crm_fts_notes(rowid, content) VALUES (new.rowid, new.content);
      END;

      -- Saved views
      CREATE TABLE IF NOT EXISTS crm_saved_views (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        entity TEXT NOT NULL,
        filter_json TEXT NOT NULL DEFAULT '{}',
        sort_json TEXT,
        shared INTEGER NOT NULL DEFAULT 0,
        created_by_agent_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_views_tenant_entity ON crm_saved_views(tenant_id, entity);
    `);

    // Backfill existing rows into FTS tables
    db.exec(`
      INSERT INTO crm_fts_cards(rowid, title, description)
        SELECT rowid, title, COALESCE(description,'') FROM crm_cards;
      INSERT INTO crm_fts_contacts(rowid, name, email, phone, notes)
        SELECT rowid, name, COALESCE(email,''), COALESCE(phone,''), COALESCE(notes,'') FROM crm_contacts;
      INSERT INTO crm_fts_activities(rowid, content)
        SELECT rowid, content FROM crm_activities;
      INSERT INTO crm_fts_notes(rowid, content)
        SELECT rowid, content FROM crm_contact_notes;
    `);

    db.prepare('INSERT INTO crm_migrations (version, applied_at) VALUES (?, ?)').run(122, Date.now());
    console.log('[crm-migrate] Onda 22 applied: FTS5 full-text search + saved views');
  }

  // ONDA 23 — Outbound webhooks + External integrations
  const onda23Applied = db.prepare('SELECT 1 FROM crm_migrations WHERE version = ?').get(123);
  if (!onda23Applied) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS crm_outbound_webhooks (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        events_json TEXT NOT NULL DEFAULT '[]',
        secret TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        total_sent INTEGER DEFAULT 0,
        total_failed INTEGER DEFAULT 0,
        last_attempt_at INTEGER,
        last_status INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ohk_tenant ON crm_outbound_webhooks(tenant_id);

      CREATE TABLE IF NOT EXISTS crm_webhook_deliveries (
        id TEXT PRIMARY KEY,
        webhook_id TEXT NOT NULL REFERENCES crm_outbound_webhooks(id) ON DELETE CASCADE,
        event TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        attempt_count INTEGER DEFAULT 0,
        http_status INTEGER,
        response_body TEXT,
        last_tried_at INTEGER,
        next_retry_at INTEGER,
        succeeded_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_whd_retry ON crm_webhook_deliveries(next_retry_at) WHERE succeeded_at IS NULL AND next_retry_at IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_whd_hook ON crm_webhook_deliveries(webhook_id, created_at);

      CREATE TABLE IF NOT EXISTS crm_external_integrations (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        agent_id TEXT,
        config_json TEXT NOT NULL DEFAULT '{}',
        enabled INTEGER NOT NULL DEFAULT 1,
        total_synced INTEGER DEFAULT 0,
        last_sync_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_extint_tenant ON crm_external_integrations(tenant_id);
    `);
    db.prepare('INSERT INTO crm_migrations (version, applied_at) VALUES (?, ?)').run(123, Date.now());
    console.log('[crm-migrate] Onda 23 applied: outbound webhooks + external integrations');
  }

  // ONDA 24 — Push notifications
  const onda24Applied = db.prepare('SELECT 1 FROM crm_migrations WHERE version = ?').get(124);
  if (!onda24Applied) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS crm_push_subscriptions (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        agent_id TEXT,
        endpoint TEXT NOT NULL UNIQUE,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        ua TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_push_agent ON crm_push_subscriptions(tenant_id, agent_id, enabled);
    `);
    db.prepare('INSERT INTO crm_migrations (version, applied_at) VALUES (?, ?)').run(124, Date.now());
    console.log('[crm-migrate] Onda 24 applied: push notifications');
  }

  // ONDA 25 — AI insights (score, next_step, summary, sentiment, forecast, classification)
  const onda25Applied = db.prepare('SELECT 1 FROM crm_migrations WHERE version = ?').get(125);
  if (!onda25Applied) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS crm_ai_insights (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        entity TEXT NOT NULL,           -- card | contact | board
        entity_id TEXT NOT NULL,
        kind TEXT NOT NULL,             -- score | next_step | summary | sentiment | forecast | classification
        score_numeric REAL,
        content_text TEXT,
        content_json TEXT,
        confidence REAL,
        model TEXT,
        computed_at INTEGER NOT NULL,
        stale_at INTEGER,
        UNIQUE (tenant_id, entity, entity_id, kind)
      );
      CREATE INDEX IF NOT EXISTS idx_ai_lookup ON crm_ai_insights(tenant_id, entity, entity_id);
      CREATE INDEX IF NOT EXISTS idx_ai_stale ON crm_ai_insights(stale_at) WHERE stale_at IS NOT NULL;
    `);
    db.prepare('INSERT INTO crm_migrations (version, applied_at) VALUES (?, ?)').run(125, Date.now());
    console.log('[crm-migrate] Onda 25 applied: AI insights (score/next_step/summary/sentiment/forecast/classification)');
  }

  // ONDA 26 — Documents / Contracts (templates + generate + sign + version)
  const onda26Applied = db.prepare('SELECT 1 FROM crm_migrations WHERE version = ?').get(126);
  if (!onda26Applied) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS crm_document_templates (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'custom',
        body_html TEXT NOT NULL,
        variables_json TEXT DEFAULT '[]',
        default_terms TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_doctpl_tenant ON crm_document_templates(tenant_id, kind);

      CREATE TABLE IF NOT EXISTS crm_documents (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        contact_id TEXT REFERENCES crm_contacts(id) ON DELETE SET NULL,
        card_id TEXT REFERENCES crm_cards(id) ON DELETE SET NULL,
        template_id TEXT,
        title TEXT NOT NULL,
        body_html TEXT NOT NULL,
        variables_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'draft',
        public_token TEXT NOT NULL UNIQUE,
        version INTEGER NOT NULL DEFAULT 1,
        parent_document_id TEXT,
        signed_at INTEGER,
        signed_by TEXT,
        signed_ip TEXT,
        signature_image_b64 TEXT,
        file_url TEXT,
        sent_via TEXT,
        sent_to TEXT,
        sent_at INTEGER,
        viewed_at INTEGER,
        viewed_count INTEGER DEFAULT 0,
        created_by_agent_id TEXT,
        ics_uid TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_docs_tenant ON crm_documents(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_docs_contact ON crm_documents(contact_id);
      CREATE INDEX IF NOT EXISTS idx_docs_card ON crm_documents(card_id);
      CREATE INDEX IF NOT EXISTS idx_docs_token ON crm_documents(public_token);

      CREATE TABLE IF NOT EXISTS crm_document_events (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES crm_documents(id) ON DELETE CASCADE,
        event TEXT NOT NULL,
        ts INTEGER NOT NULL,
        ip TEXT,
        ua TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_docevts ON crm_document_events(document_id, ts);
    `);
    db.prepare('INSERT INTO crm_migrations (version, applied_at) VALUES (?, ?)').run(126, Date.now());
    console.log('[crm-migrate] Onda 26 applied: documents + templates + signature + events');
  }


  const applied = new Set(
    db.prepare('SELECT version FROM crm_migrations').all().map((r: any) => r.version as number),
  );

  const run = (version: number, up: string) => {
    if (applied.has(version)) return;
    const tx = db.transaction(() => {
      db.exec(up);
      db.prepare('INSERT INTO crm_migrations (version, applied_at) VALUES (?, ?)').run(version, Date.now());
    });
    tx();
  };

  // ─────────────────────────────────────────────────────────────────────
  // v1: Core entities
  // ─────────────────────────────────────────────────────────────────────
  run(1, `
    CREATE TABLE crm_boards (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'sales',
      description TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX idx_boards_tenant ON crm_boards(tenant_id, position);

    CREATE TABLE crm_columns (
      id TEXT PRIMARY KEY,
      board_id TEXT NOT NULL REFERENCES crm_boards(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      color TEXT NOT NULL DEFAULT '#9B59FC',
      auto_rule_json TEXT,
      is_terminal INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_columns_board ON crm_columns(board_id, position);

    CREATE TABLE crm_contacts (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      avatar_url TEXT,
      tags_json TEXT NOT NULL DEFAULT '[]',
      custom_fields_json TEXT NOT NULL DEFAULT '{}',
      notes TEXT,
      source TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_interaction_at INTEGER
    );
    CREATE INDEX idx_contacts_tenant ON crm_contacts(tenant_id);
    CREATE INDEX idx_contacts_phone ON crm_contacts(tenant_id, phone);
    CREATE INDEX idx_contacts_email ON crm_contacts(tenant_id, email);
    CREATE INDEX idx_contacts_name ON crm_contacts(tenant_id, name);

    CREATE TABLE crm_cards (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      board_id TEXT NOT NULL REFERENCES crm_boards(id) ON DELETE CASCADE,
      column_id TEXT NOT NULL REFERENCES crm_columns(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT,
      contact_id TEXT REFERENCES crm_contacts(id) ON DELETE SET NULL,
      owner_agent_id TEXT,
      value_cents INTEGER NOT NULL DEFAULT 0,
      probability INTEGER NOT NULL DEFAULT 0,
      labels_json TEXT NOT NULL DEFAULT '[]',
      due_date INTEGER,
      position INTEGER NOT NULL DEFAULT 0,
      custom_fields_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_activity_at INTEGER
    );
    CREATE INDEX idx_cards_tenant ON crm_cards(tenant_id);
    CREATE INDEX idx_cards_column ON crm_cards(column_id, position);
    CREATE INDEX idx_cards_contact ON crm_cards(contact_id);
    CREATE INDEX idx_cards_owner ON crm_cards(owner_agent_id);
    CREATE INDEX idx_cards_due ON crm_cards(tenant_id, due_date) WHERE due_date IS NOT NULL;

    CREATE TABLE crm_activities (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      card_id TEXT REFERENCES crm_cards(id) ON DELETE CASCADE,
      contact_id TEXT REFERENCES crm_contacts(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      channel TEXT NOT NULL DEFAULT 'manual',
      direction TEXT,
      content TEXT NOT NULL DEFAULT '',
      media_url TEXT,
      media_type TEXT,
      provider_message_id TEXT,
      created_by_agent_id TEXT,
      metadata_json TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_activities_card ON crm_activities(card_id, created_at);
    CREATE INDEX idx_activities_contact ON crm_activities(contact_id, created_at);
    CREATE INDEX idx_activities_tenant ON crm_activities(tenant_id, created_at);
    CREATE INDEX idx_activities_pid ON crm_activities(provider_message_id);

    CREATE TABLE crm_agents (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT,
      role TEXT NOT NULL DEFAULT 'agent',
      active INTEGER NOT NULL DEFAULT 1,
      api_key_hash TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(tenant_id, email)
    );
    CREATE INDEX idx_agents_tenant ON crm_agents(tenant_id, active);

    CREATE TABLE crm_channels (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      credentials_encrypted TEXT NOT NULL,
      phone_number TEXT,
      phone_number_id TEXT,
      webhook_secret TEXT,
      last_inbound_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_channels_tenant ON crm_channels(tenant_id);
    CREATE INDEX idx_channels_phone_id ON crm_channels(phone_number_id);
    CREATE INDEX idx_channels_webhook ON crm_channels(webhook_secret);

    CREATE TABLE crm_subscriptions (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      contact_id TEXT NOT NULL REFERENCES crm_contacts(id) ON DELETE CASCADE,
      card_id TEXT REFERENCES crm_cards(id) ON DELETE SET NULL,
      plan_name TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      cycle TEXT NOT NULL DEFAULT 'monthly',
      next_charge_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      reminders_sent INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      cancelled_at INTEGER
    );
    CREATE INDEX idx_subs_tenant ON crm_subscriptions(tenant_id, status);
    CREATE INDEX idx_subs_next_charge ON crm_subscriptions(next_charge_at) WHERE status = 'active';

    CREATE TABLE crm_automations (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      trigger_json TEXT NOT NULL,
      conditions_json TEXT NOT NULL DEFAULT '[]',
      actions_json TEXT NOT NULL,
      last_run_at INTEGER,
      runs_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_automations_tenant ON crm_automations(tenant_id, enabled);

    CREATE TABLE crm_inventory (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      sku TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      price_cents INTEGER NOT NULL DEFAULT 0,
      stock INTEGER NOT NULL DEFAULT 0,
      category TEXT,
      custom_fields_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(tenant_id, sku)
    );
    CREATE INDEX idx_inventory_tenant ON crm_inventory(tenant_id);

    CREATE TABLE crm_reminders (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      card_id TEXT REFERENCES crm_cards(id) ON DELETE CASCADE,
      contact_id TEXT REFERENCES crm_contacts(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      due_at INTEGER NOT NULL,
      completed_at INTEGER,
      created_by_agent_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_reminders_due ON crm_reminders(due_at) WHERE completed_at IS NULL;
    CREATE INDEX idx_reminders_tenant ON crm_reminders(tenant_id, due_at);
  `);
}
