import { Hono } from 'hono';
import { conferirCredencialCrm } from '../tenancy/territorioToken.js';
import { ensureTerritorioTenant } from '../tenancy/tenantStore.js';
import { territorioEnabled, territorioOrigin } from '../tenancy/territorio.js';
import { bootstrapTenantRBAC } from '../auth/authRoutes.js';
import { seedDefaultBoards } from '../crm/store.js';

export function buildTerritorioRoutes(): Hono {
  const app = new Hono();
  app.get('/integrations/territorio/config.js', c => {
    c.header('Cache-Control', 'no-store');
    c.header('Content-Type', 'application/javascript');
    return c.body(`window.CLOW_TERRITORIO_ORIGIN=${JSON.stringify(territorioEnabled() ? territorioOrigin() : null)};`);
  });
  app.post('/integrations/territorio/tenant', c => {
    c.header('Cache-Control', 'no-store');
    if (!territorioEnabled()) return c.json({ error: 'integration_disabled' }, 503);
    const token = c.req.header('Authorization')?.replace(/^Bearer /, '') || '';
    const p = conferirCredencialCrm(token);
    if (!p || p.scope !== 'provision') return c.json({ error: 'invalid_grant' }, 401);
    try {
      const tenant = ensureTerritorioTenant(p);
      if (tenant.status === 'suspended') return c.json({ error: 'tenant_suspended' }, 403);
      // Idempotentes; falha parcial é completada na próxima tentativa.
      bootstrapTenantRBAC(tenant.id, tenant.name, tenant.email);
      seedDefaultBoards(tenant.id);
      return c.json({ tenant_id: tenant.id });
    } catch {
      return c.json({ error: 'tenant_provision_failed' }, 409);
    }
  });
  return app;
}
