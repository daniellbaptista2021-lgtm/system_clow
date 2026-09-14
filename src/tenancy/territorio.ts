import { conferirCredencialCrm } from './territorioToken.js';
import { getTenant } from './tenantStore.js';

export function territorioEnabled(): boolean {
  return process.env.CRM_TERRITORIO_ENABLED === 'true';
}

/**
 * Tranca a entrada direta (login, API key, usr.) e deixa só o Território.
 * Chave SEPARADA de propósito: ligar a integração não pode derrubar os
 * clientes que já usam o Clow direto. Só vale junto com a integração ligada.
 */
export function territorioExclusivo(): boolean {
  return territorioEnabled() && process.env.CRM_TERRITORIO_EXCLUSIVO === 'true';
}

export function territorioOrigin(): string {
  const url = new URL(process.env.TERRITORIO_APP_URL || 'https://territorio.pvcorretor01.com.br');
  if (url.protocol !== 'https:' && !(process.env.NODE_ENV !== 'production' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('Território exige HTTPS');
  return url.origin;
}

export function territorioSession(token?: string) {
  if (!territorioEnabled() || !token) return null;
  const p = conferirCredencialCrm(token);
  if (!p || p.scope !== 'session' || !p.tid) return null;
  const tenant = getTenant(p.tid);
  if (!tenant || tenant.territorio_profile_id !== p.sub || tenant.status === 'suspended') return null;
  return { type: 'user_session' as const, tid: tenant.id, uid: tenant.id, email: p.email, role: 'owner' as const, iat: p.iat, exp: p.exp };
}
