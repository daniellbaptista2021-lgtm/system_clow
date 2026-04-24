/**
 * AI Features — Onda 25.
 *
 * Six flavors:
 *   1. leadScore(cardId)       — deterministic 0-100 based on activity signals
 *   2. nextStep(cardId)         — LLM suggestion for the salesperson's next action
 *   3. summarizeConversation    — LLM digest of recent activities
 *   4. sentiment(messageText)   — rule-based polarity {-1..1} with LLM fallback
 *   5. forecast(boardId)        — probability-weighted pipeline forecast
 *   6. classifyLead(cardId)     — Hot | Warm | Cold based on score + value + signals
 *
 * Results cached in crm_ai_insights with `stale_at` for re-compute scheduling.
 */

import { randomBytes } from 'crypto';
import { getCrmDb } from './schema.js';

function nid(): string { return 'crm_ai_' + randomBytes(6).toString('hex'); }
const now = () => Date.now();

export type InsightKind = 'score' | 'next_step' | 'summary' | 'sentiment' | 'forecast' | 'classification';

export interface Insight {
  id: string;
  tenantId: string;
  entity: 'card' | 'contact' | 'board';
  entityId: string;
  kind: InsightKind;
  scoreNumeric?: number;
  contentText?: string;
  contentJson?: any;
  confidence?: number;
  model?: string;
  computedAt: number;
  staleAt?: number;
}

function storeInsight(tenantId: string, input: Omit<Insight, 'id' | 'tenantId' | 'computedAt'>): Insight {
  const db = getCrmDb();
  // Upsert: one insight per (entity, entity_id, kind)
  const id = nid();
  const t = now();
  db.prepare(`
    INSERT INTO crm_ai_insights (id, tenant_id, entity, entity_id, kind, score_numeric, content_text, content_json, confidence, model, computed_at, stale_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tenant_id, entity, entity_id, kind) DO UPDATE SET
      score_numeric = excluded.score_numeric,
      content_text = excluded.content_text,
      content_json = excluded.content_json,
      confidence = excluded.confidence,
      model = excluded.model,
      computed_at = excluded.computed_at,
      stale_at = excluded.stale_at
  `).run(id, tenantId, input.entity, input.entityId, input.kind,
    input.scoreNumeric ?? null, input.contentText ?? null,
    input.contentJson ? JSON.stringify(input.contentJson) : null,
    input.confidence ?? null, input.model ?? null, t, input.staleAt ?? null);

  const row = db.prepare('SELECT * FROM crm_ai_insights WHERE tenant_id = ? AND entity = ? AND entity_id = ? AND kind = ?')
    .get(tenantId, input.entity, input.entityId, input.kind) as any;
  return rowToInsight(row);
}

function rowToInsight(r: any): Insight {
  return {
    id: r.id, tenantId: r.tenant_id, entity: r.entity, entityId: r.entity_id,
    kind: r.kind, scoreNumeric: r.score_numeric ?? undefined,
    contentText: r.content_text ?? undefined,
    contentJson: r.content_json ? JSON.parse(r.content_json) : undefined,
    confidence: r.confidence ?? undefined, model: r.model ?? undefined,
    computedAt: r.computed_at, staleAt: r.stale_at ?? undefined,
  };
}

export function getInsight(tenantId: string, entity: string, entityId: string, kind: InsightKind): Insight | null {
  const r = getCrmDb().prepare(
    'SELECT * FROM crm_ai_insights WHERE tenant_id = ? AND entity = ? AND entity_id = ? AND kind = ?'
  ).get(tenantId, entity, entityId, kind) as any;
  return r ? rowToInsight(r) : null;
}

export function getAllInsights(tenantId: string, entity: string, entityId: string): Insight[] {
  return (getCrmDb().prepare(
    'SELECT * FROM crm_ai_insights WHERE tenant_id = ? AND entity = ? AND entity_id = ? ORDER BY computed_at DESC'
  ).all(tenantId, entity, entityId) as any[]).map(rowToInsight);
}

