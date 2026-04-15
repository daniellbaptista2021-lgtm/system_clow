const CACHE = 'clow-v99';
const STATIC = ['/', '/assets/logo.png', '/assets/favicon.png', '/assets/icon-192.png', '/assets/icon-512.png', '/assets/apple-touch-icon.png', '/manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(STATIC)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  if (e.request.url.includes('/v1/') || e.request.url.includes('/auth/')) return;
  e.respondWith(
    fetch(e.request).then(r => {
      if (r.ok && e.request.url.match(/\.(png|jpg|js|css|json)$/)) {
        const clone = r.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
      }
      return r;
    }).catch(() => caches.match(e.request))
  );
});
