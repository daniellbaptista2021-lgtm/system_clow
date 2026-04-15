/**
 * routes.ts — HTTP API Endpoints with SSE Streaming
 *
 * REST API exposing QueryEngine as a service.
 * SSE streaming for real-time tool execution and text deltas.
 *
 * Endpoints:
 *   POST   /v1/sessions                 Create session
 *   POST   /v1/sessions/:id/messages    Send message (SSE stream)
 *   GET    /v1/sessions/:id             Session metadata
 *   GET    /v1/sessions/:id/history     Message history
 *   DELETE /v1/sessions/:id             End session
 *   GET    /v1/sessions                 List active sessions
 *   GET    /health                      Healthcheck
 */

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { getSessionCacheMetrics } from '../api/anthropic.js';
import { randomUUID } from 'crypto';
import { SessionPool, type CreateSessionOptions } from './sessionPool.js';
import { checkQuota } from '../tenancy/quotaGuard.js';
import { incrementUsage } from '../tenancy/tenantStore.js';
import { apiQueue } from './requestQueue.js';
import {
  flushSession,
  recordTranscriptForSession,
} from '../utils/session/sessionStorage.js';
import {
  getTotalCostUSD,
  getTotalInputTokens,
  getTotalOutputTokens,
  runWithExecutionContext,
} from '../bootstrap/state.js';

// ─── Build Routes ───────────────────────────────────────────────────────────

