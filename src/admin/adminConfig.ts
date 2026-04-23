/**
 * adminConfig.ts — storage persistente das configurações do admin.
 *
 * Admin não tem linha na tabela tenants (é o dono do sistema), então
 * precisa de storage separado pra:
 *   - authorized_phones: números que podem comandar a IA admin via WhatsApp
 *   - (futuro) outras prefs admin-only
 *
 * Arquivo JSON em $CLOW_ADMIN_CONFIG_DIR/admin-config.json (default /root/.clow/).
 * Seed inicial: META_WA_ADMIN_PHONES do .env (primeira leitura quando arquivo
 * ainda não existe).
 */

import fs from 'fs';
import path from 'path';

const CONFIG_DIR = process.env.CLOW_ADMIN_CONFIG_DIR || '/root/.clow';
const CONFIG_FILE = path.join(CONFIG_DIR, 'admin-config.json');

interface AdminConfig {
  authorized_phones: string[];
}

/** E.164 BR: remove tudo não-dígito, garante prefixo 55 pra números locais. */
function normPhone(raw: string): string {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('55') && digits.length >= 12) return digits;
  if (digits.length === 10 || digits.length === 11) return '55' + digits;
  return digits;
}

function seedFromEnv(): string[] {
  const raw = process.env.META_WA_ADMIN_PHONES || '';
  return raw.split(',').map(normPhone).filter((p) => p.length >= 10);
}

function load(): AdminConfig {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
      const list = Array.isArray(parsed?.authorized_phones) ? parsed.authorized_phones : [];
      return { authorized_phones: list.map(normPhone).filter((p: string) => p.length >= 10) };
    }
  } catch (err: any) {
    console.error('[admin-config] load failed:', err?.message);
  }
  // Primeira leitura (ou corrupção): seed do env
  return { authorized_phones: seedFromEnv() };
}

function save(cfg: AdminConfig): void {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf-8');
  } catch (err: any) {
    console.error('[admin-config] save failed:', err?.message);
    throw err;
  }
}

export function getAdminPhones(): string[] {
  return load().authorized_phones;
}

export function setAdminPhones(phones: string[]): string[] {
  const normalized = Array.from(new Set(phones.map(normPhone).filter((p) => p.length >= 10)));
  save({ authorized_phones: normalized });
  return normalized;
}

/** Match exato após normalização (ambos em E.164 sem +). */
export function isAdminPhone(phone: string): boolean {
  const cleaned = normPhone(phone);
  if (!cleaned) return false;
  const list = getAdminPhones();
  return list.some((p) => p === cleaned);
}
