/**
 * memoryRoutes.ts — Hono API routes for persistent memory
 *
 * Endpoints:
 *   GET /search    — FTS5 full-text search
 *   GET /sessions  — Recent sessions list
 *   GET /sessions/:id/timeline — Observations for a session
 *   DELETE /sessions/:id       — Delete session + cascade (GDPR)
 *   GET /stats     — Memory statistics
 */

import { Hono } from 'hono';
import { MemoryStore } from './MemoryStore.js';
import { RAGEngine } from './ragEngine.js';

/**
 * Resolve tenantId pra rotas de /v1/memory. Fail-closed.
 *
 * Antes: lia `c.req.query('tenant_id') || 'default'` — qualquer user
 * autenticado podia ler/deletar memórias de outro tenant passando
 * `?tenant_id=alvo`. Agora: prioriza tenantId do contexto auth; admin
 * pode passar via query (admin não tem tenantId próprio).
 */
function memTenant(c: any): string {
  const ctxTid = c.get?.('tenantId');
  if (typeof ctxTid === 'string' && ctxTid.trim()) return ctxTid;
  // Sem tenantId no contexto → só admin pode passar via query
  const authMode = c.get?.('authMode');
  if (authMode === 'admin_session' || authMode === 'clow_sonnet') {
    const q = c.req.query('tenant_id');
    if (typeof q === 'string' && q.trim()) return q;
  }
  // Não autenticado ou user sem tenant → bloqueia
  throw new Error('tenant_context_missing');
}

export function buildMemoryRoutes(): Hono {
  const app = new Hono();

  // ─── Search ─────────────────────────────────────────────────────

  app.get('/search', (c) => {
    const q = c.req.query('q') || '';
    let tenantId: string;
    try { tenantId = memTenant(c); } catch { return c.json({ error: 'unauthorized' }, 401); }
    const type = c.req.query('type');
    const limit = parseInt(c.req.query('limit') || '10', 10);

    if (!q) {
      return c.json({ error: 'Query parameter "q" is required' }, 400);
    }

    try {
      const store = new MemoryStore(tenantId);
      const results = store.search(q, { type, limit });
      return c.json({ results, count: results.length });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // ─── Sessions List ──────────────────────────────────────────────

  app.get('/sessions', (c) => {
    let tenantId: string;
    try { tenantId = memTenant(c); } catch { return c.json({ error: 'unauthorized' }, 401); }
    const limit = parseInt(c.req.query('limit') || '10', 10);

    try {
      const store = new MemoryStore(tenantId);
      const sessions = store.getRecentSessions(limit);
      const summaries = sessions.map(s => ({
        ...s,
        summary: store.getSummary(s.session_id),
      }));
      return c.json({ sessions: summaries });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // ─── Session Timeline ───────────────────────────────────────────

  app.get('/sessions/:id/timeline', (c) => {
    const sessionId = c.req.param('id');
    let tenantId: string;
    try { tenantId = memTenant(c); } catch { return c.json({ error: 'unauthorized' }, 401); }

    try {
      const store = new MemoryStore(tenantId);
      const observations = store.getSessionObservations(sessionId);
      return c.json({ session_id: sessionId, observations });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // ─── Delete Session ─────────────────────────────────────────────

  app.delete('/sessions/:id', (c) => {
    const sessionId = c.req.param('id');
    let tenantId: string;
    try { tenantId = memTenant(c); } catch { return c.json({ error: 'unauthorized' }, 401); }

    try {
      const store = new MemoryStore(tenantId);
      const deleted = store.deleteSession(sessionId);
      return c.json({ deleted, session_id: sessionId });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // ─── Semantic Search (RAG) ────────────────────────────────────

  app.get('/semantic', (c) => {
    const q = c.req.query('q') || '';
    let tenantId: string;
    try { tenantId = memTenant(c); } catch { return c.json({ error: 'unauthorized' }, 401); }
    const limit = parseInt(c.req.query('limit') || '10', 10);

    if (!q) return c.json({ error: 'Query "q" required' }, 400);

    try {
      const rag = new RAGEngine(tenantId);
      const results = rag.search(q, limit);
      return c.json({ results, count: results.length, method: 'semantic_embedding' });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // ─── Stats ──────────────────────────────────────────────────────

  app.get('/stats', (c) => {
    let tenantId: string;
    try { tenantId = memTenant(c); } catch { return c.json({ error: 'unauthorized' }, 401); }

    try {
      const store = new MemoryStore(tenantId);
      const memStats = store.getStats();
      let ragStats = { totalEmbeddings: 0, observations: 0, summaries: 0 };
      try {
        const rag = new RAGEngine(tenantId);
        ragStats = rag.getStats();
      } catch {}
      return c.json({ ...memStats, rag: ragStats });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  return app;
}
