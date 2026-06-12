// Quick messages (mensagens prontas) — CRUD por tenant.
// UI: botão no composer dentro do card. Envio reaproveita o path normal
// (POST /channels/:id/send) — aqui só guardamos o template.
import { Hono } from 'hono';
import { tenantOf } from './_helpers.js';
import * as store from '.././store.js';

function badRequest(c: any, msg: string) {
  return c.json({ error: 'bad_request', message: msg }, 400);
}
function notFound(c: any, what: string) {
  return c.json({ error: 'not_found', message: `${what} not found` }, 404);
}
function ok(c: any, data: unknown, status = 200) {
  return c.json(data, status);
}

const ALLOWED_MEDIA = new Set(['image', 'video', 'audio', 'document']);

function normalizeMedia(body: any): {
  mediaUrl: string | null;
  mediaType: string | null;
  mediaFilename: string | null;
} {
  const rawUrl = typeof body.mediaUrl === 'string' ? body.mediaUrl.trim() : '';
  if (!rawUrl) {
    return { mediaUrl: null, mediaType: null, mediaFilename: null };
  }
  const type = typeof body.mediaType === 'string' && ALLOWED_MEDIA.has(body.mediaType)
    ? body.mediaType
    : 'document';
  const filename = typeof body.mediaFilename === 'string'
    ? body.mediaFilename.slice(0, 200)
    : null;
  return { mediaUrl: rawUrl.slice(0, 2000), mediaType: type, mediaFilename: filename };
}

export function registerQuickMessagesRoutes(app: Hono): void {
  app.get('/quick-messages', (c) => {
    return ok(c, { items: store.listQuickMessages(tenantOf(c)) });
  });

  app.post('/quick-messages', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as any;
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) return badRequest(c, 'title required');
    const text = typeof body.body === 'string' ? body.body : '';
    const media = normalizeMedia(body);
    if (!text.trim() && !media.mediaUrl) {
      return badRequest(c, 'body or media required');
    }
    const item = store.createQuickMessage(tenantOf(c), {
      title,
      body: text,
      mediaUrl: media.mediaUrl,
      mediaType: media.mediaType,
      mediaFilename: media.mediaFilename,
      sortOrder: typeof body.sortOrder === 'number' ? body.sortOrder : 0,
    });
    return ok(c, { item }, 201);
  });

  app.patch('/quick-messages/:id', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as any;
    const patch: any = {};
    if (typeof body.title === 'string') {
      const t = body.title.trim();
      if (!t) return badRequest(c, 'title cannot be empty');
      patch.title = t;
    }
    if (typeof body.body === 'string') patch.body = body.body;
    if (body.mediaUrl !== undefined || body.mediaType !== undefined || body.mediaFilename !== undefined) {
      const m = normalizeMedia(body);
      patch.mediaUrl = m.mediaUrl;
      patch.mediaType = m.mediaType;
      patch.mediaFilename = m.mediaFilename;
    }
    if (typeof body.sortOrder === 'number') patch.sortOrder = body.sortOrder;
    const upd = store.updateQuickMessage(tenantOf(c), c.req.param('id'), patch);
    return upd ? ok(c, { item: upd }) : notFound(c, 'quick_message');
  });

  app.delete('/quick-messages/:id', (c) => {
    const r = store.deleteQuickMessage(tenantOf(c), c.req.param('id'));
    return r ? c.body(null, 204) : notFound(c, 'quick_message');
  });
}
