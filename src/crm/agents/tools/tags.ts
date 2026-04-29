/**
 * Tool aplicar_tag — adiciona tag em crm_card_tags (PR 7.0).
 *
 * Tags sao usadas pra:
 *   - evitar disparar mesmo step de chase/followup duas vezes
 *   - sinalizar estado do lead pro dashboard (querendo_fechar, tem_duvida, etc)
 *   - segmentar leads pra retomada futura
 *
 * Idempotente: PRIMARY KEY em (card_id, tag) impede duplicate.
 */
import { logger } from '../../../utils/logger.js';
import { getCrmDb } from '../../schema.js';
import type { ToolDef } from './types.js';

const aplicarTag: ToolDef = {
  name: 'aplicar_tag',
  description: 'Aplica uma tag estruturada no card. Tags sao usadas pra controle interno (evitar duplicar mensagem, segmentar lead). Use snake_case curto. Exemplos: querendo_fechar, tem_duvida, sem_resposta_30m, qualificado_funeral, interesse_plano_completo, dados_completos.',
  roles: ['*'],
  parameters: {
    type: 'object',
    properties: {
      tag: {
        type: 'string',
        description: 'Tag em snake_case (max 50 chars).',
      },
    },
    required: ['tag'],
  },
  execute(args, ctx) {
    const tag = String(args.tag || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 50);
    if (!tag) return { ok: false, error: 'tag_vazia' };

    try {
      const db = getCrmDb();
      // INSERT OR IGNORE — duplicate (PRIMARY KEY violation) vira no-op
      const stmt = db.prepare(`
        INSERT OR IGNORE INTO crm_card_tags (card_id, tag, applied_at, applied_by)
        VALUES (?, ?, ?, ?)
      `);
      const info = stmt.run(ctx.card.id, tag, Date.now(), ctx.role);
      const inserted = info.changes > 0;
      logger.info(`[tool.aplicar_tag] card=${ctx.card.id} tag=${tag} inserted=${inserted}`);
      return { ok: true, result: { tag, inserted } };
    } catch (err: any) {
      logger.warn(`[tool.aplicar_tag] erro: ${err?.message}`);
      return { ok: false, error: `aplicar_tag_erro: ${err?.message || 'unknown'}` };
    }
  },
};

/** Lista tags do card (pra runner / scheduler verificar). */
export function listCardTags(cardId: string): string[] {
  try {
    const db = getCrmDb();
    const rows = db.prepare(`SELECT tag FROM crm_card_tags WHERE card_id = ?`).all(cardId) as Array<{ tag: string }>;
    return rows.map((r) => r.tag);
  } catch {
    return [];
  }
}

/** Verifica se card tem uma tag especifica. */
export function cardHasTag(cardId: string, tag: string): boolean {
  try {
    const db = getCrmDb();
    const r = db.prepare(`SELECT 1 FROM crm_card_tags WHERE card_id = ? AND tag = ? LIMIT 1`).get(cardId, tag) as { 1?: number } | undefined;
    return !!r;
  } catch {
    return false;
  }
}

/** Aplica tag direto (sem ir pelo LLM) — usado pelo scheduler/runner. */
export function applyTagSystem(cardId: string, tag: string): boolean {
  try {
    const db = getCrmDb();
    const info = db.prepare(`
      INSERT OR IGNORE INTO crm_card_tags (card_id, tag, applied_at, applied_by)
      VALUES (?, ?, ?, 'system')
    `).run(cardId, tag, Date.now());
    return info.changes > 0;
  } catch (err: any) {
    logger.warn(`[applyTagSystem] erro: ${err?.message}`);
    return false;
  }
}

/** Remove tag de um card. Idempotente — DELETE se nao existir e no-op. */
export function removeTagSystem(cardId: string, tag: string): boolean {
  try {
    const db = getCrmDb();
    const info = db.prepare(`DELETE FROM crm_card_tags WHERE card_id = ? AND tag = ?`).run(cardId, tag);
    return info.changes > 0;
  } catch (err: any) {
    logger.warn(`[removeTagSystem] erro: ${err?.message}`);
    return false;
  }
}

/** Lista cardIds que tem uma tag especifica num tenant. JOIN com crm_cards
 *  pra garantir tenant isolation. */
export function listCardIdsByTag(tenantId: string, tag: string, limit = 200): string[] {
  try {
    const db = getCrmDb();
    const rows = db.prepare(`
      SELECT t.card_id AS card_id
      FROM crm_card_tags t
      JOIN crm_cards c ON c.id = t.card_id
      WHERE c.tenant_id = ? AND t.tag = ?
      ORDER BY t.applied_at DESC
      LIMIT ?
    `).all(tenantId, tag, limit) as Array<{ card_id: string }>;
    return rows.map((r) => r.card_id);
  } catch (err: any) {
    logger.warn(`[listCardIdsByTag] erro: ${err?.message}`);
    return [];
  }
}

export const TAG_TOOLS: ToolDef[] = [aplicarTag];
