/**
 * SSE event bus — push real-time updates to UI clients.
 *
 * Architecture:
 *   - In-process pub/sub (Node Map of tenantId → Set<writer>)
 *   - Routes: GET /v1/crm/events (server-sent events stream)
 *   - Hot points emit via `publish(tenantId, event)`:
 *     • activity logged → 'activity'
 *     • card created/updated/moved/deleted → 'card.*'
 *     • channel created/updated → 'channel.*'
 *
 * UI strategy:
 *   const es = new EventSource('/v1/crm/events?token=...');
 *   es.addEventListener('activity', e => { const d = JSON.parse(e.data); ... });
 */

type Subscriber = {
  send: (event: string, data: unknown) => void;
  close: () => void;
};

const subscribers = new Map<string, Set<Subscriber>>();

export function subscribe(tenantId: string, sub: Subscriber): () => void {
  if (!subscribers.has(tenantId)) subscribers.set(tenantId, new Set());
  subscribers.get(tenantId)!.add(sub);
  return () => {
    const set = subscribers.get(tenantId);
    if (set) {
      set.delete(sub);
      if (set.size === 0) subscribers.delete(tenantId);
    }
  };
}

export function publish(tenantId: string, event: string, data: unknown): void {
  const set = subscribers.get(tenantId);
  if (!set) return;
  for (const sub of set) {
    try { sub.send(event, data); } catch { /* will be cleaned by close */ }
  }
}

export function subscriberCount(tenantId?: string): number {
  if (tenantId) return subscribers.get(tenantId)?.size || 0;
  let total = 0;
  for (const s of subscribers.values()) total += s.size;
  return total;
}

/** Format SSE payload (event + JSON data + retry hint). */
export function formatSseFrame(event: string, data: unknown): string {
  const json = typeof data === 'string' ? data : JSON.stringify(data);
  // Multi-line data must be prefixed; encode as single-line JSON for simplicity
  return `event: ${event}\ndata: ${json}\n\n`;
}
