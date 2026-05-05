/**
 * tokenRevocation.ts — blacklist de tokens revogados (logout / forced revoke).
 *
 * Como funciona:
 *   - Token = `usr.<body>.<sig>` ou `<adm body>.<sig>` (HMAC-signed JWT-like).
 *   - Revogar = persistir sha256(token) com expires_at = exp do JWT.
 *   - Verify = `verifyUserToken` / `verifyAdminSessionToken` consultam aqui
 *     ANTES de aceitar — token revogado retorna null mesmo com sig valida.
 *   - Cleanup periodico remove entries onde expires_at < now (no proximo
 *     scheduler.tick, baixo overhead).
 *
 * Trade-offs:
 *   - In-memory cache evita 1 query por request HTTP autenticado.
 *   - DB (revoked_tokens) garante persistencia entre reloads.
 */

import { createHash } from 'node:crypto';
import { getCrmDb } from '../crm/schema.js';
import { logger } from '../utils/logger.js';

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Revoga um token. `expiresAt` deve ser o exp do JWT em ms.
 * Idempotente: revogar 2x nao falha.
 */
export function revokeToken(token: string, expiresAt: number, reason = 'logout'): void {
  if (!token) return;
  const hash = tokenHash(token);
  try {
    const db = getCrmDb();
    db.prepare(
      'INSERT OR REPLACE INTO revoked_tokens (token_hash, revoked_at, expires_at, reason) VALUES (?, ?, ?, ?)',
    ).run(hash, Date.now(), expiresAt, reason);
  } catch (err: any) {
    logger.warn('[tokenRevocation] persist falhou:', err?.message);
  }
}

/**
 * Retorna true se o token foi revogado. Le direto do SQLite (PK indexed,
 * <1ms). Sem cache em memoria pra evitar inconsistencia entre workers PM2
 * (worker A revoga, worker B veria tarde demais com cache).
 */
export function isTokenRevoked(token: string | undefined): boolean {
  if (!token) return false;
  try {
    const db = getCrmDb();
    const row = db.prepare('SELECT 1 FROM revoked_tokens WHERE token_hash = ? AND expires_at > ?').get(tokenHash(token), Date.now());
    return !!row;
  } catch (err: any) {
    // Tabela ainda nao migrada (testes legacy) — fail-open
    return false;
  }
}

/**
 * Cleanup de entries expiradas. Chamado pelo scheduler diario.
 */
export function cleanupExpiredRevocations(): { removed: number } {
  try {
    const now = Date.now();
    const db = getCrmDb();
    const r = db.prepare('DELETE FROM revoked_tokens WHERE expires_at <= ?').run(now);
    return { removed: r.changes };
  } catch (err: any) {
    logger.warn('[tokenRevocation] cleanup falhou:', err?.message);
    return { removed: 0 };
  }
}

/** Apenas pra testes — limpa DB. */
export function _resetForTests(): void {
  try {
    const db = getCrmDb();
    db.prepare('DELETE FROM revoked_tokens').run();
  } catch { /* tabela ainda nao existe — OK */ }
}
