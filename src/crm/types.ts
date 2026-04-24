/**
 * CRM types — shared across the CRM module.
 *
 * All entities are scoped by `tenantId` for multi-tenant isolation.
 */

export type BoardType = 'sales' | 'support' | 'post_sales' | 'billing' | 'custom';
export type ActivityType =
  | 'note'
  | 'message_in'
  | 'message_out'
  | 'call'
  | 'email'
  | 'stage_change'
  | 'assignment'
  | 'system'
  | 'ai_action'
  | 'billing';
export type Channel = 'whatsapp_meta' | 'whatsapp_zapi' | 'email' | 'manual' | 'ai';
export type MediaType = 'text' | 'image' | 'audio' | 'video' | 'document' | 'location' | 'interactive';
export type ChannelType = 'meta' | 'zapi';
export type ChannelStatus = 'active' | 'disabled' | 'error' | 'pending';
export type BillingCycle = 'weekly' | 'monthly' | 'quarterly' | 'yearly' | 'one_time';
export type SubscriptionStatus = 'active' | 'paused' | 'past_due' | 'cancelled' | 'pending';
export type AgentRole = 'owner' | 'admin' | 'agent' | 'viewer';

export interface Board {
  settings?: BoardSettings;
  id: string;
  tenantId: string;
  name: string;
  type: BoardType;
  description?: string;
  position: number;
  createdAt: number;
  updatedAt: number;
}

export interface BoardColumn {
  id: string;
  boardId: string;
  name: string;
  position: number;
  color: string; // hex
  autoRule?: { trigger: string; action: string; params?: Record<string, unknown> } | null;
  isTerminal?: boolean; // e.g. won/lost — closes the deal
  createdAt: number;
}

// ONDA 1 - Contatos Pro: Segments e bulk ops
export interface Segment {
  id: string;
  tenantId: string;
  name: string;
  description?: string;
  filter: SegmentFilter;
  createdAt: number;
  updatedAt: number;
}
export interface SegmentFilter {
  tags?: string[];
  tagsMode?: 'any' | 'all';
  hasPhone?: boolean;
  hasEmail?: boolean;
  company?: string;
  source?: string;
  minLeadScore?: number;
  maxLeadScore?: number;
  createdAfter?: number;
  createdBefore?: number;
  lastInteractionAfter?: number;
  lastInteractionBefore?: number;
  customFieldEquals?: Record<string, string | number | boolean>;
  nameContains?: string;
}
export type BulkContactAction = 'addTag' | 'removeTag' | 'delete' | 'updateField';
export interface BulkContactOp {
  action: BulkContactAction;
  ids: string[];
  payload?: { tag?: string; field?: string; value?: unknown };
}

export interface Contact {
  id: string;
  tenantId: string;
  name: string;
  phone?: string; // E.164
  email?: string;
  avatarUrl?: string;
  tags: string[];
  customFields: Record<string, unknown>;
  notes?: string;
  source?: string; // how the lead came in
  // ONDA 1 Pro — typed fields
  company?: string;
  title?: string;
  website?: string;
  address?: string;
  birthdateTs?: number;
  cpfCnpj?: string;
  leadScore?: number;
  createdAt: number;
  updatedAt: number;
  lastInteractionAt?: number;
}

// ONDA 2 — Kanban Pro
export interface Swimlane {
  id: string; tenantId: string; boardId: string;
  name: string; color: string; position: number; createdAt: number;
}
export interface ChecklistItem {
  id: string; text: string; done: boolean; assignedAgentId?: string; dueDate?: number;
}
export interface Checklist {
  id: string; tenantId: string; cardId: string;
  title: string; items: ChecklistItem[]; createdAt: number; updatedAt: number;
}
export interface BoardSettings {
  wipEnforce?: boolean;                   // se true, bloqueia move pra coluna cheia
  swimlanesEnabled?: boolean;
  defaultSort?: 'position' | 'due_asc' | 'value_desc' | 'priority_desc' | 'updated_desc';
  autoArchiveWonAfterDays?: number;       // arquiva cards won apos N dias
}
export type CardStatus = 'active' | 'archived';
export type ColumnStageType = 'open' | 'won' | 'lost' | 'paused';

export interface Card {
  id: string;
  tenantId: string;
  boardId: string;
  columnId: string;
  title: string;
  description?: string;
  contactId?: string;
  ownerAgentId?: string;
  valueCents: number;
  probability: number; // 0-100
  labels: string[];
  dueDate?: number;
  position: number;
  customFields: Record<string, unknown>;
  // ONDA 2 Pro:
  priority?: number;                      // 1-5
  color?: string;                         // hex
  status?: CardStatus;
  archivedAt?: number;
  swimlaneId?: string;
  createdAt: number;
  updatedAt: number;
  lastActivityAt?: number;
}

