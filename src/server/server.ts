#!/usr/bin/env node

/**
 * server.ts — System Clow HTTP API Server
 *
 * Bootstrap: env → Anthropic → MCP → SessionPool → Routes → Listen
 * Auth: Bearer token via CLOW_API_KEY
 * CORS: open for v1, restrict later
 */

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { config as loadEnv } from 'dotenv';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as https from 'https';
import { execSync } from 'child_process';

import { initAnthropic } from '../api/anthropic.js';
import { MCPManager } from '../mcp/MCPManager.js';
import { SessionPool } from './sessionPool.js';
import { PluginSystem } from '../plugins/PluginSystem.js';
import { initCrm } from '../crm/index.js';
import crmRoutes from '../crm/routes.js';
import crmWebhooks from '../crm/webhooks.js';
import { startScheduler } from '../crm/scheduler.js';
import authRoutes from '../auth/authRoutes.js';
import stripeRoutes from '../billing/stripeRoutes.js';
import n8nRoutes from '../billing/n8nRoutes.js';
import { PluginMcpLoader } from '../plugins/components/PluginMcpLoader.js';
import { buildRoutes } from './routes.js';
import { buildAdminRoutes, buildBillingRoutes } from './adminRoutes.js';
import { buildWhatsAppRoutes } from '../adapters/whatsapp.js';
import { buildMetaWhatsAppRoutes } from '../adapters/whatsappMeta.js';
import { buildBridgeRoutes } from './bridgeRoutes.js';
import { buildMCPRemoteRoutes } from './mcpRemoteServer.js';
import { createAdminSessionToken, tenantAuth, verifyAdminSessionToken } from './middleware/tenantAuth.js';
import { clowSonnetGuard } from './middleware/clowSonnetGuard.js';
import { initSessionStorage } from '../utils/session/sessionStorage.js';
import { getGitStatus } from '../utils/context/context.js';
import { initMemorySystem, buildMemoryRoutes } from '../memory/index.js';
import { buildDocsRoutes } from './openapi.js';
import { getMetricsSummary } from '../utils/logger.js';
import { buildDashboardRoutes } from './adminDashboard.js';
import { apiQueue } from './requestQueue.js';
import { buildSSORoutes } from './ssoAuth.js';
import { buildMarketplaceRoutes } from '../plugins/marketplace.js';
import { buildMissionRoutes } from './missions.js';

