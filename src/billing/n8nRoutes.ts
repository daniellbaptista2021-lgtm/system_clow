/**
 * n8n integration routes + white-label theming.
 *
 * n8n:
 *   - Each tenant gets N pre-provisioned workflow slots (1 / 4 / 8 by plan)
 *   - Templates: atendimento-basico, qualificacao-leads, lembrete-aniversariante,
 *     cobranca-automatica, pos-venda-nps, agendamento-google-calendar, etc
 *   - We don't host n8n instances (too heavy); we host a shared n8n with per-tenant
 *     credentials namespace, OR integrate with n8n.cloud via API.
 *
 *   For now: we store flow metadata on our side (name, template_key, status,
 *   webhook_url). User can provide their own n8n instance URL and we install
 *   the workflows via n8n REST API.
 *
 * White-label:
 *   - Empresarial tier can override: logo_url, primary_color, secondary_color,
 *     brand_name, custom_domain
 *   - Served via GET /v1/branding (public, tenant-scoped by host header)
 */

import { Hono } from 'hono';
import { getTenant, updateTenant, listTenants } from '../tenancy/tenantStore.js';
import { verifyUserToken } from '../auth/authRoutes.js';
import { getCrmDb } from '../crm/schema.js';
import { PLAN_LIMITS, checkResourceLimit } from './quotaGuard.js';

const app = new Hono();

// ─── N8N WORKFLOW TEMPLATES ─────────────────────────────────────────────
export const N8N_TEMPLATES = [
  {
    key: 'atendimento-basico',
    name: 'Atendimento básico 24/7',
    description: 'Responde mensagens fora do horário comercial com opção de escalar pra humano ao detectar palavras-chave (urgente, reclamação, cancelar).',
    category: 'atendimento',
    triggers: ['whatsapp_inbound'],
  },
  {
    key: 'qualificacao-leads',
    name: 'Qualificação automática de leads',
    description: 'Faz 3 perguntas de qualificação (orçamento, prazo, necessidade) e grava resposta no CRM.',
    category: 'vendas',
    triggers: ['whatsapp_inbound'],
  },
  {
    key: 'lembrete-aniversariante',
    name: 'Aniversariante do dia',
    description: 'Todo dia 9h: manda mensagem personalizada pra aniversariantes do CRM com cupom/desconto.',
    category: 'retencao',
    triggers: ['cron_daily'],
  },
  {
    key: 'cobranca-automatica',
    name: 'Cobrança de inadimplentes',
    description: 'Identifica assinaturas em past_due e manda mensagem escalonada (dia 1, 3, 7 após vencimento).',
    category: 'financeiro',
    triggers: ['cron_daily'],
  },
  {
    key: 'pos-venda-nps',
    name: 'NPS pós-venda',
    description: '7 dias após cliente virar Ganho no kanban: pede NPS + review Google.',
    category: 'retencao',
    triggers: ['crm_card_moved'],
  },
  {
    key: 'agendamento-google-calendar',
    name: 'Agendamento via Google Calendar',
    description: 'Cliente escolhe horário via WhatsApp → cria evento no Google Calendar + confirma.',
    category: 'atendimento',
    triggers: ['whatsapp_inbound'],
  },
  {
    key: 'reengajamento-lead-frio',
    name: 'Reengajamento de lead frio',
    description: 'Leads sem interação há 30 dias: manda oferta especial + pergunta interesse.',
    category: 'vendas',
    triggers: ['cron_weekly'],
  },
  {
    key: 'indicacao-cliente',
    name: 'Programa de indicação',
    description: 'Cliente Ganho recebe link único. Toda indicação que fecha gera comissão registrada.',
    category: 'vendas',
    triggers: ['crm_card_moved'],
  },
];

