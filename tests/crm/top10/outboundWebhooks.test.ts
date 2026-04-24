/**
 * TOP 10 #6 — Webhooks de Saida (Onda 23)
 * Testa CRUD + emit + delivery tracking + HMAC signing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes, createHmac } from 'crypto';
import { unlinkSync } from 'fs';
import { createServer } from 'http';

const DB = '/tmp/clow-test-ohk-' + randomBytes(6).toString('hex') + '.db';
process.env.CRM_DB_PATH = DB;

describe('TOP 10 #6 — Webhooks de Saida', () => {
  let ohk: any, schema: any;
  const tid = 'ohk-tenant';
  let server: any, receivedHits: any[] = [];
  const PORT = 14567;

  beforeAll(async () => {
    schema = await import('../../../src/crm/schema.js');
    ohk = await import('../../../src/crm/outboundWebhooks.js');
    schema.getCrmDb();

    // Spin up a tiny HTTP receiver
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        receivedHits.push({
          method: req.method, headers: req.headers, body,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ received: true }));
      });
    });
    await new Promise<void>((resolve) => server.listen(PORT, resolve));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try { unlinkSync(DB); } catch {}
  });

  it('createOutboundWebhook stores config with HMAC secret', () => {
    const hook = ohk.createOutboundWebhook(tid, {
      name: 'Test receiver',
      url: 'http://127.0.0.1:' + PORT + '/hook',
      events: ['contact.created', 'card.won'],
    });
    expect(hook.id).toBeTruthy();
    expect(hook.secret).toBeTruthy();
    expect(hook.events).toContain('contact.created');
  });

  it('listOutboundWebhooks returns tenant hooks', () => {
    const list = ohk.listOutboundWebhooks(tid);
    expect(list.length).toBe(1);
  });

  it('emit fires HTTP POST with HMAC signature + records delivery', async () => {
    receivedHits = [];
    await ohk.emit(tid, 'contact.created', { id: 'ct_test', name: 'Fired' });
    // Wait for the fire-and-forget delivery
    await new Promise(r => setTimeout(r, 500));

    expect(receivedHits.length).toBe(1);
    const hit = receivedHits[0];
    expect(hit.headers['x-clow-event']).toBe('contact.created');
    expect(hit.headers['x-clow-signature']).toBeTruthy();
    expect(hit.headers['x-clow-delivery']).toMatch(/^crm_whd_/);
    // Body contains the payload
    const parsed = JSON.parse(hit.body);
    expect(parsed.event).toBe('contact.created');
    expect(parsed.id).toBe('ct_test');

    // Verify HMAC — recompute and compare
    const hooks = ohk.listOutboundWebhooks(tid);
    const expected = createHmac('sha256', hooks[0].secret).update(hit.body).digest('hex');
    expect(hit.headers['x-clow-signature']).toBe(expected);
  });

  it('listDeliveries shows successful attempt', async () => {
    const hooks = ohk.listOutboundWebhooks(tid);
    const deliveries = ohk.listDeliveries(tid, hooks[0].id);
    expect(deliveries.length).toBeGreaterThanOrEqual(1);
    const d = deliveries[0];
    expect(d.http_status).toBe(200);
    expect(d.attempt_count).toBe(1);
    expect(d.succeeded_at).toBeTruthy();
  });

  it('deliveryStats reports counts', () => {
    const stats = ohk.deliveryStats(tid);
    expect(stats).toHaveProperty('succeeded');
    expect(stats).toHaveProperty('pending');
    expect(stats).toHaveProperty('failed');
    expect(stats.succeeded).toBeGreaterThanOrEqual(1);
  });

  it('emit only fires for subscribed events', async () => {
    receivedHits = [];
    // card.won NOT subscribed — ok, it IS subscribed actually. test unrelated event:
    await ohk.emit(tid, 'task.created', { id: 't1' });
    await new Promise(r => setTimeout(r, 300));
    expect(receivedHits.length).toBe(0);
  });

  it('updateOutboundWebhook toggles enabled flag', () => {
    const hooks = ohk.listOutboundWebhooks(tid);
    const updated = ohk.updateOutboundWebhook(tid, hooks[0].id, { enabled: false });
    expect(updated.enabled).toBe(false);
  });
});
