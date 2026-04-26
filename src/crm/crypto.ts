/**
 * CRM crypto — AES-256-GCM encryption for channel credentials.
 *
 * Uses CLOW_CRM_SECRET env var (derives key via scrypt). Never store
 * channel tokens in plaintext.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

const ALGO = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const SALT = Buffer.from('clow-crm-v1', 'utf-8');

function getKey(): Buffer {
  const secret = process.env.CLOW_CRM_SECRET
    || process.env.CLOW_ADMIN_SESSION_SECRET
    || process.env.JWT_SECRET
    || '';
  if (!secret || secret.length < 16) {
    throw new Error('CLOW_CRM_SECRET must be set (min 16 chars) to encrypt channel credentials');
  }
  return scryptSync(secret, SALT, KEY_LENGTH);
}

/**
 * Encrypt arbitrary JSON-serializable value. Returns a single base64 string:
 * `iv_b64.tag_b64.ciphertext_b64`
 */
export function encryptJson(value: unknown): string {
  const plaintext = Buffer.from(JSON.stringify(value), 'utf-8');
  const iv = randomBytes(IV_LENGTH);
  const key = getKey();
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64url')}.${tag.toString('base64url')}.${ct.toString('base64url')}`;
}

export function decryptJson<T = unknown>(encoded: string): T {
  const parts = encoded.split('.');
  if (parts.length !== 3) throw new Error('invalid_ciphertext');
  const [ivB, tagB, ctB] = parts;
  const iv = Buffer.from(ivB, 'base64url');
  const tag = Buffer.from(tagB, 'base64url');
  const ct = Buffer.from(ctB, 'base64url');
  if (iv.length !== IV_LENGTH || tag.length !== TAG_LENGTH) {
    throw new Error('invalid_ciphertext_shape');
  }
  const key = getKey();
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(pt.toString('utf-8')) as T;
}

/** Mask sensitive strings for logs/UI (keeps first 4 + last 4). */
export function maskSecret(s: string): string {
  if (!s) return '';
  if (s.length <= 10) return '********';
  return `${s.slice(0, 4)}...${s.slice(-4)}`;
}
