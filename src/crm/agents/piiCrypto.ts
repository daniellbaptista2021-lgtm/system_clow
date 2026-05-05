/**
 * piiCrypto — AES-256-GCM granular per-field pra dados sensíveis (LGPD).
 *
 * Uso na PR 3 da Onda 62: salvar_dados_proposta cifra cada campo
 * sensível (cpf, rg, endereco, beneficiarios) em row separada do
 * estado collected_data.sensitive. Estrutura:
 *
 *   collected_data: {
 *     qualification: { nome, idade, tipo_plano, ... }, // claro
 *     sensitive: {
 *       cpf_enc: "iv.tag.ct",
 *       rg_enc: "iv.tag.ct",
 *       endereco_enc: "iv.tag.ct",
 *       beneficiarios_enc: "iv.tag.ct"
 *     }
 *   }
 *
 * Vantagens (vs blob unico cifrado):
 *   - lê/atualiza campo isolado sem descifrar tudo
 *   - sabe quais campos foram preenchidos olhando so as chaves
 *     ("preencheu CPF" sem precisar descifrar)
 *   - migracao futura pra tabela separada fica trivial
 *
 * Chave: CLOW_PII_KEY (preferida) → fallback CLOW_CRM_SECRET.
 * Permite rotacao futura sem quebrar canais ja cifrados com CRM_SECRET.
 *
 * Mascaras: maskPII() retorna versao mostly-redacted pra logs/dashboards.
 *   CPF "12345678900" → "***.456.789-**"
 *   RG  "12345678X"   → "*****678-X"
 *   etc.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { logger } from '../../utils/logger.js';

const ALGO = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const SALT = Buffer.from('clow-pii-v1', 'utf-8');

let _cachedKey: Buffer | null = null;
let _cachedKeySource: string | null = null;

function getKey(): Buffer {
  const secret = process.env.CLOW_PII_KEY
    || process.env.CLOW_CRM_SECRET
    || process.env.CLOW_ADMIN_SESSION_SECRET
    || process.env.JWT_SECRET
    || '';
  if (!secret || secret.length < 16) {
    throw new Error(
      'CLOW_PII_KEY (ou fallback CLOW_CRM_SECRET) precisa ter min 16 chars pra cifrar PII',
    );
  }
  // Cache derivacao scrypt — getKey() chamado por campo, sem cache fica caro.
  if (_cachedKey && _cachedKeySource === secret) return _cachedKey;
  _cachedKey = scryptSync(secret, SALT, KEY_LENGTH);
  _cachedKeySource = secret;
  return _cachedKey;
}

/**
 * Cifra um valor. Sempre JSON.stringify ANTES de cifrar — preserva o
 * tipo JS no round-trip (string fica string, objeto fica objeto). Sem
 * isso, "11144477735" cifrado retornava como Number 11144477735 no
 * decrypt (JSON.parse desambigua um inteiro).
 */
export function encryptPII(value: unknown): string {
  const plaintext = Buffer.from(JSON.stringify(value), 'utf-8');
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGO, getKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64url')}.${tag.toString('base64url')}.${ct.toString('base64url')}`;
}

