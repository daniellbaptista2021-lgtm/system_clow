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

export function buildMemoryRoutes(): Hono {
  const app = new Hono();

  // ─── Search ─────────────────────────────────────────────────────

  app.get('/search', (c) => {
    const q = c.req.query('q') || '';
    const tenantId = c.req.query('tenant_id') || 'default';
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
    const tenantId = c.req.query('tenant_id') || 'default';
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
    const tenantId = c.req.query('tenant_id') || 'default';

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
    const tenantId = c.req.query('tenant_id') || 'default';

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
    const tenantId = c.req.query('tenant_id') || 'default';
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
    const tenantId = c.req.query('tenant_id') || 'default';

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