// ─── 1) Lead scoring (deterministic algorithm) ─────────────────────────
/**
 * Score 0..100 derived from measurable signals:
 *   - Activity volume in last 14 days (max 25)
 *   - Response rate from contact (max 20)
 *   - Pipeline stage progression (max 20)
 *   - Deal value vs tenant median (max 15)
 *   - Engagement freshness (max 10)
 *   - Proposal view count (max 10)
 */
export function leadScore(tenantId: string, cardId: string): Insight | null {
  const db = getCrmDb();
  const card = db.prepare('SELECT * FROM crm_cards WHERE id = ? AND tenant_id = ?').get(cardId, tenantId) as any;
  if (!card) return null;

  const nowTs = now();
  const d14 = nowTs - 14 * 86400_000;

  // 1) Activity volume (0-25): 10+ activities = max
  const activities14d = (db.prepare(
    'SELECT COUNT(*) n FROM crm_activities WHERE tenant_id = ? AND card_id = ? AND created_at >= ?'
  ).get(tenantId, cardId, d14) as any).n;
  const scoreActivity = Math.min(25, Math.round((activities14d / 10) * 25));

  // 2) Response rate: fraction of outbound that received an inbound reply
  const outbound = (db.prepare(
    "SELECT COUNT(*) n FROM crm_activities WHERE tenant_id = ? AND card_id = ? AND direction = 'out'"
  ).get(tenantId, cardId) as any).n;
  const inbound = (db.prepare(
    "SELECT COUNT(*) n FROM crm_activities WHERE tenant_id = ? AND card_id = ? AND direction = 'in'"
  ).get(tenantId, cardId) as any).n;
  const responseRate = outbound > 0 ? Math.min(1, inbound / outbound) : 0;
  const scoreResponse = Math.round(responseRate * 20);

  // 3) Pipeline stage progression
  const col = db.prepare('SELECT position, stage_type FROM crm_columns WHERE id = ?').get(card.column_id) as any;
  const totalCols = (db.prepare('SELECT COUNT(*) n FROM crm_columns WHERE board_id = ?').get(card.board_id) as any).n || 1;
  let scoreStage = 0;
  if (col?.stage_type === 'won') scoreStage = 20;
  else if (col?.stage_type === 'lost') scoreStage = 0;
  else scoreStage = Math.round(((col?.position ?? 0) / Math.max(1, totalCols - 1)) * 20);

  // 4) Value vs tenant median
  const medianRow = db.prepare(
    'SELECT value_cents FROM crm_cards WHERE tenant_id = ? AND value_cents > 0 ORDER BY value_cents LIMIT 1 OFFSET (SELECT COUNT(*) / 2 FROM crm_cards WHERE tenant_id = ? AND value_cents > 0)'
  ).get(tenantId, tenantId) as any;
  const median = medianRow?.value_cents || 1;
  const ratio = card.value_cents / median;
  const scoreValue = Math.min(15, Math.round(Math.log10(1 + ratio) * 10));

  // 5) Engagement freshness — last activity timestamp
  const lastAct = (db.prepare(
    'SELECT MAX(created_at) t FROM crm_activities WHERE tenant_id = ? AND card_id = ?'
  ).get(tenantId, cardId) as any).t || card.created_at;
  const daysSince = (nowTs - lastAct) / 86400_000;
  const scoreFresh = daysSince <= 1 ? 10
    : daysSince <= 3 ? 7
    : daysSince <= 7 ? 5
    : daysSince <= 14 ? 2
    : 0;

  // 6) Proposal views
  const propViews = (db.prepare(
    'SELECT COALESCE(SUM(viewed_count), 0) n FROM crm_proposals WHERE tenant_id = ? AND card_id = ?'
  ).get(tenantId, cardId) as any).n;
  const scoreProposal = Math.min(10, propViews * 2);

  const total = scoreActivity + scoreResponse + scoreStage + scoreValue + scoreFresh + scoreProposal;
  const finalScore = Math.max(0, Math.min(100, total));

  const breakdown = {
    activity: scoreActivity,
    response: scoreResponse,
    stage: scoreStage,
    value: scoreValue,
    freshness: scoreFresh,
    proposal: scoreProposal,
    signals: { activities14d, outbound, inbound, responseRate, daysSinceLastActivity: Math.round(daysSince), propViews, valueCents: card.value_cents, stageType: col?.stage_type },
  };

  return storeInsight(tenantId, {
    entity: 'card', entityId: cardId, kind: 'score',
    scoreNumeric: finalScore, contentJson: breakdown,
    confidence: 1.0, model: 'deterministic-v1',
    staleAt: nowTs + 6 * 3600_000, // stale after 6h
  });
}

