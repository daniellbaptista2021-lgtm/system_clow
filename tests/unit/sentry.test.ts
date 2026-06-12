/**
 * sentry.ts — sensitive-data filter tests.
 *
 * Don't init Sentry (no DSN). We exercise the pure-function exports:
 *   sentryBeforeSend(event)  — Sentry's main filter hook
 *   shouldStripBody(path)    — path-based body-strip predicate
 *   captureException(err, ctx) — no-op when not initialized
 *
 * The whole point: a misconfigured Sentry must NEVER ship raw passwords,
 * Stripe webhook payloads, or auth tokens to the cloud. These tests pin
 * that behavior so a regression on the redaction list trips the CI.
 */
import { describe, it, expect } from 'vitest';
import {
  sentryBeforeSend,
  shouldStripBody,
  captureException,
  isSentryEnabled,
} from '../../src/utils/sentry.js';
import type { ErrorEvent } from '@sentry/node';

function event(req: Partial<ErrorEvent['request']> & { url?: string } = {}, extra: Record<string, unknown> = {}): ErrorEvent {
  return {
    type: undefined,
    event_id: 'evt_test',
    request: { url: 'http://localhost/v1/crm/contacts', ...req } as ErrorEvent['request'],
    extra,
  } as ErrorEvent;
}

describe('shouldStripBody — sensitive route detector', () => {
  it.each([
    ['/auth/signup',                              true],
    ['/auth/login',                               true],
    ['/auth/authorized-phones',                   true],
    ['/webhooks/stripe',                          true],
    ['/webhooks/stripe/foo',                      true],
    ['/v1/crm/channels/abc/credentials',          true],
    ['/v1/crm/channels/abc/credentials/rotate',   true],
    ['/v1/crm/contacts',                          false],
    ['/health/live',                              false],
    ['/webhooks/crm/zapi/secret',                 false],   // intentional: only Stripe webhooks have signing secrets in body
    ['/v1/crm/channels',                          false],
  ])('shouldStripBody(%s) = %s', (path, expected) => {
    expect(shouldStripBody(path)).toBe(expected);
  });
});

describe('sentryBeforeSend — body strip on sensitive paths', () => {
  it('strips request.data on /auth/signup', () => {
    const e = event(
      { url: 'https://api.example.com/auth/signup', data: { email: 'x@y.com', password: 'mySecret123' } },
    );
    const out = sentryBeforeSend(e);
    expect(out!.request!.data).toBe('[Filtered: sensitive route]');
  });

  it('strips request.data on /webhooks/stripe', () => {
    const e = event({
      url: 'https://api.example.com/webhooks/stripe',
      data: { id: 'evt_x', data: { object: { customer: 'cus_x' } } },
    });
    const out = sentryBeforeSend(e);
    expect(out!.request!.data).toBe('[Filtered: sensitive route]');
  });

  it('strips request.data on /v1/crm/channels/:id/credentials', () => {
    const e = event({
      url: 'https://api.example.com/v1/crm/channels/abc/credentials',
      data: { token: 'super-secret' },
    });
    const out = sentryBeforeSend(e);
    expect(out!.request!.data).toBe('[Filtered: sensitive route]');
  });

  it('does NOT strip request.data on regular CRM routes', () => {
    const e = event({
      url: 'https://api.example.com/v1/crm/contacts',
      data: { name: 'João', phone: '+5511999999999' },
    });
    const out = sentryBeforeSend(e);
    expect(out!.request!.data).toEqual({ name: 'João', phone: '+5511999999999' });
  });
});

describe('sentryBeforeSend — header redaction (always)', () => {
  it('strips Authorization, Cookie, x-api-key, stripe-signature, x-hub-signature*', () => {
    const e = event({
      url: 'https://api.example.com/v1/crm/contacts',
      headers: {
        authorization: 'Bearer clow_live_xxxxxxxxxxxxxxxxxxxxxxxx',
        cookie: 'session=abc123',
        'x-api-key': 'secret',
        'stripe-signature': 't=1,v1=abcdef',
        'x-hub-signature-256': 'sha256=deadbeef',
        'content-type': 'application/json',
        'user-agent': 'Mozilla/5.0',
      },
    });
    const out = sentryBeforeSend(e);
    const h = out!.request!.headers!;
    expect(h.authorization).toBe('[Filtered]');
    expect(h.cookie).toBe('[Filtered]');
    expect(h['x-api-key']).toBe('[Filtered]');
    expect(h['stripe-signature']).toBe('[Filtered]');
    expect(h['x-hub-signature-256']).toBe('[Filtered]');
    expect(h['content-type']).toBe('application/json');
    expect(h['user-agent']).toBe('Mozilla/5.0');
  });
});

describe('sentryBeforeSend — sensitive key scrub in extra/data', () => {
  it('scrubs password / api_key / stripe_* / access_token / credentials_encrypted by name', () => {
    const e = event(
      { url: 'https://api.example.com/v1/crm/contacts' },
      {
        user: {
          email: 'x@y.com',
          password: 'plaintext',
          password_hash: 'bcrypt$...',
          api_key: 'sk_live_x',
          stripe_customer_id: 'cus_x',
          stripe_secret_key: 'sk_live_x',
          access_token: 'EAA...',
          credentials_encrypted: 'aes-blob',
          webhook_secret: 'whsec_x',
          refresh_token: 'rfr_x',
          // safe fields stay
          name: 'João',
          tier: 'profissional',
        },
      },
    );
    const out = sentryBeforeSend(e)!;
    const u = (out.extra as { user: Record<string, string> }).user;
    expect(u.password).toBe('[Filtered]');
    expect(u.password_hash).toBe('[Filtered]');
    expect(u.api_key).toBe('[Filtered]');
    expect(u.stripe_customer_id).toBe('[Filtered]');
    expect(u.stripe_secret_key).toBe('[Filtered]');
    expect(u.access_token).toBe('[Filtered]');
    expect(u.credentials_encrypted).toBe('[Filtered]');
    expect(u.webhook_secret).toBe('[Filtered]');
    expect(u.refresh_token).toBe('[Filtered]');
    expect(u.name).toBe('João');
    expect(u.tier).toBe('profissional');
  });

  it('scrubs nested arrays', () => {
    const e = event(
      { url: 'https://api.example.com/v1/crm/contacts' },
      {
        users: [
          { name: 'a', password: 'p1' },
          { name: 'b', password: 'p2' },
        ],
      },
    );
    const out = sentryBeforeSend(e)!;
    const list = (out.extra as { users: Array<Record<string, string>> }).users;
    expect(list[0]!.password).toBe('[Filtered]');
    expect(list[1]!.password).toBe('[Filtered]');
    expect(list[0]!.name).toBe('a');
  });
});

describe('captureException — no-op when not initialized', () => {
  it('does NOT throw and does NOT enable Sentry', () => {
    expect(isSentryEnabled()).toBe(false);
    // Should not throw despite Sentry being disabled.
    expect(() => captureException(new Error('test'), { source: 'unit' })).not.toThrow();
    expect(isSentryEnabled()).toBe(false);
  });
});