export function buildRoutes(pool: SessionPool): Hono {
  const app = new Hono();

  function getTenantContext(c: unknown): {
    tenant?: Record<string, unknown>;
    tenantId?: string;
    tenantTier?: string;
  } {
    const contextStore = c as { get?: (key: string) => unknown };
    const tenant = contextStore.get?.('tenant') as Record<string, unknown> | undefined;
    const tenantIdValue = contextStore.get?.('tenantId');
    return {
      tenant,
      tenantId: typeof tenantIdValue === 'string' ? tenantIdValue : undefined,
      tenantTier: typeof tenant?.tier === 'string' ? tenant.tier : undefined,
    };
  }

  // ── Health ──────────────────────────────────────────────────────────
  app.get('/health', (c) => {
    return c.json({
      status: 'ok',
      service: 'system-clow',
      version: '1.0.0',
      activeSessions: pool.size,
      uptimeSeconds: Math.floor(process.uptime()),
    });
  });

  // ── Create Session ──────────────────────────────────────────────────
  app.post('/v1/sessions', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const sessionId = body.session_id || randomUUID();
    const { tenant, tenantId, tenantTier } = getTenantContext(c);
    const requestedCwd = typeof body.cwd === 'string' ? body.cwd : process.cwd();
    const tenantWorkspaceRoot =
      typeof tenant?.workspaceRoot === 'string'
        ? tenant.workspaceRoot
        : typeof tenant?.workspace_root === 'string'
          ? tenant.workspace_root
          : undefined;
    const quotaError = tenant ? checkQuota(tenant as any) : null;
    if (quotaError) {
      return c.json({ error: quotaError.code, message: quotaError.message }, quotaError.httpStatus as any);
    }
    const workspaceRoot =
      typeof body.workspace_root === 'string'
        ? body.workspace_root
        : tenantWorkspaceRoot || requestedCwd;

    const sessionMode = body.mode === 'coordinator' || body.coordinator === true ? 'coordinator' : 'server';

    const options: CreateSessionOptions = {
      cwd: requestedCwd,
      workspaceRoot,
      tenantId,
      tenantTier,
      mode: sessionMode,
      maxTurns: body.max_turns,
      maxBudgetUsd: body.max_budget_usd,
      isAdmin: (c as any).get("authMode") === "admin_session",
    };

    try {
      await pool.create(sessionId, options);
      await flushSession();
      return c.json({
        session_id: sessionId,
        status: 'created',
        cwd: options.cwd,
        mode: options.mode,
      }, 201);
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });

  // ── Send Message (SSE Streaming) ────────────────────────────────────
  app.post('/v1/sessions/:id/messages', async (c) => {
    const sessionId = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const message = body.message || body.content || body.prompt;
    const { tenant, tenantId: requestTenantId, tenantTier } = getTenantContext(c);

    if (!message || typeof message !== 'string') {
      return c.json({ error: 'message is required (string)' }, 400);
    }

    const quotaError = tenant ? checkQuota(tenant as any) : null;
    if (quotaError) {
      return c.json({ error: quotaError.code, message: quotaError.message }, quotaError.httpStatus as any);
    }

    let engine = await pool.get(sessionId);
    if (!engine) {
      // Auto-create session if it doesn't exist
      const requestedCwd = typeof body.cwd === 'string' ? body.cwd : process.cwd();
      const tenantWorkspaceRoot =
        typeof tenant?.workspaceRoot === 'string'
          ? tenant.workspaceRoot
          : typeof tenant?.workspace_root === 'string'
            ? tenant.workspace_root
            : undefined;
      engine = await pool.create(sessionId, {
        cwd: requestedCwd,
        workspaceRoot: typeof body.workspace_root === 'string' ? body.workspace_root : tenantWorkspaceRoot || requestedCwd,
        tenantId: requestTenantId,
        tenantTier,
        mode: body.mode === 'coordinator' || body.coordinator === true ? 'coordinator' : 'server',
        isAdmin: (c as any).get("authMode") === "admin_session",
      });
    }

    const sessionMeta = pool.getMetadata(sessionId);
    const requestCwd = sessionMeta?.cwd || process.cwd();
    const workspaceRoot = sessionMeta?.workspaceRoot || requestCwd;
    const tenantId = sessionMeta?.tenantId;

    return streamSSE(c, async (stream) => {
      await runWithExecutionContext({
        sessionId,
        cwd: requestCwd,
        originalCwd: requestCwd,
        projectRoot: workspaceRoot,
        tenantId,
      }, async () => {
        let assistantRecorded = false;
        const costBefore = engine!.getInstanceCostUsd();

        try {
          await recordTranscriptForSession(sessionId, 'user', message);

          for await (const event of engine!.submitMessage(message)) {
            switch (event.type) {
              case 'assistant':
                if (event.content) {
                  await recordTranscriptForSession(sessionId, 'assistant', event.content);
                  assistantRecorded = true;
                }
                await stream.writeSSE({
                  event: 'text_delta',
                  data: JSON.stringify({ text: event.content || '' }),
                });
                break;

              case 'progress':
                await stream.writeSSE({
                  event: 'tool_use',
                  data: JSON.stringify({
                    tool_name: event.toolName,
                    tool_input: event.toolInput,
                  }),
                });
                break;

              case 'system':
                await stream.writeSSE({
                  event: 'system',
                  data: JSON.stringify({
                    subtype: event.subtype,
                    content: event.content,
                  }),
                });
                break;

              case 'result':
                if (!assistantRecorded && event.content) {
                  await recordTranscriptForSession(sessionId, 'assistant', event.content);
                  assistantRecorded = true;
                }
                await stream.writeSSE({
                  event: event.subtype?.startsWith('error') ? 'error' : 'result',
                  data: JSON.stringify({
                    subtype: event.subtype,
                    content: event.content,
                  }),
                });
                break;
            }
          }

          pool.trackMessage(sessionId);
          if (tenantId) {
            incrementUsage(tenantId, {
              messages: 1,
              cost_usd: Math.max(0, engine!.getInstanceCostUsd() - costBefore),
            });
          }
          await flushSession();

          await stream.writeSSE({
            event: 'done',
            data: JSON.stringify({
              session_id: sessionId,
              cost_usd: getTotalCostUSD(),
            }),
          });
        } catch (err: any) {
          await flushSession().catch(() => undefined);
          await stream.writeSSE({
            event: 'error',
            data: JSON.stringify({ message: err.message }),
          });
        }
      });
    });
  });

  // ── Get Session Metadata ────────────────────────────────────────────
  app.get('/v1/sessions/:id', async (c) => {
    const sessionId = c.req.param('id');
    const meta = pool.getMetadata(sessionId);

    if (!meta) {
      return c.json({ error: 'session_not_found' }, 404);
    }

    return c.json({
      session_id: sessionId,
      ...meta,
      cost_usd: getTotalCostUSD(),
      input_tokens: getTotalInputTokens(),
      output_tokens: getTotalOutputTokens(),
    });
  });

  // ── Get Session History ─────────────────────────────────────────────
  app.get('/v1/sessions/:id/history', async (c) => {
    const sessionId = c.req.param('id');
    const engine = await pool.get(sessionId);

    if (!engine) {
      return c.json({ error: 'session_not_found' }, 404);
    }

    const messages = engine.getMessages();
    return c.json({
      session_id: sessionId,
      message_count: messages.length,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content?.slice(0, 2000),
        has_tool_calls: Boolean(m.tool_calls && m.tool_calls.length > 0),
      })),
    });
  });

  // ── Delete Session ──────────────────────────────────────────────────
  app.delete('/v1/sessions/:id', async (c) => {
    const sessionId = c.req.param('id');
    const existed = pool.delete(sessionId);

    return c.json({
      session_id: sessionId,
      deleted: existed,
    });
  });

  // ── List Active Sessions ────────────────────────────────────────────
  app.get('/v1/sessions', (c) => {
    const sessions = pool.listActive();
    return c.json({
      count: sessions.length,
      sessions,
    });
  });

  // ── Session Cache Metrics ───────────────────────────────────────────
  app.get('/v1/sessions/:id/metrics', async (c) => {
    const sessionId = c.req.param('id');
    const engine = await pool.get(sessionId);
    if (!engine) {
      return c.json({ error: 'session_not_found' }, 404);
    }

    const cache = getSessionCacheMetrics();
    return c.json({
      session_id: sessionId,
      cache: {
        total_cached_tokens: cache.totalCachedTokens,
        total_uncached_tokens: cache.totalUncachedTokens,
        total_output_tokens: cache.totalOutputTokens,
        overall_cache_hit_rate: cache.overallCacheHitRate,
        turns_tracked: cache.turnCount,
        cost_actual_usd: cache.totalCostActual,
        cost_uncached_usd: cache.totalCostUncached,
        cost_saved_usd: cache.totalCostSaved,
      },
      instance: {
        cost_usd: engine.getInstanceCostUsd(),
        input_tokens: engine.getInstanceInputTokens(),
        output_tokens: engine.getInstanceOutputTokens(),
        turns: engine.getInstanceTurns(),
        duration_ms: engine.getInstanceDurationMs(),
      },
    });
  });

  return app;
}
