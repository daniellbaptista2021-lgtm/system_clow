/**
 * Media CDN rewriting — Onda 32.
 *
 * Rewrites media URLs in responses to point to CDN when CDN_BASE_URL env is set.
 * Works for activities.media_url, contact.avatar_url, proposal.file_url, etc.
 *
 * If CDN_BASE_URL=https://cdn.clow.dev and original url starts with /media/ or is relative,
 * result becomes https://cdn.clow.dev/media/....
 */

export function rewriteMediaUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const cdn = process.env.CDN_BASE_URL;
  if (!cdn) return url;
  if (/^https?:\/\//i.test(url)) {
    // Already absolute — only rewrite if it points to our own origin
    const origin = process.env.PUBLIC_BASE_URL;
    if (origin && url.startsWith(origin)) {
      return cdn.replace(/\/$/, '') + url.slice(origin.length);
    }
    return url; // external URL, leave alone
  }
  return cdn.replace(/\/$/, '') + (url.startsWith('/') ? url : '/' + url);
}

/** Apply rewrite recursively to a response object for known URL fields. */
const URL_FIELDS = new Set([
  'mediaUrl', 'media_url', 'avatarUrl', 'avatar_url',
  'fileUrl', 'file_url', 'iconUrl', 'icon_url',
]);

export function rewriteUrlsInPlace(obj: any): any {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) { for (const it of obj) rewriteUrlsInPlace(it); return obj; }
  for (const [k, v] of Object.entries(obj)) {
    if (URL_FIELDS.has(k) && typeof v === 'string') obj[k] = rewriteMediaUrl(v);
    else if (v && typeof v === 'object') rewriteUrlsInPlace(v);
  }
  return obj;
}

/** Hono middleware — rewrite URL fields in JSON responses. */
export function cdnMiddleware() {
  return async (c: any, next: () => Promise<void>) => {
    await next();
    const cdn = process.env.CDN_BASE_URL;
    if (!cdn) return;
    const ct = c.res.headers.get('content-type') || '';
    if (!ct.includes('application/json')) return;
    try {
      const data = await c.res.clone().json();
      rewriteUrlsInPlace(data);
      c.res = new Response(JSON.stringify(data), { status: c.res.status, headers: c.res.headers });
    } catch { /* non-JSON */ }
  };
}
