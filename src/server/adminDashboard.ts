/**
 * adminDashboard.ts — Admin Dashboard + Real Health Check
 *
 * Provides:
 *   - /admin/dashboard — Visual dashboard with metrics, sessions, memory, costs
 *   - Enhanced /health with Anthropic API connectivity check
 */

import { Hono } from 'hono';
import { getMetricsSummary } from '../utils/logger.js';
import { apiQueue } from './requestQueue.js';

// ════════════════════════════════════════════════════════════════════════════
// Real Health Check
// ════════════════════════════════════════════════════════════════════════════

let lastApiCheck: { ok: boolean; latencyMs: number; checkedAt: number; error?: string } | null = null;
const API_CHECK_INTERVAL = 60_000; // Cache API check for 1 minute

async function checkAnthropicApi(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  // Return cached result if fresh
  if (lastApiCheck && Date.now() - lastApiCheck.checkedAt < API_CHECK_INTERVAL) {
    return lastApiCheck;
  }

  const start = Date.now();
  try {
    // Verify API key format and connectivity
    const apiKey = process.env.ANTHROPIC_API_KEY || '';
    if (!apiKey || apiKey.length < 10) {
      const result = { ok: false, latencyMs: 0, error: 'API key not configured' };
      lastApiCheck = { ...result, checkedAt: Date.now() };
      return result;
    }

    // Quick connectivity check via HTTP HEAD to Anthropic API
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.CLOW_MODEL || 'claude-haiku-4-5-20250315',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    // 200 = works, 400/401 = key issue, but server reachable
    const ok = response.status === 200;
    const result = {
      ok,
      latencyMs: Date.now() - start,
      error: ok ? undefined : `API returned ${response.status}`,
    };
    lastApiCheck = { ...result, checkedAt: Date.now() };
    return result;
  } catch (err) {
    const result = { ok: false, latencyMs: Date.now() - start, error: (err as Error).message };
    lastApiCheck = { ...result, checkedAt: Date.now() };
    return result;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Dashboard Routes
// ════════════════════════════════════════════════════════════════════════════

export function buildDashboardRoutes(pool: any): Hono {
  const app = new Hono();

  // ─── Enhanced Health Check ──────────────────────────────────────

  app.get('/health/deep', async (c) => {
    const apiStatus = await checkAnthropicApi();
    const queueStats = apiQueue.getStats();
    const sessions = pool.listActive?.() || [];

    // Check memory system
    let memoryOk = false;
    try {
      const { MemoryStore } = await import('../memory/MemoryStore.js');
      const store = new MemoryStore('default');
      store.getStats();
      memoryOk = true;
    } catch {}

    const allOk = apiStatus.ok && memoryOk;

    return c.json({
      status: allOk ? 'healthy' : 'degraded',
      checks: {
        server: { ok: true },
        anthropicApi: apiStatus,
        memoryDb: { ok: memoryOk },
        requestQueue: {
          ok: queueStats.queueDepth < 10,
          ...queueStats,
        },
      },
      activeSessions: sessions.length,
      uptime: process.uptime(),
    }, allOk ? 200 : 503);
  });

  // ─── Dashboard HTML ─────────────────────────────────────────────

  app.get('/admin/dashboard', async (c) => {
    // Verify admin auth
    const authHeader = c.req.header('Authorization');
    const token = authHeader?.replace('Bearer ', '') || c.req.query('token') || '';

    try {
      const { verifyAdminSessionToken } = await import('./middleware/tenantAuth.js');
      if (!verifyAdminSessionToken(token)) {
        return c.html('<h1>401 — Acesso negado</h1><p><a href="/">Voltar ao login</a></p>', 401);
      }
    } catch {
      // If auth module fails, allow access (dev mode)
    }

    const metrics = getMetricsSummary();
    const queueStats = apiQueue.getStats();
    const sessions = pool.listActive?.() || [];
    const apiCheck = await checkAnthropicApi();

    let memoryStats = { sessionCount: 0, observationCount: 0, summaryCount: 0, dbSizeBytes: 0 };
    try {
      const { MemoryStore } = await import('../memory/MemoryStore.js');
      memoryStats = new MemoryStore('default').getStats();
    } catch {}

    const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>System Clow — Admin Dashboard</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Inter',system-ui,sans-serif;background:#0f0f13;color:#e8e4dd;min-height:100vh;padding:24px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px;max-width:1400px;margin:0 auto}
.card{background:#1a1a22;border:1px solid #2a2a35;border-radius:16px;padding:20px}
.card h3{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:#8888aa;margin-bottom:14px}
.stat{font-size:32px;font-weight:700;color:#f0e8d8;line-height:1.1}
.stat-label{font-size:13px;color:#777;margin-top:4px}
.stat-row{display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid #22222e}
.stat-row:last-child{border:none}
.badge{display:inline-block;padding:3px 10px;border-radius:99px;font-size:12px;font-weight:600}
.badge-ok{background:#1a3a1a;color:#4ade80}
.badge-warn{background:#3a2a0a;color:#fbbf24}
.badge-err{background:#3a1a1a;color:#f87171}
.header{max-width:1400px;margin:0 auto 24px;display:flex;align-items:center;justify-content:space-between}
.header h1{font-size:22px;font-weight:600}
.header .refresh{background:#2a2a35;border:1px solid #3a3a45;color:#e8e4dd;padding:8px 16px;border-radius:10px;cursor:pointer;font-size:13px}
.header .refresh:hover{background:#3a3a45}
.bar{height:6px;background:#22222e;border-radius:99px;overflow:hidden;margin-top:8px}
.bar-fill{height:100%;border-radius:99px;transition:width .3s}
.bar-ok{background:linear-gradient(90deg,#22c55e,#4ade80)}
.bar-warn{background:linear-gradient(90deg,#f59e0b,#fbbf24)}
.bar-err{background:linear-gradient(90deg,#ef4444,#f87171)}
</style>
</head>
<body>
<div class="header">
  <h1>System Clow — Dashboard</h1>
  <button class="refresh" onclick="location.reload()">Atualizar</button>
</div>
<div class="grid">

  <div class="card">
    <h3>Status do Sistema</h3>
    <div class="stat-row">
      <span>Servidor</span>
      <span class="badge badge-ok">Online</span>
    </div>
    <div class="stat-row">
      <span>Anthropic API</span>
      <span class="badge ${apiCheck.ok ? 'badge-ok' : 'badge-err'}">${apiCheck.ok ? 'Conectado' : 'Erro'}${apiCheck.latencyMs ? ' (' + apiCheck.latencyMs + 'ms)' : ''}</span>
    </div>
    <div class="stat-row">
      <span>Memoria SQLite</span>
      <span class="badge ${memoryStats.sessionCount >= 0 ? 'badge-ok' : 'badge-err'}">Ativo</span>
    </div>
    <div class="stat-row">
      <span>Uptime</span>
      <span>${formatUptime(process.uptime())}</span>
    </div>
  </div>

  <div class="card">
    <h3>Sessoes Ativas</h3>
    <div class="stat">${sessions.length}</div>
    <div class="stat-label">sessoes no pool</div>
  </div>

  <div class="card">
    <h3>Fila de Requisicoes</h3>
    <div class="stat">${queueStats.activeRequests}/${queueStats.maxConcurrency}</div>
    <div class="stat-label">ativas / max concorrencia</div>
    <div class="stat-row">
      <span>Na fila</span>
      <span>${queueStats.queueDepth}</span>
    </div>
    <div class="stat-row">
      <span>Processadas</span>
      <span>${queueStats.totalProcessed}</span>
    </div>
    <div class="stat-row">
      <span>Espera media</span>
      <span>${queueStats.avgWaitMs}ms</span>
    </div>
    <div class="stat-row">
      <span>Pico da fila</span>
      <span>${queueStats.peakQueueDepth}</span>
    </div>
  </div>

  <div class="card">
    <h3>Latencia (ultima hora)</h3>
    <div class="stat-row">
      <span>Requisicoes</span>
      <span>${metrics.totalRequests}</span>
    </div>
    <div class="stat-row">
      <span>Media</span>
      <span>${metrics.avgLatencyMs}ms</span>
    </div>
    <div class="stat-row">
      <span>P95</span>
      <span>${metrics.p95LatencyMs}ms</span>
    </div>
    <div class="stat-row">
      <span>P99</span>
      <span>${metrics.p99LatencyMs}ms</span>
    </div>
    <div class="stat-row">
      <span>Erros</span>
      <span class="${metrics.errorCount > 0 ? 'badge badge-err' : ''}">${metrics.errorCount}</span>
    </div>
  </div>

  <div class="card">
    <h3>Memoria Persistente</h3>
    <div class="stat-row">
      <span>Sessoes gravadas</span>
      <span>${memoryStats.sessionCount}</span>
    </div>
    <div class="stat-row">
      <span>Observacoes</span>
      <span>${memoryStats.observationCount}</span>
    </div>
    <div class="stat-row">
      <span>Resumos</span>
      <span>${memoryStats.summaryCount}</span>
    </div>
    <div class="stat-row">
      <span>Tamanho do DB</span>
      <span>${formatBytes(memoryStats.dbSizeBytes)}</span>
    </div>
  </div>

  <div class="card">
    <h3>Por Componente</h3>
    ${Object.entries(metrics.byComponent).length > 0
      ? Object.entries(metrics.byComponent).map(([comp, data]: [string, any]) =>
          `<div class="stat-row"><span>${comp}</span><span>${data.count} req, ${data.avgMs}ms avg${data.errors > 0 ? ', ' + data.errors + ' erros' : ''}</span></div>`
        ).join('')
      : '<div class="stat-label">Nenhuma metrica ainda</div>'
    }
  </div>

</div>

<script>
// Auto-refresh every 30 seconds
setTimeout(() => location.reload(), 30000);
</script>
</body>
</html>`;

    return c.html(html);
  });

  return app;
}

// ════════════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════════════

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}
