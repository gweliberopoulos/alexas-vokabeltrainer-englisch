const CACHE_NAME = 'vokabeltrainer-v1';
const ASSETS = [
  '/',
  '/index.html',
  '/app.js',
  '/style.css',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/data/index.json',
  '/data/unit1-across-cultures.json',
  '/data/unit1-weekend-workshop.json',
  '/data/unit1-checkout-story.json',
  '/data/unit1-text-smart.json',
  '/data/unit2.json',
  '/data/unit2-welcome-station1.json',
  '/data/unit2-station2.json',
  '/data/unit2-story-checkin.json',
  '/data/irregular-verbs.json'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  e.respondWith(
    caches.match(e.request)
      .then(cached => cached || fetch(e.request)
        .then(resp => {
          if (resp && resp.status === 200 && e.request.method === 'GET') {
            const clone = resp.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
          }
          return resp;
        })
      )
  );
});
