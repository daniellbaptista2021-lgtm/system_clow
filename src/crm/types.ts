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
  createdAt: number;
  updatedAt: number;
  lastInteractionAt?: number;
}

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