function getAllowedCorsOrigins(): string[] {
  return (process.env.CLOW_ALLOWED_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function isOriginAllowed(origin: string | undefined, allowedOrigins: string[]): boolean {
  if (!origin) return true;
  if (allowedOrigins.length === 0) return false;
  return allowedOrigins.includes(origin);
}

function resolveDownloadRootCandidates(): string[] {
  const configured = (process.env.CLOW_DOWNLOADS_DIR || '')
    .split(path.delimiter)
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => path.resolve(value));

  return Array.from(new Set([
    ...configured,
    path.resolve(process.cwd(), 'output'),
    path.resolve(process.cwd(), 'tmp'),
    path.resolve(os.tmpdir(), 'clow-downloads'),
  ]));
}

function isSafeDownloadName(requested: string): boolean {
  if (!requested || requested.includes('/') || requested.includes('\\')) return false;
  if (requested === '.' || requested === '..') return false;
  return !/[\x00-\x1f]/.test(requested);
}

function ensureSSLCertificates(): { key: string; cert: string } {
  const certDir = path.join(os.homedir(), '.clow', 'ssl');
  const keyPath = path.join(certDir, 'key.pem');
  const certPath = path.join(certDir, 'cert.pem');

  // Create directory if it doesn't exist
  if (!fs.existsSync(certDir)) {
    fs.mkdirSync(certDir, { recursive: true });
  }

  // Check if certificates already exist
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return {
      key: fs.readFileSync(keyPath, 'utf-8'),
      cert: fs.readFileSync(certPath, 'utf-8'),
    };
  }

  // Generate self-signed certificate
  console.log('  Generating self-signed SSL certificate...');
  try {
    execSync(
      `openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -days 365 -nodes -subj "/CN=localhost"`,
      { stdio: 'pipe' }
    );
    console.log('  ✓ SSL certificate generated');
    return {
      key: fs.readFileSync(keyPath, 'utf-8'),
      cert: fs.readFileSync(certPath, 'utf-8'),
    };
  } catch (err: any) {
    console.error('  ✗ Failed to generate SSL certificate:', err.message);
    throw err;
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Load env
  loadEnv({ path: path.resolve(process.cwd(), '.env') });
  loadEnv({ path: path.resolve(os.homedir(), '.clow', '.env') });

  const PORT = parseInt(process.env.PORT || '3001', 10);
  const allowedCorsOrigins = getAllowedCorsOrigins();
  const downloadRoots = resolveDownloadRootCandidates();

  // Init API
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('FATAL: Set ANTHROPIC_API_KEY in .env');
    process.exit(1);
  }

  const selectedModel = process.env.CLOW_MODEL
    || 'claude-sonnet-4-6';

  initAnthropic({
    apiKey,
    model: selectedModel,
    maxOutputTokens: 8192,
  });

  // Init session storage
  await initSessionStorage();

  const pluginSystem = new PluginSystem();
  try {
    await pluginSystem.initialize(process.cwd());
    const pluginStats = pluginSystem.getStats();
    if (pluginStats.pluginCount > 0) {
      console.log(`  ? Plugins: ${pluginStats.pluginCount} plugin(s), ${pluginStats.commandCount} command(s)`);
    }
  } catch (err: any) {
    console.error(`  ? Plugins: ${err.message}`);
  }

  // Init MCP
  const mcpManager = new MCPManager();
  const mcpConfigPath = path.join(os.homedir(), '.clow', 'mcp.json');
  try {
    if (fs.existsSync(mcpConfigPath)) {
      await mcpManager.loadFromConfig(mcpConfigPath);
    }
    const pluginMcpLoader = new PluginMcpLoader();
    const pluginMcpConfigs: Record<string, { command: string; args?: string[]; env?: Record<string, string> }> = {};
    for (const plugin of pluginSystem.registry.listEnabled()) {
      Object.assign(pluginMcpConfigs, pluginMcpLoader.getServerConfigs(plugin.manifest, plugin.rootDir));
    }
    mcpManager.registerServers(pluginMcpConfigs);
    await mcpManager.connectAll();
    if (mcpManager.serverCount > 0) {
      console.log(`  ? MCP: ${mcpManager.serverCount} server(s), ${mcpManager.getAllTools().length} tool(s)`);
    }
  } catch (err: any) {
    console.error(`  ? MCP: ${err.message}`);
  }

  // Populate git cache silently
  await getGitStatus().catch(() => {});

  // Create session pool
  const pool = new SessionPool(mcpManager);

  // Initialize CRM (migrations + DB setup)
  initCrm();
  startScheduler();

  // Build Hono app
  const app = new Hono();

  // CORS is opt-in via allowlist. Same-origin requests work without these headers.
  if (allowedCorsOrigins.length > 0) {
    app.use('*', cors({
      origin: (origin) => isOriginAllowed(origin, allowedCorsOrigins) ? (origin || '') : '',
      allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization'],
    }));
  }

  // Auth: Clow sonnet bridge (short-circuits for clow_sonnet_* tokens)
  app.use('/v1/sessions/*', clowSonnetGuard);
  app.use('/v1/sessions', clowSonnetGuard);

  // Auth: multi-tenant via API key (skip health, webhooks, admin)
  app.use('/v1/sessions/*', tenantAuth);
  app.use('/v1/sessions', tenantAuth);
  app.use('/v1/crm/*', tenantAuth);
  app.use('/v1/crm', tenantAuth);
  console.log('  ✓ Auth: Multi-tenant API key enabled');

  // Mount routes
  const apiRoutes = buildRoutes(pool);
  app.route('/', apiRoutes);

  // Mount admin routes (protected by CLOW_ADMIN_KEY)
  const adminR = buildAdminRoutes();
  app.route('/', adminR);

  // Mount billing webhooks
  const billingR = buildBillingRoutes();
  app.route('/', billingR);

  // Mount bridge routes
  const bridgeRoutes = buildBridgeRoutes();
  app.route('/', bridgeRoutes);

  // Mount WhatsApp adapters
  const whatsappRoutes = buildWhatsAppRoutes(pool);
  app.route('/', whatsappRoutes);

  // Mount Meta WhatsApp Official API adapter
  const metaWhatsAppRoutes = buildMetaWhatsAppRoutes(pool);
  app.route('/', metaWhatsAppRoutes);
  console.log('  ✓ WhatsApp Meta: /webhooks/meta');

  // Mount MCP Remote Server (for Claude Desktop integration)
  const mcpRemoteRoutes = buildMCPRemoteRoutes(pool, mcpManager);
  app.route('/', mcpRemoteRoutes);

  // Mount persistent memory API routes
  const memoryRoutes = buildMemoryRoutes();
  app.route('/v1/memory', memoryRoutes);
  console.log('  ✓ Persistent Memory: API routes mounted');

  // Mount OpenAPI docs (Swagger UI at /docs)
  const docsRoutes = buildDocsRoutes();
  app.route('/', docsRoutes);
  console.log('  ✓ API Docs: /docs (Swagger UI) + /openapi.json');

  // Metrics endpoint
  app.get('/v1/metrics', (c) => c.json({
    ...getMetricsSummary(),
    queue: apiQueue.getStats(),
  }));
  console.log('  ✓ Metrics: /v1/metrics');

  // Admin dashboard
  const dashboardRoutes = buildDashboardRoutes(pool);
  app.route('/', dashboardRoutes);
  console.log('  ✓ Dashboard: /admin/dashboard + /health/deep');

  // SSO authentication
  const ssoRoutes = buildSSORoutes();
  app.route('/', ssoRoutes);
  console.log('  ✓ SSO: /auth/sso + /auth/sso/verify');

  // Plugin marketplace
  const marketplaceRoutes = buildMarketplaceRoutes();
  app.route('/v1/marketplace', marketplaceRoutes);
  console.log('  ✓ Marketplace: /v1/marketplace/plugins');

  // Mission runner
  const missionRoutes = buildMissionRoutes();
  app.route('/v1/missions', missionRoutes);
  app.route('/v1/crm', crmRoutes);
  app.route('/webhooks/crm', crmWebhooks);
  // ─── Login Auth UNIFIED (registered BEFORE /auth mount pra ter precedência) ───
  // Ordem importa no Hono: handler direto ganha do app.route('/auth', authRoutes).
  // Aceita admin (username+password) OU tenant (email+password, ou username contendo '@').
  const ADMIN_USER = process.env.CLOW_ADMIN_USER;
  const ADMIN_PASS = process.env.CLOW_ADMIN_PASS;

  app.post('/auth/login', async (c) => {
    const body = await c.req.json().catch(() => ({})) as any;
    const { username, email, password } = body as { username?: string; email?: string; password?: string };
    if (!password || (!username && !email)) {
      return c.json({ ok: false, error: 'missing_credentials' }, 400);
    }

    // 1) Admin login (username match)
    if (username && ADMIN_USER && ADMIN_PASS && username === ADMIN_USER && password === ADMIN_PASS) {
      const token = createAdminSessionToken(username);
      return c.json({ ok: true, token });
    }

    // 2) Tenant login (email). Form antigo manda 'username' que pode ser o email.
    const emailStr = String(email || username || '').toLowerCase().trim();
    if (emailStr && emailStr.includes('@')) {
      try {
        const { findTenantByEmail, updateTenant } = await import('../tenancy/tenantStore.js');
        const { signUserToken } = await import('../auth/authRoutes.js');
        const bcrypt = (await import('bcryptjs')).default;
        const tenant = findTenantByEmail(emailStr);
        if (tenant && (tenant as any).password_hash) {
          if (tenant.status === 'cancelled' || tenant.status === 'suspended') {
            return c.json({ ok: false, error: 'account_blocked' }, 403);
          }
          const ok = await bcrypt.compare(password, (tenant as any).password_hash);
          if (ok) {
            updateTenant(tenant.id, { last_login_at: new Date().toISOString() } as any);
            const token = signUserToken({ tid: tenant.id, uid: tenant.id, email: tenant.email, role: 'owner' });
            return c.json({ ok: true, token, user: { id: tenant.id, email: tenant.email, tier: tenant.tier, role: 'owner' } });
          }
        }
      } catch (err: any) {
        console.error('[auth tenant fallback]', err?.message);
      }
    }

    return c.json({ ok: false, error: 'invalid_credentials' }, 401);
  });

  app.get('/auth/verify', (c) => {
    if (!ADMIN_USER || !ADMIN_PASS) return c.json({ ok: false }, 503);
    const token = c.req.header('X-Auth-Token')
      || c.req.header('Authorization')?.replace(/^Bearer\s+/i, '');
    if (!token) return c.json({ ok: false }, 401);
    const verified = verifyAdminSessionToken(token);
    if (verified.ok && verified.username === ADMIN_USER) return c.json({ ok: true });
    return c.json({ ok: false }, 401);
  });

  // Route mounts DEPOIS pra preservar precedência dos handlers acima
  app.route('/auth', authRoutes);
  app.route('/', stripeRoutes);
  app.route('/v1/n8n', n8nRoutes);
  app.route('/v1/branding', n8nRoutes);
  console.log('  ✓ Missions: /v1/missions/:id');

  // ─── File Downloads (Excel, CSV, etc created by Clow) ───────────
  app.get('/downloads/*', (c) => {
    const requestedName = decodeURIComponent(c.req.path.replace('/downloads/', '').trim());
    if (!isSafeDownloadName(requestedName)) {
      return c.json({ error: 'invalid_file_name' }, 400);
    }
    const candidates = downloadRoots.map((root) => path.resolve(root, requestedName));
    for (const fp of candidates) {
      if (fs.existsSync(fp) && !fs.statSync(fp).isDirectory()) {
        const content = fs.readFileSync(fp);
        const ext = path.extname(fp).toLowerCase();
        const mimeTypes: Record<string,string> = {
          '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          '.xls': 'application/vnd.ms-excel',
          '.csv': 'text/csv; charset=utf-8',
          '.pdf': 'application/pdf',
          '.json': 'application/json; charset=utf-8',
          '.txt': 'text/plain; charset=utf-8',
          '.md': 'text/markdown; charset=utf-8',
          '.html': 'text/html; charset=utf-8',
          '.htm': 'text/html; charset=utf-8',
          '.xml': 'application/xml; charset=utf-8',
          '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          '.doc': 'application/msword',
          '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          '.ppt': 'application/vnd.ms-powerpoint',
          '.zip': 'application/zip',
          '.tar': 'application/x-tar',
          '.gz': 'application/gzip',
          '.mp4': 'video/mp4',
          '.webm': 'video/webm',
          '.mp3': 'audio/mpeg',
          '.wav': 'audio/wav',
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.gif': 'image/gif',
          '.webp': 'image/webp',
          '.svg': 'image/svg+xml',
        };
        const contentType = mimeTypes[ext] || 'application/octet-stream';
        const fileName = path.basename(fp);
        return new Response(content, {
          headers: {
            'Content-Type': contentType,
            'Content-Disposition': `attachment; filename="${fileName}"`,
            'Content-Length': String(content.length),
          },
        });
      }
    }
    return c.json({ error: 'File not found' }, 404);
  });

  // Serve static frontend (public/)
  // Serve manifest, sw.js, and static assets
  app.get('/manifest.json', (c) => {
    const fp = path.resolve(process.cwd(), 'public', 'manifest.json');
    if (fs.existsSync(fp)) return new Response(fs.readFileSync(fp), { headers: { 'Content-Type': 'application/manifest+json' } });
    return c.notFound();
  });

  app.get('/sw.js', (c) => {
    const fp = path.resolve(process.cwd(), 'public', 'sw.js');
    if (fs.existsSync(fp)) return new Response(fs.readFileSync(fp), { headers: { 'Content-Type': 'application/javascript', 'Service-Worker-Allowed': '/' } });
    return c.notFound();
  });

  // Serve CRM UI static files (public/crm/*)
  app.get('/crm/*', async (c) => {
    const url = new URL(c.req.url);
    let p = url.pathname.replace(/^\/crm/, '') || '/';
    if (p === '/' || p === '') p = '/index.html';
    const fsMod = await import('fs');
    const pathMod = await import('path');
    const file = pathMod.join(process.cwd(), 'public/crm', p);
    // path traversal guard
    const base = pathMod.join(process.cwd(), 'public/crm');
    if (!file.startsWith(base)) return c.text('forbidden', 403);
    if (!fsMod.existsSync(file) || !fsMod.statSync(file).isFile()) return c.text('not found', 404);
    const buf = fsMod.readFileSync(file);
    const mt = p.endsWith('.html') ? 'text/html' : p.endsWith('.css') ? 'text/css' : p.endsWith('.js') ? 'application/javascript' : 'application/octet-stream';
    const noCache = p.endsWith('.html') || p.endsWith('.js');
    return new Response(buf, { headers: { 'Content-Type': mt + '; charset=utf-8', 'Cache-Control': noCache ? 'no-cache, no-store, must-revalidate' : 'public, max-age=300' } });
  });
  app.get('/crm', (c) => Response.redirect(new URL('/crm/', c.req.url).toString(), 302) as any);

  app.get('/onboarding', async (c) => {
    try {
      const fsMod = await import('fs');
      const pathMod = await import('path');
      const file = pathMod.join(process.cwd(), 'public/onboarding.html');
      const buf = fsMod.readFileSync(file);
      return new Response(buf, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' } });
    } catch (e: any) { return c.text('error: ' + e.message, 500); }
  });
  app.get('/pricing', async (c) => {
    try {
      const fsMod = await import('fs');
      const pathMod = await import('path');
      const file = pathMod.join(process.cwd(), 'public/pricing.html');
      const buf = fsMod.readFileSync(file);
      return new Response(buf, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' } });
    } catch (e: any) { return c.text('error: ' + e.message, 500); }
  });
  app.get('/signup', (c) => {
    // Old signup form unified into /pricing (plan picker + modal)
    const qs = (new URL(c.req.url)).search;
    return c.redirect('/pricing' + qs, 302);
  });
  // Videos estaticos (HTML + JSX + assets PNG) pra landing /pricing etc
  app.get('/videos/*', (c) => {
    const rel = c.req.path.slice(1).replace(/\.\.+/g,'');
    const filePath = path.resolve(process.cwd(), 'public', rel);
    if (!filePath.startsWith(path.resolve(process.cwd(), 'public/videos'))) return c.notFound();
    const fp = fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()
      ? path.join(filePath, 'index.html')
      : filePath;
    if (!fs.existsSync(fp)) return c.notFound();
    const content = fs.readFileSync(fp);
    const ext = path.extname(fp).toLowerCase();
    const types: Record<string,string> = {
      '.html':'text/html; charset=utf-8',
      '.jsx':'text/javascript; charset=utf-8',
      '.js':'text/javascript; charset=utf-8',
      '.css':'text/css; charset=utf-8',
      '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg',
      '.svg':'image/svg+xml','.webp':'image/webp','.gif':'image/gif',
      '.mp4':'video/mp4','.webm':'video/webm','.ogg':'video/ogg','.mp3':'audio/mpeg','.wav':'audio/wav','.m4a':'audio/mp4',
      '.json':'application/json; charset=utf-8',
    };
    return new Response(content, { headers: {
      'Content-Type': types[ext] || 'application/octet-stream',
      'Cache-Control': 'public, max-age=3600',
      'X-Frame-Options': 'SAMEORIGIN',
    }});
  });

  app.get('/assets/*', (c) => {
    const filePath = path.resolve(process.cwd(), 'public', c.req.path.slice(1));
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const types: Record<string,string> = { '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.png':'image/png', '.svg':'image/svg+xml', '.ico':'image/x-icon', '.css':'text/css', '.js':'text/javascript' };
      return new Response(content, { headers: { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': 'public, max-age=86400' } });
    }
    return c.notFound();
  });

  app.get('/', (c) => {
    const htmlPath = path.resolve(process.cwd(), 'public', 'index.html');
    if (fs.existsSync(htmlPath)) {
      const html = fs.readFileSync(htmlPath, 'utf-8');
      return c.html(html);
    }
    return c.text('System Clow API', 200);
  });

  // Graceful shutdown
  const cleanup = async () => {
    console.log('\n  Shutting down...');
    pool.shutdown();
    await mcpManager.disconnectAll();
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  // Start
  console.log(`\n  ╔═══════════════════════════════════════╗`);
  console.log(`  ║   System Clow API — port ${PORT}         ║`);
  console.log(`  ╚═══════════════════════════════════════╝\n`);

  // Use HTTPS with self-signed certificate
  const useHttps = process.env.CLOW_USE_HTTPS !== 'false';
  
  if (useHttps) {
    const { key, cert } = ensureSSLCertificates();
    const httpsServer = https.createServer({ key, cert }, app.fetch as any);
    httpsServer.listen(PORT, () => {
      console.log(`  Listening on https://localhost:${PORT}`);
      console.log(`  Health: https://localhost:${PORT}/health`);
      console.log(`  MCP: https://localhost:${PORT}/mcp`);
      console.log(`  Webhook: https://localhost:${PORT}/webhooks/zapi\n`);
    });
  } else {
    serve({ fetch: app.fetch, port: PORT, hostname: "127.0.0.1" }, (info) => {
      console.log(`  Listening on http://localhost:${info.port}`);
      console.log(`  Health: http://localhost:${info.port}/health`);
      console.log(`  Webhook: http://localhost:${info.port}/webhooks/zapi\n`);
    });
  }
}

main().catch((err) => {
  console.error(`FATAL: ${err.message}`);
  process.exit(1);
});
