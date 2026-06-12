/**
 * tiers.ts — Tier definitions with quotas and features
 *
 * Planos publicos vendidos (https://system-clow.pvcorretor01.com.br/pricing):
 *   STARTER:      R$347/mes
 *   PROFISSIONAL: R$697/mes  (mais escolhido)
 *   EMPRESARIAL:  R$1.297/mes
 *
 * Tiers legacy (`one`, `smart`, `business`) ficam definidos abaixo so pra
 * suportar tenants criados antes da padronizacao dos planos publicos. NAO
 * sao oferecidos no signup nem na pricing page. Nao crie tenant novo neles.
 */

export type TierName = 'starter' | 'profissional' | 'empresarial' | 'one' | 'smart' | 'business';

/** Tiers que aparecem no /pricing publico — unicos aceitos pelo /auth/signup. */
export const PUBLIC_TIERS: TierName[] = ['starter', 'profissional', 'empresarial'];

export interface TierConfig {
  price_brl: number;
  max_messages_per_month: number;
  max_cost_usd_per_month: number;
  max_concurrent_sessions: number;
  max_workspace_size_mb: number;
  // Per-artifact caps (enforced at generation time)
  max_sites_per_month: number;
  max_apps_per_month: number;
  max_spreadsheets_per_month: number;
  max_n8n_flows_active: number;
  // Onda 53 — WhatsApp limits
  // included_whatsapp_numbers: numero gratis incluso no plano (sempre 1)
  // max_whatsapp_numbers: limite total de numeros conectados (1, 5, 10)
  // Z-API extras alem do incluso = (max - included), cobrados R$100/mes cada via Stripe addon
  // Meta Cloud API: ilimitada, gratuita, BYO credentials (so conta no max_whatsapp_numbers)
  included_whatsapp_numbers: number;
  max_whatsapp_numbers: number;
  // Telefones autorizados a comandar a IA via WhatsApp pessoal (whitelist).
  // Diferente de max_whatsapp_numbers (canais conectados pra atender clientes
  // do tenant). Isso aqui e numero de owners/colaboradores que podem mandar
  // mensagem PRA o agente do tenant pedindo trabalhos.
  // Starter:1 / Profissional:3 / Empresarial:5
  max_authorized_phones: number;
  features: string[];
}

// Recalculated with current Claude Sonnet pricing assumptions (April 2026):
// Input miss $0.28/1M, Input hit $0.028/1M (10x discount), Output $0.42/1M
// Cost per message (realistic 50% cache): ~$0.00156 → 500 msgs = $0.78/mo ≈ R$3.90
// Quotas TRIPLED from original — margin stays >95% on all tiers
export const TIERS: Record<TierName, TierConfig> = {
  one: {
    price_brl: 129.90,
    max_messages_per_month: 1500,        // was 500, cost ~R$12 max
    max_cost_usd_per_month: 5,
    max_concurrent_sessions: 3,
    max_workspace_size_mb: 200,
    max_sites_per_month: 3,
    max_apps_per_month: 1,
    max_spreadsheets_per_month: 10,
    max_n8n_flows_active: 1,
    included_whatsapp_numbers: 1,
    max_whatsapp_numbers: 1,
    max_authorized_phones: 1,
    features: ['basic_tools', 'whatsapp'],
  },
  smart: {
    price_brl: 297,
    max_messages_per_month: 6000,        // was 2000, cost ~R$47 max
    max_cost_usd_per_month: 20,
    max_concurrent_sessions: 8,
    max_workspace_size_mb: 1000,
    max_sites_per_month: 15,
    max_apps_per_month: 5,
    max_spreadsheets_per_month: 50,
    max_n8n_flows_active: 2,
    included_whatsapp_numbers: 3,
    max_whatsapp_numbers: 3,
    max_authorized_phones: 3,
    features: ['basic_tools', 'whatsapp', 'agent_tool', 'mcp_basic'],
  },
  profissional: {
    price_brl: 697,
    max_messages_per_month: 3000,
    max_cost_usd_per_month: 60,
    max_concurrent_sessions: 25,
    max_workspace_size_mb: 5000,
    max_sites_per_month: 30,
    max_apps_per_month: 10,
    max_spreadsheets_per_month: 100,
    max_n8n_flows_active: 4,
    included_whatsapp_numbers: 1,
    max_whatsapp_numbers: 5,
    max_authorized_phones: 3,
    features: ['basic_tools', 'whatsapp', 'crm', 'agent_tool', 'mcp_full', 'plan_mode', 'session_resume', 'api', 'webhooks'],
  },
  business: {
    price_brl: 897,
    max_messages_per_month: 100000,      // was 30000, cost ~R$780 max
    max_cost_usd_per_month: 200,
    max_concurrent_sessions: 100,
    max_workspace_size_mb: 20000,
    max_sites_per_month: 100,
    max_apps_per_month: 30,
    max_spreadsheets_per_month: 300,
    max_n8n_flows_active: 8,
    included_whatsapp_numbers: 999,
    max_whatsapp_numbers: 999,
    max_authorized_phones: 5,
    features: ['basic_tools', 'whatsapp', 'agent_tool', 'mcp_full', 'plan_mode', 'session_resume', 'priority', 'custom_skills'],
  },
  starter: {
    price_brl: 347,
    max_messages_per_month: 500,
    max_cost_usd_per_month: 6,
    max_concurrent_sessions: 3,
    max_workspace_size_mb: 500,
    max_sites_per_month: 5,
    max_apps_per_month: 2,
    max_spreadsheets_per_month: 20,
    max_n8n_flows_active: 1,
    included_whatsapp_numbers: 1,
    max_whatsapp_numbers: 1,
    max_authorized_phones: 1,
    features: ['basic_tools', 'whatsapp', 'crm'],
  },
  empresarial: {
    price_brl: 1297,
    max_messages_per_month: 8000,
    max_cost_usd_per_month: 80,
    max_concurrent_sessions: 50,
    max_workspace_size_mb: 10000,
    max_sites_per_month: 100,
    max_apps_per_month: 30,
    max_spreadsheets_per_month: 300,
    max_n8n_flows_active: 8,
    included_whatsapp_numbers: 1,
    max_whatsapp_numbers: 10,
    max_authorized_phones: 5,
    features: ['basic_tools', 'whatsapp', 'crm', 'agent_tool', 'mcp_full', 'plan_mode', 'session_resume', 'whitelabel', 'api', 'webhooks', 'priority_support', 'custom_integrations'],
  },
} as const;

export function getTierConfig(tier: string): TierConfig | null {
  return TIERS[tier as TierName] || null;
}

export function tierHasFeature(tier: string, feature: string): boolean {
  const config = getTierConfig(tier);
  return config ? config.features.includes(feature) : false;
}
