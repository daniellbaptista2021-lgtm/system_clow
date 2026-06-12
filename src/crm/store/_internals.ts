// CRM _internals module — split out from the legacy monolithic file in a refactor.
// Edit this file directly; scripts/split-store.cjs is retained only as a record
// of how the original was decomposed (it ran once against the .ts.bak snapshot).
/**
 * Internal helpers shared by every src/crm/store/*Store.ts entity file.
 *
 * Lazy-emitter caches (`_emit`, `_autoAssign`, `_commitStock`,
 * `_publishEvent`) live HERE and only here — duplicating them across
 * entity files would create separate cache instances and re-trigger
 * dynamic imports under load.
 *
 * This module is the single source of truth for nid/J/now too.
 */
/**
 * CRM store — Data access layer.
 *
 * All functions require `tenantId`. Never expose raw db to routes.
 * Consistent ID format: `crm_${entity}_${uuid}` (debuggable).
 */

import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import { getCrmDb } from '.././schema.js';
import type {
  Board, BoardColumn, Contact, Card, Activity, Agent, Channel2,
  Subscription, Automation, InventoryItem, BoardType, ActivityType,
  Channel, MediaType, ChannelType, ChannelStatus, BillingCycle, SubscriptionStatus, AgentRole,
} from '.././types.js';

export const now = () => Date.now();
// Lazy-loaded automation emitter (avoids circular import: automations -> store)
let _emit: ((ev: any) => Promise<void>) | null = null;

let _autoAssign: ((tid: string, cid: string) => boolean) | null = null;
export async function getAutoAssign() {
  if (!_autoAssign) {
    try { _autoAssign = (await import('.././assignment.js')).maybeAutoAssign; }
    catch { _autoAssign = () => false; }
  }
  return _autoAssign;
}
let _commitStock: ((tid: string, cid: string) => void) | null = null;
export async function getCommitStock() {
  if (!_commitStock) {
    try { _commitStock = (await import('.././lineItems.js')).commitStockForWonCard; }
    catch { _commitStock = () => {}; }
  }
  return _commitStock;
}
let _publishEvent: ((tid: string, ev: string, data: any) => void) | null = null;
export async function getPublish() {
  if (!_publishEvent) {
    try { _publishEvent = (await import('.././events.js')).publish; }
    catch { _publishEvent = () => {}; }
  }
  return _publishEvent;
}

export async function getEmit() {
  if (!_emit) {
    try {
      const mod = await import('.././automations.js');
      _emit = mod.emit;
    } catch { _emit = async () => {}; }
  }
  return _emit;
}

export const nid = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

// ─── Serialization helpers ──────────────────────────────────────────────
export const J = {
  parse: (s: string | null | undefined, def: any): any => {
    if (!s) return def;
    try { return JSON.parse(s); } catch { return def; }
  },
  stringify: (v: unknown): string => JSON.stringify(v ?? null),
};

// ═══ BOARDS ═════════════════════════════════════════════════════════════

// ═══ COLUMNS ════════════════════════════════════════════════════════════

// ═══ CONTACTS ═══════════════════════════════════════════════════════════

/** Get-or-create — used by WhatsApp webhooks to upsert incoming contacts. */

// ═══ CARDS ══════════════════════════════════════════════════════════════

// Onda 45: posicao MIN-1 pra novos leads aparecerem no TOPO da coluna

/** Move a card to a different column (optionally re-position). Logs a stage_change activity. */

// Onda 59: reorderCard — reorganiza posicoes inteiras sequencialmente

// ═══ ACTIVITIES (timeline) ══════════════════════════════════════════════

// Onda 48: marcar card como lido (zera unread_count)

// ═══ AGENTS ═════════════════════════════════════════════════════════════

// ═══ CHANNELS (Meta / Z-API) ════════════════════════════════════════════

// ═══ SUBSCRIPTIONS (cobrança recorrente) ════════════════════════════════

// ═══ REMINDERS ══════════════════════════════════════════════════════════

// ═══ INVENTORY ══════════════════════════════════════════════════════════

// ═══ SEED DEFAULTS (first-time tenant) ══════════════════════════════════
/**
 * Create a sensible default board ("Pipeline de Vendas") with 6 columns
 * when a tenant accesses the CRM for the first time.
 */

// ═══════════════════════════════════════════════════════════════════════
// ONDA 1 — Contatos Pro: duplicates, merge, import/export, bulk, segments
// ═══════════════════════════════════════════════════════════════════════

import type { Segment, SegmentFilter, BulkContactOp } from '.././types.js';

// Re-list com os campos typed inclusos

// CSV utils — parser manual pra nao depender de lib externa

// Detecta separador (',' ou ';') olhando a primeira linha de header

export interface ImportResult {
  total: number;
  created: number;
  updated: number;
  errors: Array<{ line: number; error: string }>;
  headerDetected?: string[];
}

// Onda 57: normalizacao agressiva de header — lowercase + sem acento + sem caracteres especiais