// ─── 2) Next step suggestion (LLM) ─────────────────────────────────────
export async function nextStep(tenantId: string, cardId: string): Promise<Insight | null> {
  const context = gatherCardContext(tenantId, cardId);
  if (!context) return null;

  const system = `Você é um assistente de vendas experiente. Analise o contexto do card de CRM e sugira a próxima ação ideal (uma frase curta, acionável, em português). Considere o estágio, últimas interações, proposta enviada (se houver), tempo desde última interação.`;
  const user = `CARD:
- Título: ${context.card.title}
- Valor: R$ ${(context.card.valueCents / 100).toLocaleString('pt-BR')}
- Etapa: ${context.column?.name} (${context.column?.stage_type})
- Criado: ${new Date(context.card.createdAt).toISOString().slice(0, 10)}
- Última atividade: ${context.lastActivityDaysAgo} dias atrás

CONTATO: ${context.contact?.name || '—'} ${context.contact?.email ? '· ' + context.contact.email : ''}

ÚLTIMAS ATIVIDADES (mais recentes primeiro):
${context.recentActivities.map((a: any) => `- [${a.type}] ${a.content.slice(0, 120)}`).join('\n')}

PROPOSTAS: ${context.proposals.length > 0 ? context.proposals.map((p: any) => `v${p.version} status=${p.status} visualizações=${p.viewed_count || 0}`).join(', ') : 'nenhuma'}

Responda SOMENTE com a sugestão da próxima ação (máx 200 caracteres, sem explicação).`;

  const llm = await callLLM(system, user, 300);
  if (!llm) return null;

  return storeInsight(tenantId, {
    entity: 'card', entityId: cardId, kind: 'next_step',
    contentText: llm.content.trim().slice(0, 500),
    confidence: 0.85, model: llm.model,
    staleAt: now() + 24 * 3600_000,
  });
}

// ─── 3) Conversation summary (LLM) ─────────────────────────────────────
export async function summarizeConversation(tenantId: string, cardId: string): Promise<Insight | null> {
  const context = gatherCardContext(tenantId, cardId);
  if (!context || context.recentActivities.length === 0) return null;

  const system = 'Você resume conversas de vendas. Responda SOMENTE com 3-5 bullet points diretos em português, cada um começando com -. NÃO explique seu raciocínio, NÃO escreva analysis ou draft. Responda diretamente os bullets finais.';
  const user = `Resumir as ${Math.min(20, context.recentActivities.length)} últimas atividades deste card:

${context.recentActivities.slice(0, 20).reverse().map((a: any) => {
    const when = new Date(a.created_at).toISOString().slice(0, 10);
    const who = a.direction === 'in' ? 'CLIENTE' : a.direction === 'out' ? 'EQUIPE' : 'SISTEMA';
    return `[${when}] ${who} (${a.type}): ${a.content.slice(0, 300)}`;
  }).join('\n')}`;

  const llm = await callLLM(system, user, 600);
  if (!llm) return null;

  return storeInsight(tenantId, {
    entity: 'card', entityId: cardId, kind: 'summary',
    contentText: llm.content.trim(),
    confidence: 0.85, model: llm.model,
    staleAt: now() + 12 * 3600_000,
  });
}

