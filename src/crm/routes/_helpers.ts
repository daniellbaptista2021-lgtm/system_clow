/**
 * _helpers.ts — Helpers compartilhados pelas routes do CRM.
 *
 * tenantOf é FAIL-CLOSED: se o middleware de auth não setou tenantId no
 * contexto, retornamos 401 imediatamente. Antes existiam 11 cópias deste
 * helper inline (uma por arquivo de route) com fallback `|| 'default'`,
 * que misturava dados de tenants diferentes no bucket "default" quando
 * o middleware falhava em propagar tenantId. Memory regra: JAMAIS
 * `tenantId || 'default'` — fallback vira vazamento entre clientes.
 */
import { HTTPException } from 'hono/http-exception';

/** Retorna o tenantId do contexto. Throw 401 se vazio. */
export function tenantOf(c: any): string {
  const t = c.get?.('tenantId') || c.get?.('tenant_id');
  if (typeof t !== 'string' || !t.trim()) {
    throw new HTTPException(401, {
      message: 'tenant_context_missing',
    });
  }
  return t;
}
