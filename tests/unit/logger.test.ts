/**
 * logger.test.ts — pino-backed structured logger tests.
 *
 * Verifies:
 *   - JSON output shape (ts, level, env, msg, plus extras)
 *   - level filtering via CLOW_LOG_LEVEL
 *   - request_id auto-injection via AsyncLocalStorage
 *   - tenant_id / user_id auto-injection
 *   - createLogger(component) tags every line
 *   - request middleware sets a fresh request_id per request
 *   - x-request-id header from client is preserved
 *   - metrics + getMetricsSummary track latency / errors
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';

// pino writes to stdout; we capture stdout writes by monkey-patching.
const originalWrite = process.stdout.write.bind(process.stdout);
let captured: string[] = [];

beforeEach(() => {
  captured = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = (chunk: any) => {
    if (typeof chunk === 'string') captured.push(chunk);
    else if (Buffer.isBuffer(chunk)) captured.push(chunk.toString('utf-8'));
    return true;
  };
  // Force production-like JSON output (no pino-pretty transport).
  process.env.NODE_ENV = 'production';
  process.env.CLOW_LOG_LEVEL = 'debug';
  vi.resetModules();
});

afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = originalWrite;
  delete process.env.CLOW_LOG_LEVEL;
});

function lines(): Array<Record<string, unknown>> {
  return captured.flatMap((c) => c.split('\n'))
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter((x): x is Record<string, unknown> => x !== null);
}

describe('logger — JSON output shape', () => {
  it('logger.info emits a JSON line with ts/level/env/msg', async () => {
    const { logger } = await import('../../src/utils/logger.js');
    logger.info('hello world');

    const out = lines();
    expect(out.length).toBeGreaterThan(0);
    const entry = out[out.length - 1]!;
    expect(entry).toMatchObject({
      level: 'info',
      msg: 'hello world',
      env: 'production',
    });
    expect(typeof entry.ts).toBe('string');
    expect(/^\d{4}-\d{2}-\d{2}T/.test(entry.ts as string)).toBe(true);
  });

  it('all levels emit with correct level field', async () => {
    const { logger } = await import('../../src/utils/logger.js');
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    const levels = lines().map((e) => e.level);
    expect(levels).toEqual(expect.arrayContaining(['debug', 'info', 'warn', 'error']));
  });

  it('extra data fields are merged into the JSON line', async () => {
    const { logger } = await import('../../src/utils/logger.js');
    logger.info('order placed', { order_id: 'abc123', amount_cents: 5000 });

    const last = lines().slice(-1)[0]!;
    expect(last.order_id).toBe('abc123');
    expect(last.amount_cents).toBe(5000);
  });
});

describe('logger — level filtering via CLOW_LOG_LEVEL', () => {
  it('CLOW_LOG_LEVEL=warn drops debug+info, keeps warn+error', async () => {
    process.env.CLOW_LOG_LEVEL = 'warn';
    vi.resetModules();
    const { logger } = await import('../../src/utils/logger.js');
    logger.debug('d-msg');
    logger.info('i-msg');
    logger.warn('w-msg');
    logger.error('e-msg');

    const msgs = lines().map((e) => e.msg);
    expect(msgs).not.toContain('d-msg');
    expect(msgs).not.toContain('i-msg');
    expect(msgs).toContain('w-msg');
    expect(msgs).toContain('e-msg');
  });
});

describe('logger — request context', () => {
  it('withRequestContext injects request_id / tenant_id / user_id', async () => {
    const { logger, withRequestContext } = await import('../../src/utils/logger.js');

    withRequestContext({ request_id: 'req-1', tenant_id: 't-1', user_id: 'u-1' }, () => {
      logger.info('inside scope');
    });
    logger.info('outside scope');

    const inside = lines().find((e) => e.msg === 'inside scope')!;
    const outside = lines().find((e) => e.msg === 'outside scope')!;
    expect(inside.request_id).toBe('req-1');
    expect(inside.tenant_id).toBe('t-1');
    expect(inside.user_id).toBe('u-1');
    // outside has no scope — those fields are absent.
    expect(outside.request_id).toBeUndefined();
    expect(outside.tenant_id).toBeUndefined();
  });

  it('AsyncLocalStorage propagates across awaits', async () => {
    const { logger, withRequestContext } = await import('../../src/utils/logger.js');

    await withRequestContext({ request_id: 'req-async' }, async () => {
      await Promise.resolve();
      await new Promise((r) => setImmediate(r));
      logger.info('after async hop');
    });

    const log = lines().find((e) => e.msg === 'after async hop')!;
    expect(log.request_id).toBe('req-async');
  });
});

describe('logger — createLogger(component)', () => {
  it('component tag appears on every line emitted by the child logger', async () => {
    const { createLogger } = await import('../../src/utils/logger.js');
    const log = createLogger('Billing');
    log.info('charged', { cents: 100 });
    log.warn('webhook retry');

    const billingLines = lines().filter((e) => e.component === 'Billing');
    expect(billingLines.length).toBe(2);
    expect(billingLines[0]!.msg).toBe('charged');
    expect(billingLines[1]!.msg).toBe('webhook retry');
  });

  it('startTimer().end() emits a duration field and increments metrics', async () => {
    const { createLogger, getMetricsSummary } = await import('../../src/utils/logger.js');
    const log = createLogger('TestComp');
    const t = log.startTimer('expensive_op');
    await new Promise((r) => setTimeout(r, 5));
    t.end({ rows: 42 });

    const last = lines().slice(-1)[0]!;
    expect(last.operation).toBe('expensive_op');
    expect(last.rows).toBe(42);
    expect(typeof last.durationMs).toBe('number');
    expect(last.durationMs).toBeGreaterThan(0);

    const summary = getMetricsSummary();
    expect(summary.byComponent.TestComp).toBeDefined();
    expect(summary.byComponent.TestComp!.count).toBeGreaterThan(0);
  });
});

describe('requestContextMiddleware (Hono)', () => {
  it('assigns a fresh x-request-id when client did not send one', async () => {
    const { logger, requestContextMiddleware } = await import('../../src/utils/logger.js');
    const app = new Hono();
    app.use('*', requestContextMiddleware());
    app.get('/echo', (c) => {
      logger.info('handling /echo');
      return c.json({ ok: true });
    });

    const r = await app.fetch(new Request('http://localhost/echo'));
    const reqId = r.headers.get('x-request-id');
    expect(reqId).toMatch(/^[0-9a-f-]{36}$/i);

    const log = lines().find((e) => e.msg === 'handling /echo')!;
    expect(log.request_id).toBe(reqId);
  });

  it('preserves the client-supplied x-request-id', async () => {
    const { logger, requestContextMiddleware } = await import('../../src/utils/logger.js');
    const app = new Hono();
    app.use('*', requestContextMiddleware());
    app.get('/x', (c) => {
      logger.info('handling /x');
      return c.json({ ok: true });
    });

    const r = await app.fetch(
      new Request('http://localhost/x', { headers: { 'x-request-id': 'client-trace-99' } }),
    );
    expect(r.headers.get('x-request-id')).toBe('client-trace-99');
    const log = lines().find((e) => e.msg === 'handling /x')!;
    expect(log.request_id).toBe('client-trace-99');
  });
});