// ─── 4) Sentiment detection (rule-based, fast) ─────────────────────────
export function sentimentForText(text: string): { score: number; label: 'positive' | 'neutral' | 'negative'; triggers: string[] } {
  const t = (text || '').toLowerCase();
  const POS = ['obrigado', 'gostei', 'amei', 'perfeito', 'otimo', 'ótimo', 'excelente', 'incrivel', 'incrível', 'maravilha', 'top', 'adorei', 'ficou bom', 'fechado', 'aceito', 'sim', 'confirmo', 'pode enviar', 'bora', 'vamos'];
  const NEG = ['não quero', 'nao quero', 'decepcionado', 'ruim', 'pessimo', 'péssimo', 'horrivel', 'horrível', 'caro demais', 'caro', 'cancelar', 'cancelo', 'desisto', 'nao tenho interesse', 'não tenho interesse', 'nao gostei', 'não gostei', 'reclamar', 'reclamação', 'problema', 'insatisfeito', 'bug', 'quebrou', 'nao funciona', 'nao recebi', 'demorou', 'esperei'];
  const STRONG_NEG = ['cancelar', 'cancelo', 'desisto', 'horrivel', 'péssimo', 'não recebi'];

  const found: string[] = [];
  let pos = 0, neg = 0;
  for (const k of POS) if (t.includes(k)) { pos++; found.push(k); }
  for (const k of NEG) if (t.includes(k)) { neg += STRONG_NEG.includes(k) ? 2 : 1; found.push(k); }

  let score = 0;
  if (pos > 0 || neg > 0) score = (pos - neg) / Math.max(1, pos + neg);
  score = Math.max(-1, Math.min(1, score));

  const label = score > 0.2 ? 'positive' : score < -0.2 ? 'negative' : 'neutral';
  return { score: Math.round(score * 100) / 100, label, triggers: found };
}

export function sentimentForCard(tenantId: string, cardId: string): Insight | null {
  const db = getCrmDb();
  const acts = db.prepare(
    "SELECT content FROM crm_activities WHERE tenant_id = ? AND card_id = ? AND direction = 'in' ORDER BY created_at DESC LIMIT 20"
  ).all(tenantId, cardId) as any[];
  if (acts.length === 0) return null;

  const combined = acts.map(a => a.content).join(' ');
  const result = sentimentForText(combined);
  return storeInsight(tenantId, {
    entity: 'card', entityId: cardId, kind: 'sentiment',
    scoreNumeric: result.score, contentJson: result,
    confidence: result.triggers.length > 0 ? 0.7 : 0.3,
    model: 'rule-based-v1',
    staleAt: now() + 1 * 3600_000,
  });
}

// ─── 5) Forecast (weighted pipeline value) ─────────────────────────────
export interface ForecastResult {
  pipelineTotalCents: number;
  weightedCents: number;       // value × probability × stage_progression
  expectedWinsCount: number;
  horizonDays: number;
  byStage: Array<{ columnId: string; stageName: string; cardCount: number; valueCents: number; weightedCents: number }>;
}

export function forecast(tenantId: string, opts: { boardId?: string; horizonDays?: number } = {}): ForecastResult {
  const db = getCrmDb();
  const horizon = opts.horizonDays || 30;
  const boardFilter = opts.boardId ? 'AND c.board_id = ?' : '';
  const boardParam = opts.boardId ? [opts.boardId] : [];

  // Base win rate for tenant (last 90d)
  const histRow = db.prepare(`
    SELECT
      SUM(CASE WHEN col.stage_type = 'won' THEN 1 ELSE 0 END) wins,
      SUM(CASE WHEN col.stage_type IN ('won','lost') THEN 1 ELSE 0 END) closed
    FROM crm_cards c
    JOIN crm_columns col ON col.id = c.column_id
    WHERE c.tenant_id = ? ${boardFilter} AND c.updated_at >= ?
  `).get(tenantId, ...boardParam, now() - 90 * 86400_000) as any;
  const baseWinRate = histRow.closed > 0 ? histRow.wins / histRow.closed : 0.3;

  // Per-stage: column position / total columns × base win rate × avg deal
  const stages = db.prepare(`
    SELECT col.id, col.name, col.position, col.stage_type, COUNT(c.id) card_count,
      COALESCE(SUM(c.value_cents), 0) value_cents,
      COALESCE(AVG(c.probability), 30) avg_prob
    FROM crm_columns col
    LEFT JOIN crm_cards c ON c.column_id = col.id AND c.tenant_id = ?
    ${opts.boardId ? 'WHERE col.board_id = ?' : ''}
    GROUP BY col.id ORDER BY col.position
  `).all(tenantId, ...(opts.boardId ? [opts.boardId] : [])) as any[];

  const totalOpenCols = Math.max(1, stages.filter(s => s.stage_type === 'open').length);
  let pipelineTotal = 0, weighted = 0, expectedWins = 0;
  const byStage: ForecastResult['byStage'] = [];

  for (const s of stages) {
    if (s.stage_type === 'won' || s.stage_type === 'lost') continue;
    const stageProgression = (s.position + 1) / totalOpenCols;
    const cardProb = Math.min(1, (s.avg_prob || 30) / 100);
    const factor = stageProgression * baseWinRate * (cardProb > 0 ? cardProb : 1);
    const stageWeighted = Math.round(s.value_cents * factor);
    pipelineTotal += s.value_cents;
    weighted += stageWeighted;
    expectedWins += s.card_count * factor;
    byStage.push({
      columnId: s.id, stageName: s.name, cardCount: s.card_count,
      valueCents: s.value_cents, weightedCents: stageWeighted,
    });
  }

  const result: ForecastResult = {
    pipelineTotalCents: pipelineTotal,
    weightedCents: weighted,
    expectedWinsCount: Math.round(expectedWins * 10) / 10,
    horizonDays: horizon,
    byStage,
  };

  storeInsight(tenantId, {
    entity: 'board', entityId: opts.boardId || 'all', kind: 'forecast',
    scoreNumeric: weighted, contentJson: result,
    confidence: histRow.closed >= 10 ? 0.8 : 0.5,
    model: 'weighted-pipeline-v1',
    staleAt: now() + 2 * 3600_000,
  });
  return result;
}

