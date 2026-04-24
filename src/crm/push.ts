/**
 * Push notifications — Onda 24.
 *
 * Web Push Protocol (RFC 8030) with VAPID (RFC 8292) using Node built-in crypto.
 * Falls back gracefully if VAPID keys not configured (env: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT).
 *
 * Browser side: await navigator.serviceWorker.ready.pushManager.subscribe(...)
 * POSTs the subscription here. Server signs a request to the push endpoint with
 * JWT (ES256) + AES-128-GCM encrypted payload.
 */

import { randomBytes, createHmac, createPrivateKey, createSign, createECDH, createHash, createCipheriv } from 'crypto';
import { getCrmDb } from './schema.js';

function nid(prefix: string): string { return prefix + '_' + randomBytes(6).toString('hex'); }
const now = () => Date.now();

export interface PushSubscription {
  id: string;
  tenantId: string;
  agentId?: string;
  endpoint: string;
  p256dh: string;            // base64url UA public key
  auth: string;              // base64url shared secret
  ua?: string;
  enabled: boolean;
  createdAt: number;
  lastUsedAt?: number;
}

function rowToSub(r: any): PushSubscription {
  return {
    id: r.id, tenantId: r.tenant_id, agentId: r.agent_id ?? undefined,
    endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth,
    ua: r.ua ?? undefined, enabled: r.enabled === 1,
    createdAt: r.created_at, lastUsedAt: r.last_used_at ?? undefined,
  };
}

export function subscribe(tenantId: string, input: {
  endpoint: string; p256dh: string; auth: string; agentId?: string; ua?: string;
}): PushSubscription {
  const db = getCrmDb();
  const existing = db.prepare('SELECT id FROM crm_push_subscriptions WHERE endpoint = ?').get(input.endpoint) as any;
  const t = now();
  if (existing) {
    db.prepare('UPDATE crm_push_subscriptions SET p256dh = ?, auth = ?, agent_id = ?, ua = ?, enabled = 1, last_used_at = ? WHERE id = ?')
      .run(input.p256dh, input.auth, input.agentId ?? null, input.ua ?? null, t, existing.id);
    return rowToSub(db.prepare('SELECT * FROM crm_push_subscriptions WHERE id = ?').get(existing.id));
  }
  const id = nid('crm_push');
  db.prepare(`
    INSERT INTO crm_push_subscriptions
      (id, tenant_id, agent_id, endpoint, p256dh, auth, ua, enabled, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
  `).run(id, tenantId, input.agentId ?? null, input.endpoint, input.p256dh, input.auth, input.ua ?? null, t);
  return rowToSub(db.prepare('SELECT * FROM crm_push_subscriptions WHERE id = ?').get(id));
}

export function unsubscribe(tenantId: string, endpoint: string): boolean {
  return getCrmDb().prepare('DELETE FROM crm_push_subscriptions WHERE tenant_id = ? AND endpoint = ?')
    .run(tenantId, endpoint).changes > 0;
}

export function listSubscriptions(tenantId: string, agentId?: string): PushSubscription[] {
  const wh: string[] = ['tenant_id = ?', 'enabled = 1'];
  const params: any[] = [tenantId];
  if (agentId) { wh.push('agent_id = ?'); params.push(agentId); }
  return (getCrmDb().prepare(`SELECT * FROM crm_push_subscriptions WHERE ${wh.join(' AND ')}`).all(...params) as any[])
    .map(rowToSub);
}

/**
 * VAPID public key for the browser's subscribe() call.
 * Returns base64url-encoded 65-byte uncompressed EC point.
 */
export function getVapidPublicKey(): string | null {
  return process.env.VAPID_PUBLIC_KEY || null;
}

/** Send a push notification to ALL subscriptions of an agent. */
export async function sendToAgent(
  tenantId: string,
  agentId: string,
  payload: { title: string; body: string; url?: string; icon?: string; data?: any },
): Promise<{ sent: number; failed: number }> {
  const subs = listSubscriptions(tenantId, agentId);
  let sent = 0, failed = 0;
  for (const sub of subs) {
    try {
      await sendOne(sub, payload);
      sent++;
      getCrmDb().prepare('UPDATE crm_push_subscriptions SET last_used_at = ? WHERE id = ?').run(now(), sub.id);
    } catch (err: any) {
      failed++;
      // 410 Gone = unsubscribe
      if (err?.statusCode === 410 || err?.statusCode === 404) {
        getCrmDb().prepare('UPDATE crm_push_subscriptions SET enabled = 0 WHERE id = ?').run(sub.id);
      }
    }
  }
  return { sent, failed };
}

/** Send push to all agents of a tenant (broadcast, e.g. admin announcements). */
export async function broadcastToTenant(
  tenantId: string,
  payload: { title: string; body: string; url?: string; icon?: string; data?: any },
): Promise<{ sent: number; failed: number }> {
  const subs = listSubscriptions(tenantId);
  let sent = 0, failed = 0;
  for (const sub of subs) {
    try { await sendOne(sub, payload); sent++; }
    catch { failed++; }
  }
  return { sent, failed };
}

// ─── Low-level RFC 8291 encryption + RFC 8292 VAPID ─────────────────────
async function sendOne(sub: PushSubscription, payload: any): Promise<void> {
  const vapidPub = process.env.VAPID_PUBLIC_KEY;
  const vapidPriv = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || 'mailto:noreply@clow.dev';

  if (!vapidPub || !vapidPriv) {
    // Dev fallback: log instead of sending
    console.log('[push] VAPID not configured — would send:', JSON.stringify(payload).slice(0, 100));
    return;
  }

  const url = new URL(sub.endpoint);
  const audience = `${url.protocol}//${url.host}`;
  const jwt = await makeVapidJWT(subject, audience, vapidPriv);
  const encrypted = await encryptPayload(JSON.stringify(payload), sub.p256dh, sub.auth);

  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'TTL': '60',
      'Authorization': `vapid t=${jwt}, k=${vapidPub}`,
    },
    body: new Uint8Array(encrypted),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const err: any = new Error(`push_http_${res.status}`);
    err.statusCode = res.status;
    throw err;
  }
}

