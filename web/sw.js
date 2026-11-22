// Rokhan service worker: keeps the app shell and the vendored libraries for offline use.
// Never touches /api (logbook, chat and lessons always go to the server).
// Bump VERSION when web/ changes so old caches are dropped; test/web-sw.test.mjs checks SHELL.
const VERSION = 'rokhan-2026-11-22-5';
const SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/app.css',
  '/theme.js',
  '/app.js',
  '/api.js',
  '/lib/blocks.js',
  '/lib/cnp.js',
  '/lib/crop.js',
  '/lib/format.js',
  '/lib/ga.js',
  '/lib/ghid.js',
  '/lib/outbox.js',
  '/lib/registru.js',
  '/lib/sse.js',
  '/ui/crop.js',
  '/ui/icons.js',
  '/ui/markdown.js',
  '/views/chat.js',
  '/views/ghiduri.js',
  '/views/lecturi.js',
  '/views/mai-mult.js',
  '/views/registru.js',
  '/fonts/atkinson-hyperlegible-next-latin-ext-wght-italic.woff2',
  '/fonts/atkinson-hyperlegible-next-latin-ext-wght-normal.woff2',
  '/fonts/atkinson-hyperlegible-next-latin-wght-italic.woff2',
  '/fonts/atkinson-hyperlegible-next-latin-wght-normal.woff2',
  '/fonts/courier-prime-latin-400-normal.woff2',
  '/fonts/courier-prime-latin-700-normal.woff2',
  '/fonts/courier-prime-latin-ext-400-normal.woff2',
  '/fonts/courier-prime-latin-ext-700-normal.woff2',
  '/fonts/protest-strike-latin-400-normal.woff2',
  '/fonts/protest-strike-latin-ext-400-normal.woff2',
  '/fonts/source-sans-3-latin-ext-wght-italic.woff2',
  '/fonts/source-sans-3-latin-ext-wght-normal.woff2',
  '/fonts/source-sans-3-latin-wght-italic.woff2',
  '/fonts/source-sans-3-latin-wght-normal.woff2',
  '/icons/icon.svg',
  '/icons/icon-maskable.svg',
  '/icons/icon-192.png',
  '/icons/apple-touch-icon.png',
  '/vendor/preact-11.2.0.mjs',
  '/vendor/preact-hooks-11.2.0.mjs',
  '/vendor/htm-3.1.1.mjs',
  '/vendor/marked-18.2.1.mjs',
  '/vendor/dompurify-3.4.18.mjs',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Web push (the daily lesson): the server sends { title, body, url }. A push must always show something.
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data?.json() ?? {}; } catch { d = { body: e.data?.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Rokhan', {
    body: d.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: typeof d.url === 'string' && d.url.startsWith('/') && !d.url.startsWith('//') ? d.url : '/' },
  }));
});

// A tap opens the app: an open window is focused and sent to the address, else a new one opens.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = e.notification.data?.url || '/';
  e.waitUntil((async () => {
    const wins = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find((w) => new URL(w.url).origin === location.origin);
    if (win) {
      try {
        await win.focus();
        await win.navigate(url);
        return;
      } catch { /* a browser that cannot navigate the window: open a new one */ }
    }
    await clients.openWindow(url);
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;

  // The page itself: network first, so a new version shows up at once; the cached copy offline.
  if (req.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) caches.open(VERSION).then((c) => c.put('/index.html', res.clone()));
          return res;
        })
        .catch(() => caches.match('/index.html')),
    );
    return;
  }

  // Versioned vendor files never change: cache first. The rest: cached copy at once, refreshed in
  // the background, so a deploy is picked up on the next start even without a VERSION bump.
  e.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const hit = await cache.match(req);
      if (hit && url.pathname.startsWith('/vendor/')) return hit;
      const fresh = fetch(req)
        .then((res) => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => hit);
      return hit ?? fresh;
    }),
  );
});