// ─── 6) Lead classification (Hot / Warm / Cold) ────────────────────────
export function classifyLead(tenantId: string, cardId: string): Insight | null {
  // Uses score + value + freshness to bucket
  const scoreIns = getInsight(tenantId, 'card', cardId, 'score') || leadScore(tenantId, cardId);
  if (!scoreIns) return null;
  const score = scoreIns.scoreNumeric || 0;

  const db = getCrmDb();
  const card = db.prepare('SELECT value_cents, last_activity_at, created_at FROM crm_cards WHERE id = ? AND tenant_id = ?').get(cardId, tenantId) as any;
  if (!card) return null;

  const lastAct = card.last_activity_at || card.created_at;
  const daysSince = (now() - lastAct) / 86400_000;

  let label: 'hot' | 'warm' | 'cold';
  let reasoning: string[] = [];

  if (score >= 65 && daysSince <= 3) {
    label = 'hot';
    reasoning.push('Score alto (' + score + ') + atividade recente');
  } else if (score >= 40 && daysSince <= 14) {
    label = 'warm';
    reasoning.push('Score moderado (' + score + ')');
  } else if (score < 30 || daysSince > 21) {
    label = 'cold';
    reasoning.push(score < 30 ? 'Score baixo (' + score + ')' : 'Sem atividade há ' + Math.round(daysSince) + ' dias');
  } else {
    label = 'warm';
    reasoning.push('Sinal misto — score ' + score + ', ' + Math.round(daysSince) + ' dias desde ultima atividade');
  }

  return storeInsight(tenantId, {
    entity: 'card', entityId: cardId, kind: 'classification',
    contentText: label,
    contentJson: { label, score, daysSinceLastActivity: Math.round(daysSince), valueCents: card.value_cents, reasoning },
    confidence: 0.8, model: 'threshold-v1',
    staleAt: now() + 6 * 3600_000,
  });
}

// ─── Helpers ───────────────────────────────────────────────────────────
function gatherCardContext(tenantId: string, cardId: string): any {
  const db = getCrmDb();
  const card = db.prepare('SELECT * FROM crm_cards WHERE id = ? AND tenant_id = ?').get(cardId, tenantId) as any;
  if (!card) return null;
  const column = db.prepare('SELECT * FROM crm_columns WHERE id = ?').get(card.column_id) as any;
  const contact = card.contact_id
    ? (db.prepare('SELECT id, name, email, phone FROM crm_contacts WHERE id = ? AND tenant_id = ?').get(card.contact_id, tenantId) as any)
    : null;
  const recentActivities = db.prepare(
    'SELECT id, type, channel, direction, content, created_at FROM crm_activities WHERE tenant_id = ? AND card_id = ? ORDER BY created_at DESC LIMIT 20'
  ).all(tenantId, cardId) as any[];
  const proposals = db.prepare(
    'SELECT id, version, status, viewed_count FROM crm_proposals WHERE tenant_id = ? AND card_id = ? ORDER BY version DESC'
  ).all(tenantId, cardId) as any[];
  const lastActivityDaysAgo = recentActivities[0]
    ? Math.round((now() - recentActivities[0].created_at) / 86400_000)
    : 999;
  return {
    card: { id: card.id, title: card.title, valueCents: card.value_cents, createdAt: card.created_at },
    column, contact, recentActivities, proposals, lastActivityDaysAgo,
  };
}