function b64urlDecode(s: string): Buffer {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

function b64urlEncode(b: Buffer): string {
  return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function makeVapidJWT(subject: string, audience: string, privateKeyB64: string): Promise<string> {
  const header = { typ: 'JWT', alg: 'ES256' };
  const payload = {
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: subject,
  };
  const encodedHeader = b64urlEncode(Buffer.from(JSON.stringify(header)));
  const encodedPayload = b64urlEncode(Buffer.from(JSON.stringify(payload)));
  const input = encodedHeader + '.' + encodedPayload;

  // Build PEM from raw 32-byte private key
  const privKeyRaw = b64urlDecode(privateKeyB64);
  const pem = derEncodeEcPrivateKey(privKeyRaw);
  const key = createPrivateKey({ key: pem, format: 'pem' });

  const signer = createSign('SHA256');
  signer.update(input);
  signer.end();
  const derSig = signer.sign(key);

  // DER → raw (r||s) format required by JWT ES256
  const rawSig = derToJose(derSig);
  return input + '.' + b64urlEncode(rawSig);
}

function derEncodeEcPrivateKey(privateKeyRaw: Buffer): string {
  // Minimal PKCS#8 DER wrapper for P-256 (prime256v1) private key
  // Template adapted from RFC 5958 + SEC 1
  const version = Buffer.from([0x02, 0x01, 0x00]);
  const algId = Buffer.from([0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07]);
  const innerEc = Buffer.concat([
    Buffer.from([0x30, 0x25]),       // SEQUENCE { version=1, privateKey[32 bytes] }
    Buffer.from([0x02, 0x01, 0x01]), // version
    Buffer.from([0x04, 0x20]),       // OCTET STRING 32 bytes
    privateKeyRaw,
  ]);
  const privOctet = Buffer.concat([Buffer.from([0x04, innerEc.length]), innerEc]);
  const body = Buffer.concat([version, algId, privOctet]);
  const pkcs8 = Buffer.concat([Buffer.from([0x30, 0x81, body.length]), body]);
  return '-----BEGIN PRIVATE KEY-----\n' + pkcs8.toString('base64').match(/.{1,64}/g)!.join('\n') + '\n-----END PRIVATE KEY-----\n';
}

function derToJose(der: Buffer): Buffer {
  // DER: 30 LL 02 RL R... 02 SL S...
  let offset = 2;
  if (der[1] & 0x80) offset += (der[1] & 0x7f);
  // r
  const rLen = der[offset + 1];
  let r = der.subarray(offset + 2, offset + 2 + rLen);
  while (r.length > 32 && r[0] === 0) r = r.subarray(1);
  while (r.length < 32) r = Buffer.concat([Buffer.from([0]), r]);
  // s
  const sOffset = offset + 2 + rLen;
  const sLen = der[sOffset + 1];
  let s = der.subarray(sOffset + 2, sOffset + 2 + sLen);
  while (s.length > 32 && s[0] === 0) s = s.subarray(1);
  while (s.length < 32) s = Buffer.concat([Buffer.from([0]), s]);
  return Buffer.concat([r, s]);
}

// ─── RFC 8188 aes128gcm content-coding ─────────────────────────────────
async function encryptPayload(plaintext: string, p256dhB64: string, authB64: string): Promise<Buffer> {
  const uaPubKey = b64urlDecode(p256dhB64);
  const auth = b64urlDecode(authB64);

  // Generate ephemeral ECDH keypair
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const asPubKey = ecdh.getPublicKey(null, 'uncompressed'); // 65 bytes
  const sharedSecret = ecdh.computeSecret(uaPubKey);

  const salt = randomBytes(16);

  // RFC 8291 §3.3: key derivation
  const prkKey = hkdf(sharedSecret, auth, Buffer.concat([
    Buffer.from('WebPush: info\0'), uaPubKey, asPubKey,
  ]), 32);
  const contentKey = hkdf(prkKey, salt, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0')]), 16);
  const nonce      = hkdf(prkKey, salt, Buffer.concat([Buffer.from('Content-Encoding: nonce\0')]), 12);

  // Pad + encrypt
  const paddedInput = Buffer.concat([Buffer.from(plaintext, 'utf-8'), Buffer.from([0x02])]); // record delimiter
  const cipher = createCipheriv('aes-128-gcm', contentKey, nonce);
  const ciphertext = Buffer.concat([cipher.update(paddedInput), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Header: salt(16) + rs(4, big-endian) + idlen(1) + asPubKey(65)
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096, 0);
  const idlen = Buffer.from([asPubKey.length]);
  const header = Buffer.concat([salt, rs, idlen, asPubKey]);

  return Buffer.concat([header, ciphertext, tag]);
}

function hkdf(ikm: Buffer, salt: Buffer, info: Buffer, length: number): Buffer {
  const prk = createHmac('sha256', salt).update(ikm).digest();
  const out: Buffer[] = [];
  let prev = Buffer.alloc(0);
  let counter = 1;
  while (Buffer.concat(out).length < length) {
    const h = createHmac('sha256', prk);
    h.update(prev); h.update(info); h.update(Buffer.from([counter]));
    prev = h.digest();
    out.push(prev);
    counter++;
  }
  return Buffer.concat(out).subarray(0, length);
}
