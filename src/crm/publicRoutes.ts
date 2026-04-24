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
import * as em from './emailMarketing.js';
import * as forms from './forms.js';
import * as cal from './calendar.js';
import * as docs from './documents.js';
import { buildDocumentHTML } from './documentPublic.js';
import { buildBookingHTML } from './bookingPage.js';
import { buildEmbedJS, buildHostedFormHTML } from './embedTemplate.js';

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


// ─── Email marketing public tracking ────────────────────────────────────
const PIXEL_GIF2 = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

app.get('/e/o/:token', (c) => {
  em.recordOpen(c.req.param('token'), clientIp(c));
  return new Response(new Uint8Array(PIXEL_GIF2), {
    status: 200,
    headers: { 'content-type': 'image/gif', 'cache-control': 'no-store' },
  });
});

app.get('/e/c/:token', (c) => {
  const url = c.req.query('u');
  if (!url) return c.text('missing u', 400);
  const dest = em.recordClick(c.req.param('token'), url, clientIp(c));
  return c.redirect(dest, 302);
});

app.get('/e/u/:token', (c) => {
  const r = em.unsubscribe(c.req.param('token'));
  if (!r.ok) return c.text('Link inválido ou expirado.', 404);
  return c.html(`<!doctype html><meta charset="utf-8"><title>Inscrição cancelada</title>
<body style="font-family:system-ui;max-width:520px;margin:80px auto;padding:24px;text-align:center;color:#1e293b">
  <h1 style="color:#9B59FC">Inscrição cancelada</h1>
  <p>${r.email ? 'O email ' + r.email + ' foi' : 'Você foi'} removido da lista. Não enviaremos mais mensagens.</p>
  <p style="color:#64748b;font-size:13px">Se mudou de ideia, entre em contato conosco.</p>
</body>`);
});



// ─── Public form endpoints ──────────────────────────────────────────────
app.get('/forms/:slug/config.json', (c) => {
  const f = forms.getFormBySlug(c.req.param('slug'));
  if (!f) return c.json({ error: 'not_found' }, 404);
  return c.json({
    slug: f.slug, name: f.name, fields: f.fields,
    redirectUrl: f.redirectUrl,
  });
});

app.get('/forms/:slug/embed.js', (c) => {
  const f = forms.getFormBySlug(c.req.param('slug'));
  if (!f) return c.text('console.error("Clow form not found");', 404, { 'content-type': 'application/javascript' });
  const proto = c.req.header('x-forwarded-proto') || 'https';
  const host = c.req.header('host') || 'localhost';
  const base = `${proto}://${host}`;
  const js = buildEmbedJS(f, base);
  return new Response(js, { status: 200, headers: { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'public, max-age=60' } });
});

app.get('/forms/:slug', (c) => {
  const f = forms.getFormBySlug(c.req.param('slug'));
  if (!f) return c.text('Form not found', 404);
  const proto = c.req.header('x-forwarded-proto') || 'https';
  const host = c.req.header('host') || 'localhost';
  return c.html(buildHostedFormHTML(f, `${proto}://${host}`));
});

app.post('/forms/:slug', async (c) => {
  const f = forms.getFormBySlug(c.req.param('slug'));
  if (!f) return c.json({ ok: false, error: 'not_found' }, 404);
  const body = await c.req.json().catch(() => ({})) as any;
  const r = forms.submitForm(f, body, { ip: clientIp(c), ua: c.req.header('user-agent') });
  return c.json(r);
});

// Inbound webhook receiver — accepts arbitrary JSON, applies mapping
app.post('/hooks/:hookKey', async (c) => {
  const hook = forms.getHookByKey(c.req.param('hookKey'));
  if (!hook) return c.json({ error: 'not_found' }, 404);
  const rawBody = await c.req.text();
  const providedSig = c.req.header('x-clow-signature') || c.req.header('x-webhook-signature');
  if (hook.secret && !forms.verifyHookSignature(hook, rawBody, providedSig ?? null)) {
    return c.json({ error: 'invalid_signature' }, 401);
  }
  let payload: any = {};
  try { payload = JSON.parse(rawBody); } catch { payload = {}; }
  const r = forms.processWebhookPayload(hook, payload, { ip: clientIp(c), ua: c.req.header('user-agent') });
  return c.json(r);
});



// ─── Public booking pages + ICS feed ────────────────────────────────────
app.get('/book/:slug', (c) => {
  const link = cal.getSchedulingLinkBySlug(c.req.param('slug'));
  if (!link || !link.enabled) return c.text('Link de agendamento não encontrado', 404);
  const proto = c.req.header('x-forwarded-proto') || 'https';
  const host = c.req.header('host') || 'localhost';
  return c.html(buildBookingHTML(link, `${proto}://${host}`));
});

app.get('/book/:slug/slots', (c) => {
  const link = cal.getSchedulingLinkBySlug(c.req.param('slug'));
  if (!link || !link.enabled) return c.json({ error: 'not_found' }, 404);
  const from = Number(c.req.query('from') || Date.now());
  const to = Number(c.req.query('to') || (Date.now() + 30 * 86400_000));
  const slots = cal.computeAvailability(link, from, to);
  return c.json({ slots });
});

app.post('/book/:slug/book', async (c) => {
  const link = cal.getSchedulingLinkBySlug(c.req.param('slug'));
  if (!link || !link.enabled) return c.json({ ok: false, error: 'not_found' }, 404);
  const body = await c.req.json().catch(() => ({})) as any;
  if (!body.startsAt) return c.json({ ok: false, error: 'startsAt required' }, 400);
  const r = cal.bookViaLink(link, body);
  return c.json(r);
});

// ICS feed — subscribable via calendar apps
app.get('/cal/:tokenPath', (c) => {
  const raw = c.req.param('tokenPath');
  const token = raw.endsWith('.ics') ? raw.slice(0, -4) : raw;
  const tid = cal.findTenantByIcsToken(token);
  if (!tid) return c.text('not found', 404);
  const now = Date.now();
  const appts = cal.listAppointments(tid, { from: now - 30 * 86400_000, to: now + 365 * 86400_000 });
  return new Response(cal.renderICS(appts), {
    status: 200,
    headers: {
      'content-type': 'text/calendar; charset=utf-8',
      'content-disposition': `inline; filename="clow-${token.slice(0, 8)}.ics"`,
    },
  });
});



// ─── Document public view + sign ────────────────────────────────────────
app.get('/docs/:token', (c) => {
  const r = docs.getDocumentByToken(c.req.param('token'));
  if (!r) return c.text('Documento não encontrado', 404);
  docs.recordEvent(r.doc.id, 'viewed', { ip: clientIp(c), ua: c.req.header('user-agent') });
  const proto = c.req.header('x-forwarded-proto') || 'https';
  const host = c.req.header('host') || 'localhost';
  return c.html(buildDocumentHTML(r.doc, `${proto}://${host}`));
});

app.post('/docs/:token/sign', async (c) => {
  const r = docs.getDocumentByToken(c.req.param('token'));
  if (!r) return c.json({ ok: false, error: 'not_found' }, 404);
  const body = await c.req.json().catch(() => ({})) as any;
  const signedBy = String(body.signedBy || '').trim();
  if (!signedBy) return c.json({ ok: false, error: 'signedBy required' }, 400);
  const signed = docs.signDocument(r.tenantId, r.doc.id, {
    signedBy, signedIp: clientIp(c), signatureImage: body.signatureImage,
  });
  return signed ? c.json({ ok: true, status: signed.status }) : c.json({ ok: false, error: 'sign_failed' }, 500);
});


export default app;
