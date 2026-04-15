/**
 * MemoryDatabase.ts — SQLite database factory for persistent memory
 *
 * Per-tenant SQLite databases stored at ~/.clow/memory/{tenantId}.sqlite3
 * Uses better-sqlite3 (synchronous, Node-native).
 * WAL mode for concurrent read/write.
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { runMigrations } from './MemorySchema.js';

// ════════════════════════════════════════════════════════════════════════════
// Singleton Cache
// ════════════════════════════════════════════════════════════════════════════

const dbCache = new Map<string, Database.Database>();

/**
 * Get or create a SQLite database for the given tenant.
 * Databases are cached per-process and reused.
 */
export function getMemoryDb(tenantId: string = 'default'): Database.Database {
  if (dbCache.has(tenantId)) {
    return dbCache.get(tenantId)!;
  }

  const dbDir = getMemoryDir();
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const dbPath = path.join(dbDir, `${sanitizeTenantId(tenantId)}.sqlite3`);
  const db = new Database(dbPath);

  // Performance settings
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('cache_size = 10000');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  // Run migrations
  runMigrations(db);

  dbCache.set(tenantId, db);
  return db;
}

/**
 * Close all database connections.
 * Call on process shutdown.
 */
export function closeAllMemoryDbs(): void {
  for (const [tenantId, db] of dbCache.entries()) {
    try {
      db.close();
    } catch (err) {
      console.warn(`[Memory] Failed to close DB for tenant ${tenantId}: ${(err as Error).message}`);
    }
  }
  dbCache.clear();
}

/**
 * Close a specific tenant's database.
 */
export function closeMemoryDb(tenantId: string = 'default'): void {
  const db = dbCache.get(tenantId);
  if (db) {
    db.close();
    dbCache.delete(tenantId);
  }
}

/**
 * Get the memory directory path.
 */
export function getMemoryDir(): string {
  return path.join(os.homedir(), '.clow', 'memory');
}

/**
 * Sanitize tenant ID for use as filename.
 */
function sanitizeTenantId(tenantId: string): string {
  return tenantId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'default';
}

/**
 * Get database file size in bytes.
 */
export function getDbSize(tenantId: string = 'default'): number {
  const dbPath = path.join(getMemoryDir(), `${sanitizeTenantId(tenantId)}.sqlite3`);
  try {
    return fs.statSync(dbPath).size;
  } catch {
    return 0;
  }
}
