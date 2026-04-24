/**
 * Public proposal routes — no tenant auth, access via signed token.
 *
 * Mounted at /p (see server.ts).
 *
 *   GET  /p/proposals/:token        — HTML view (tracks visit)
 *   POST /p/proposals/:token/sign   — accept + sign (triggers auto-convert)
 *   GET  /p/proposals/:token/pdf    — PDF download
 *   GET  /p/proposals/:token/pixel  — 1x1 tracking pixel
 */

import { Hono } from 'hono';
import { getCrmDb } from './schema.js';
import * as store from './store.js';
import { buildContext, renderHTML, renderPDF, recordEvent, onAccept } from './proposals.js';

const app = new Hono();

function findByToken(token: string): { tenantId: string; proposalId: string } | null {
  const row = getCrmDb().prepare('SELECT id, tenant_id FROM crm_proposals WHERE public_token = ?').get(token) as any;
  return row ? { tenantId: row.tenant_id, proposalId: row.id } : null;
}

function clientIp(c: any): string {
  return c.req.header('x-forwarded-for')?.split(',')[0].trim()
    || c.req.header('x-real-ip')
    || 'unknown';
}

function baseUrl(c: any): string {
  const proto = c.req.header('x-forwarded-proto') || 'https';
  const host = c.req.header('host') || 'localhost';
  return `${proto}://${host}`;
}

app.get('/proposals/:token', (c) => {
  const t = findByToken(c.req.param('token'));
  if (!t) return c.text('Proposta não encontrada', 404);
  recordEvent(t.proposalId, 'viewed', { ip: clientIp(c), ua: c.req.header('user-agent') });
  try {
    const ctx = buildContext(t.tenantId, t.proposalId, baseUrl(c));
    const html = renderHTML(ctx);
    return c.html(html);
  } catch (err: any) {
    return c.text('Erro: ' + err.message, 500);
  }
});

app.get('/proposals/:token/pdf', async (c) => {
  const t = findByToken(c.req.param('token'));
  if (!t) return c.text('not found', 404);
  recordEvent(t.proposalId, 'viewed', { ip: clientIp(c), ua: c.req.header('user-agent') });
  try {
    const ctx = buildContext(t.tenantId, t.proposalId, baseUrl(c));
    const pdf = await renderPDF(ctx);
    return new Response(new Uint8Array(pdf), {
      status: 200,
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': `inline; filename="proposta-v${ctx.proposal.version}.pdf"`,
      },
    });
  } catch (err: any) {
    return c.text('Erro: ' + err.message, 500);
  }
});

// 1x1 GIF tracking pixel (for when proposal is opened in email)
const PIXEL_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
app.get('/proposals/:token/pixel', (c) => {
  const t = findByToken(c.req.param('token'));
  if (t) recordEvent(t.proposalId, 'viewed', { ip: clientIp(c), ua: c.req.header('user-agent') });
  return new Response(new Uint8Array(PIXEL_GIF), {
    status: 200,
    headers: { 'content-type': 'image/gif', 'cache-control': 'no-store' },
  });
});

app.post('/proposals/:token/sign', async (c) => {
  const t = findByToken(c.req.param('token'));
  if (!t) return c.json({ error: 'not_found' }, 404);
  const body = await c.req.json().catch(() => ({})) as any;
  const signedBy = String(body.signed_by || body.signedBy || '').trim();
  if (!signedBy) return c.json({ error: 'signed_by required' }, 400);

  const p = store.updateProposalStatus(t.tenantId, t.proposalId, 'accepted', { signedBy, signedIp: clientIp(c) });
  if (!p) return c.json({ error: 'failed' }, 500);
  recordEvent(t.proposalId, 'signed', { ip: clientIp(c), ua: c.req.header('user-agent') });
  onAccept(t.tenantId, t.proposalId);
  return c.json({ ok: true, status: p.status });
});

export default app;
