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
