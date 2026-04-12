/** Cache for expensive context assembly ops (memory walks, tool docs). */

import type { MemoryFileResult } from './types.js';

export class ContextCache {
  private memCache = new Map<string, { result: MemoryFileResult[]; at: number }>();
  private toolDocCache = new Map<string, string>();
  private readonly TTL = 30_000;

  getMemoryFiles(key: string): MemoryFileResult[] | null {
    const c = this.memCache.get(key);
    if (!c || Date.now() - c.at > this.TTL) { this.memCache.delete(key); return null; }
    return c.result;
  }
  setMemoryFiles(key: string, result: MemoryFileResult[]): void { this.memCache.set(key, { result, at: Date.now() }); }
  invalidateMemoryFiles(): void { this.memCache.clear(); }
  getToolDoc(hash: string): string | null { return this.toolDocCache.get(hash) ?? null; }
  setToolDoc(hash: string, doc: string): void { this.toolDocCache.set(hash, doc); }
  clearAll(): void { this.memCache.clear(); this.toolDocCache.clear(); }
}