export interface Activity {
  id: string;
  tenantId: string;
  cardId?: string;
  contactId?: string;
  type: ActivityType;
  channel: Channel;
  direction?: 'in' | 'out';
  content: string;
  mediaUrl?: string;
  mediaType?: MediaType;
  providerMessageId?: string; // external ID (e.g. wamid)
  createdByAgentId?: string;
  createdAt: number;
  metadata?: Record<string, unknown>;
}

export interface Agent {
  id: string;
  tenantId: string;
  name: string;
  email: string;
  phone?: string;
  role: AgentRole;
  active: boolean;
  apiKeyHash?: string; // agent-scoped API key (optional)
  createdAt: number;
}

export interface Channel2 {
  id: string;
  tenantId: string;
  type: ChannelType;
  name: string;
  status: ChannelStatus;
  // Encrypted credentials JSON (see crypto.ts for encrypt/decrypt)
  credentialsEncrypted: string;
  phoneNumber?: string;
  phoneNumberId?: string; // Meta phone_number_id
  webhookSecret?: string;
  lastInboundAt?: number;
  createdAt: number;
}

export interface Subscription {
  id: string;
  tenantId: string;
  contactId: string;
  cardId?: string;
  planName: string;
  amountCents: number;
  cycle: BillingCycle;
  nextChargeAt: number;
  status: SubscriptionStatus;
  remindersSent: number;
  createdAt: number;
  cancelledAt?: number;
}

export interface Automation {
  id: string;
  tenantId: string;
  name: string;
  enabled: boolean;
  trigger: { type: string; params?: Record<string, unknown> };
  conditions: Array<{ field: string; op: string; value: unknown }>;
  actions: Array<{ type: string; params?: Record<string, unknown> }>;
  lastRunAt?: number;
  runsCount: number;
  createdAt: number;
}