/** Decifra retornando o JSON.stringify-encoded raw (string). */
export function decryptPIIRaw(encoded: string): string {
  const parts = encoded.split('.');
  if (parts.length !== 3) throw new Error('invalid_pii_ciphertext');
  const [ivB, tagB, ctB] = parts;
  const iv = Buffer.from(ivB, 'base64url');
  const tag = Buffer.from(tagB, 'base64url');
  const ct = Buffer.from(ctB, 'base64url');
  if (iv.length !== IV_LENGTH || tag.length !== TAG_LENGTH) {
    throw new Error('invalid_pii_ciphertext_shape');
  }
  const decipher = createDecipheriv(ALGO, getKey(), iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf-8');
}

/** Decifra E JSON.parseia — preserva o tipo original do encrypt.
 *  encryptPII("123") → decryptPII → "123" (string).
 *  encryptPII({a:1}) → decryptPII → {a:1}. */
export function decryptPII<T = unknown>(encoded: string): T {
  return JSON.parse(decryptPIIRaw(encoded)) as T;
}

// ─── Estrutura padronizada de sensitive ──────────────────────────────────

export interface SensitiveBag {
  cpf_enc?: string;
  rg_enc?: string;
  endereco_enc?: string;
  beneficiarios_enc?: string;
  // Permite extensao no futuro (ex: cnpj_enc, email_enc, etc)
  [key: string]: string | undefined;
}

/** Lista quais campos sensitive ja foram preenchidos (sem descifrar). */
export function listSensitiveFields(bag: SensitiveBag | null | undefined): string[] {
  if (!bag) return [];
  return Object.keys(bag).filter((k) => k.endsWith('_enc') && typeof bag[k] === 'string');
}

/** Decifra um campo sensitive nominal (ex: 'cpf' → procura 'cpf_enc'). */
export function decryptSensitiveField<T = string>(
  bag: SensitiveBag | null | undefined,
  field: string,
): T | string | null {
  if (!bag) return null;
  const key = field.endsWith('_enc') ? field : `${field}_enc`;
  const v = bag[key];
  if (!v) return null;
  try { return decryptPII<T>(v); }
  catch (err: any) {
    logger.warn(`[piiCrypto] decrypt '${key}' failed:`, err?.message);
    return null;
  }
}

/** Decifra TODOS os campos sensitive de uma vez (pra UI / export autorizado). */
export function decryptAllSensitive(
  bag: SensitiveBag | null | undefined,
): Record<string, string | unknown | null> {
  const out: Record<string, string | unknown | null> = {};
  if (!bag) return out;
  for (const key of Object.keys(bag)) {
    if (!key.endsWith('_enc')) continue;
    const fieldName = key.slice(0, -4); // 'cpf_enc' → 'cpf'
    out[fieldName] = decryptSensitiveField(bag, fieldName);
  }
  return out;
}

// ─── Mascaras ────────────────────────────────────────────────────────────

/** Mascara CPF: 12345678900 → ***.456.789-** (mantem digitos do meio). */
export function maskCPF(cpf: string | null): string {
  const digits = (cpf || '').replace(/\D/g, '');
  if (digits.length !== 11) return '***.***.***-**';
  return `***.${digits.slice(3, 6)}.${digits.slice(6, 9)}-**`;
}

/** Mascara RG: deixa ultimos 3 caracteres + ultimo digito. */
export function maskRG(rg: string | null): string {
  const v = (rg || '').trim();
  if (v.length < 4) return '*****';
  return '*'.repeat(Math.max(v.length - 4, 4)) + v.slice(-4);
}

/** Mascara endereco: mantem cidade/UF, esconde rua/numero. */
export function maskEndereco(end: any): string {
  if (!end) return '*** (não preenchido)';
  if (typeof end === 'string') return '*** ' + end.slice(-15);
  const cidade = end.cidade || end.city || '?';
  const uf = end.uf || end.estado || end.state || '?';
  return `*** (${cidade}/${uf})`;
}

/** Mascara generica pra strings desconhecidas. */
export function maskGeneric(s: string | null): string {
  const v = (s || '').trim();
  if (v.length < 4) return '****';
  return v.slice(0, 2) + '*'.repeat(Math.max(v.length - 4, 4)) + v.slice(-2);
}

/**
 * Retorna SensitiveBag mascarado pra logs/UI/agentes não-finalizadores.
 * Se algum campo nao consegue decifrar (chave errada / corrompido),
 * marca como [ERRO_DECRYPT] em vez de explodir.
 */
export function maskAllSensitive(bag: SensitiveBag | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!bag) return out;
  for (const key of Object.keys(bag)) {
    if (!key.endsWith('_enc')) continue;
    const field = key.slice(0, -4);
    let plain: any;
    try { plain = decryptSensitiveField(bag, field); }
    catch { plain = null; }
    if (plain === null) { out[field] = '[ERRO_DECRYPT]'; continue; }
    if (field === 'cpf') out[field] = maskCPF(typeof plain === 'string' ? plain : null);
    else if (field === 'rg') out[field] = maskRG(typeof plain === 'string' ? plain : null);
    else if (field === 'endereco') out[field] = maskEndereco(plain);
    else out[field] = typeof plain === 'string' ? maskGeneric(plain) : '*** (preenchido)';
  }
  return out;
}
