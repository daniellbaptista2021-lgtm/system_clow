/**
 * 013 — PR security: tabela de revogacao de tokens (logout / forced revoke).
 *
 * Token blacklist com TTL: ao fazer logout (ou forced revoke), o hash sha256
 * do token vai pra essa tabela junto com expires_at = exp do JWT. verifyUserToken
 * checa essa tabela antes de aceitar. Cleanup periodico remove entries expiradas.
 *
 * Schema:
 *   revoked_tokens (
 *     token_hash TEXT PRIMARY KEY,    -- sha256 hex do token (nao guarda token raw)
 *     revoked_at INTEGER NOT NULL,
 *     expires_at INTEGER NOT NULL,    -- quando podemos limpar
 *     reason TEXT                      -- 'logout' | 'forced' | etc
 *   )
 *
 * Idempotente (CREATE TABLE IF NOT EXISTS).
 */
import type { Database } from 'better-sqlite3';

export const version = 13;
export const description = 'security: revoked_tokens table for logout/revoke';

export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS revoked_tokens (
      token_hash TEXT PRIMARY KEY,
      revoked_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_revoked_tokens_expires ON revoked_tokens(expires_at);
  `);
}

export function down(db: Database): void {
  db.exec('DROP TABLE IF EXISTS revoked_tokens');
}
