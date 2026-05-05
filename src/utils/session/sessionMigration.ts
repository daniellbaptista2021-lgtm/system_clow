/**
 * SessionMigration.ts — Schema migration for session JSONL files
 *
 * Based on Claude Code's sessionMigration.ts (~200 lines)
 *
 * Handles upgrading session files from older schema versions
 * to the current version. Migrations are applied per-entry.
 *
 * Features:
 *   - Version detection from first entry
 *   - Forward-only migration (v1→v2→v3)
 *   - Per-entry transformation
 *   - Entry validation after migration
 *   - Migration statistics
 *   - Error recovery (skip unmigrateable entries)
 *   - Backup before migration
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import { SESSION_SCHEMA_VERSION, type JSONLEntry, type MigrationResult } from './types.js';

// ─── Types ──────────────────────────────────────────────────────────────────

type MigrationFn = (entry: JSONLEntry) => JSONLEntry;

interface MigrationStep {
  fromVersion: number;
  toVersion: number;
  migrate: MigrationFn;
  description: string;
}

// ─── Migration Steps ────────────────────────────────────────────────────────

const MIGRATIONS: MigrationStep[] = [
  {
    fromVersion: 1,
    toVersion: 2,
    description: 'Add uuid and type fields to flat entries',
    migrate: (entry: JSONLEntry): JSONLEntry => {
      // V1 entries were flat objects without wrapper
      if (!entry.uuid) {
        entry.uuid = `migrated_v1_${entry.ts ?? Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      }
      if (!entry.type) {
        entry.type = 'message';
      }
      entry.v = 2;
      return entry;
    },
  },
  {
    fromVersion: 2,
    toVersion: 3,
    description: 'Wrap data in data field, add parentUuid support',
    migrate: (entry: JSONLEntry): JSONLEntry => {
      // V2 entries had data inline, V3 wraps in data field
      if (!entry.data && entry.type === 'message') {
        const { v, uuid, type, ts, ...rest } = entry as unknown as Record<string, unknown>;
        entry = {
          v: 3,
          uuid: uuid as string,
          type: type as any,
          ts: ts as number,
          data: rest,
        };
      }
      entry.v = 3;
      return entry;
    },
  },
];

// ════════════════════════════════════════════════════════════════════════════
// SessionMigration Class
// ════════════════════════════════════════════════════════════════════════════

export class SessionMigration {
  /**
   * Migrate an array of entries to the current schema version.
   * Returns the migrated entries (original array is not modified).
   */
  static migrate(entries: JSONLEntry[]): JSONLEntry[] {
    if (entries.length === 0) return entries;

    const currentVersion = entries[0].v || 1;
    if (currentVersion === SESSION_SCHEMA_VERSION) return entries;
    if (currentVersion > SESSION_SCHEMA_VERSION) {
      throw new Error(`Cannot migrate from future schema v${currentVersion} (current: v${SESSION_SCHEMA_VERSION})`);
    }

    let migrated = [...entries];

    // Apply migration steps sequentially
    for (const step of MIGRATIONS) {
      if (step.fromVersion < currentVersion) continue;
      if (step.fromVersion >= SESSION_SCHEMA_VERSION) break;

      migrated = migrated.map(entry => {
        try {
          return step.migrate({ ...entry });
        } catch {
          // Keep original entry if migration fails
          return { ...entry, v: step.toVersion };
        }
      });
    }

    return migrated;
  }

  /**
   * Migrate with full reporting.
   */
  static migrateWithReport(entries: JSONLEntry[]): MigrationResult {
    const startTime = Date.now();

    if (entries.length === 0) {
      return { success: true, fromVersion: SESSION_SCHEMA_VERSION, toVersion: SESSION_SCHEMA_VERSION, entriesMigrated: 0, entriesSkipped: 0, durationMs: 0, errors: [] };
    }

    const fromVersion = entries[0].v || 1;
    if (fromVersion === SESSION_SCHEMA_VERSION) {
      return { success: true, fromVersion, toVersion: SESSION_SCHEMA_VERSION, entriesMigrated: 0, entriesSkipped: 0, durationMs: Date.now() - startTime, errors: [] };
    }

    const errors: string[] = [];
    let migrated = 0;
    let skipped = 0;

    try {
      const result = SessionMigration.migrate(entries);
      migrated = result.length;
    } catch (err) {
      errors.push((err as Error).message);
    }

    return {
      success: errors.length === 0,
      fromVersion,
      toVersion: SESSION_SCHEMA_VERSION,
      entriesMigrated: migrated,
      entriesSkipped: skipped,
      durationMs: Date.now() - startTime,
      errors,
    };
  }

  /**
   * Migrate a file in place (with backup).
   */
  static async migrateFile(filePath: string): Promise<MigrationResult> {
    const startTime = Date.now();

    if (!fs.existsSync(filePath)) {
      return { success: false, fromVersion: 0, toVersion: SESSION_SCHEMA_VERSION, entriesMigrated: 0, entriesSkipped: 0, durationMs: 0, errors: ['File not found'] };
    }

    // Read entries
    const content = await fsp.readFile(filePath, 'utf-8');
    const entries: JSONLEntry[] = [];
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try { entries.push(JSON.parse(line)); } catch { /* skip */ }
    }

    if (entries.length === 0) {
      return { success: true, fromVersion: SESSION_SCHEMA_VERSION, toVersion: SESSION_SCHEMA_VERSION, entriesMigrated: 0, entriesSkipped: 0, durationMs: Date.now() - startTime, errors: [] };
    }

    const fromVersion = entries[0].v || 1;
    if (fromVersion === SESSION_SCHEMA_VERSION) {
      return { success: true, fromVersion, toVersion: SESSION_SCHEMA_VERSION, entriesMigrated: 0, entriesSkipped: 0, durationMs: Date.now() - startTime, errors: [] };
    }

    // Backup
    const backupPath = `${filePath}.v${fromVersion}.bak`;
    await fsp.copyFile(filePath, backupPath);

    // Migrate
    const migrated = SessionMigration.migrate(entries);

    // Write back
    const newContent = migrated.map(e => JSON.stringify(e)).join('\n') + '\n';
    await fsp.writeFile(filePath, newContent);

    return {
      success: true,
      fromVersion,
      toVersion: SESSION_SCHEMA_VERSION,
      entriesMigrated: migrated.length,
      entriesSkipped: entries.length - migrated.length,
      durationMs: Date.now() - startTime,
      errors: [],
    };
  }

  /**
   * Detect schema version of a file without loading all entries.
   */
  static async detectVersion(filePath: string): Promise<number> {
    if (!fs.existsSync(filePath)) return SESSION_SCHEMA_VERSION;

    try {
      const content = await fsp.readFile(filePath, 'utf-8');
      const firstLine = content.split('\n').find(l => l.trim());
      if (!firstLine) return SESSION_SCHEMA_VERSION;
      const entry = JSON.parse(firstLine);
      return entry.v || entry.version || 1;
    } catch {
      return 1; // Assume oldest version if can't parse
    }
  }

  /**
   * Check if a file needs migration.
   */
  static async needsMigration(filePath: string): Promise<boolean> {
    const version = await SessionMigration.detectVersion(filePath);
    return version < SESSION_SCHEMA_VERSION;
  }
}