export interface InventoryItem {
  id: string;
  tenantId: string;
  sku: string;
  name: string;
  description?: string;
  priceCents: number;
  stock: number;
  category?: string;
  customFields: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

// ONDA 3 — Agentes Pro
export interface Team {
  id: string; tenantId: string; name: string; color: string;
  description?: string; managerAgentId?: string;
  createdAt: number; updatedAt: number;
}
export interface AgentPermissions {
  cards?: { create?: boolean; edit?: boolean; delete?: boolean; move?: boolean };
  contacts?: { create?: boolean; edit?: boolean; delete?: boolean; export?: boolean };
  channels?: { manage?: boolean; send?: boolean };
  agents?: { manage?: boolean };
  automations?: { manage?: boolean };
  subscriptions?: { manage?: boolean; markPaid?: boolean };
  inventory?: { manage?: boolean };
  reports?: { view?: boolean };
}
export interface AgentMetricsPro {
  agentId: string;
  agentName: string;
  cardsOpen: number;
  cardsWon: number;
  cardsLost: number;
  conversionRate: number;
  totalValueCents: number;
  avgResponseMins: number;
  messagesToday: number;
  lastSeenAt?: number;
  status: 'online' | 'away' | 'offline';
}
export interface SlaRule {
  id: string; tenantId: string;
  teamId?: string; agentId?: string;
  name: string; maxResponseMins: number;
  escalateToAgentId?: string;
  enabled: boolean; createdAt: number;
}

// ONDA 4 — Inbox Pro
export interface Label {
  id: string; tenantId: string; name: string; color: string;
  scope: 'inbox' | 'contact' | 'both'; createdAt: number;
}
export interface QuickReply {
  id: string; tenantId: string;
  title: string; body: string; shortcut?: string; category?: string;
  useCount: number; createdAt: number; updatedAt: number;
}
export interface InboxRule {
  id: string; tenantId: string; name: string;
  keyword?: string; assignToAgentId?: string; assignToTeamId?: string;
  labelId?: string; priority: number; enabled: boolean; createdAt: number;
}

// ONDA 5 — Timeline Pro
export type ActivityTypePro = 'message_in' | 'message_out' | 'note' | 'call' | 'email' | 'meeting' | 'file' | 'system' | 'status_change' | 'card_moved';
export interface ActivityFilter {
  types?: string[];
  agentId?: string;
  contactId?: string;
  cardId?: string;
  dateFrom?: number;
  dateTo?: number;
  hasAttachment?: boolean;
  mentionedAgent?: string;
  isPrivate?: boolean;
}

// ONDA 6 — Lembretes Pro
export type ReminderChannel = 'email' | 'whatsapp' | 'push' | 'in_app';
export type ReminderStatus = 'active' | 'done' | 'skipped' | 'archived';
export interface ReminderPro {
  id: string; tenantId: string;
  title: string; description?: string;
  dueAt: number;
  agentId?: string; contactId?: string; cardId?: string;
  recurrenceRule?: string;           // e.g. 'FREQ=DAILY' 'FREQ=WEEKLY;BYDAY=MO,WE,FR'
  recurrenceEndTs?: number;
  snoozeUntil?: number;
  channels: ReminderChannel[];
  preNotifyMins?: number;
  status: ReminderStatus;
  createdAt: number;
  completedAt?: number;
}

// ONDA 7 — Inventario Pro
export interface InventoryCategory { id: string; tenantId: string; name: string; parentId?: string; createdAt: number; }
export interface InventoryVariant {
  id: string; tenantId: string; inventoryId: string;
  sku: string; name: string; attrs: Record<string, string>;
  stock: number; priceCents?: number; barcode?: string; createdAt: number;
}
export interface InventoryMovement {
  id: string; tenantId: string; inventoryId: string; variantId?: string;
  delta: number; reason?: string; reference?: string; createdByAgentId?: string; createdAt: number;
}

// ONDA 8 — Proposals + Line Items Pro
export type ProposalStatus = 'draft' | 'sent' | 'viewed' | 'accepted' | 'rejected' | 'expired';
export interface Proposal {
  id: string; tenantId: string; cardId: string;
  version: number;
  subtotalCents: number; discountCents: number; taxCents: number; totalCents: number;
  validUntilTs?: number;
  status: ProposalStatus;
  terms?: string;
  signedAt?: number; signedBy?: string; signedIp?: string;
  pdfUrl?: string;
  createdAt: number; updatedAt: number;
}
export interface ProposalTemplate {
  id: string; tenantId: string; name: string;
  items: Array<{ productId?: string; name: string; quantity: number; unitPriceCents: number }>;
  defaultTerms?: string;
  taxPercent?: number;
  discountPercent?: number;
  validForDays?: number;
  createdAt: number;
}

// ONDA 9 — Subscriptions Pro
export interface StripeConnectAccount {
  tenantId: string; stripeAccountId: string;
  status: 'pending' | 'active' | 'restricted' | 'disabled';
  chargesEnabled: boolean; payoutsEnabled: boolean;
  onboardedAt?: number; createdAt: number;
}
export type InvoiceStatus = 'pending' | 'paid' | 'overdue' | 'cancelled' | 'refunded';
export interface InvoicePro {
  id: string; tenantId: string;
  subscriptionId?: string; contactId?: string;
  amountCents: number; status: InvoiceStatus;
  dueAt?: number; paidAt?: number;
  pdfUrl?: string; stripeInvoiceId?: string; paymentMethod?: string;
  createdAt: number;
}
export interface Coupon {
  id: string; tenantId: string; code: string;
  discountPercent?: number; discountCents?: number;
  maxRedemptions?: number; timesRedeemed: number;
  validUntil?: number; active: boolean; createdAt: number;
}
export interface DunningLog {
  id: string; tenantId: string; subscriptionId: string;
  attempt: number; action: string; success: boolean;
  error?: string; createdAt: number;
}
export interface MrrSnapshot {
  totalMrrCents: number;
  activeSubs: number;
  trialSubs: number;
  pastDueSubs: number;
  cancelledMonth: number;
  newMonth: number;
  churnRate: number;
  averageRevenuePerUser: number;
}

// ONDA 10 — Automacoes Pro
export interface AutomationLog {
  id: string; tenantId: string; automationId: string;
  firedAt: number; triggerPayload?: any;
  actionsExecuted: number; success: boolean; error?: string; durationMs?: number;
}

// ONDA 11 — Assignment Pro
export interface AssignmentConditions {
  region?: string;
  minValueCents?: number;
  maxValueCents?: number;
  tags?: string[];            // card labels OR contact tags
  tier?: string;              // contact tier (e.g. lead_score based)
  source?: string;            // contact.source
  channel?: string;           // 'whatsapp_meta'|'whatsapp_zapi'|...
  keyword?: string;           // body/text contains
  timeWindow?: { start: string; end: string; weekdays?: number[] }; // HH:MM
}
export interface AssignmentRule {
  id: string; tenantId: string; name: string;
  conditions: AssignmentConditions;
  assignToAgentId?: string; assignToTeamId?: string;
  skillRequired?: string;
  slaMinutes?: number;
  escalateToAgentId?: string;
  priority: number;
  enabled: boolean;
  createdAt: number;
}
export interface AssignmentLog {
  id: string; tenantId: string; ruleId?: string;
  cardId: string; agentId?: string; teamId?: string;
  escalated: boolean; slaDeadlineTs?: number;
  resolvedAt?: number; createdAt: number;
}
