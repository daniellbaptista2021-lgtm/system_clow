/**
 * scratchpadManager.ts — Shared workspace for cross-worker data
 *
 * The scratchpad is a directory where workers can read/write data
 * without permission prompts. Used for:
 *   - Sharing research findings between workers
 *   - Persisting data across worker spawns
 *   - Checkpointing progress
 *
 * All keys are sanitized to prevent path traversal.
 * Writes are atomic (tmp + rename).
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import type { ScratchpadEntry } from './types.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_KEY_LENGTH = 100;
const MAX_ENTRY_SIZE = 1024 * 1024; // 1MB per entry
const MAX_TOTAL_SIZE = 50 * 1024 * 1024; // 50MB total

// ════════════════════════════════════════════════════════════════════════════
// ScratchpadManager Class
// ════════════════════════════════════════════════════════════════════════════

export class ScratchpadManager {
  constructor(private readonly scratchpadDir: string) {}

  /**
   * Initialize the scratchpad directory.
   */
  async initialize(): Promise<void> {
    await fsp.mkdir(this.scratchpadDir, { recursive: true });
  }

  /**
   * Write an entry to the scratchpad.
   * Atomic: writes to tmp file, then renames.
   */
  async write(
    key: string,
    value: string,
    writtenBy: string,
    contentType: ScratchpadEntry['contentType'] = 'text',
  ): Promise<void> {
    const safeKey = this.sanitizeKey(key);
    const filePath = path.join(this.scratchpadDir, `${safeKey}.json`);

    // Size check
    if (Buffer.byteLength(value, 'utf-8') > MAX_ENTRY_SIZE) {
      throw new Error(`Scratchpad entry too large (max ${MAX_ENTRY_SIZE} bytes)`);
    }

    // Total size check
    const totalSize = await this.getTotalSize();
    if (totalSize + Buffer.byteLength(value, 'utf-8') > MAX_TOTAL_SIZE) {
      throw new Error(`Scratchpad total size would exceed ${MAX_TOTAL_SIZE} bytes`);
    }

    const entry: ScratchpadEntry = {
      key: safeKey,
      value,
      writtenBy,
      writtenAt: Date.now(),
      contentType,
    };

    // Atomic write
    const tmpPath = `${filePath}.tmp.${Date.now()}`;
    try {
      await fsp.writeFile(tmpPath, JSON.stringify(entry, null, 2));
      await fsp.rename(tmpPath, filePath);
    } catch (err) {
      try { await fsp.unlink(tmpPath); } catch {}
      throw err;
    }
  }

  /**
   * Read an entry from the scratchpad.
   */
  async read(key: string): Promise<ScratchpadEntry | null> {
    const safeKey = this.sanitizeKey(key);
    const filePath = path.join(this.scratchpadDir, `${safeKey}.json`);

    try {
      const content = await fsp.readFile(filePath, 'utf-8');
      return JSON.parse(content) as ScratchpadEntry;
    } catch {
      return null;
    }
  }

  /**
   * Read just the value (convenience method).
   */
  async readValue(key: string): Promise<string | null> {
    const entry = await this.read(key);
    return entry?.value ?? null;
  }

  /**
   * Check if a key exists.
   */
  async has(key: string): Promise<boolean> {
    const safeKey = this.sanitizeKey(key);
    const filePath = path.join(this.scratchpadDir, `${safeKey}.json`);
    return fs.existsSync(filePath);
  }

  /**
   * List all keys in the scratchpad.
   */
  async list(): Promise<string[]> {
    try {
      const files = await fsp.readdir(this.scratchpadDir);
      return files
        .filter(f => f.endsWith('.json') && !f.includes('.tmp.'))
        .map(f => f.replace(/\.json$/, ''));
    } catch {
      return [];
    }
  }

  /**
   * List all entries with metadata.
   */
  async listEntries(): Promise<ScratchpadEntry[]> {
    const keys = await this.list();
    const entries = await Promise.all(keys.map(k => this.read(k)));
    return entries.filter((e): e is ScratchpadEntry => e !== null);
  }

  /**
   * Delete a single entry.
   */
  async delete(key: string): Promise<boolean> {
    const safeKey = this.sanitizeKey(key);
    const filePath = path.join(this.scratchpadDir, `${safeKey}.json`);

    try {
      await fsp.unlink(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Clear the entire scratchpad.
   */
  async clear(): Promise<number> {
    const keys = await this.list();
    let deleted = 0;
    for (const key of keys) {
      if (await this.delete(key)) deleted++;
    }
    return deleted;
  }

  /**
   * Get total size in bytes.
   */
  async getTotalSize(): Promise<number> {
    const keys = await this.list();
    let total = 0;

    for (const key of keys) {
      try {
        const filePath = path.join(this.scratchpadDir, `${key}.json`);
        const stat = await fsp.stat(filePath);
        total += stat.size;
      } catch {}
    }

    return total;
  }

  /**
   * Get entry count.
   */
  async getEntryCount(): Promise<number> {
    return (await this.list()).length;
  }

  /**
   * Get the scratchpad directory path.
   */
  getDir(): string {
    return this.scratchpadDir;
  }

  // ─── Key Sanitization ────────────────────────────────────────────

  /**
   * Sanitize a key to be filesystem-safe.
   * Prevents path traversal and special characters.
   */
  private sanitizeKey(key: string): string {
    return key
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .replace(/_{2,}/g, '_')
      .replace(/^_|_$/g, '')
      .slice(0, MAX_KEY_LENGTH) || 'unnamed';
  }
}
