const CACHE_NAME = 'nzuko-ai-shell-v92';
const APP_SHELL = [
  '/',
  '/index.html',
  '/styles.css?v=20260904-92',
  '/app.js?v=20260904-92',
  '/supabase-browser.js',
  '/importText.js',
  '/manifest.webmanifest',
  '/offline.html',
  '/assets/nzuko-mark.svg',
  '/assets/nzuko-install-qr.svg',
  '/assets/purpose/healthcare-operations.png',
  '/assets/purpose/property-facilities.png',
  '/assets/purpose/field-service.png',
  '/assets/purpose/community-charity.png',
  '/assets/purpose/personal-productivity.png',
  '/assets/icon-192.png',
  '/assets/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method !== 'GET') {
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put('/index.html', copy));
          return response;
        })
        .catch(async () => {
          const cachedPage = await caches.match('/index.html');
          return cachedPage || caches.match('/offline.html');
        })
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (!response || response.status !== 200 || response.type !== 'basic') {
          return response;
        }
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        return response;
      });
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      const existing = clients.find((client) => 'focus' in client);
      if (existing) {
        existing.navigate('/#actions');
        return existing.focus();
      }
      return self.clients.openWindow('/#actions');
    })
  );
});