async function callLLM(system: string, user: string, maxTokens: number): Promise<{ content: string; model: string } | null> {
  // Call LiteLLM proxy directly in OpenAI-compat format (more reliable than SDK wrappers)
  const base = process.env.ANTHROPIC_BASE_URL || process.env.LITELLM_BASE_URL || 'http://127.0.0.1:4000';
  const model = process.env.CRM_AI_MODEL || process.env.ANTHROPIC_MODEL || 'glm-5.1';
  const key = process.env.ANTHROPIC_API_KEY || process.env.LITELLM_API_KEY || 'sk-anything';
  try {
    const r = await fetch(base + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        max_tokens: maxTokens,
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) {
      console.warn('[ai] LLM http', r.status);
      return null;
    }
    const data = await r.json() as any;
    let content = data?.choices?.[0]?.message?.content || '';
    // GLM sometimes returns only reasoning_content. Extract the final answer heuristically:
    // look for a "Draft 2", "final answer", or the last --- section.
    if (!content) {
      const reasoning = String(data?.choices?.[0]?.message?.reasoning_content || '');
      content = extractFinalAnswer(reasoning);
    }
    return { content: String(content).trim(), model };
  } catch (err: any) {
    console.warn('[ai] LLM call failed:', err?.message);
    return null;
  }
}

// ─── Scheduler hook: rolling auto-score top N stale cards ──────────────
export async function tickAutoScore(limit = 10): Promise<{ scored: number }> {
  const db = getCrmDb();
  // Find open cards without a fresh score insight
  const stale = db.prepare(`
    SELECT c.id, c.tenant_id FROM crm_cards c
    JOIN crm_columns col ON col.id = c.column_id
    LEFT JOIN crm_ai_insights ai ON ai.entity = 'card' AND ai.entity_id = c.id AND ai.kind = 'score'
    WHERE col.stage_type = 'open'
      AND (ai.id IS NULL OR ai.stale_at IS NULL OR ai.stale_at < ?)
    ORDER BY COALESCE(c.last_activity_at, c.updated_at) DESC
    LIMIT ?
  `).all(now(), limit) as any[];

  let scored = 0;
  for (const r of stale) {
    try {
      leadScore(r.tenant_id, r.id);
      classifyLead(r.tenant_id, r.id);
      sentimentForCard(r.tenant_id, r.id);
      scored++;
    } catch (err: any) { console.warn('[ai auto-score]', r.id, err.message); }
  }
  return { scored };
}

function extractFinalAnswer(reasoning: string): string {
  if (!reasoning) return '';
  // Heuristic 1: last "Draft" section (GLM style)
  const drafts = reasoning.split(/\*?\s*Draft\s*\d/i);
  if (drafts.length > 1) {
    const lastDraft = drafts[drafts.length - 1];
    const cleaned = lastDraft.replace(/^[^\n]*:\s*/, '').trim();
    if (cleaned.length > 30 && cleaned.length < 2000) return cleaned;
  }
  // Heuristic 2: look for consecutive bullet lines
  const bulletMatch = reasoning.match(/((?:\s*[-*\u2022]\s*[^\n]+\n?){2,})/);
  if (bulletMatch) return bulletMatch[1].trim();
  // Heuristic 3: last paragraph (split on blank lines, take last non-empty)
  const paras = reasoning.split(/\n\s*\n/).filter((pp: string) => pp.trim().length > 20);
  if (paras.length > 0) return paras[paras.length - 1].trim().slice(0, 1500);
  return reasoning.slice(0, 500);
}
