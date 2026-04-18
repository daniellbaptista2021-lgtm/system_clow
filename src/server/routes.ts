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
import { rateLimiter } from './rateLimiter.js';
import { audit } from '../tenancy/auditLog.js';
import { getTenantWorkspaceDir } from '../tenancy/bashSandbox.js';
import { detectGreeting, handleSlashCommand } from './slashCommands.js';
import { getMissionRunner } from './missions.js';
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

  // ── Helper: Check session ownership ──────────────────────────────
  function checkSessionOwnership(sessionId: string, requestTenantId: string | undefined, isAdmin: boolean): string | null {
    if (isAdmin) return null; // Admin can access everything
    const meta = pool.getMetadata(sessionId);
    if (!meta) return null; // Session not found — will 404 later
    if (meta.tenantId && requestTenantId && meta.tenantId !== requestTenantId) {
      return 'Acesso negado: esta sessao pertence a outro usuario';
    }
    return null;
  }

  // ── Create Session ──────────────────────────────────────────────────
  app.post('/v1/sessions', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const sessionId = body.session_id || randomUUID();
    const { tenant, tenantId, tenantTier } = getTenantContext(c);
    const isAdmin = (c as any).get("authMode") === "admin_session";
    const clientIp = c.req.header('x-real-ip') || c.req.header('x-forwarded-for') || '';

    // Rate limiting (skip for admin)
    if (!isAdmin && tenantId) {
      const rl = rateLimiter.checkSessionCreate(tenantId);
      if (!rl.allowed) {
        audit('rate_limit_exceeded', tenantId || 'unknown', { endpoint: 'session_create', retryAfterMs: rl.retryAfterMs }, undefined, clientIp);
        return c.json({ error: 'rate_limit', message: 'Limite de criacao de sessoes excedido. Tente novamente em breve.' }, 429);
      }
      rateLimiter.recordSessionCreate(tenantId);
    }

    const quotaError = tenant ? checkQuota(tenant as any) : null;
    if (quotaError) {
      audit('quota_exceeded', tenantId || 'unknown', { code: quotaError.code }, undefined, clientIp);
      return c.json({ error: quotaError.code, message: quotaError.message }, quotaError.httpStatus as any);
    }

    // Workspace isolation: regular users get isolated workspace
    let workspaceRoot: string;
    let requestedCwd: string;
    if (isAdmin) {
      requestedCwd = typeof body.cwd === 'string' ? body.cwd : process.cwd();
      const tenantWorkspaceRoot = typeof tenant?.workspaceRoot === 'string' ? tenant.workspaceRoot
        : typeof tenant?.workspace_root === 'string' ? (tenant.workspace_root as string) : undefined;
      workspaceRoot = typeof body.workspace_root === 'string' ? body.workspace_root : tenantWorkspaceRoot || requestedCwd;
    } else {
      // Regular users: locked to their workspace
      workspaceRoot = tenantId ? getTenantWorkspaceDir(tenantId) : process.cwd();
      requestedCwd = workspaceRoot;
    }

    const sessionMode = body.mode === 'coordinator' || body.coordinator === true ? 'coordinator' : 'server';

    const options: CreateSessionOptions = {
      cwd: requestedCwd,
      workspaceRoot,
      tenantId,
      tenantTier,
      mode: sessionMode,
      maxTurns: body.max_turns,
      maxBudgetUsd: body.max_budget_usd,
      isAdmin,
    };

    audit('session_create', tenantId || 'admin', { sessionId, isAdmin, tier: tenantTier }, sessionId, clientIp);

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
    const isAdmin = (c as any).get("authMode") === "admin_session";

    if (!message || typeof message !== 'string') {
      return c.json({ error: 'message is required (string)' }, 400);
    }

    // Session ownership check
    const ownershipError = checkSessionOwnership(sessionId, requestTenantId, isAdmin);
    if (ownershipError) {
      audit('security_violation', requestTenantId || 'unknown', { sessionId, reason: 'session_hijack_attempt' });
      return c.json({ error: 'access_denied', message: ownershipError }, 403);
    }

    // Rate limiting
    if (!isAdmin && requestTenantId) {
      const rl = rateLimiter.checkRequest(requestTenantId, tenantTier || 'one');
      if (!rl.allowed) {
        audit('rate_limit_exceeded', requestTenantId, { endpoint: 'messages' });
        return c.json({ error: 'rate_limit', message: 'Limite de requisicoes excedido. Tente novamente em breve.', retry_after_ms: rl.retryAfterMs }, 429);
      }
      rateLimiter.recordRequest(requestTenantId);
    }

    const quotaError = tenant ? checkQuota(tenant as any) : null;
    if (quotaError) {
      audit('quota_exceeded', requestTenantId || 'unknown', { code: quotaError.code });
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

    // ─── Intercept greetings (instant response, zero LLM) ─────────────
    const greeting = detectGreeting(message);
    if (greeting) {
      await recordTranscriptForSession(sessionId, 'user', message);
      await recordTranscriptForSession(sessionId, 'assistant', greeting);
      return streamSSE(c, async (stream) => {
        await stream.writeSSE({ event: 'text_delta', data: JSON.stringify({ text: greeting }) });
        await stream.writeSSE({ event: 'result', data: JSON.stringify({ subtype: 'success', content: greeting }) });
        await stream.writeSSE({ event: 'done', data: JSON.stringify({ session_id: sessionId, cost_usd: 0 }) });
      });
    }

    // ─── Intercept slash commands ────────────────────────────────────
    const cmdResult = await handleSlashCommand(message, {
      tenantId: tenantId || 'default',
      sessionId,
      isAdmin,
      missionRunner: getMissionRunner(),
    });
    if (cmdResult.handled && cmdResult.response) {
      const response = cmdResult.response;
      await recordTranscriptForSession(sessionId, 'user', message);
      await recordTranscriptForSession(sessionId, 'assistant', response);
      return streamSSE(c, async (stream) => {
        await stream.writeSSE({ event: 'text_delta', data: JSON.stringify({ text: response }) });
        await stream.writeSSE({ event: 'result', data: JSON.stringify({ subtype: 'success', content: response, missionId: cmdResult.missionId }) });
        await stream.writeSSE({ event: 'done', data: JSON.stringify({ session_id: sessionId, cost_usd: 0 }) });
      });
    }

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
    const { tenantId: reqTenantId } = getTenantContext(c);
    const isAdmin = (c as any).get("authMode") === "admin_session";

    const ownershipError = checkSessionOwnership(sessionId, reqTenantId, isAdmin);
    if (ownershipError) return c.json({ error: 'access_denied', message: ownershipError }, 403);

    const meta = pool.getMetadata(sessionId);
    if (!meta) return c.json({ error: 'session_not_found' }, 404);

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
    const { tenantId: reqTenantId } = getTenantContext(c);
    const isAdmin = (c as any).get("authMode") === "admin_session";

    const ownershipError = checkSessionOwnership(sessionId, reqTenantId, isAdmin);
    if (ownershipError) return c.json({ error: 'access_denied', message: ownershipError }, 403);

    const engine = await pool.get(sessionId);
    if (!engine) return c.json({ error: 'session_not_found' }, 404);

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
    const { tenantId: reqTenantId } = getTenantContext(c);
    const isAdmin = (c as any).get("authMode") === "admin_session";

    const ownershipError = checkSessionOwnership(sessionId, reqTenantId, isAdmin);
    if (ownershipError) return c.json({ error: 'access_denied', message: ownershipError }, 403);

    const existed = pool.delete(sessionId);
    audit('session_delete', reqTenantId || 'admin', { sessionId, deleted: existed }, sessionId);

    return c.json({ session_id: sessionId, deleted: existed });
  });

  // ── List Active Sessions ────────────────────────────────────────────
  app.get('/v1/sessions', (c) => {
    const { tenantId: reqTenantId } = getTenantContext(c);
    const isAdmin = (c as any).get("authMode") === "admin_session";

    let sessions = pool.listActive();
    // Regular users only see their own sessions
    if (!isAdmin && reqTenantId) {
      sessions = sessions.filter((s: any) => s.tenantId === reqTenantId);
    }

    return c.json({ count: sessions.length, sessions });
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
