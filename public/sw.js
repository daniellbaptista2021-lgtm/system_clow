// System Clow PWA Service Worker — v116
// Bypass: /v1/* /auth/* /webhooks/* /crm/* /downloads/* — sempre fresh do server
// Cache: assets estaticos do shell (icons, manifest)

const CACHE = 'clow-v116-native-video';
const STATIC = ['/assets/logo.png', '/assets/favicon.png', '/assets/icon-192.png', '/assets/icon-512.png', '/assets/apple-touch-icon.png', '/manifest.json'];

self.addEventListener('install', e => {
  // Pre-cache shell assets but never block install on failure
  e.waitUntil(
    caches.open(CACHE).then(c => Promise.allSettled(STATIC.map(u => c.add(u).catch(() => {}))))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = e.request.url;
  // Bypass: APIs, auth, webhooks, CRM (full bypass), downloads, SSE
  if (url.includes('/v1/') || url.includes('/auth/') || url.includes('/webhooks/')
      || url.includes('/crm/') || url.includes('/downloads/') || url.includes('/events')) {
    return; // let browser handle directly
  }
  // Network-first only for static assets we expect to cache
  if (!url.match(/\.(png|jpg|svg|css|json|woff2?)$/)) return;
  e.respondWith(
    fetch(e.request).then(r => {
      if (r.ok) {
        const clone = r.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
      }
      return r;
    }).catch(() => caches.match(e.request))
  );
});

// Allow page → SW message to nuke cache (used by force-reset paths)
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'NUKE') {
    e.waitUntil((async () => {
      const ks = await caches.keys();
      await Promise.all(ks.map(k => caches.delete(k)));
      try { await self.registration.unregister(); } catch {}
    })());
  }
});
