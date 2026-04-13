import { randomUUID, createHash } from 'crypto';
import { findTenantByApiKeyHash, hashApiKey } from '../tenancy/tenantStore.js';
import { Hono } from 'hono';
import type {
  RegisterEnvironmentResponse,
  CreateSessionEnvLessResponse,
  CreateBridgeForSessionResponse,
  ReconnectSessionResponse,
} from '../bridge/types.js';

interface BridgeEnvironmentRecord {
  environmentId: string;
  secret: string;
  registeredAt: string;
  capacity: number;
  metadata?: Record<string, string>;
  lastHeartbeatAt?: string;
  activeSessions: string[];
}

interface BridgeSessionRecord {
  sessionId: string;
  source: string;
  sdkUrl: string;
  workSecret: string;
  workerJwt: string;
  workerJwtExpiresAt: number;
  epoch: number;
  environmentId?: string;
  transportHandle?: string;
  events: Array<Record<string, unknown>>;
  createdAt: number;
  updatedAt: number;
}

const bridgeEnvironments = new Map<string, BridgeEnvironmentRecord>();
const bridgeSessions = new Map<string, BridgeSessionRecord>();

function base64UrlEncode(value: string): string {
  return Buffer.from(value, 'utf-8').toString('base64url');
}

function createWorkerJwt(sessionId: string, expiresAtMs: number): string {
  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64UrlEncode(JSON.stringify({
    sub: sessionId,
    exp: Math.floor(expiresAtMs / 1000),
    iat: Math.floor(Date.now() / 1000),
  }));
  const signature = createHash('sha256').update(`${header}.${payload}.bridge`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

function requireBridgeApiKey(authHeader: string | undefined): boolean {
  if (!authHeader?.startsWith('Bearer ')) return false;
  const token = authHeader.slice(7);

  if (process.env.CLOW_API_KEY && token === process.env.CLOW_API_KEY) {
    return true;
  }

  if (process.env.CLOW_ADMIN_KEY && token === process.env.CLOW_ADMIN_KEY) {
    return true;
  }

  if (token.startsWith('clow_')) {
    return Boolean(findTenantByApiKeyHash(hashApiKey(token)));
  }

  return false;
}

function requireWorkerJwt(authHeader: string | undefined, session: BridgeSessionRecord): boolean {
  return authHeader === `Bearer ${session.workerJwt}`;
}

function buildSdkUrl(c: { req: { url: string } }, sessionId: string): string {
  const url = new URL(c.req.url);
  return `${url.origin}/v1/code/sessions/${sessionId}`;
}

function jsonError(message: string, status: number) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function buildBridgeRoutes(): Hono {
  const app = new Hono();

  app.use('/environments/*', async (c, next) => {
    if (!requireBridgeApiKey(c.req.header('Authorization'))) {
      return jsonError('bridge_unauthorized', 401);
    }
    await next();
  });

  app.use('/environments', async (c, next) => {
    if (!requireBridgeApiKey(c.req.header('Authorization'))) {
      return jsonError('bridge_unauthorized', 401);
    }
    await next();
  });

  app.use('/sessions/env-less', async (c, next) => {
    if (!requireBridgeApiKey(c.req.header('Authorization'))) {
      return jsonError('bridge_unauthorized', 401);
    }
    await next();
  });

  app.use('/sessions/bridge', async (c, next) => {
    if (!requireBridgeApiKey(c.req.header('Authorization'))) {
      return jsonError('bridge_unauthorized', 401);
    }
    await next();
  });

  app.use('/sessions/reconnect', async (c, next) => {
    if (!requireBridgeApiKey(c.req.header('Authorization'))) {
      return jsonError('bridge_unauthorized', 401);
    }
    await next();
  });

  app.post('/environments', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const environmentId = randomUUID();
    const response: RegisterEnvironmentResponse = {
      environmentId,
      secret: randomUUID(),
      registeredAt: new Date().toISOString(),
    };
    bridgeEnvironments.set(environmentId, {
      ...response,
      capacity: typeof body.capacity === 'number' ? body.capacity : 1,
      metadata: typeof body.metadata === 'object' && body.metadata !== null ? body.metadata as Record<string, string> : undefined,
      activeSessions: [],
    });
    return c.json(response, 201);
  });

  app.get('/environments/:id/work', (c) => {
    const env = bridgeEnvironments.get(c.req.param('id'));
    if (!env) return c.json({ error: 'environment_not_found' }, 404);
    return c.json({ work: null });
  });

  app.post('/environments/:id/heartbeat', async (c) => {
    const env = bridgeEnvironments.get(c.req.param('id'));
    if (!env) return c.json({ error: 'environment_not_found' }, 404);
    const body = await c.req.json().catch(() => ({}));
    env.lastHeartbeatAt = new Date().toISOString();
    env.activeSessions = Array.isArray(body.activeSessions)
      ? body.activeSessions.filter((value: unknown): value is string => typeof value === 'string')
      : env.activeSessions;
    return c.json({ ok: true, commands: [] });
  });

  app.post('/environments/:id/work/ack', async (c) => {
    const env = bridgeEnvironments.get(c.req.param('id'));
    if (!env) return c.json({ error: 'environment_not_found' }, 404);
    const body = await c.req.json().catch(() => ({}));
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : undefined;
    if (sessionId && !env.activeSessions.includes(sessionId)) {
      env.activeSessions.push(sessionId);
    }
    return c.json({ ok: true });
  });

  app.post('/environments/:id/work/stop', async (c) => {
    const env = bridgeEnvironments.get(c.req.param('id'));
    if (!env) return c.json({ error: 'environment_not_found' }, 404);
    const body = await c.req.json().catch(() => ({}));
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : undefined;
    if (sessionId) {
      env.activeSessions = env.activeSessions.filter((id) => id !== sessionId);
    }
    return c.json({ ok: true });
  });

  app.delete('/environments/:id', (c) => {
    const existed = bridgeEnvironments.delete(c.req.param('id'));
    return c.json({ ok: existed });
  });

  app.post('/sessions/env-less', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const sessionId = `envless_${randomUUID().slice(0, 12)}`;
    const workSecret = `v2:${randomUUID()}`;
    const workerJwtExpiresAt = Date.now() + 60 * 60_000;
    const workerJwt = createWorkerJwt(sessionId, workerJwtExpiresAt);
    const record: BridgeSessionRecord = {
      sessionId,
      source: typeof body.source === 'string' ? body.source : 'env-less',
      sdkUrl: buildSdkUrl(c, sessionId),
      workSecret,
      workerJwt,
      workerJwtExpiresAt,
      epoch: 1,
      events: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    bridgeSessions.set(sessionId, record);
    const response: CreateSessionEnvLessResponse = {
      sessionId: record.sessionId,
      sdkUrl: record.sdkUrl,
      workSecret: record.workSecret,
      workerJwt: record.workerJwt,
      workerJwtExpiresAt: record.workerJwtExpiresAt,
      epoch: record.epoch,
    };
    return c.json(response, 201);
  });

  app.post('/sessions/bridge', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : undefined;
    const environmentId = typeof body.environmentId === 'string' ? body.environmentId : undefined;
    if (!sessionId || !environmentId) return c.json({ error: 'sessionId and environmentId are required' }, 400);
    const env = bridgeEnvironments.get(environmentId);
    if (!env) return c.json({ error: 'environment_not_found' }, 404);

    const existing = bridgeSessions.get(sessionId);
    const workSecret = existing?.workSecret ?? `v2:${randomUUID()}`;
    const workerJwtExpiresAt = existing?.workerJwtExpiresAt ?? (Date.now() + 60 * 60_000);
    const workerJwt = existing?.workerJwt ?? createWorkerJwt(sessionId, workerJwtExpiresAt);
    const transportHandle = `transport_${randomUUID().slice(0, 12)}`;
    const record: BridgeSessionRecord = {
      sessionId,
      source: existing?.source ?? 'bridge',
      sdkUrl: buildSdkUrl(c, sessionId),
      workSecret,
      workerJwt,
      workerJwtExpiresAt,
      epoch: existing?.epoch ?? 1,
      environmentId,
      transportHandle,
      events: existing?.events ?? [],
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    };
    bridgeSessions.set(sessionId, record);
    if (!env.activeSessions.includes(sessionId)) {
      env.activeSessions.push(sessionId);
    }
    const response: CreateBridgeForSessionResponse = {
      transportHandle,
      sdkUrl: record.sdkUrl,
      workSecret: record.workSecret,
    };
    return c.json(response, 201);
  });

  app.post('/sessions/reconnect', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : undefined;
    if (!sessionId) return c.json({ error: 'sessionId is required' }, 400);
    const session = bridgeSessions.get(sessionId);
    if (!session) return c.json({ error: 'session_not_found' }, 404);
    session.epoch += 1;
    session.updatedAt = Date.now();
    session.workerJwtExpiresAt = Date.now() + 60 * 60_000;
    session.workerJwt = createWorkerJwt(session.sessionId, session.workerJwtExpiresAt);
    const response: ReconnectSessionResponse = {
      sdkUrl: session.sdkUrl,
      workSecret: session.workSecret,
      workerJwt: session.workerJwt,
      workerJwtExpiresAt: session.workerJwtExpiresAt,
      epoch: session.epoch,
    };
    return c.json(response);
  });

  app.post('/v1/code/sessions/:id/events', async (c) => {
    const session = bridgeSessions.get(c.req.param('id'));
    if (!session) return c.json({ error: 'session_not_found' }, 404);
    if (!requireWorkerJwt(c.req.header('Authorization'), session)) {
      return c.json({ error: 'invalid_worker_jwt' }, 401);
    }
    const body = await c.req.json().catch(() => ({}));
    session.events.push(typeof body === 'object' && body !== null ? body as Record<string, unknown> : { payload: body });
    session.updatedAt = Date.now();
    return c.json({ ok: true, received: session.events.length });
  });

  app.get('/v1/code/sessions/:id/events', (c) => {
    const session = bridgeSessions.get(c.req.param('id'));
    if (!session) return c.json({ error: 'session_not_found' }, 404);
    return c.json({ sessionId: session.sessionId, count: session.events.length, events: session.events });
  });

  return app;
}
