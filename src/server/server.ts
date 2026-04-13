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

import { initAnthropic } from '../api/anthropic.js';
import { MCPManager } from '../mcp/MCPManager.js';
import { SessionPool } from './sessionPool.js';
import { PluginSystem } from '../plugins/PluginSystem.js';
import { PluginMcpLoader } from '../plugins/components/PluginMcpLoader.js';
import { buildRoutes } from './routes.js';
import { buildAdminRoutes, buildBillingRoutes } from './adminRoutes.js';
import { buildWhatsAppRoutes } from '../adapters/whatsapp.js';
import { buildBridgeRoutes } from './bridgeRoutes.js';
import { createAdminSessionToken, tenantAuth, verifyAdminSessionToken } from './middleware/tenantAuth.js';
import { initSessionStorage } from '../utils/session/sessionStorage.js';
import { getGitStatus } from '../utils/context/context.js';

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

  // Auth: multi-tenant via API key (skip health, webhooks, admin)
  app.use('/v1/sessions/*', tenantAuth);
  app.use('/v1/sessions', tenantAuth);
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

  // Mount WhatsApp adapter
  const whatsappRoutes = buildWhatsAppRoutes(pool);
  app.route('/', whatsappRoutes);

  // ─── Login Auth ─────────────────────────────────────────────────
  const ADMIN_USER = process.env.CLOW_ADMIN_USER;
  const ADMIN_PASS = process.env.CLOW_ADMIN_PASS;

  app.post('/auth/login', async (c) => {
    if (!ADMIN_USER || !ADMIN_PASS) {
      return c.json({ ok: false, error: 'Login admin não configurado no servidor' }, 503);
    }
    const body = await c.req.json().catch(() => ({}));
    const { username, password } = body as { username?: string; password?: string };
    if (username === ADMIN_USER && password === ADMIN_PASS) {
      const token = createAdminSessionToken(username);
      return c.json({ ok: true, token });
    }
    return c.json({ ok: false, error: 'Credenciais inválidas' }, 401);
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
          '.csv': 'text/csv',
          '.pdf': 'application/pdf',
          '.json': 'application/json',
          '.txt': 'text/plain',
          '.zip': 'application/zip',
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

  serve({ fetch: app.fetch, port: PORT }, (info) => {
    console.log(`  Listening on http://localhost:${info.port}`);
    console.log(`  Health: http://localhost:${info.port}/health`);
    console.log(`  Webhook: http://localhost:${info.port}/webhooks/zapi\n`);
  });
}

main().catch((err) => {
  console.error(`FATAL: ${err.message}`);
  process.exit(1);
});
