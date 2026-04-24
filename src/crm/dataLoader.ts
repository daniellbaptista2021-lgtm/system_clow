/**
 * DataLoader — Onda 32.
 *
 * Batch + dedup promises — classic N+1 solution.
 * Pattern: collect all contact ids during one request tick, fetch in single query.
 *
 * Usage in route handlers:
 *   const loader = new DataLoader((ids) => store.getContactsBulk(tenantId, ids));
 *   const contact = await loader.load(cardA.contactId);
 *   const contact2 = await loader.load(cardB.contactId);  // batched in same tick
 */

export class DataLoader<K, V> {
  private queue: Array<{ key: K; resolve: (v: V | null) => void; reject: (e: any) => void }> = [];
  private scheduled = false;
  private cache = new Map<K, V | null>();

  constructor(private batchFn: (keys: K[]) => Promise<Map<K, V>> | Map<K, V>) {}

  load(key: K): Promise<V | null> {
    if (this.cache.has(key)) return Promise.resolve(this.cache.get(key) || null);
    return new Promise((resolve, reject) => {
      this.queue.push({ key, resolve, reject });
      if (!this.scheduled) {
        this.scheduled = true;
        process.nextTick(() => this.flush());
      }
    });
  }

  loadMany(keys: K[]): Promise<(V | null)[]> {
    return Promise.all(keys.map(k => this.load(k)));
  }

  private async flush(): Promise<void> {
    const queue = this.queue;
    this.queue = [];
    this.scheduled = false;
    if (queue.length === 0) return;

    const uniqueKeys = Array.from(new Set(queue.map(q => q.key)));
    try {
      const result = await this.batchFn(uniqueKeys);
      for (const q of queue) {
        const v = result.get(q.key) ?? null;
        this.cache.set(q.key, v);
        q.resolve(v);
      }
    } catch (err) {
      for (const q of queue) q.reject(err);
    }
  }

  clear(): void { this.cache.clear(); }
}

/** Pre-built contact loader helper. */
import { getCrmDb } from './schema.js';
export function contactLoader(tenantId: string): DataLoader<string, any> {
  return new DataLoader<string, any>((ids) => {
    const placeholders = ids.map(() => '?').join(',');
    const rows = getCrmDb().prepare(
      `SELECT id, name, email, phone, avatar_url, source FROM crm_contacts WHERE tenant_id = ? AND id IN (${placeholders})`
    ).all(tenantId, ...ids) as any[];
    const map = new Map<string, any>();
    for (const r of rows) map.set(r.id, r);
    return map;
  });
}

/** Pre-built agent loader. */
export function agentLoader(tenantId: string): DataLoader<string, any> {
  return new DataLoader<string, any>((ids) => {
    const placeholders = ids.map(() => '?').join(',');
    const rows = getCrmDb().prepare(
      `SELECT id, name, email, phone, role, active FROM crm_agents WHERE tenant_id = ? AND id IN (${placeholders})`
    ).all(tenantId, ...ids) as any[];
    const map = new Map<string, any>();
    for (const r of rows) map.set(r.id, r);
    return map;
  });
}
