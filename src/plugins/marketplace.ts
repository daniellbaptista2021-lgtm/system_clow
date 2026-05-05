/**
 * marketplace.ts — Plugin Marketplace for System Clow
 *
 * Public registry of installable plugins.
 * Plugins can be: tools, skills, hooks, MCP servers, themes.
 *
 * Registry stored in SQLite (same as memory DB pattern).
 * API endpoints for browse, install, uninstall, rate, review.
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { Hono } from 'hono';

// ════════════════════════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════════════════════════

export interface MarketplacePlugin {
  id: string;
  name: string;
  slug: string;
  description: string;
  version: string;
  author: string;
  category: 'tool' | 'skill' | 'hook' | 'mcp' | 'theme' | 'integration';
  tags: string[];
  downloads: number;
  rating: number;
  rating_count: number;
  source_url?: string;
  npm_package?: string;
  created_at: number;
  updated_at: number;
  is_official: boolean;
  is_verified: boolean;
  readme?: string;
}

export interface InstalledPlugin {
  plugin_id: string;
  tenant_id: string;
  installed_at: number;
  version: string;
  config?: string;
}

// ════════════════════════════════════════════════════════════════════════════
// Database
// ════════════════════════════════════════════════════════════════════════════

const DB_PATH = path.join(os.homedir(), '.clow', 'marketplace.sqlite3');

function getDb(): Database.Database {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Schema
  db.exec(`
    CREATE TABLE IF NOT EXISTS plugins (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      description TEXT,
      version TEXT NOT NULL DEFAULT '1.0.0',
      author TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'tool',
      tags TEXT DEFAULT '[]',
      downloads INTEGER NOT NULL DEFAULT 0,
      rating REAL NOT NULL DEFAULT 0,
      rating_count INTEGER NOT NULL DEFAULT 0,
      source_url TEXT,
      npm_package TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      is_official INTEGER NOT NULL DEFAULT 0,
      is_verified INTEGER NOT NULL DEFAULT 0,
      readme TEXT
    );

    CREATE TABLE IF NOT EXISTS installed_plugins (
      plugin_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      installed_at INTEGER NOT NULL,
      version TEXT NOT NULL,
      config TEXT,
      PRIMARY KEY (plugin_id, tenant_id),
      FOREIGN KEY (plugin_id) REFERENCES plugins(id)
    );

    CREATE TABLE IF NOT EXISTS plugin_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plugin_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
      comment TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (plugin_id) REFERENCES plugins(id)
    );

    CREATE INDEX IF NOT EXISTS idx_plugins_category ON plugins(category);
    CREATE INDEX IF NOT EXISTS idx_plugins_slug ON plugins(slug);
    CREATE INDEX IF NOT EXISTS idx_installed_tenant ON installed_plugins(tenant_id);
  `);

  // Seed official plugins if empty
  const count = db.prepare('SELECT COUNT(*) as c FROM plugins').get() as { c: number };
  if (count.c === 0) seedOfficialPlugins(db);

  return db;
}

function seedOfficialPlugins(db: Database.Database): void {
  const now = Date.now();
  const plugins: Partial<MarketplacePlugin>[] = [
    { id: 'clone-website', name: 'Clone Website', slug: 'clone-website', description: 'Clona qualquer site pixel-perfect usando Browser MCP. Pipeline de 5 fases com specs detalhadas.', version: '1.0.0', author: 'System Clow', category: 'skill', tags: ['clone', 'website', 'next.js', 'pixel-perfect'], is_official: true, is_verified: true },
    { id: 'meta-ads', name: 'Meta Ads Manager', slug: 'meta-ads', description: 'Gerencia campanhas no Meta Ads (Facebook/Instagram). Cria, analisa e otimiza campanhas.', version: '1.0.0', author: 'System Clow', category: 'integration', tags: ['meta', 'facebook', 'instagram', 'ads'], is_official: true, is_verified: true },
    { id: 'whatsapp-bot', name: 'WhatsApp Bot', slug: 'whatsapp-bot', description: 'Bot de atendimento automatico via WhatsApp com Z-API. Respostas inteligentes 24/7.', version: '1.0.0', author: 'System Clow', category: 'integration', tags: ['whatsapp', 'bot', 'atendimento', 'zapi'], is_official: true, is_verified: true },
    { id: 'excel-generator', name: 'Excel Generator', slug: 'excel-generator', description: 'Gera planilhas .xlsx profissionais com ExcelJS. Tabelas, graficos e formatacao.', version: '1.0.0', author: 'System Clow', category: 'tool', tags: ['excel', 'xlsx', 'planilha', 'relatorio'], is_official: true, is_verified: true },
    { id: 'chatwoot-crm', name: 'Chatwoot CRM', slug: 'chatwoot-crm', description: 'Integra com Chatwoot para gerenciamento de conversas multi-canal.', version: '1.0.0', author: 'System Clow', category: 'integration', tags: ['crm', 'chatwoot', 'atendimento'], is_official: true, is_verified: true },
    { id: 'n8n-workflows', name: 'n8n Workflows', slug: 'n8n-workflows', description: 'Cria e gerencia workflows de automacao no n8n via API.', version: '1.0.0', author: 'System Clow', category: 'integration', tags: ['n8n', 'automacao', 'workflow'], is_official: true, is_verified: true },
    { id: 'vercel-deploy', name: 'Vercel Deploy', slug: 'vercel-deploy', description: 'Deploy automatico de sites e apps no Vercel com configuracao de dominio.', version: '1.0.0', author: 'System Clow', category: 'tool', tags: ['vercel', 'deploy', 'hosting'], is_official: true, is_verified: true },
    { id: 'pdf-generator', name: 'PDF Generator', slug: 'pdf-generator', description: 'Gera documentos PDF profissionais com cabecalho, rodape e formatacao.', version: '1.0.0', author: 'System Clow', category: 'tool', tags: ['pdf', 'documento', 'relatorio'], is_official: true, is_verified: true },
  ];

  const stmt = db.prepare(`
    INSERT INTO plugins (id, name, slug, description, version, author, category, tags, downloads, rating, rating_count, is_official, is_verified, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 5, 1, ?, ?, ?, ?)
  `);

  for (const p of plugins) {
    const tagsJson = Array.isArray(p.tags) ? JSON.stringify(p.tags) : (p.tags || '[]');
    stmt.run(p.id, p.name, p.slug, p.description, p.version, p.author, p.category, tagsJson, p.is_official ? 1 : 0, p.is_verified ? 1 : 0, now, now);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Marketplace API Routes
// ════════════════════════════════════════════════════════════════════════════

export function buildMarketplaceRoutes(): Hono {
  const app = new Hono();

  // Browse plugins
  app.get('/plugins', (c) => {
    const db = getDb();
    const category = c.req.query('category');
    const search = c.req.query('q');
    const limit = parseInt(c.req.query('limit') || '20', 10);

    let sql = 'SELECT * FROM plugins';
    const params: any[] = [];

    if (category) {
      sql += ' WHERE category = ?';
      params.push(category);
    } else if (search) {
      sql += ' WHERE name LIKE ? OR description LIKE ? OR tags LIKE ?';
      const q = `%${search}%`;
      params.push(q, q, q);
    }

    sql += ' ORDER BY is_official DESC, downloads DESC LIMIT ?';
    params.push(limit);

    const plugins = db.prepare(sql).all(...params);
    return c.json({ plugins, count: plugins.length });
  });

  // Get plugin details
  app.get('/plugins/:slug', (c) => {
    const db = getDb();
    const plugin = db.prepare('SELECT * FROM plugins WHERE slug = ?').get(c.req.param('slug'));
    if (!plugin) return c.json({ error: 'Plugin not found' }, 404);
    return c.json(plugin);
  });

  // Install plugin
  app.post('/plugins/:slug/install', (c) => {
    const db = getDb();
    const tenantId = (c as any).get('tenantId') || 'admin';
    const plugin = db.prepare('SELECT * FROM plugins WHERE slug = ?').get(c.req.param('slug')) as any;
    if (!plugin) return c.json({ error: 'Plugin not found' }, 404);

    db.prepare(`
      INSERT OR REPLACE INTO installed_plugins (plugin_id, tenant_id, installed_at, version)
      VALUES (?, ?, ?, ?)
    `).run(plugin.id, tenantId, Date.now(), plugin.version);

    db.prepare('UPDATE plugins SET downloads = downloads + 1 WHERE id = ?').run(plugin.id);

    return c.json({ installed: true, plugin_id: plugin.id, version: plugin.version });
  });

  // Uninstall plugin
  app.delete('/plugins/:slug/uninstall', (c) => {
    const db = getDb();
    const tenantId = (c as any).get('tenantId') || 'admin';
    const plugin = db.prepare('SELECT id FROM plugins WHERE slug = ?').get(c.req.param('slug')) as any;
    if (!plugin) return c.json({ error: 'Plugin not found' }, 404);

    db.prepare('DELETE FROM installed_plugins WHERE plugin_id = ? AND tenant_id = ?').run(plugin.id, tenantId);
    return c.json({ uninstalled: true });
  });

  // List installed plugins for tenant
  app.get('/installed', (c) => {
    const db = getDb();
    const tenantId = (c as any).get('tenantId') || 'admin';
    const plugins = db.prepare(`
      SELECT p.*, ip.installed_at, ip.version as installed_version
      FROM installed_plugins ip JOIN plugins p ON ip.plugin_id = p.id
      WHERE ip.tenant_id = ?
    `).all(tenantId);
    return c.json({ plugins });
  });

  // Rate plugin
  app.post('/plugins/:slug/rate', async (c) => {
    const db = getDb();
    const tenantId = (c as any).get('tenantId') || 'admin';
    const body = await c.req.json().catch(() => ({}));
    const rating = parseInt(body.rating, 10);
    const comment = body.comment || '';

    if (!rating || rating < 1 || rating > 5) {
      return c.json({ error: 'Rating must be 1-5' }, 400);
    }

    const plugin = db.prepare('SELECT id FROM plugins WHERE slug = ?').get(c.req.param('slug')) as any;
    if (!plugin) return c.json({ error: 'Plugin not found' }, 404);

    db.prepare(`INSERT INTO plugin_reviews (plugin_id, tenant_id, rating, comment, created_at) VALUES (?, ?, ?, ?, ?)`).run(plugin.id, tenantId, rating, comment, Date.now());

    // Update average rating
    const avg = db.prepare('SELECT AVG(rating) as avg, COUNT(*) as count FROM plugin_reviews WHERE plugin_id = ?').get(plugin.id) as any;
    db.prepare('UPDATE plugins SET rating = ?, rating_count = ? WHERE id = ?').run(Math.round(avg.avg * 10) / 10, avg.count, plugin.id);

    return c.json({ rated: true, new_rating: avg.avg, total_reviews: avg.count });
  });

  // Marketplace stats
  app.get('/stats', (c) => {
    const db = getDb();
    const total = db.prepare('SELECT COUNT(*) as c FROM plugins').get() as { c: number };
    const official = db.prepare('SELECT COUNT(*) as c FROM plugins WHERE is_official = 1').get() as { c: number };
    const installs = db.prepare('SELECT COUNT(*) as c FROM installed_plugins').get() as { c: number };
    const categories = db.prepare('SELECT category, COUNT(*) as count FROM plugins GROUP BY category').all();

    return c.json({
      totalPlugins: total.c,
      officialPlugins: official.c,
      totalInstalls: installs.c,
      categories,
    });
  });

  return app;
}
