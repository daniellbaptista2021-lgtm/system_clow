/**
 * BridgePointer.ts — Persistent pointer file for crash recovery
 *
 * Stores environment ID and session state on disk so the bridge
 * can reconnect after a crash without re-registering.
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import type { BridgePointer as BridgePointerType } from '../types.js';

const POINTER_FILE = 'bridge-pointer.json';

export class BridgePointerManager {
  private readonly pointerPath: string;

  constructor(clowHome: string = path.join(os.homedir(), '.clow')) {
    this.pointerPath = path.join(clowHome, POINTER_FILE);
  }

  async load(): Promise<BridgePointerType | null> {
    if (!fs.existsSync(this.pointerPath)) return null;
    try {
      const content = await fsp.readFile(this.pointerPath, 'utf-8');
      return JSON.parse(content) as BridgePointerType;
    } catch {
      return null;
    }
  }

  async save(pointer: BridgePointerType): Promise<void> {
    await fsp.mkdir(path.dirname(this.pointerPath), { recursive: true });
    const tmp = `${this.pointerPath}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(pointer, null, 2));
    await fsp.rename(tmp, this.pointerPath);
  }

  async clear(): Promise<void> {
    try { await fsp.unlink(this.pointerPath); } catch {}
  }

  async exists(): Promise<boolean> {
    return fs.existsSync(this.pointerPath);
  }

  async isStale(maxAgeMs: number = 24 * 60 * 60_000): Promise<boolean> {
    const pointer = await this.load();
    if (!pointer) return true;
    return Date.now() - pointer.createdAt > maxAgeMs;
  }

  async updatePid(): Promise<void> {
    const pointer = await this.load();
    if (!pointer) return;
    pointer.lastPid = process.pid;
    await this.save(pointer);
  }
}