// Mapa de aliases MUITO amplo — capta variacoes reais de planilhas humanas
export const HEADER_ALIASES: Record<string, string[]> = {
  name: ['name','nome','nome completo','nome cliente','nome do cliente','nome contato','full name','fullname','full_name','cliente','contato','lead','razao social','nome da empresa','nome lead','primeiro nome','nome e sobrenome'],
  phone: ['phone','telefone','whatsapp','wpp','wpp1','wa','celular','tel','fone','numero whatsapp','numero celular','telefone celular','celular telefone','tel celular','telefone1','telefone 1','contato whatsapp','contato','telefone whatsapp','celular wpp'],
  email: ['email','e mail','mail','endereco email','endereco de email','correio eletronico'],
  company: ['company','empresa','organizacao','organization','org','companhia','negocio','nome empresa'],
  title: ['title','cargo','funcao','posicao','profissao','ocupacao','job title'],
  website: ['website','site','url','pagina','homepage','web','www'],
  address: ['address','endereco','endereço','rua','logradouro','endereco completo','endereco residencial'],
  cpfCnpj: ['cpf','cnpj','cpf cnpj','cnpj cpf','cpfcnpj','cnpjcpf','documento','doc','cpf_cnpj','cnpj_cpf','rg cpf','cpf rg'],
  notes: ['notes','observacoes','observacao','obs','notas','comentarios','comentario','descricao','description'],
  tags: ['tags','tag','etiquetas','etiqueta','categorias','categoria','grupo'],
  source: ['source','origem','canal','fonte','captado em','captacao','origem medium','origem source','origem campaign','origem campanha','utm source','utm medium','utm campaign'],
  birthdateTs: ['birthdate','nascimento','data de nascimento','data nascimento','dt nascimento','aniversario'],
};

// Constroi mapa header_normalizado → campo_canonico

// Limpa telefone: mantem so digitos

// ─── Segments ──────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════
// ONDA 2 — Kanban Pro: WIP limits, archive, checklists, swimlanes
// ═══════════════════════════════════════════════════════════════════════

import type { Swimlane, Checklist, ChecklistItem, BoardSettings, ColumnStageType } from '.././types.js';

// ─── WIP limits & column settings ─────────────────────────────────

// ─── Archive ───────────────────────────────────────────────────────

// ─── Board settings ────────────────────────────────────────────────

// ─── Swimlanes ─────────────────────────────────────────────────────

// ─── Checklists ────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════
// ONDA 3 — Agentes Pro: teams, perms, status, SLA, metrics
// ═══════════════════════════════════════════════════════════════════════
import type { Team, AgentPermissions, AgentMetricsPro, SlaRule,
              Label, QuickReply, InboxRule } from '.././types.js';

// SLA

// ═══════════════════════════════════════════════════════════════════════
// ONDA 4 — Inbox Pro
// ═══════════════════════════════════════════════════════════════════════

// Attach label to activity

// Quick replies

// Inbox rules + engine

// Auto-assign: passa texto + cardId, aplica rules em ordem de priority

// Mark read/unread

// ═══════════════════════════════════════════════════════════════════════
// ONDA 5 — Timeline Pro
// ═══════════════════════════════════════════════════════════════════════
import type { ActivityFilter, ReminderChannel, ReminderStatus, ReminderPro } from '.././types.js';

// ═══════════════════════════════════════════════════════════════════════
// ONDA 6 — Lembretes Pro
// ═══════════════════════════════════════════════════════════════════════

// Very lightweight RRULE-ish advancer:
// Suporta FREQ=DAILY|WEEKLY|MONTHLY|YEARLY; INTERVAL=N

// ═══════════════════════════════════════════════════════════════════════
// ONDA 7 — Inventario Pro
// ═══════════════════════════════════════════════════════════════════════
import type { InventoryCategory, InventoryVariant, InventoryMovement,
              Proposal, ProposalStatus, ProposalTemplate } from '.././types.js';

// ═══════════════════════════════════════════════════════════════════════
// ONDA 8 — Proposals (Line Items Pro)
// ═══════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════
// ONDA 9 — Subscriptions Pro, Stripe Connect, Invoices, Coupons, Dunning
// ═══════════════════════════════════════════════════════════════════════
import type { StripeConnectAccount, InvoicePro, InvoiceStatus, Coupon, DunningLog, MrrSnapshot } from '.././types.js';

// --- Stripe Connect ---

// --- Invoices ---

// --- Coupons ---

// --- Dunning log ---

// --- MRR Dashboard ---

// ═══════════════════════════════════════════════════════════════════════
// ONDA 10 — Automacoes Pro (cron, webhook, logs)
// ═══════════════════════════════════════════════════════════════════════
import type { AutomationLog, AssignmentRule, AssignmentConditions, AssignmentLog } from '.././types.js';

// Webhook incoming trigger for automations

// ═══════════════════════════════════════════════════════════════════════
// ONDA 11 — Assignment Rules Pro
// ═══════════════════════════════════════════════════════════════════════

// Context used by evaluator
export interface EvalContext {
  card: any;
  contact?: any;
  channel?: string;
  keyword?: string;
}

// ═══════════════════════════════════════════════════════════════════════
// ONDA 12 — Canais + SSE + Midia upgrade
// ═══════════════════════════════════════════════════════════════════════
import type { ChannelTemplate, ChannelHealth, ChannelMetrics } from '.././types.js';

// Templates registry

// Sync templates from Meta

