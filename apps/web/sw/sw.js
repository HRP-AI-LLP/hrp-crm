/* HRP Synapse service worker — generated into dist/sw.js by vite.config.ts (precache list + version).
 *  - app shell: hashed assets cache-first, page navigations network-first with the cached shell offline
 *  - never touches /api/* (data is always live; offline writes are queued by the app itself)
 *  - Web Push: shows notifications, focuses or opens the app at the notification's link
 */
const VERSION = '__VERSION__';
const PRECACHE = __PRECACHE__;
const SHELL = `synapse-shell-${VERSION}`;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((c) => c.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('synapse-shell-') && k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/.well-known/')) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(async () => (await caches.match('/', { cacheName: SHELL })) || new Response('Offline', { status: 503, headers: { 'content-type': 'text/plain' } })),
    );
    return;
  }
  if (url.pathname.startsWith('/assets/') || PRECACHE.includes(url.pathname)) {
    event.respondWith(
      caches.match(req, { cacheName: SHELL }).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok && url.pathname.startsWith('/assets/')) {
              const copy = res.clone();
              caches.open(SHELL).then((c) => c.put(req, copy));
            }
            return res;
          }),
      ),
    );
  }
});

self.addEventListener('push', (event) => {
  let msg = {};
  try {
    msg = event.data ? event.data.json() : {};
  } catch {
    msg = { title: 'HRP Synapse', body: event.data ? event.data.text() : '' };
  }
  let link = '/field';
  try {
    const u = new URL(String(msg.link || '/field'), self.location.origin);
    if (u.origin === self.location.origin) link = u.pathname + u.search;
  } catch {
    /* keep the default */
  }
  event.waitUntil(
    self.registration.showNotification(msg.title || 'HRP Synapse', {
      body: msg.body || '',
      tag: msg.tag || undefined,
      renotify: !!msg.tag,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { link },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.link) || '/field', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if (new URL(w.url).origin === self.location.origin && 'focus' in w) {
          w.postMessage({ type: 'navigate', link: new URL(target).pathname + new URL(target).search });
          return w.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});