// ─── Ensure table ───────────────────────────────────────────────────────
function ensureFlowsTable(): void {
  const db = getCrmDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS crm_n8n_flows (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      template_key TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      webhook_url TEXT,
      n8n_workflow_id TEXT,
      n8n_instance_url TEXT,
      config_json TEXT,
      runs_count INTEGER NOT NULL DEFAULT 0,
      last_run_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_n8n_tenant ON crm_n8n_flows(tenant_id);
  `);
}

function rowToFlow(r: any) {
  return {
    id: r.id, tenantId: r.tenant_id, name: r.name,
    templateKey: r.template_key, status: r.status,
    webhookUrl: r.webhook_url, n8nWorkflowId: r.n8n_workflow_id, n8nInstanceUrl: r.n8n_instance_url,
    config: r.config_json ? JSON.parse(r.config_json) : {},
    runsCount: r.runs_count, lastRunAt: r.last_run_at ?? undefined, createdAt: r.created_at,
  };
}

// ─── Auth helper ────────────────────────────────────────────────────────
function requireUser(c: any): { tid: string; uid: string; role: string } | null {
  const auth = c.req.header('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  const p = verifyUserToken(token);
  if (!p) return null;
  return { tid: p.tid, uid: p.uid, role: p.role };
}

// ═══ N8N ROUTES ═════════════════════════════════════════════════════════
app.get('/templates', (c) => {
  return c.json({ templates: N8N_TEMPLATES });
});

app.get('/flows', (c) => {
  const u = requireUser(c);
  if (!u) return c.json({ error: 'unauthorized' }, 401);
  ensureFlowsTable();
  const db = getCrmDb();
  const rows = db.prepare('SELECT * FROM crm_n8n_flows WHERE tenant_id = ? ORDER BY created_at ASC').all(u.tid) as any[];
  const tenant: any = getTenant(u.tid);
  const tier = tenant?.tier || 'starter';
  const limit = PLAN_LIMITS[tier]?.flows || 1;
  return c.json({
    flows: rows.map(rowToFlow),
    limit,
    used: rows.filter((r: any) => r.status === 'active').length,
  });
});

app.post('/flows/install-template', async (c) => {
  const u = requireUser(c);
  if (!u) return c.json({ error: 'unauthorized' }, 401);
  const body = await c.req.json().catch(() => ({})) as any;
  const tpl = N8N_TEMPLATES.find((t) => t.key === body.key);
  if (!tpl) return c.json({ error: 'unknown_template' }, 400);

  ensureFlowsTable();
  const db = getCrmDb();

  // Quota check
  const current = db.prepare("SELECT COUNT(*) as n FROM crm_n8n_flows WHERE tenant_id = ? AND status = 'active'").get(u.tid) as any;
  const gate = checkResourceLimit(u.tid, 'flows', current.n);
  if (!gate.allowed) {
    return c.json({ error: 'flow_limit_reached', limit: gate.limit, message: `Seu plano permite ${gate.limit} fluxo(s). Faça upgrade pra mais.` }, 402);
  }

  const id = 'n8n_' + Math.random().toString(36).slice(2, 14);
  const webhookSecret = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  const webhookUrl = `https://system-clow.pvcorretor01.com.br/webhooks/n8n/${u.tid}/${webhookSecret}`;
  db.prepare(`
    INSERT INTO crm_n8n_flows (id, tenant_id, name, template_key, status, webhook_url, config_json, created_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?, ?)
  `).run(id, u.tid, tpl.name, tpl.key, webhookUrl, JSON.stringify(body.config || {}), Date.now());
  return c.json({ ok: true, flow_id: id, webhook_url: webhookUrl, template: tpl }, 201);
});

app.patch('/flows/:id', async (c) => {
  const u = requireUser(c);
  if (!u) return c.json({ error: 'unauthorized' }, 401);
  const body = await c.req.json().catch(() => ({})) as any;
  ensureFlowsTable();
  const db = getCrmDb();
  const fields: string[] = [];
  const values: any[] = [];
  if (body.name !== undefined) { fields.push('name = ?'); values.push(body.name); }
  if (body.status !== undefined) { fields.push('status = ?'); values.push(body.status); }
  if (body.config !== undefined) { fields.push('config_json = ?'); values.push(JSON.stringify(body.config)); }
  if (body.n8n_workflow_id !== undefined) { fields.push('n8n_workflow_id = ?'); values.push(body.n8n_workflow_id); }
  if (body.n8n_instance_url !== undefined) { fields.push('n8n_instance_url = ?'); values.push(body.n8n_instance_url); }
  if (fields.length === 0) return c.json({ error: 'no_fields' }, 400);
  values.push(c.req.param('id'), u.tid);
  db.prepare(`UPDATE crm_n8n_flows SET ${fields.join(', ')} WHERE id = ? AND tenant_id = ?`).run(...values);
  return c.json({ ok: true });
});

app.delete('/flows/:id', (c) => {
  const u = requireUser(c);
  if (!u) return c.json({ error: 'unauthorized' }, 401);
  ensureFlowsTable();
  const db = getCrmDb();
  const r = db.prepare('DELETE FROM crm_n8n_flows WHERE id = ? AND tenant_id = ?').run(c.req.param('id'), u.tid);
  return r.changes > 0 ? c.body(null, 204) : c.json({ error: 'not_found' }, 404);
});

// ═══ BRANDING / WHITE-LABEL ═════════════════════════════════════════════
app.get('/branding', (c) => {
  // Public endpoint: resolve tenant by Host header OR query param
  const host = c.req.header('host') || '';
  const tenantIdQ = c.req.query('tenant_id');
  let tenant: any = null;
  if (tenantIdQ) {
    tenant = getTenant(tenantIdQ);
  } else {
    const all = listTenants();
    tenant = all.find((t: any) => t.custom_domain === host);
  }
  if (!tenant) return c.json({ default: true });
  return c.json({
    brand_name: tenant.brand_name || null,
    logo_url: tenant.logo_url || null,
    primary_color: tenant.primary_color || null,
    secondary_color: tenant.secondary_color || null,
    custom_domain: tenant.custom_domain || null,
    tier: tenant.tier,
    whitelabel_enabled: tenant.tier === 'empresarial',
  });
});

app.put('/branding', async (c) => {
  const u = requireUser(c);
  if (!u) return c.json({ error: 'unauthorized' }, 401);
  const tenant: any = getTenant(u.tid);
  if (tenant?.tier !== 'empresarial') {
    return c.json({ error: 'upgrade_required', message: 'White-label é exclusivo do plano Empresarial.' }, 402);
  }
  const body = await c.req.json().catch(() => ({})) as any;
  const patch: any = {};
  if (body.brand_name !== undefined) patch.brand_name = body.brand_name;
  if (body.logo_url !== undefined) patch.logo_url = body.logo_url;
  if (body.primary_color !== undefined) patch.primary_color = body.primary_color;
  if (body.secondary_color !== undefined) patch.secondary_color = body.secondary_color;
  if (body.custom_domain !== undefined) patch.custom_domain = body.custom_domain;
  updateTenant(u.tid, patch);
  return c.json({ ok: true, ...patch });
});

export default app;
