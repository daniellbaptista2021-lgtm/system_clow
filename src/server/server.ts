#!/usr/bin/env node

/**
 * server.ts — System Clow HTTP API Server
 *
 * Bootstrap: env → DeepSeek → MCP → SessionPool → Routes → Listen
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

import { initDeepSeek } from '../api/deepseek.js';
import { MCPManager } from '../mcp/MCPManager.js';
import { SessionPool } from './sessionPool.js';
import { buildRoutes } from './routes.js';
import { buildAdminRoutes, buildBillingRoutes } from './adminRoutes.js';
import { buildWhatsAppRoutes } from '../adapters/whatsapp.js';
import { tenantAuth } from './middleware/tenantAuth.js';
import { initSessionStorage } from '../utils/session/sessionStorage.js';
import { getGitStatus } from '../utils/context/context.js';

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Load env
  loadEnv({ path: path.resolve(process.cwd(), '.env') });
  loadEnv({ path: path.resolve(os.homedir(), '.clow', '.env') });

  const PORT = parseInt(process.env.PORT || '3001', 10);
  const API_KEY = process.env.CLOW_API_KEY;

  // Init DeepSeek
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    console.error('FATAL: DEEPSEEK_API_KEY not set');
    process.exit(1);
  }

  initDeepSeek({
    apiKey,
    baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    maxOutputTokens: 8192,
  });

  console.log('  ✓ DeepSeek initialized');

  // Init session storage
  await initSessionStorage();

  // Init MCP
  const mcpManager = new MCPManager();
  const mcpConfigPath = path.join(os.homedir(), '.clow', 'mcp.json');
  if (fs.existsSync(mcpConfigPath)) {
    try {
      await mcpManager.loadFromConfig(mcpConfigPath);
      await mcpManager.connectAll();
      if (mcpManager.serverCount > 0) {
        console.log(`  ✓ MCP: ${mcpManager.serverCount} server(s), ${mcpManager.getAllTools().length} tool(s)`);
      }
    } catch (err: any) {
      console.error(`  ⚠ MCP: ${err.message}`);
    }
  }

  // Populate git cache silently
  await getGitStatus().catch(() => {});

  // Create session pool
  const pool = new SessionPool(mcpManager);

  // Build Hono app
  const app = new Hono();

  // CORS
  app.use('*', cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
  }));

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

  // Mount WhatsApp adapter
  const whatsappRoutes = buildWhatsAppRoutes(pool);
  app.route('/', whatsappRoutes);

  // Serve static frontend (public/)
  app.get('/', (c) => {
    const htmlPath = path.resolve(process.cwd(), 'public', 'index.html');
    if (fs.existsSync(htmlPath)) {
      const html = fs.readFileSync(htmlPath, 'utf-8');
      return c.html(html);
    }
    return c.text('System Clow API — use /health or /v1/sessions', 200);
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
